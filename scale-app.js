/* UI state is separate from hardware transport and measurement parsing. */
(function () {
  "use strict";
  const core = window.ScaleCore;
  const $ = (id) => document.getElementById(id);
  const state = {
    transport: "usb",
    status: "disconnected",
    adapter: null,
    records: [],
    latest: null,
    tare: 0,
    invalid: 0,
    source: "",
    demoTimer: null,
    token: 0,
    lang: "en",
    events: [],
    packet: "",
    pending: [],
  };
  const translations = {
    Disconnected: "غير متصل",
    Connecting: "جارٍ الاتصال",
    Connected: "متصل",
    Error: "خطأ",
    "DEMO · simulated": "محاكاة · ليست قياسات حقيقية",
    "No physical scale connected": "لا يوجد ميزان فعلي متصل",
    "No readings yet": "لا توجد قراءات بعد",
    "Waiting for a device": "في انتظار جهاز",
    "Connected · waiting for a valid reading": "متصل · في انتظار قراءة صالحة",
    "Last reading · disconnected": "آخر قراءة · الاتصال مقطوع",
    "Simulated readings — not a physical scale":
      "قراءات محاكاة — ليس ميزاناً فعلياً",
    "Stability not supplied by device": "لم يرسل الجهاز حالة ثبات",
    "Device reports stable": "الجهاز يبلغ عن قراءة ثابتة",
    "Device reports unstable": "الجهاز يبلغ عن قراءة غير ثابتة",
    "Try demo": "جرّب المحاكاة",
    "Stop demo": "أوقف المحاكاة",
    "No data for 5 seconds · check the scale":
      "لا توجد بيانات منذ 5 ثوانٍ · افحص الميزان",
  };
  const t = (value) =>
    state.lang === "ar" && translations[value] ? translations[value] : value;
  function log(message) {
    state.events.push(new Date().toLocaleTimeString() + "  " + message);
    state.events = state.events.slice(-30);
    $("log").textContent = state.events.join("\n");
  }
  function message(text, error = false) {
    $("message").textContent = text;
    $("message").classList.toggle("error", error);
  }
  function capabilityBanner() {
    const serial = window.isSecureContext && "serial" in navigator;
    const ble = window.isSecureContext && "bluetooth" in navigator;
    const embedded = window.self !== window.top;
    const en = `Laptop capabilities: USB serial ${serial ? "available" : "unavailable"} · Bluetooth LE ${ble ? "available" : "unavailable"} · Wi-Fi via endpoint. ${embedded ? "Open the actual website in a browser tab for hardware permissions; embedded previews may block access." : "Browser permission and compatible firmware are still required."}`;
    const ar = `قدرات الحاسوب: USB ${serial ? "متاح" : "غير متاح"} · Bluetooth LE ${ble ? "متاح" : "غير متاح"} · Wi-Fi عبر عنوان بيانات. ${embedded ? "افتح الموقع في تبويب مستقل لمنح إذن الأجهزة؛ قد تمنع المعاينة المضمنة الاتصال." : "يلزم إذن المتصفح وبرنامج جهاز متوافق."}`;
    $("compatibility").textContent = state.lang === "ar" ? ar : en;
    $("compatibility").classList.toggle("warning", !serial || !ble || embedded);
  }
  function applySelection() {
    const locked =
      state.status === "connecting" ||
      state.status === "connected" ||
      state.status === "demo";
    document.querySelectorAll("[data-transport]").forEach((button) => {
      const selected = button.dataset.transport === state.transport;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.disabled = locked;
    });
    ["usb", "wifi", "ble"].forEach((transport) => {
      const panel = $("settings-" + transport);
      panel.hidden = transport !== state.transport;
      panel.querySelectorAll("input,select").forEach((input) => {
        input.disabled = transport !== state.transport;
      });
    });
    $("connection-fields").disabled = locked;
    $("connect").disabled = locked;
    $("disconnect").disabled = !locked;
    $("demo").disabled =
      state.status === "connecting" || state.status === "connected";
    $("demo").textContent = t(
      state.status === "demo" ? "Stop demo" : "Try demo",
    );
    const http = $("network-mode").value === "http";
    $("poll-field").hidden = !http;
    $("poll-ms").disabled = !http || state.transport !== "wifi";
    $("ws-field").hidden = http;
    $("ws-framing").disabled = http || state.transport !== "wifi";
    $("endpoint").required = state.transport === "wifi";
    $("endpoint").placeholder = http
      ? "https://scale.example/weight"
      : "wss://scale.example/weights";
    const standard =
      state.transport === "ble" && $("ble-preset").value === "standard";
    document.querySelector(".format-settings").hidden = standard;
    $("ble-framing").disabled = standard || state.transport !== "ble";
  }
  function render() {
    const labels = {
      disconnected: "Disconnected",
      connecting: "Connecting",
      connected: "Connected",
      error: "Error",
      demo: "DEMO · simulated",
    };
    $("status").dataset.state = state.status;
    $("status").textContent = t(labels[state.status]);
    $("source").textContent = state.source || t("No physical scale connected");
    $("reading-count").textContent = String(state.records.length);
    $("invalid-count").textContent = String(state.invalid);
    const unit = $("display-unit").value;
    const format = (grams) => {
      const value = grams / core.UNITS[unit];
      if (Math.abs(value) > 1e9) return value.toExponential(4);
      return value.toFixed(
        unit === "kg" || unit === "lb" ? 4 : unit === "mg" ? 1 : 3,
      );
    };
    $("tare-value").textContent = format(state.tare) + " " + unit;
    $("weight").textContent = state.latest
      ? format(state.latest.grams - state.tare)
      : "—";
    $("gross").textContent = state.latest
      ? format(state.latest.grams) + " " + unit
      : "—";
    const active = state.status === "connected" || state.status === "demo";
    const fresh =
      state.latest && Date.now() - state.latest.time < staleThreshold();
    $("tare").disabled = !(active && fresh);
    $("reset-tare").disabled = state.tare === 0;
    $("export").disabled = state.records.length === 0;
    $("clear").disabled = state.records.length === 0 && !state.latest;
    let measurementText = "Waiting for a device";
    if (state.status === "demo")
      measurementText = "Simulated readings — not a physical scale";
    else if (state.status === "connected") {
      if (state.latest && !fresh)
        measurementText = "No data for 5 seconds · check the scale";
      else if (
        !state.latest &&
        state.connectedAt &&
        Date.now() - state.connectedAt > staleThreshold()
      )
        measurementText = "No data for 5 seconds · check the scale";
      else if (!state.latest)
        measurementText = "Connected · waiting for a valid reading";
      else
        measurementText =
          state.latest.stable === null
            ? "Stability not supplied by device"
            : state.latest.stable
              ? "Device reports stable"
              : "Device reports unstable";
    } else if (state.latest) measurementText = "Last reading · disconnected";
    // Custom polling rates get a matching stale threshold; text remains accurate.
    if (measurementText.startsWith("No data") && staleThreshold() !== 5000)
      measurementText = `No data for ${staleThreshold() / 1000} seconds · check the scale`;
    $("measurement-state").textContent = t(measurementText);
    $("measurement-state").classList.toggle(
      "stale",
      state.status !== "demo" &&
        ((state.latest && !fresh) || measurementText.startsWith("No data")),
    );
    $("last-updated").textContent = state.latest
      ? new Date(state.latest.time).toLocaleTimeString()
      : t("No readings yet");
    applySelection();
  }
  function staleThreshold() {
    return state.transport === "wifi" && $("network-mode").value === "http"
      ? Math.max(5000, Number($("poll-ms").value) * 3)
      : 5000;
  }
  function clearSession() {
    state.records = [];
    state.latest = null;
    state.tare = 0;
    state.invalid = 0;
    state.packet = "";
    $("last-packet").textContent = "—";
    render();
    draw();
  }
  function invalid(reason) {
    state.invalid += 1;
    $("invalid-count").textContent = String(state.invalid);
    if (state.invalid <= 3 || state.invalid % 25 === 0) {
      log("Ignored packet: " + reason);
      message("Packet ignored: " + reason, true);
    }
  }
  function record(reading, raw) {
    state.packet = String(raw).slice(0, 300);
    $("last-packet").textContent = state.packet;
    const time = Date.now();
    state.latest = { ...reading, time };
    if (state.records.length < 10000)
      state.records.push({
        time,
        gross: reading.grams,
        tare: state.tare,
        net: reading.grams - state.tare,
        source: state.source,
        transport: state.status === "demo" ? "demo" : state.transport,
        stable: reading.stable,
      });
    else if (!state.capacityWarned) {
      state.capacityWarned = true;
      log(
        "10,000-reading storage limit reached. Live display continues; export and clear to record more.",
      );
      message(
        "Session storage is full (10,000 readings). Export and clear to resume recording.",
      );
    }
    render();
    draw();
  }
  function onData(text) {
    state.packet = String(text).slice(0, 300);
    $("last-packet").textContent = state.packet;
    try {
      record(
        core.parseWeight(text, {
          format: $("format").value,
          unit: $("input-unit").value,
          key: $("json-key").value.trim(),
        }),
        text,
      );
    } catch (error) {
      invalid(error.message);
    }
  }
  function routeEvent(token, type, ...args) {
    if (token !== state.token) return;
    if (state.status === "connecting" && type !== "close") {
      if (state.pending.length < 240) state.pending.push({ type, args });
      return;
    }
    if (type === "data") onData(args[0]);
    if (type === "reading") record(args[0], args[1]);
    if (type === "invalid") invalid(args[0]);
    if (type === "close") {
      const adapter = state.adapter;
      state.token += 1;
      state.adapter = null;
      state.status = "disconnected";
      message(args[0], true);
      log(args[0]);
      render();
      if (adapter)
        adapter.disconnect().catch((error) => log("Cleanup: " + error.message));
    }
  }
  function settings() {
    if (state.transport === "usb") {
      const baud = Number($("baud").value);
      if (!Number.isInteger(baud) || baud < 300 || baud > 4000000)
        throw new Error(
          "Baud rate must be an integer between 300 and 4,000,000.",
        );
      return {
        baudRate: baud,
        dataBits: Number($("data-bits").value),
        stopBits: Number($("stop-bits").value),
        parity: $("parity").value,
        flowControl: $("flow").value,
      };
    }
    if (state.transport === "ble")
      return {
        service: $("ble-service").value.trim(),
        characteristic: $("ble-characteristic").value.trim(),
        framing: $("ble-framing").value,
        standard: $("ble-preset").value === "standard",
      };
    const interval = Number($("poll-ms").value);
    if (
      $("network-mode").value === "http" &&
      (!Number.isFinite(interval) || interval < 250 || interval > 60000)
    )
      throw new Error("Polling interval must be between 250 and 60,000 ms.");
    return {
      endpoint: $("endpoint").value.trim(),
      interval,
      framing: $("ws-framing").value,
    };
  }
  $("connection-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.adapter || state.status === "demo") return;
    let config;
    try {
      config = settings();
    } catch (error) {
      message(error.message, true);
      return;
    }
    const token = ++state.token;
    const callbacks = {
      onData: (text) => routeEvent(token, "data", text),
      onReading: (reading, raw) => routeEvent(token, "reading", reading, raw),
      onInvalid: (reason) => routeEvent(token, "invalid", reason),
      onClose: (reason) => routeEvent(token, "close", reason),
    };
    const Constructor =
      state.transport === "usb"
        ? core.SerialTransport
        : state.transport === "ble"
          ? core.BluetoothTransport
          : $("network-mode").value === "http"
            ? core.HttpTransport
            : core.WebSocketTransport;
    const adapter = (state.adapter = new Constructor(config, callbacks));
    state.status = "connecting";
    state.pending = [];
    render();
    message("Select your device or wait for the endpoint.");
    log("Connecting: " + state.transport);
    // Device choosers must be called within this click/submit gesture, before any unrelated await.
    let connectPromise;
    try {
      connectPromise = adapter.connect();
    } catch (error) {
      connectPromise = Promise.reject(error);
    }
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Connection timed out. Check the device and permissions, then try again.",
            ),
          ),
        25000,
      );
    });
    Promise.race([connectPromise, deadline])
      .then((source) => {
        if (token !== state.token || adapter.closed) return;
        state.status = "connected";
        state.source = source;
        state.connectedAt = Date.now();
        state.capacityWarned = false;
        const pending = state.pending;
        state.pending = [];
        clearSession();
        pending.forEach((event) =>
          routeEvent(token, event.type, ...event.args),
        );
        message("Connected. Waiting for measurements in your selected format.");
        log("Connected: " + source);
        render();
      })
      .catch(async (error) => {
        await adapter.disconnect().catch(() => {});
        if (token !== state.token) return;
        state.token += 1;
        state.adapter = null;
        state.status = "error";
        state.pending = [];
        const cancelled =
          error.name === "NotFoundError" ||
          error.message === "Connection cancelled.";
        message(
          cancelled
            ? "Device selection cancelled. No scale connected."
            : error.message,
          !cancelled,
        );
        log(error.message);
        render();
      })
      .finally(() => clearTimeout(timeout));
  });
  async function disconnect() {
    ++state.token;
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
    }
    const adapter = state.adapter;
    state.adapter = null;
    state.status = "disconnected";
    state.pending = [];
    render();
    message("Disconnected. Captured readings remain available for CSV export.");
    log("Disconnected by user.");
    if (adapter) {
      try {
        await adapter.disconnect();
      } catch (error) {
        message("Disconnected; cleanup reported: " + error.message, true);
      }
    }
  }
  $("disconnect").addEventListener("click", disconnect);
  document.querySelectorAll("[data-transport]").forEach((button) => {
    button.addEventListener("click", () => {
      state.transport = button.dataset.transport;
      applySelection();
      capabilityBanner();
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const tabs = Array.from(document.querySelectorAll("[data-transport]"));
      const index = tabs.indexOf(button);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      tabs[next].click();
      tabs[next].focus();
    });
  });
  $("network-mode").addEventListener("change", applySelection);
  $("ble-preset").addEventListener("change", () => {
    if ($("ble-preset").value === "standard") {
      $("ble-service").value = "0x181d";
      $("ble-characteristic").value = "0x2a9d";
    } else if ($("ble-preset").value === "uart") {
      $("ble-service").value = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
      $("ble-characteristic").value = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
    }
    applySelection();
  });
  ["ble-service", "ble-characteristic"].forEach((id) =>
    $(id).addEventListener("input", () => {
      $("ble-preset").value = "custom";
      applySelection();
    }),
  );
  $("display-unit").addEventListener("change", render);
  $("tare").addEventListener("click", () => {
    if (state.latest) {
      state.tare = state.latest.grams;
      render();
      log(
        "Software tare set to " + state.tare + " g; no command sent to device.",
      );
    }
  });
  $("reset-tare").addEventListener("click", () => {
    state.tare = 0;
    render();
    log("Software tare reset.");
  });
  $("clear").addEventListener("click", () => {
    state.capacityWarned = false;
    clearSession();
    log("Session cleared; connection unchanged.");
    message("Session cleared. Software tare reset.");
  });
  $("demo").addEventListener("click", () => {
    if (state.status === "demo") {
      disconnect();
      return;
    }
    if (state.adapter) return;
    state.status = "demo";
    state.source = "DEMO · simulated";
    state.capacityWarned = false;
    clearSession();
    log("DEMO started. Generated samples are not physical measurements.");
    message("DEMO ONLY — simulated readings; no hardware connected.");
    const start = Date.now();
    const tick = () =>
      record(
        {
          grams: 250 + 12 * Math.sin((Date.now() - start) / 2500),
          stable: null,
          inputValue: 250,
          inputUnit: "g",
        },
        "SIMULATED",
      );
    tick();
    state.demoTimer = setInterval(tick, 500);
    render();
  });
  function csvCell(value) {
    let text = value === null ? "" : String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text))
      text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  $("export").addEventListener("click", () => {
    const rows = [
      [
        "timestamp_utc",
        "source",
        "transport",
        "gross_g",
        "software_tare_g",
        "net_g",
        "device_stable",
      ],
    ];
    state.records.forEach((row) =>
      rows.push([
        new Date(row.time).toISOString(),
        row.source,
        row.transport,
        row.gross,
        row.tare,
        row.net,
        row.stable,
      ]),
    );
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv + "\r\n"], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      "weightlab-" +
      (state.records.every((row) => row.transport === "demo") ? "DEMO-" : "") +
      new Date().toISOString().replace(/[:.]/g, "-") +
      ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    log("CSV exported: " + state.records.length + " readings.");
  });
  function draw() {
    const canvas = $("chart");
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.clientWidth || 600,
      height = canvas.clientHeight || 210,
      ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    const points = state.records.slice(-240);
    $("chart-empty").hidden = points.length > 0;
    const left = 65,
      right = width - 14,
      top = 12,
      bottom = height - 27;
    const values = points.map((point) => point.net);
    let min = points.length ? Math.min(...values) : 0,
      max = points.length ? Math.max(...values) : 100;
    const padding = Math.max((max - min) * 0.15, 0.5);
    min -= padding;
    max += padding;
    context.font = "10px ui-monospace, monospace";
    context.textAlign = "right";
    context.strokeStyle = "#203750";
    context.fillStyle = "#9eb1c8";
    for (let i = 0; i < 5; i++) {
      const y = top + ((bottom - top) * i) / 4;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(right, y);
      context.stroke();
      const value = max - ((max - min) * i) / 4;
      context.fillText(
        Math.abs(value) > 999999 ? value.toExponential(1) : value.toFixed(1),
        left - 8,
        y + 3,
      );
    }
    if (points.length) {
      const start = points[0].time,
        end = points[points.length - 1].time;
      context.strokeStyle =
        state.status === "demo" || points.every((p) => p.transport === "demo")
          ? "#ffd18a"
          : "#60e5e8";
      context.lineWidth = 2;
      context.beginPath();
      points.forEach((point, index) => {
        const x =
          left +
          (right - left) *
            (end === start ? 0.5 : (point.time - start) / (end - start));
        const y = bottom - ((bottom - top) * (point.net - min)) / (max - min);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      if (points.length === 1) {
        context.beginPath();
        context.arc((left + right) / 2, (top + bottom) / 2, 3, 0, Math.PI * 2);
        context.fillStyle = "#60e5e8";
        context.fill();
      }
      context.fillStyle = "#9eb1c8";
      context.textAlign = "left";
      context.fillText(new Date(start).toLocaleTimeString(), left, height - 8);
      context.textAlign = "right";
      context.fillText(new Date(end).toLocaleTimeString(), right, height - 8);
    }
  }
  function language(lang) {
    state.lang = lang === "ar" ? "ar" : "en";
    document.documentElement.lang = state.lang;
    document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
    document.querySelectorAll("[data-en][data-ar]").forEach((element) => {
      element.textContent = element.dataset[state.lang];
    });
    $("language").textContent = state.lang === "ar" ? "English" : "العربية";
    try {
      localStorage.setItem("weightlab-language", state.lang);
    } catch (_) {
      /* Storage may be blocked in embedded preview. */
    }
    capabilityBanner();
    render();
  }
  $("language").addEventListener("click", () =>
    language(state.lang === "en" ? "ar" : "en"),
  );
  window.addEventListener("resize", draw);
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      capabilityBanner();
      render();
      draw();
    }
  });
  let initialLanguage = "en";
  try {
    initialLanguage = localStorage.getItem("weightlab-language") || "en";
  } catch (_) {
    /* Optional preference only. */
  }
  language(initialLanguage);
  draw();
  setInterval(render, 1000);
  log("Ready. Hardware connections require your permission.");
})();
