let ws = null;
let reconnectTimer = null;

let lastStatus = {
    currenttemp: null,
    targettemp: null,
    pwm: null,
    pwmlimit: null,
    relaystate: null,
    currenttime: null,
    turnoffat: null,
    totalontime: null
};

let graphData = {
    times: [],
    temps: [],
    relays: []
};

let tempChart = null;

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
                    backgroundColor: 'rgba(239,68,68,0.2)',     // red tint
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


function initWebSocket() {
    const url = `ws://${window.location.host}/ws`;
    ws = new WebSocket(url);

    ws.onopen = () => {
        console.log("WebSocket connected");
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };

    ws.onclose = () => {
        console.log("WebSocket closed, will reconnect...");
        reconnectTimer = setTimeout(initWebSocket, 3000);
    };

    ws.onerror = (e) => {
        console.log("WebSocket error:", e);
        ws.close();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleStatusJson(data);
        } catch (e) {
            console.log("JSON parse error:", e);
        }
    };
}

function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

// Handle incoming status JSON
function handleStatusJson(data) {
    // store last status
    lastStatus = { ...lastStatus, ...data };

    // TEMPERATURE
    if (data.currenttemp !== undefined) {
        document.getElementById("currentTemp").innerText = data.currenttemp.toFixed(1);
    }
    if (data.targettemp !== undefined) {
        document.getElementById("targetTempDisplay").innerText = data.targettemp.toFixed(1);
        document.getElementById("targetTempSlider").value = data.targettemp;
    }

    // BURNER
    if (data.pwm !== undefined) {
        document.getElementById("pwmValue").innerText = data.pwm;
    }
    if (data.pwmlimit !== undefined) {
        document.getElementById("pwmLimitDisplay").innerText = data.pwmlimit;
        document.getElementById("pwmLimitSlider").value = data.pwmlimit;
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
        document.getElementById("elapsedTime").innerText =
            msToHMS(data.currenttime);
    }
    if (data.totalontime !== undefined) {
        document.getElementById("totalOnTime").innerText =
            Math.floor(data.totalontime / 1000);
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

    // absolute time: browser time + remainingMs
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

// GRAPH with detection if chart.js could be loaded
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

    // Temperature
    tempChart.data.datasets[0].data.push(temp);

    // Relay (convert boolean → 0/1)
    tempChart.data.datasets[1].data.push(relay ? 1 : 0);

    // Keep last 200 points
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



// GRAPH (simple manual drawing), a fallback if there is no internet connection
function updateOfflineGraph(data) {
    resizeCanvas();
    const canvas = document.getElementById("tempGraph");
    const ctx = canvas.getContext("2d");

    const maxPoints = 600;

    const t = data.currenttime !== undefined ? data.currenttime : lastStatus.currenttime;
    const temp = data.currenttemp !== undefined ? data.currenttemp : lastStatus.currenttemp;
    const relay = data.relaystate !== undefined ? data.relaystate : lastStatus.relaystate;

    if (t == null || temp == null) return;

    graphData.times.push(t);
    graphData.temps.push(temp);
    graphData.relays.push(relay ? 1 : 0);

    if (graphData.times.length > maxPoints) {
        graphData.times.shift();
        graphData.temps.shift();
        graphData.relays.shift();
    }

    // clear
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (graphData.times.length < 2) return;

    const minT = Math.min(...graphData.temps);
    const maxT = Math.max(...graphData.temps);
    const rangeT = maxT - minT || 1;

    const w = canvas.width;
    const h = canvas.height;

    // temp line
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

    // relay state as bars at bottom
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

// UI events
function initUI() {
    const targetSlider = document.getElementById("targetTempSlider");
    const pwmSlider = document.getElementById("pwmLimitSlider");
    const setTimerBtn = document.getElementById("setTimerBtn");

    targetSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById("targetTempDisplay").innerText = val.toFixed(1);
        sendJson({ targettemp: val });
    });

    pwmSlider.addEventListener("input", (e) => {
        const val = parseInt(e.target.value, 10);
        document.getElementById("pwmLimitDisplay").innerText = val;
        sendJson({ pwmlimit: val });
    });

    setTimerBtn.addEventListener("click", () => {
        const hours = parseInt(document.getElementById("hoursSelect").value, 10);
        const minutes = parseInt(document.getElementById("minutesSelect").value, 10);
        const totalSeconds = hours * 3600 + minutes * 60;
        if (totalSeconds > 0) {
            sendJson({ turnoff: totalSeconds }); // you can adapt to your cpp expectation
        }
    });
}

function resizeCanvas() {
    const canvas = document.getElementById("tempGraph");
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width;
    canvas.height = rect.height;
}


window.addEventListener("load", () => {
    initWebSocket();
    initUI();
});

window.addEventListener("resize", () => {
    if (tempChart) tempChart.resize();
});

window.addEventListener("resize", () => {
    if (!chartJsAvailable) {
        resizeCanvas();
    }
});
