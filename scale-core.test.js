const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./scale-core.js");
const encoder = new TextEncoder();
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
function callbacks() {
  return {
    data: [],
    readings: [],
    invalid: [],
    closed: [],
    onData(value) {
      this.data.push(value);
    },
    onReading(value) {
      this.readings.push(value);
    },
    onInvalid(value) {
      this.invalid.push(value);
    },
    onClose(value) {
      this.closed.push(value);
    },
  };
}
function boundCallbacks() {
  const cb = callbacks();
  ["onData", "onReading", "onInvalid", "onClose"].forEach((key) => {
    cb[key] = cb[key].bind(cb);
  });
  return cb;
}

test("text and signed units normalize to grams", () => {
  assert.equal(core.parseWeight("123.45 g").grams, 123.45);
  assert.equal(core.parseWeight("-2.5 kg").grams, -2500);
  assert.equal(core.parseWeight("1e3 mg").grams, 1);
  assert.equal(core.parseWeight("1 lbs").grams, 453.59237);
  assert.equal(core.parseWeight("2", { unit: "kg" }).grams, 2000);
  assert.equal(core.parseWeight("ST,GS,+001.25 kg").stable, true);
  assert.equal(core.parseWeight("US,NT,-3 g").stable, false);
});
test("JSON mappings, units, zero and stability are preserved", () => {
  assert.deepEqual(core.parseWeight('{"weight":0,"unit":"g","stable":false}'), {
    grams: 0,
    stable: false,
    inputValue: 0,
    inputUnit: "g",
  });
  assert.equal(
    core.parseWeight('{"sensor":{"load":"0.125"},"unit":"kg"}', {
      key: "sensor.load",
    }).grams,
    125,
  );
  assert.equal(core.parseWeight('{"grams":1}', { unit: "kg" }).grams, 1);
  assert.equal(core.parseWeight('{"value":2}', { unit: "kg" }).grams, 2000);
});
test("malformed, untrusted, non-numeric and overlarge data never becomes a weight", () => {
  for (const value of [
    "debug boot123",
    "OL,GS,123 g",
    "NaN",
    "Infinity",
    '{"weight":true}',
    '{"weight":null}',
    '{"weight":""}',
    '{"weight":{}}',
    '{"weight":1,"unit":"stones"}',
    "[123]",
    "<script>123</script>",
    "1e999 g",
    "x".repeat(16385),
  ])
    assert.throws(() => core.parseWeight(value));
  assert.throws(() => core.parseWeight('{"weight":2}', { format: "text" }));
  assert.throws(() => core.parseWeight("2", { format: "json" }));
  assert.throws(() =>
    core.parseWeight('{"weight":2}', { key: "__proto__.polluted" }),
  );
});
test("USB framing handles chunks, CR/LF, trailing data and oversized lines", () => {
  const lines = [],
    bad = [];
  const frame = new core.LineFramer(
    (value) => lines.push(value),
    (reason) => bad.push(reason),
  );
  frame.push("12");
  frame.push("3.45 g\r");
  frame.push("\n0 g\n-1");
  frame.push(" g");
  frame.flush();
  assert.deepEqual(lines, ["123.45 g", "0 g", "-1 g"]);
  frame.push("x".repeat(17000));
  frame.push("999 g\n125 g\n");
  assert.equal(bad.length, 1);
  assert.equal(lines.at(-1), "125 g");
  assert.equal(lines.includes("999 g"), false);
});
test("Bluetooth UUIDs accept short and full values only", () => {
  assert.equal(core.normalizeUuid("0x181D"), 0x181d);
  assert.equal(core.normalizeUuid("2a9d"), 0x2a9d);
  assert.equal(
    core.normalizeUuid("6E400001-B5A3-F393-E0A9-E50E24DCCA9E"),
    "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  );
  assert.throws(() => core.normalizeUuid("not-a-service"));
});
test("standard BLE weight binary decodes units, flags and invalid measurement", () => {
  const view = new DataView(new ArrayBuffer(3));
  view.setUint16(1, 200, true);
  assert.equal(core.parseStandardBle(view).grams, 1000);
  view.setUint8(0, 1);
  view.setUint16(1, 100, true);
  assert.equal(core.parseStandardBle(view).grams, 453.59237);
  view.setUint16(1, 65535, true);
  assert.throws(() => core.parseStandardBle(view));
  view.setUint8(0, 2);
  assert.throws(() => core.parseStandardBle(view));
  assert.throws(() => core.parseStandardBle(new DataView(new ArrayBuffer(2))));
});
test("secure webpage rejects mixed-content URLs and credentials", () => {
  assert.equal(
    core.validateEndpoint("wss://scale.local/weights", "websocket", "https:"),
    "wss://scale.local/weights",
  );
  assert.equal(
    core.validateEndpoint("http://192.168.1.10/weight", "http", "http:"),
    "http://192.168.1.10/weight",
  );
  for (const url of [
    "ws://scale.local/",
    "wss://user:pass@scale.local/",
    "wss://scale.local/#secret",
    "javascript:alert(1)",
    "https://scale.local/",
  ])
    assert.throws(() => core.validateEndpoint(url, "websocket", "https:"));
  assert.throws(() =>
    core.validateEndpoint("http://localhost/weight", "http", "https:"),
  );
});
test("USB adapter reads fragmented data and closes on physical stream end", async () => {
  const cb = boundCallbacks();
  let opened,
    closed = 0;
  const chunks = [encoder.encode("12"), encoder.encode("3 g\n0 g\n")];
  const port = {
    readable: new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      },
    }),
    async open(settings) {
      opened = settings;
    },
    async close() {
      closed++;
    },
  };
  const adapter = new core.SerialTransport({ baudRate: 115200 }, cb, {
    isSecureContext: true,
    navigator: { serial: { requestPort: async () => port } },
  });
  await adapter.connect();
  await adapter.task;
  assert.equal(opened.baudRate, 115200);
  assert.deepEqual(cb.data, ["123 g", "0 g"]);
  assert.equal(closed, 1);
  assert.equal(cb.closed.length, 1);
});
test("USB disconnect cancels reader and unlocks port without reporting fake failure", async () => {
  const cb = boundCallbacks();
  let cancelled = 0,
    closed = 0;
  const port = {
    readable: new ReadableStream({
      cancel() {
        cancelled++;
      },
    }),
    async open() {},
    async close() {
      assert.equal(this.readable.locked, false);
      closed++;
    },
  };
  const adapter = new core.SerialTransport({}, cb, {
    isSecureContext: true,
    navigator: { serial: { requestPort: async () => port } },
  });
  await adapter.connect();
  await adapter.disconnect();
  assert.equal(cancelled, 1);
  assert.equal(closed, 1);
  assert.equal(cb.closed.length, 0);
});
test("USB chooser cancellation and unsupported browser propagate explicit errors", async () => {
  const cb = boundCallbacks();
  const error = Object.assign(new Error("No port"), { name: "NotFoundError" });
  await assert.rejects(
    new core.SerialTransport({}, cb, {
      isSecureContext: true,
      navigator: {
        serial: {
          requestPort: async () => {
            throw error;
          },
        },
      },
    }).connect(),
    { name: "NotFoundError" },
  );
  await assert.rejects(
    new core.SerialTransport({}, cb, {
      isSecureContext: false,
      navigator: {},
    }).connect(),
    /unavailable/,
  );
});
function fakeBle({ fail = false } = {}) {
  const deviceEvents = {},
    charEvents = {};
  let disconnected = 0,
    options;
  const characteristic = {
    properties: { notify: true },
    addEventListener(type, fn) {
      charEvents[type] = fn;
    },
    removeEventListener(type) {
      delete charEvents[type];
    },
    async startNotifications() {},
  };
  const device = {
    name: "Lab scale",
    addEventListener(type, fn) {
      deviceEvents[type] = fn;
    },
    removeEventListener(type) {
      delete deviceEvents[type];
    },
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return {
          async getPrimaryService() {
            if (fail) throw new Error("UUID not found");
            return {
              async getCharacteristic() {
                return characteristic;
              },
            };
          },
        };
      },
      disconnect() {
        this.connected = false;
        disconnected++;
      },
    },
  };
  return {
    device,
    characteristic,
    deviceEvents,
    charEvents,
    get disconnected() {
      return disconnected;
    },
    get options() {
      return options;
    },
    env: {
      isSecureContext: true,
      navigator: {
        bluetooth: {
          async requestDevice(value) {
            options = value;
            return device;
          },
        },
      },
    },
  };
}
test("BLE adapter authorizes the selected service and receives text notifications", async () => {
  const fake = fakeBle();
  const cb = boundCallbacks();
  const adapter = new core.BluetoothTransport(
    { service: "0x181d", characteristic: "0x2a9d", framing: "packet" },
    cb,
    fake.env,
  );
  assert.equal(await adapter.connect(), "Lab scale");
  assert.deepEqual(fake.options.optionalServices, [0x181d]);
  fake.charEvents.characteristicvaluechanged({
    target: { value: new DataView(encoder.encode("250 g").buffer) },
  });
  assert.deepEqual(cb.data, ["250 g"]);
  await adapter.disconnect();
  assert.equal(fake.disconnected, 1);
  assert.equal(Object.keys(fake.charEvents).length, 0);
});
test("BLE fragmented notifications assemble a full newline reading", async () => {
  const fake = fakeBle();
  const cb = boundCallbacks();
  const adapter = new core.BluetoothTransport(
    { service: "0x181d", characteristic: "0x2a9d", framing: "newline" },
    cb,
    fake.env,
  );
  await adapter.connect();
  ["12", "3 g\n"].forEach((text) =>
    fake.charEvents.characteristicvaluechanged({
      target: { value: new DataView(encoder.encode(text).buffer) },
    }),
  );
  assert.deepEqual(cb.data, ["123 g"]);
  await adapter.disconnect();
});
test("BLE partial failure cleans up the connected device", async () => {
  const fake = fakeBle({ fail: true });
  const adapter = new core.BluetoothTransport(
    { service: "0x181d", characteristic: "0x2a9d" },
    boundCallbacks(),
    fake.env,
  );
  await assert.rejects(adapter.connect(), /UUID not found/);
  await adapter.disconnect();
  assert.equal(fake.disconnected, 1);
  assert.equal(Object.keys(fake.deviceEvents).length, 0);
});
test("WebSocket adapter consumes complete packets and reports remote closure", async () => {
  let socket;
  class FakeSocket {
    constructor() {
      socket = this;
    }
    close() {
      if (this.onclose) this.onclose();
    }
  }
  const cb = boundCallbacks();
  const adapter = new core.WebSocketTransport(
    { endpoint: "wss://scale.local/weights" },
    cb,
    { location: { protocol: "https:" }, WebSocket: FakeSocket },
  );
  const connecting = adapter.connect();
  socket.onopen();
  await connecting;
  socket.onmessage({ data: "123 g\n125 g" });
  assert.deepEqual(cb.data, ["123 g", "125 g"]);
  socket.onclose();
  assert.equal(cb.closed.length, 1);
  await adapter.disconnect();
});
test("WebSocket cancellation rejects pending connection and releases resources", async () => {
  class FakeSocket {
    close() {}
  }
  const adapter = new core.WebSocketTransport(
    { endpoint: "wss://scale.local/weights" },
    boundCallbacks(),
    { location: { protocol: "https:" }, WebSocket: FakeSocket },
  );
  const connecting = adapter.connect();
  await adapter.disconnect();
  await assert.rejects(connecting, /cancelled/);
});
test("HTTP polling requests fresh JSON without cookies and stops cleanly", async () => {
  const cb = boundCallbacks();
  let options;
  const env = {
    location: { protocol: "https:" },
    async fetch(_, value) {
      options = value;
      return new Response('{"weight":250,"unit":"g"}', { status: 200 });
    },
  };
  const adapter = new core.HttpTransport(
    { endpoint: "https://scale.local/weight", interval: 60000 },
    cb,
    env,
  );
  await adapter.connect();
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(cb.data.length, 1);
  await adapter.disconnect();
});
test("HTTP polling rejects server errors, non-JSON and oversized responses", async () => {
  for (const response of [
    new Response("failure", { status: 500 }),
    new Response("not json"),
    new Response("[]"),
    new Response("x".repeat(17000)),
  ]) {
    const adapter = new core.HttpTransport(
      { endpoint: "https://scale.local/weight", interval: 1000 },
      boundCallbacks(),
      { location: { protocol: "https:" }, fetch: async () => response },
    );
    await assert.rejects(adapter.connect());
    await adapter.disconnect();
  }
});
test("HTTP polling cancellation suppresses further data", async () => {
  const cb = boundCallbacks();
  const adapter = new core.HttpTransport(
    { endpoint: "https://scale.local/weight", interval: 1000 },
    cb,
    {
      location: { protocol: "https:" },
      fetch: (_, options) =>
        new Promise((_, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
    },
  );
  const connecting = adapter.connect();
  await pause();
  await adapter.disconnect();
  await assert.rejects(connecting, /cancelled/);
  assert.equal(cb.data.length, 0);
});

test("WebSocket newline mode buffers split readings across messages", async () => {
  let socket;
  class FakeSocket {
    constructor() {
      socket = this;
    }
    close() {}
  }
  const cb = boundCallbacks();
  const adapter = new core.WebSocketTransport(
    { endpoint: "wss://scale.local/weights", framing: "newline" },
    cb,
    { location: { protocol: "https:" }, WebSocket: FakeSocket },
  );
  const connecting = adapter.connect();
  socket.onopen();
  await connecting;
  socket.onmessage({ data: "12" });
  assert.equal(cb.data.length, 0);
  socket.onmessage({ data: '3 g\n{"weight":' });
  assert.deepEqual(cb.data, ["123 g"]);
  socket.onmessage({ data: '125,"unit":"g"}\n' });
  assert.equal(core.parseWeight(cb.data[1]).grams, 125);
  await adapter.disconnect();
});
test("USB disconnect discards an unterminated partial numeric reading", async () => {
  const cb = boundCallbacks();
  const port = {
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("12"));
        controller.close();
      },
    }),
    async open() {},
    async close() {},
  };
  const adapter = new core.SerialTransport({}, cb, {
    isSecureContext: true,
    navigator: { serial: { requestPort: async () => port } },
  });
  await adapter.connect();
  await adapter.task;
  assert.equal(cb.data.length, 0);
  assert.equal(cb.invalid.length, 1);
});
test("accepted weights cannot overflow conversions or software tare", () => {
  assert.throws(() => core.parseWeight("1e308 g"), /supported range/);
  const positive = core.parseWeight("1e12 g").grams,
    negative = core.parseWeight("-1e12 g").grams;
  assert.equal(Number.isFinite(positive / core.UNITS.mg), true);
  assert.equal(Number.isFinite(positive - negative), true);
});
