#include <Arduino.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <AsyncTCP.h>
#include "LittleFS.h"
#include <ArduinoJson.h>

float thermistor(uint8_t analogPin, uint16_t adcSize, uint32_t nominalResistance,
                 uint32_t seriesResistance, uint16_t betaCoefficient, uint8_t nominalTemperature, int samples)
{
  float v = 0;
  int read = 0;
  for (int i = 0; i < samples; i++)
  {
    read += analogRead(analogPin);
  }
  v = read;
  v /= samples;

  // Now we can apply a polynomial correction that will take care of some of the nonlinearity of the adc. Improves accuracy, not a must.
  v = (-0.0000000187911893375 * pow(v, 3) + 0.0000595767946842051 * pow(v, 2) + 1.01166726880618 * v + 138.2747);

  v = seriesResistance * ((pow(2.0, adcSize) - 1) / v - 1);

  // Steinhart–Hart equation, based on https://learn.adafruit.com/thermistor/using-a-thermistor
  float steinhart = (log(v / nominalResistance)) / betaCoefficient;
  steinhart += 1.0 / (nominalTemperature + 273.15);
  steinhart = 1.0 / steinhart; // invert
  steinhart -= 273.15;         // convert to celsius

  return steinhart;
}

int potmeter(int analogPin, int samples)
{
  float v = 0;
  for (int i = 0; i < samples; i++)
  {
    v += analogRead(analogPin);
  }
  v /= samples;
  // v = (-0.0000000187911893375 * pow(v, 3) + 0.0000595767946842051 * pow(v, 2) + 1.01166726880618 * v + 138.2747);
  return (int)v;
}

typedef struct
{
  int read;
  int spread;
} Noise;

Noise noisespread(int analogPin, int samples)
{
  Noise n;
  int read = 0;
  int prewread = analogRead(analogPin);
  int sum;
  int diff;
  for (int i = 0; i < samples; i++)
  {
    read = analogRead(analogPin);
    sum += read;
    diff += abs(prewread - read);
    prewread = read;
    // delay(20); // just to test the 50Hz noise. It will give different values with 5 and 20ms.
  }
  n.read = sum / samples;
  n.spread = diff / samples;
  return n;
}

int relayState;
int pot;

float filtered = 0;
float filteredTemp = 25;
float error;
float alpha = 0.01; // used by Expontential Moving Average (EMA)

String lastStatusJson;

float targetTemp = 110.0; // slider value
float currentTemp = 0.0;  // sensor reading

unsigned long turnOffAt = 0; // millis timestamp when action should occur
unsigned long totalOnTime = 0;

int pwm = 100;
int pwmLimit = 100;
unsigned long pwmPeriod = 60000;

int webControl = 0;

struct Sample
{
  float temp;
  int relay;
};
Sample history[600];
int historyCount = 0;
int histIndex = 0;
void addSample(float t, int relay)
{
  history[histIndex] = {t, relay};
  histIndex = (histIndex + 1) % 600;
  if (historyCount < 600)
    historyCount++;
}

void testing()
{
  Serial.print("Temperature: ");
  Serial.print(thermistor(34, 12, 100000, 19880, 3950, 25, 1000));
  Serial.print("C, potmeter read:");
  pot = potmeter(35, 50);
  Serial.print(pot);

  Serial.print(" out of 4095. Relay state:");
  if (relayState)
  {
    Serial.print("OFF");
    relayState = 0;
    digitalWrite(13, LOW);
  }
  else
  {
    Serial.print("ON");
    relayState = 1;
    digitalWrite(13, HIGH);
  }

  Serial.print(", \% of potmeter: ");
  Serial.print(map(pot, 0, 4095, 0, 100));
  Noise noise1;

  noise1 = noisespread(34, 30);
  Serial.print(", analogRead: ");
  Serial.print(noise1.read);
  Serial.print(". Average diff between reads: ");
  Serial.print(noise1.spread);
  filtered = (alpha * noise1.read) + ((1.0 - alpha) * filtered);
  Serial.print(" filtered read: ");
  Serial.print(filtered);

  Serial.print(", temp: ");
  Serial.println(filteredTemp);
}

// Create AsyncWebServer object on port 80
AsyncWebServer server(80);

AsyncWebSocket ws("/ws");

// Search for parameter in HTTP POST request
const char *PARAM_INPUT_1 = "ssid";
const char *PARAM_INPUT_2 = "pass";
const char *PARAM_INPUT_3 = "ip";
const char *PARAM_INPUT_4 = "gateway";

// Variables to save values from HTML form
String ssid;
String pass;
String ip;
String gateway;

// File paths to save input values permanently
const char *ssidPath = "/ssid.txt";
const char *passPath = "/pass.txt";
const char *ipPath = "/ip.txt";
const char *gatewayPath = "/gateway.txt";

IPAddress localIP;
// IPAddress localIP(192, 168, 1, 200); // hardcoded

// Set your Gateway IP address
IPAddress localGateway;
// IPAddress localGateway(192, 168, 1, 1); //hardcoded
IPAddress subnet(255, 255, 0, 0);

// Timer variables
unsigned long previousMillis = 0;
const long interval = 10000; // interval to wait for Wi-Fi connection (milliseconds)

// Initialize LittleFS
void initLittleFS()
{
  if (!LittleFS.begin(true))
  {
    Serial.println("An error has occurred while mounting LittleFS");
  }
  Serial.println("LittleFS mounted successfully");
}

void pwmToRelay(unsigned long periodMs, int pwmPercent, int heaterPin)
{
  static unsigned long periodStart = 0;
  static unsigned long onTime = 0;
  static unsigned long onTimeSum = 0;
  static int overshoot = 0;
  static int firstRun = 1;

  unsigned long now = millis();

  if (firstRun) // Make sure it runs at least once at startup, and doesnt lock the relay for the first period.
  {
    onTime = (periodMs * pwmPercent) / 100;
    firstRun = 0;
  }

  // Start a new period if needed
  if (now - periodStart >= periodMs)
  {
    periodStart = now;
    onTimeSum += onTime; // adding the onTime from the previous period to the sum

    // Calculate ON and OFF durations at the start of the new period
    onTime = (periodMs * pwmPercent) / 100;

    overshoot = 0;
  }

  unsigned long elapsed = now - periodStart;

  // Detect overshoot anytime and sets the relay off for the rest of the cycle
  if (onTime != 0 && pwmPercent == 0 && !overshoot)
  {
    onTime = elapsed;
    overshoot = 1;
  }

  // ON or OFF?
  if (elapsed < onTime)
  {
    digitalWrite(heaterPin, HIGH); // ON
    // digitalWrite(2, HIGH);
    relayState = 1;
    totalOnTime = onTimeSum + elapsed;
  }
  else
  {
    digitalWrite(heaterPin, LOW); // OFF
    // digitalWrite(2, LOW);
    relayState = 0;
  }
}

String historyBufferJson()
{
  String json = "[";

  int start;

  if (historyCount < 600)
    start = 0;
  else
    start = histIndex;

  for (int i = 0; i < historyCount; i++)
  {
    int idx = (start + i) % 600;

    json += "{\"temp\":";
    json += String(history[idx].temp, 2);
    json += ",\"relay\":";
    json += history[idx].relay;
    json += "}";

    if (i < historyCount - 1)
      json += ",";
  }

  json += "]";

  return json;
}

// Read File from LittleFS
String readFile(fs::FS &fs, const char *path)
{
  Serial.printf("Reading file: %s\r\n", path);

  File file = fs.open(path);
  if (!file || file.isDirectory())
  {
    Serial.println("- failed to open file for reading");
    return String();
  }

  String fileContent;
  while (file.available())
  {
    fileContent = file.readStringUntil('\n');
    break;
  }
  return fileContent;
}

// Write file to LittleFS
void writeFile(fs::FS &fs, const char *path, const char *message)
{
  Serial.printf("Writing file: %s\r\n", path);

  File file = fs.open(path, FILE_WRITE);
  if (!file)
  {
    Serial.println("- failed to open file for writing");
    return;
  }
  if (file.print(message))
  {
    Serial.println("- file written");
  }
  else
  {
    Serial.println("- write failed");
  }
}

// Initialize WiFi
bool initWiFi()
{
  if (ssid == "" || ip == "")
  {
    Serial.println("Undefined SSID or IP address.");
    return false;
  }

  WiFi.mode(WIFI_STA);
  localIP.fromString(ip.c_str());
  localGateway.fromString(gateway.c_str());

  if (!WiFi.config(localIP, localGateway, subnet))
  {
    Serial.println("STA Failed to configure");
    return false;
  }
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.println("Connecting to WiFi...");

  unsigned long currentMillis = millis();
  previousMillis = currentMillis;

  while (WiFi.status() != WL_CONNECTED)
  {
    currentMillis = millis();
    if (currentMillis - previousMillis >= interval)
    {
      Serial.println("Failed to connect.");
      return false;
    }
  }

  Serial.println(WiFi.localIP());
  return true;
}

void updateSliders()
{
  JsonDocument doc;

  doc["targettemp"] = targetTemp;
  doc["pwmlimit"] = pwmLimit;

  String json;
  serializeJson(doc, json);
  ws.textAll(json);
}

void handleWebSocketMessage(void *arg, uint8_t *data, size_t len)
{
  AwsFrameInfo *info = (AwsFrameInfo *)arg;

  if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT)
  {

    // Convert incoming bytes to a String
    String msg;
    msg.reserve(len);
    for (size_t i = 0; i < len; i++)
    {
      msg += (char)data[i];
    }

    // Parse JSON
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, msg);

    if (!error)
    {

      bool slidersChanged = false;

      if (doc["targettemp"].is<float>())
      {
        targetTemp = doc["targettemp"].as<float>();
        slidersChanged = true;
      }

      if (doc["pwmlimit"].is<int>())
      {
        pwmLimit = doc["pwmlimit"].as<int>();
        slidersChanged = true;
      }

      if (doc["turnoff"].is<int>())
      {
        int seconds = doc["turnoff"].as<int>();
        turnOffAt = millis() + (seconds * 1000);
      }

      if (slidersChanged)
      {
        // updateSliders();
        webControl = 1;
      }

      // Add more fields easily:
      // if (doc.containsKey("mode")) { mode = doc["mode"].as<int>(); }
    }
  }
}

// WebSocket Event Handler

void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
               AwsEventType type, void *arg, uint8_t *data, size_t len)
{

  if (type == WS_EVT_CONNECT)
  {
    Serial.println("WS client connected");
  }

  if (type == WS_EVT_DISCONNECT)
  {
    Serial.println("WS client disconnected");
  }

  if (type == WS_EVT_DATA)
  {
    handleWebSocketMessage(arg, data, len);
  }
}

void sendStatusJson()
{
  JsonDocument doc;

  doc["currenttemp"] = currentTemp;
  doc["targettemp"] = targetTemp;
  doc["pwm"] = pwm;
  doc["pwmlimit"] = pwmLimit;
  doc["relaystate"] = relayState;
  doc["currenttime"] = millis();
  doc["turnoffat"] = turnOffAt;
  doc["totalontime"] = totalOnTime;

  String json;
  serializeJson(doc, json);
  lastStatusJson = json;
  addSample(currentTemp, relayState);
  ws.textAll(json);
}

void setup()
{
  pinMode(34, INPUT);  // 100k thermistor + 20k resistor
  pinMode(35, INPUT);  // potmeter
  pinMode(13, OUTPUT); // relay control pin
  digitalWrite(13, LOW);
  relayState = 0;
  filteredTemp = thermistor(34, 12, 97700, 19880, 3950, 25, 100);
  Serial.begin(115200);

  initLittleFS();

  // Set GPIO 2 as an OUTPUT (LED)
  pinMode(2, OUTPUT);
  digitalWrite(2, LOW);

  // Load values saved in LittleFS
  ssid = readFile(LittleFS, ssidPath);
  pass = readFile(LittleFS, passPath);
  ip = readFile(LittleFS, ipPath);
  gateway = readFile(LittleFS, gatewayPath);
  Serial.println(ssid);
  Serial.println(pass);
  Serial.println(ip);
  Serial.println(gateway);

  if (initWiFi())
  {
    // ---------------------------
    // WebSocket
    // ---------------------------
    ws.onEvent(onWsEvent);
    server.addHandler(&ws);

    // Route for root / web page
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        AsyncWebServerResponse *response =
            request->beginResponse(LittleFS, "/index.html", "text/html");
        response->addHeader("Content-Type", "text/html; charset=utf-8");
        request->send(response); });

    server.serveStatic("/", LittleFS, "/");

    server.on("/manifest.json", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(LittleFS, "/manifest.json", "application/json"); });

    server.on("/status", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(200, "application/json", lastStatusJson); });

    server.on("/history", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(200, "application/json", historyBufferJson()); });

    server.on("/setOffTime", HTTP_GET, [](AsyncWebServerRequest *request)
              {
    if (request->hasParam("seconds")) {
        unsigned long seconds = request->getParam("seconds")->value().toInt();
        turnOffAt = millis() + seconds * 1000UL;

        Serial.println("Turn-off scheduled at: " + String(turnOffAt));
        request->send(200, "text/plain", "OK");
    } else {
        request->send(400, "text/plain", "Missing seconds parameter");
    } });

    // API: Set target temperature
    server.on("/setTemp", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        if (request->hasParam("value")) {
            targetTemp = request->getParam("value")->value().toFloat();
            Serial.println("New target temp: " + String(targetTemp));
            webControl = 1;
        }
        request->send(200, "text/plain", "OK"); });

    // API: Get initial target temperature
    server.on("/getTemp", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(200, "text/plain", String(targetTemp)); });

    server.begin();
  }
  else
  {
    // Connect to Wi-Fi network with SSID and password
    Serial.println("Setting AP (Access Point)");
    // NULL sets an open Access Point
    WiFi.softAP("ESP-WIFI-MANAGER", NULL);

    IPAddress IP = WiFi.softAPIP();
    Serial.print("AP IP address: ");
    Serial.println(IP);

    // Web Server Root URL
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(LittleFS, "/wifimanager.html", "text/html"); });

    server.serveStatic("/", LittleFS, "/");

    server.on("/", HTTP_POST, [](AsyncWebServerRequest *request)
              {
      int params = request->params();
      for(int i=0;i<params;i++){
        const AsyncWebParameter* p = request->getParam(i);
        if(p->isPost()){
          // HTTP POST ssid value
          if (p->name() == PARAM_INPUT_1) {
            ssid = p->value().c_str();
            Serial.print("SSID set to: ");
            Serial.println(ssid);
            // Write file to save value
            writeFile(LittleFS, ssidPath, ssid.c_str());
          }
          // HTTP POST pass value
          if (p->name() == PARAM_INPUT_2) {
            pass = p->value().c_str();
            Serial.print("Password set to: ");
            Serial.println(pass);
            // Write file to save value
            writeFile(LittleFS, passPath, pass.c_str());
          }
          // HTTP POST ip value
          if (p->name() == PARAM_INPUT_3) {
            ip = p->value().c_str();
            Serial.print("IP Address set to: ");
            Serial.println(ip);
            // Write file to save value
            writeFile(LittleFS, ipPath, ip.c_str());
          }
          // HTTP POST gateway value
          if (p->name() == PARAM_INPUT_4) {
            gateway = p->value().c_str();
            Serial.print("Gateway set to: ");
            Serial.println(gateway);
            // Write file to save value
            writeFile(LittleFS, gatewayPath, gateway.c_str());
          }
          //Serial.printf("POST[%s]: %s\n", p->name().c_str(), p->value().c_str());
        }
      }
      request->send(200, "text/plain", "Done. ESP will restart, connect to your router and go to IP address: " + ip);
      delay(3000);
      ESP.restart(); });
    server.begin();
  }
}

void loop()
{
  filteredTemp = (alpha * thermistor(34, 12, 97700, 19880, 3950, 25, 100)) + ((1.0 - alpha) * filteredTemp);

  if (!webControl)
  {
    pot = potmeter(35, 50);
    pwmLimit = map(pot, 0, 4095, 0, 100);
    pwm = constrain(100, 0, pwmLimit);
  }
  else
  {
    error = targetTemp - filteredTemp;
    if (error >= 0)
      pwm = constrain(error * 5 + constrain(targetTemp - 25, 0, 100) / 30, 0, pwmLimit);
    else
      pwm = 0;
  }

  static unsigned long lastStatSend = 0;

  // Push temperature every 1 second(s)
  if (millis() - lastStatSend > 1000)
  {
    lastStatSend = millis();
    currentTemp = filteredTemp;
    // Send current stats
    sendStatusJson();
  }

  ws.cleanupClients();

  if (turnOffAt > 0 && millis() >= turnOffAt)
  {
    Serial.println("Turn-off time reached!");

    targetTemp = 0.0;

    turnOffAt = 0; // reset so it doesn't repeat
  }

  pwmToRelay(pwmPeriod, pwm, 13);
}

// 19880 ohm series resistor