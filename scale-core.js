/* Shared parsing and transport adapters. No readings are invented here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScaleCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MAX_PACKET = 16384;
  const UNITS = Object.freeze({
    g: 1,
    kg: 1000,
    mg: 0.001,
    lb: 453.59237,
    oz: 28.349523125,
  });
  const numericPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  function normalizeUnit(unit) {
    const aliases = {
      gram: "g",
      grams: "g",
      kilogram: "kg",
      kilograms: "kg",
      lbs: "lb",
      pound: "lb",
      pounds: "lb",
      ounces: "oz",
    };
    const key = String(unit).trim().toLowerCase();
    const normalized = aliases[key] || key;
    if (!Object.hasOwn(UNITS, normalized))
      throw new Error("Unsupported unit: " + key);
    return normalized;
  }
  function number(value) {
    if (
      typeof value !== "number" &&
      (typeof value !== "string" || !numericPattern.test(value.trim()))
    )
      throw new Error("Weight must be a finite number.");
    const result = Number(value);
    if (!Number.isFinite(result))
      throw new Error("Weight must be a finite number.");
    return result;
  }
  function field(object, path) {
    return path
      .split(".")
      .reduce(
        (current, key) =>
          current && typeof current === "object" && Object.hasOwn(current, key)
            ? current[key]
            : undefined,
        object,
      );
  }
  function parseWeight(input, options = {}) {
    let value,
      unit = options.unit || "g",
      stable = null;
    const format = options.format || "auto";
    if (typeof input === "string") {
      if (input.length > MAX_PACKET) throw new Error("Reading exceeds 16 KiB.");
      input = input.trim();
      if (!input) throw new Error("Empty reading.");
      if (format === "json" || (format === "auto" && input.startsWith("{"))) {
        try {
          input = JSON.parse(input);
        } catch (_) {
          throw new Error("Invalid JSON reading.");
        }
      }
    }
    if (input && typeof input === "object" && !Array.isArray(input)) {
      if (format === "text")
        throw new Error("Expected number or scale text, received JSON.");
      const key =
        options.key ||
        (Object.hasOwn(input, "weight")
          ? "weight"
          : Object.hasOwn(input, "value")
            ? "value"
            : "grams");
      value = number(field(input, key));
      unit =
        input.unit === undefined ? (key === "grams" ? "g" : unit) : input.unit;
      if (typeof input.stable === "boolean") stable = input.stable;
    } else {
      if (format === "json")
        throw new Error("Expected a JSON object with a weight field.");
      if (typeof input !== "string" && typeof input !== "number")
        throw new Error("Unsupported reading format.");
      const match = String(input)
        .trim()
        .match(
          /^(?:(ST|US|OL)[,\s]+)?(?:(?:GS|NT|WT|WEIGHT)[,:\s]+)?([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z]+)?$/i,
        );
      if (!match)
        throw new Error(
          "Unrecognized text. Use 123.45 g or a JSON weight object.",
        );
      if (match[1]) {
        if (match[1].toUpperCase() === "OL")
          throw new Error("Device reports overload.");
        stable = match[1].toUpperCase() === "ST";
      }
      value = number(match[2]);
      if (match[3]) unit = match[3];
    }
    unit = normalizeUnit(unit);
    const grams = value * UNITS[unit];
    if (!Number.isFinite(grams) || Math.abs(grams) > 1e12)
      throw new Error(
        "Weight is outside the supported range of ±1 trillion grams.",
      );
    return { grams, stable, inputValue: value, inputUnit: unit };
  }
  function parseStandardBle(view) {
    if (!(view instanceof DataView) || view.byteLength < 3)
      throw new Error("Truncated BLE weight measurement.");
    const flags = view.getUint8(0);
    if (flags & 0xf0)
      throw new Error("Unsupported BLE weight measurement flags.");
    const expected =
      3 + (flags & 2 ? 7 : 0) + (flags & 4 ? 1 : 0) + (flags & 8 ? 4 : 0);
    if (view.byteLength < expected)
      throw new Error("Truncated optional BLE measurement fields.");
    const weight = view.getUint16(1, true);
    if (weight === 0xffff)
      throw new Error("BLE device reports unsuccessful measurement.");
    const pounds = Boolean(flags & 1);
    const value = weight * (pounds ? 0.01 : 0.005);
    return {
      grams: pounds ? value * UNITS.lb : value * 1000,
      stable: null,
      inputValue: value,
      inputUnit: pounds ? "lb" : "kg",
    };
  }
  class LineFramer {
    constructor(onLine, onInvalid = () => {}) {
      this.onLine = onLine;
      this.onInvalid = onInvalid;
      this.buffer = "";
      this.dropping = false;
    }
    push(chunk) {
      for (const character of chunk) {
        if (character === "\n" || character === "\r") {
          if (!this.dropping && this.buffer.trim())
            this.onLine(this.buffer.trim());
          this.buffer = "";
          this.dropping = false;
        } else if (!this.dropping) {
          this.buffer += character;
          if (this.buffer.length > MAX_PACKET) {
            this.buffer = "";
            this.dropping = true;
            this.onInvalid(
              "Reading exceeds 16 KiB; discarded until the next newline.",
            );
          }
        }
      }
    }
    flush() {
      if (!this.dropping && this.buffer.trim()) this.onLine(this.buffer.trim());
      this.buffer = "";
      this.dropping = false;
    }
  }
  function normalizeUuid(value) {
    const text = String(value).trim().toLowerCase();
    if (/^(?:0x)?[0-9a-f]{4}(?:[0-9a-f]{4})?$/.test(text))
      return parseInt(text.replace(/^0x/, ""), 16);
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        text,
      )
    )
      return text;
    throw new Error("Enter a full BLE UUID or a short value such as 0x181d.");
  }
  function validateEndpoint(value, mode, pageProtocol) {
    let url;
    try {
      url = new URL(value);
    } catch (_) {
      throw new Error(
        "Enter a full scale endpoint URL, including its protocol.",
      );
    }
    const allowed = mode === "http" ? ["http:", "https:"] : ["ws:", "wss:"];
    if (!allowed.includes(url.protocol))
      throw new Error(
        mode === "http"
          ? "HTTP polling needs an http:// or https:// endpoint."
          : "WebSocket needs a ws:// or wss:// endpoint.",
      );
    if (url.username || url.password || url.hash)
      throw new Error(
        "Endpoint URLs must not contain credentials or fragments.",
      );
    if (pageProtocol === "https:" && ["http:", "ws:"].includes(url.protocol))
      throw new Error(
        "This HTTPS website requires WSS or HTTPS with a trusted certificate. For a plain local endpoint, serve a local HTTP copy of this site; do not disable browser security.",
      );
    return url.href;
  }
  class SerialTransport {
    constructor(config, callbacks, env = globalThis) {
      this.config = config;
      this.cb = callbacks;
      this.env = env;
      this.stopped = false;
      this.closed = false;
      this.framer = new LineFramer(callbacks.onData, callbacks.onInvalid);
    }
    async connect() {
      if (!this.env.isSecureContext || !this.env.navigator.serial)
        throw new Error(
          "USB serial is unavailable. Use a supported laptop browser over HTTPS or localhost.",
        );
      const port = await this.env.navigator.serial.requestPort();
      if (this.stopped) throw new Error("Connection cancelled.");
      this.port = port;
      await port.open(this.config);
      if (this.stopped) {
        await port.close();
        throw new Error("Connection cancelled.");
      }
      this.task = this.readLoop();
      return "USB serial";
    }
    async readLoop() {
      const decoder = new TextDecoder();
      let reason = "Serial stream ended.";
      try {
        while (!this.stopped && this.port.readable) {
          this.reader = this.port.readable.getReader();
          try {
            while (!this.stopped) {
              const { value, done } = await this.reader.read();
              if (done) break;
              if (value)
                this.framer.push(decoder.decode(value, { stream: true }));
            }
          } finally {
            this.reader.releaseLock();
            this.reader = null;
          }
          break;
        }
        if (!this.stopped) {
          this.framer.push(decoder.decode());
          if (this.framer.buffer.trim())
            this.cb.onInvalid(
              "Incomplete serial reading discarded: a newline is required.",
            );
        }
      } catch (error) {
        reason = "Serial read failed: " + error.message;
      } finally {
        try {
          await this.port.close();
        } catch (_) {
          /* Already removed or closed. */
        }
        this.closed = true;
        if (!this.stopped) this.cb.onClose(reason);
      }
    }
    async disconnect() {
      this.stopped = true;
      if (this.reader) await this.reader.cancel().catch(() => {});
      if (this.task) await this.task;
      this.closed = true;
    }
  }
  class BluetoothTransport {
    constructor(config, callbacks, env = globalThis) {
      this.config = config;
      this.cb = callbacks;
      this.env = env;
      this.stopped = false;
      this.closed = false;
      this.framer = new LineFramer(callbacks.onData, callbacks.onInvalid);
      this.notify = (event) => {
        if (this.stopped) return;
        const view = event.target.value;
        if (config.standard) {
          try {
            callbacks.onReading(
              parseStandardBle(view),
              "BLE binary: " +
                Array.from(
                  new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
                  (n) => n.toString(16).padStart(2, "0"),
                ).join(" "),
            );
          } catch (error) {
            callbacks.onInvalid(error.message);
          }
        } else {
          const text = this.decoder.decode(view, {
            stream: config.framing === "newline",
          });
          if (config.framing === "newline") this.framer.push(text);
          else if (text.length > MAX_PACKET)
            callbacks.onInvalid("BLE packet exceeds 16 KiB.");
          else
            text
              .split(/[\r\n]+/)
              .filter((line) => line.trim())
              .forEach(callbacks.onData);
        }
      };
      this.onDisconnected = () => {
        this.closed = true;
        if (!this.stopped) callbacks.onClose("Bluetooth device disconnected.");
      };
      this.decoder = new TextDecoder();
    }
    check() {
      if (this.stopped) {
        if (this.device && this.device.gatt.connected)
          this.device.gatt.disconnect();
        throw new Error("Connection cancelled.");
      }
    }
    async connect() {
      if (!this.env.isSecureContext || !this.env.navigator.bluetooth)
        throw new Error(
          "Bluetooth LE is unavailable in this browser or OS. Try a supported laptop Chrome/Edge browser with a Bluetooth adapter.",
        );
      const serviceId = normalizeUuid(this.config.service);
      const characteristicId = normalizeUuid(this.config.characteristic);
      this.device = await this.env.navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [serviceId],
      });
      this.check();
      this.device.addEventListener(
        "gattserverdisconnected",
        this.onDisconnected,
      );
      const server = await this.device.gatt.connect();
      this.check();
      const service = await server.getPrimaryService(serviceId);
      this.check();
      this.characteristic = await service.getCharacteristic(characteristicId);
      this.check();
      const properties = this.characteristic.properties;
      if (!properties.notify && !properties.indicate)
        throw new Error(
          "Measurement characteristic must support notifications or indications.",
        );
      this.characteristic.addEventListener(
        "characteristicvaluechanged",
        this.notify,
      );
      await this.characteristic.startNotifications();
      this.check();
      return this.device.name || "Bluetooth LE scale";
    }
    async disconnect() {
      this.stopped = true;
      if (this.characteristic)
        this.characteristic.removeEventListener(
          "characteristicvaluechanged",
          this.notify,
        );
      if (this.device) {
        this.device.removeEventListener(
          "gattserverdisconnected",
          this.onDisconnected,
        );
        if (this.device.gatt.connected) this.device.gatt.disconnect();
      }
      this.closed = true;
    }
  }
  class WebSocketTransport {
    constructor(config, callbacks, env = globalThis) {
      this.config = config;
      this.cb = callbacks;
      this.env = env;
      this.stopped = false;
      this.closed = false;
      this.framer = new LineFramer(callbacks.onData, callbacks.onInvalid);
      this.decoder = new TextDecoder();
    }
    connect() {
      const endpoint = validateEndpoint(
        this.config.endpoint,
        "websocket",
        this.env.location.protocol,
      );
      return new Promise((resolve, reject) => {
        const socket = (this.socket = new this.env.WebSocket(endpoint));
        socket.binaryType = "arraybuffer";
        let opened = false,
          settled = false;
        const fail = (message) => {
          if (!settled) {
            settled = true;
            clearTimeout(this.timeout);
            reject(new Error(message));
          }
        };
        this.timeout = setTimeout(() => {
          fail(
            "Wi-Fi connection timed out. Check the endpoint, network, trusted certificate, and local-network permission.",
          );
          socket.close();
        }, 10000);
        this.cancel = () => fail("Connection cancelled.");
        socket.onopen = () => {
          if (this.stopped) {
            socket.close();
            fail("Connection cancelled.");
            return;
          }
          opened = true;
          settled = true;
          clearTimeout(this.timeout);
          resolve("Wi-Fi WebSocket");
        };
        socket.onmessage = (event) => {
          if (this.stopped) return;
          const data = event.data;
          const size = typeof data === "string" ? data.length : data.byteLength;
          if (size > MAX_PACKET) {
            this.cb.onInvalid("Network packet exceeds 16 KiB.");
            return;
          }
          const text =
            typeof data === "string"
              ? data
              : this.decoder.decode(data, {
                  stream: this.config.framing === "newline",
                });
          if (this.config.framing === "newline") this.framer.push(text);
          else
            text
              .split(/[\r\n]+/)
              .filter((line) => line.trim())
              .forEach(this.cb.onData);
        };
        socket.onerror = () => {
          fail(
            "Wi-Fi connection failed. Check endpoint, TLS certificate, local-network permissions, and the firmware server.",
          );
          if (opened && !this.stopped)
            this.cb.onClose("Wi-Fi connection error.");
        };
        socket.onclose = () => {
          this.closed = true;
          clearTimeout(this.timeout);
          fail("Wi-Fi endpoint closed before connecting.");
          if (opened && !this.stopped)
            this.cb.onClose("Wi-Fi connection closed.");
        };
      });
    }
    async disconnect() {
      this.stopped = true;
      clearTimeout(this.timeout);
      if (this.cancel) this.cancel();
      if (this.socket) this.socket.close();
      this.closed = true;
    }
  }
  class HttpTransport {
    constructor(config, callbacks, env = globalThis) {
      this.config = config;
      this.cb = callbacks;
      this.env = env;
      this.stopped = false;
      this.closed = false;
    }
    async connect() {
      this.endpoint = validateEndpoint(
        this.config.endpoint,
        "http",
        this.env.location.protocol,
      );
      await this.poll();
      if (this.stopped) throw new Error("Connection cancelled.");
      this.schedule();
      return "Wi-Fi HTTP polling";
    }
    async poll() {
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller.abort(), 8000);
      try {
        const response = await this.env.fetch(this.endpoint, {
          signal: this.controller.signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(
            "Scale endpoint returned HTTP " + response.status + ".",
          );
        if (!response.body)
          throw new Error("Scale endpoint returned no response body.");
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_PACKET) {
              await reader.cancel();
              throw new Error("HTTP reading exceeds 16 KiB.");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const joined = new Uint8Array(length);
        let offset = 0;
        chunks.forEach((chunk) => {
          joined.set(chunk, offset);
          offset += chunk.length;
        });
        const text = new TextDecoder().decode(joined);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch (_) {
          throw new Error("HTTP polling requires a JSON weight object.");
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new Error("HTTP polling requires a JSON weight object.");
        if (!this.stopped) this.cb.onData(text);
      } catch (error) {
        if (error.name === "AbortError")
          throw new Error("HTTP request cancelled or timed out.");
        if (error instanceof TypeError)
          throw new Error(
            "HTTP connection blocked or unreachable. Check CORS, trusted TLS, same network, and local-network permission.",
          );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    schedule() {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        try {
          await this.poll();
          this.schedule();
        } catch (error) {
          this.closed = true;
          if (!this.stopped) this.cb.onClose(error.message);
        }
      }, this.config.interval);
    }
    async disconnect() {
      this.stopped = true;
      clearTimeout(this.timer);
      if (this.controller) this.controller.abort();
      this.closed = true;
    }
  }
  return {
    UNITS,
    MAX_PACKET,
    parseWeight,
    parseStandardBle,
    LineFramer,
    normalizeUuid,
    validateEndpoint,
    SerialTransport,
    BluetoothTransport,
    WebSocketTransport,
    HttpTransport,
  };
});
