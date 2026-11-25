# WEIGHTLAB-X1 scale setup

Use current desktop Chrome or Edge on Windows/macOS as the recommended starting point. Check features before connecting: `window.isSecureContext`, `"serial" in navigator`, and `"bluetooth" in navigator`. Web Serial and Web Bluetooth are not supported in every browser; Linux BLE availability varies with browser builds, adapters, permissions, and the Bluetooth stack. Device selection requires a user click and permission. If a feature is unavailable, choose another transport rather than assuming the board is faulty.

The static website in [WEIGHTLAB-X1](https://github.com/mahmoudtaema023-glitch/WEIGHTLAB-X1) is a client, not a scale server. Your board or an adapter must acquire a real sensor measurement and expose a compatible connection. These instructions are not a claim of testing with real hardware.

## Choose hardware and transport

Classic Arduino Uno/Nano boards can send USB serial readings, but need an external WiFi or BLE module for wireless operation. Do not confuse newer radio-equipped Arduino models with the classic boards. Arduino documents the Uno R3's USB connection.[1]

Check the exact ESP32 chip: the original ESP32 has WiFi and BLE; ESP32-S2 has WiFi but no BLE; ESP32-H2 has BLE but no WiFi; ESP32-C3 and ESP32-S3 have WiFi and BLE. Board connectors and firmware still determine how USB serial is exposed.[2]

A Raspberry Pi can run a Linux measurement server for WebSocket or HTTP access. USB gadget mode requires a supported device-mode port and explicit configuration. Raspberry Pi's documented gadget package exposes USB Ethernet, not USB serial; use the network transport over that link, or separately configure a serial gadget. Native BLE peripheral service setup on Linux requires platform-specific Bluetooth software and permissions; an onboard radio does not create a scale service automatically.[3]

Proprietary HID/USB protocols or vendor binary messages need an adapter that translates to the formats below. Bluetooth Classic is not BLE. An OS-paired Classic Bluetooth SPP device may be available through desktop Web Serial: select its exposed serial port in the **USB Serial** tab if your OS/browser supports it.

## Common reading format

For USB serial, send UTF-8 newline-delimited readings using either format:

```text
123.45 g\n
```

```json
{"weight":123.45,"unit":"g","stable":true}
```

Here `\n` means an actual newline byte, not the two printed characters. Append a newline after each serial JSON object too. Send numeric measurements, explicit units, and an optional truthful `stable` flag; use `g` consistently for the simplest setup. Do not interleave debug output with readings. USB chunks may split or combine lines, so the receiver buffers complete readings and discards unfinished lines on disconnection. The software accepts measurements within ±1 trillion grams to keep conversions and tare arithmetic finite; that limit is not a statement of hardware accuracy.

WebSocket mode defaults to one complete text or JSON reading per message; a trailing newline is optional in that mode. If firmware splits a reading across separate WebSocket messages, select **Newline-delimited stream (split messages)** and append an actual newline after each reading. The receiver then buffers across messages instead of interpreting partial numbers as complete measurements.

HTTP polling returns one JSON object, without requiring a trailing newline:

```json
{"weight":123.45,"unit":"g","stable":true}
```

## Laptop USB Serial

Connect a data-capable USB cable, install the board's USB-serial driver if needed, and confirm that a serial port appears in the OS. Configure the frontend baud rate to match firmware, for example `115200`; use matching serial parameters, normally 8 data bits, no parity, and 1 stop bit. Select the port from the USB Serial connection chooser.

Close Arduino Serial Monitor and other programs holding the port. Some boards reset when opened; allow startup time before expecting readings. If values are garbled, check baud rate. If nothing arrives, check the cable, driver, port, newline framing, and whether firmware actually emits calibrated measurements.

## WiFi: WSS WebSocket or HTTPS polling

For WebSocket mode, configure the full endpoint URL, for example `wss://scale.example.net/weight`, then connect. The device/server must implement a WebSocket endpoint and send the reading format above; a raw TCP socket is not sufficient.

For JSON polling, configure an endpoint such as `https://scale.example.net/weight` and a polling interval, for example 500 ms. Each GET should return the latest reading with `Content-Type: application/json`. The client avoids overlapping requests. Firmware must return fresh sensor measurements: the website detects missing packets, but cannot distinguish a stale value repeatedly returned by firmware from a legitimately constant weight.

An HTTPS-hosted page requires a trusted **WSS or HTTPS** endpoint. A private IP address alone does not supply TLS. Use a properly configured TLS server/reverse proxy and a certificate trusted by the laptop, with a hostname matching the certificate. Self-signed or mismatched certificates commonly prevent connections.

For local development only, serve a local copy over HTTP and use `ws://` or HTTP endpoints. Prefer `localhost` when secure-context browser APIs are also needed; plain HTTP on a LAN address may not qualify. This is not a workaround for an HTTPS deployment. Never disable browser security or mixed-content protections.

## BLE measurements

For text BLE, configure the advertised service and its notifying or indicating measurement characteristic. A separate read property is not required. Nordic UART defaults are:

- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- TX measurement characteristic: `6e400003-b5a3-f393-e0a9-e50e24dcca9e`

TX here means peripheral-to-browser. Firmware must advertise the service and expose notifications. Enter custom service/characteristic UUIDs when your firmware uses different ones.

By default, send **one complete text or JSON reading per notification**. Select newline framing when readings span fragmented notifications; firmware must then terminate every reading with a newline. Do not use fragmented messages with the complete-reading setting.

Alternatively, select standard Bluetooth Weight Scale service `0x181d` and Weight Measurement characteristic `0x2a9d`. Its payload is binary, not Nordic UART text: use the standard decoder and subscribe to its indications. Flags determine units and optional fields; changing UUIDs alone does not convert binary data to text.

## Calibration and connection checks

Frontend software tare subtracts a display offset only. It does not calibrate the load cell, change firmware calibration, or send a hardware-zero command. Calibrate your actual sensor/amplifier in firmware using its library and known masses before connecting.

For network failures, verify the same reachable network, endpoint path, firewall, certificate, and browser local-network permissions. HTTP servers must allow the site's origin through CORS; WebSocket servers should accept the intended origin. Check developer-console errors for mixed content, CORS, TLS, or permission failures. For BLE, check advertising, UUIDs, subscription support, OS Bluetooth permission, and competing connections.

## References

[1]: https://docs.arduino.cc/hardware/uno-rev3 "Arduino UNO R3 hardware documentation"
[2]: https://docs.espressif.com/projects/arduino-esp32/en/latest/libraries.html "Espressif Arduino ESP32 supported features and peripherals"
[3]: https://www.raspberrypi.com/news/usb-gadget-mode-in-raspberry-pi-os-ssh-over-usb/ "Raspberry Pi USB gadget networking documentation"
