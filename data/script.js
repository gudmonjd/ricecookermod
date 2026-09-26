let lastStatus = {
    currenttemp: null,
    targettemp: null,
    pwm: null,
    pwmlimit: null,
    relaystate: null,
    currenttime: null,
    turnoffat: null,
    totalontime: null,
    controlmode: null
};

let graphData = {
    times: [],
    temps: [],
    relays: []
};

let tempChart = null;

// Slider interaction locks to prevent jitter during polling
let lastTargetInteraction = 0;
let lastPwmInteraction = 0;
const SLIDER_COOLDOWN_MS = 2500;

function initChartJs() {
    const canvas = document.getElementById("tempGraph");

    tempChart = new Chart(canvas.getContext("2d"), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Temperature',
                    data: [],
                    borderColor: '#60a5fa',
                    borderWidth: 2,
                    tension: 0.2
                },
                {
                    label: 'Burner',
                    data: [],
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239,68,68,0.2)',
                    fill: true,
                    stepped: true,
                    tension: 0,
                    yAxisID: 'relayAxis'
                }
            ]
        },
        options: {
            responsive: true,
            animation: false,
            scales: {
                x: { display: false },
                y: {
                    suggestedMin: (lastStatus.currenttemp ?? 25) - 2.5,
                    suggestedMax: (lastStatus.currenttemp ?? 25) + 2.5
                },
                relayAxis: {
                    position: 'right',
                    min: 0,
                    max: 5,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
}

if (chartJsAvailable) {
    initChartJs();
}

// Polling setup
let pollInterval = null;
const POLL_RATE_MS = 1000;

function startPolling() {
    fetchStatus(); // Fetch immediately on load
    pollInterval = setInterval(fetchStatus, POLL_RATE_MS);
}

async function fetchStatus() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
        const response = await fetch('/status', {
            cache: 'no-store',
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        handleStatusJson(data);
        updateConnectionStatus(true);
    } catch (err) {
        clearTimeout(timeoutId);
        updateConnectionStatus(false);
    }
}

function updateConnectionStatus(isOnline) {
    let modeEl = document.getElementById("controlMode");
    if (!modeEl) return;

    if (!isOnline) {
        modeEl.innerText = "Offline (Reconnecting...)";
        modeEl.style.color = "#ef4444"; // Red indicator
    } else {
        modeEl.style.color = ""; // Reset to default styling
    }
}

// Handle incoming status JSON
function handleStatusJson(data) {
    lastStatus = { ...lastStatus, ...data };
    const now = Date.now();

    // TEMPERATURE & TARGET SLIDER
    if (data.currenttemp !== undefined) {
        document.getElementById("currentTemp").innerText = data.currenttemp.toFixed(1);
    }
    if (data.targettemp !== undefined) {
        const targetSlider = document.getElementById("targetTempSlider");
        if (document.activeElement !== targetSlider && (now - lastTargetInteraction > SLIDER_COOLDOWN_MS)) {
            targetSlider.value = data.targettemp;
            document.getElementById("targetTempDisplay").innerText = data.targettemp.toFixed(1);
        }
    }

    // BURNER & PWM LIMIT SLIDER
    if (data.pwm !== undefined) {
        document.getElementById("pwmValue").innerText = data.pwm;
    }
    if (data.pwmlimit !== undefined) {
        const pwmSlider = document.getElementById("pwmLimitSlider");
        if (document.activeElement !== pwmSlider && (now - lastPwmInteraction > SLIDER_COOLDOWN_MS)) {
            pwmSlider.value = data.pwmlimit;
            document.getElementById("pwmLimitDisplay").innerText = data.pwmlimit;
        }
    }

    if (data.relaystate !== undefined) {
        const badge = document.getElementById("relayStateBadge");
        if (data.relaystate) {
            badge.textContent = "ON";
            badge.classList.remove("badge-off");
            badge.classList.add("badge-on");
        } else {
            badge.textContent = "OFF";
            badge.classList.remove("badge-on");
            badge.classList.add("badge-off");
        }
        const flame = document.getElementById("burnerIcon");

        if (data.relaystate) {
            flame.classList.add("flame-on");
        } else {
            flame.classList.remove("flame-on");
        }
    }

    // STATS
    if (data.currenttime !== undefined) {
        document.getElementById("elapsedTime").innerText = msToHMS(data.currenttime);
    }
    if (data.totalontime !== undefined) {
        document.getElementById("totalOnTime").innerText = Math.floor(data.totalontime / 1000);
    }
    if (data.controlmode !== undefined) {
        const modeEl = document.getElementById("controlMode");
        if (modeEl.style.color !== "rgb(239, 68, 68)") {
            if (String(data.controlmode) === "0") {
                modeEl.innerText = "Hardware";
            } else if (String(data.controlmode) === "1") {
                modeEl.innerText = "Web app";
            }
        }
    }

    // TIMER
    updateTimerDisplay();

    // GRAPH
    updateGraph(data);
}

// TIMER display logic
function updateTimerDisplay() {
    const ct = lastStatus.currenttime;
    const to = lastStatus.turnoffat;

    const countdownEl = document.getElementById("turnOffCountdown");
    const absoluteEl = document.getElementById("turnOffAbsolute");

    if (!ct || !to || to <= 0) {
        countdownEl.textContent = "--:--:--";
        absoluteEl.textContent = "--:--";
        return;
    }

    const remainingMs = to - ct;
    if (remainingMs <= 0) {
        countdownEl.textContent = "00:00:00";
        absoluteEl.textContent = "--:--";
        return;
    }

    countdownEl.textContent = msToHMS(remainingMs);

    const now = new Date();
    const offDate = new Date(now.getTime() + remainingMs);
    const hh = String(offDate.getHours()).padStart(2, "0");
    const mm = String(offDate.getMinutes()).padStart(2, "0");
    absoluteEl.textContent = `${hh}:${mm}`;
}

function msToHMS(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// GRAPH update routing
function updateGraph(data) {
    if (chartJsAvailable && tempChart) {
        updateChartJs(data);
    } else {
        updateOfflineGraph(data);
    }
}

function updateChartJs(data) {
    const temp = data.currenttemp ?? lastStatus.currenttemp;
    const relay = data.relaystate ?? lastStatus.relaystate;

    if (temp == null) return;

    tempChart.data.labels.push("");
    tempChart.data.datasets[0].data.push(temp);
    tempChart.data.datasets[1].data.push(relay ? 1 : 0);

    if (tempChart.data.labels.length > 600) {
        tempChart.data.labels.shift();
        tempChart.data.datasets[0].data.shift();
        tempChart.data.datasets[1].data.shift();
    }

    const arr = tempChart.data.datasets[0].data;
    if (arr.length > 0) {
        const minVal = Math.min(...arr);
        const maxVal = Math.max(...arr);

        tempChart.options.scales.y.min = minVal - 2.5;
        tempChart.options.scales.y.max = maxVal + 2.5;
    }

    tempChart.update();
}

function updateOfflineGraph(data) {
    const t = data.currenttime !== undefined ? data.currenttime : lastStatus.currenttime;
    const temp = data.currenttemp !== undefined ? data.currenttemp : lastStatus.currenttemp;
    const relay = data.relaystate !== undefined ? data.relaystate : lastStatus.relaystate;

    if (t == null || temp == null) return;

    graphData.times.push(t);
    graphData.temps.push(temp);
    graphData.relays.push(relay ? 1 : 0);

    if (graphData.times.length > 600) {
        graphData.times.shift();
        graphData.temps.shift();
        graphData.relays.shift();
    }

    drawOfflineGraph();
}

function drawOfflineGraph() {
    resizeCanvas();

    const canvas = document.getElementById("tempGraph");
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (graphData.times.length < 2) return;

    const minT = Math.min(...graphData.temps);
    const maxT = Math.max(...graphData.temps);
    const rangeT = maxT - minT || 1;

    const w = canvas.width;
    const h = canvas.height;

    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 2;
    ctx.beginPath();

    graphData.temps.forEach((val, i) => {
        const x = (i / (graphData.temps.length - 1)) * w;
        const y = h - ((val - minT) / rangeT) * (h - 10) - 5;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });

    ctx.stroke();

    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    graphData.relays.forEach((val, i) => {
        const x = (i / (graphData.relays.length - 1)) * w;
        const y = h - 2;

        if (val === 1) {
            ctx.moveTo(x, y);
            ctx.lineTo(x, y - 10);
        }
    });

    ctx.stroke();
}

// UI events using HTTP GET endpoints and smooth input/change handling
function initUI() {
    const targetSlider = document.getElementById("targetTempSlider");
    const pwmSlider = document.getElementById("pwmLimitSlider");
    const setTimerBtn = document.getElementById("setTimerBtn");

    // Target Temp Slider handlers
    targetSlider.addEventListener("input", (e) => {
        lastTargetInteraction = Date.now();
        const val = parseFloat(e.target.value);
        document.getElementById("targetTempDisplay").innerText = val.toFixed(1);
    });

    targetSlider.addEventListener("change", (e) => {
        lastTargetInteraction = Date.now();
        const val = parseFloat(e.target.value);
        fetch(`/setTemp?value=${val}`).catch(err => console.log("Failed to set temp:", err));
    });

    // PWM Limit Slider handlers
    pwmSlider.addEventListener("input", (e) => {
        lastPwmInteraction = Date.now();
        const val = parseInt(e.target.value, 10);
        document.getElementById("pwmLimitDisplay").innerText = val;
    });

    pwmSlider.addEventListener("change", (e) => {
        lastPwmInteraction = Date.now();
        const val = parseInt(e.target.value, 10);
        fetch(`/setPwmLimit?value=${val}`).catch(err => console.log("Failed to set PWM limit:", err));
    });

    // Countdown Timer Button handler
    setTimerBtn.addEventListener("click", () => {
        const hours = parseInt(document.getElementById("hoursSelect").value, 10);
        const minutes = parseInt(document.getElementById("minutesSelect").value, 10);
        const totalSeconds = hours * 3600 + minutes * 60;
        if (totalSeconds > 0) {
            fetch(`/setOffTime?seconds=${totalSeconds}`).catch(err => console.log("Failed to set timer:", err));
        }
    });
}

function resizeCanvas() {
    if (chartJsAvailable && tempChart) return;
    const canvas = document.getElementById("tempGraph");
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
}

async function loadHistory() {
    try {
        const response = await fetch("/history");

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const history = await response.json();

        if (!Array.isArray(history) || history.length === 0) {
            return;
        }

        if (chartJsAvailable && tempChart) {
            tempChart.data.labels = history.map(() => "");
            tempChart.data.datasets[0].data = history.map(sample => sample.temp);
            tempChart.data.datasets[1].data = history.map(sample => sample.relay ? 1 : 0);

            const temps = history.map(sample => sample.temp);
            const minVal = Math.min(...temps);
            const maxVal = Math.max(...temps);

            tempChart.options.scales.y.min = minVal - 2.5;
            tempChart.options.scales.y.max = maxVal + 2.5;

            tempChart.update();
        }

        graphData.times = history.map(() => 0);
        graphData.temps = history.map(sample => sample.temp);
        graphData.relays = history.map(sample => sample.relay ? 1 : 0);

        if (!chartJsAvailable) {
            drawOfflineGraph();
        }

    } catch (e) {
        console.log("Failed to load history:", e);
    }
}

window.addEventListener("load", () => {
    initUI();
    loadHistory();
    startPolling();
});

window.addEventListener("resize", () => {
    if (chartJsAvailable && tempChart) {
        tempChart.resize();
    } else {
        resizeCanvas();
        drawOfflineGraph();
    }
});