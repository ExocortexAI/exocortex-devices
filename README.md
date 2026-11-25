# @exocortex/devices

Pair any body device, health source or sensor you made through one contract. An app that speaks the contract can
read an OpenBCI board, a heart-rate strap, a FIT file or a custom Arduino the same way, without knowing which one it is.

- TypeScript with erasable syntax only: Node 24 runs the files directly, and a bundler serves them to a browser.
- No runtime dependencies. No DOM and no network inside a driver: the host hands it a transport.
- Apache-2.0.

## The contract in one picture

```
  Descriptor (plain data)                 Driver (code)                        Records (out)
  ─────────────────────────               ─────────────────────                ──────────────────────────────
  what a kind of device is:               opens one device over a              samples    a chunk of a regular signal
   channels  (eeg, hr, accel …)   ──────▶ transport the host hands it  ──────▶ intervals  a sleep stage, a workout
   actions   (start, stop, mark)          and emits records                    events     an RR interval, a marker
   routes    transport × hosts ×                │                              media      a clip, a photo
             driver × verified                  │
                                                ▼                              each with provenance (instance, model,
                                          Transport                            firmware, host, transport, vendor id)
                                           ByteTransport   (Web Serial, Node serial, TCP)
                                           GattTransport   (Web Bluetooth, a phone's BLE)
                                           HealthStoreTransport (HealthKit, Health Connect)
                                           FileTransport   (a file, a chunk at a time)
```

The types are in [`src/contract.ts`](src/contract.ts). A descriptor can be listed, searched and reviewed without
running code. A route says how far its support was checked (`verified`): `none`, `spec` (tested against bytes laid
out from the protocol's documentation), `loopback` (the driver ran its whole session against a simulated device),
`bench` or `hardware` (tested with the device, with a report). Never more than what was done.

## Pair a board in 10 lines

```ts
import { openbciCyton, requestSerial } from '@exocortex/devices';

button.onclick = async () => {
  const port = await requestSerial(openbciCyton);               // Chrome's port chooser, filtered to the dongle
  const conn = await openbciCyton.open(port, {
    instance: 'my-cyton', host: 'chrome-desktop', enabled: new Set(['eeg']), config: {},
    emit: (r) => console.log(r.channel, r.shape === 'samples' ? r.data[0].length : r),
    status: (s) => console.log(s.state, s.why ?? ''), now: Date.now,
  });
  await conn.start();                                            // ... later: await conn.stop(); await conn.close();
};
```

A Bluetooth device is the same with `requestGatt(driver)`. A file is `fileFrom(name, bytes)` or any object with
`chunks()`. `examples/pair-in-chrome.html` pairs any serial or Bluetooth driver and plots it: run `npx vite examples`
in this folder and open `/pair-in-chrome.html` in Chrome. Its Demo button runs a simulated Cyton, with no hardware.

## Drivers

| driver | device | transport | verified | why |
|---|---|---|---|---|
| `openbci-cyton` | OpenBCI Cyton, 8 EEG at 250 Hz, accelerometer | Web Serial (FTDI dongle) | loopback | packets written from the Cyton Data Format, resync, and the reset / stream / stop session against a simulated board |
| `openbci-cyton-daisy` | Cyton + Daisy, 16 EEG at 125 Hz | Web Serial | loopback | odd/even Daisy pairing and the attach check against a simulated board |
| `openbci-ganglion` | OpenBCI Ganglion, 4 EEG at 200 Hz | Web Bluetooth | spec | packets built from the Ganglion Data Format (18/19-bit deltas); no recorded Ganglion bytes tested yet |
| `ble-heart-rate` | any standard heart-rate sensor (0x180D) | Web Bluetooth | loopback | every flag of the Heart Rate Service spec, and a session |
| `polar-h10` | Polar H10: ECG 130 Hz, accelerometer, HR, RR | Web Bluetooth (Polar PMD) | loopback | commands and frames per polar-ble-sdk, a session against a simulated strap |
| `media-audio` | Headphones, earbuds, clip and USB mics: 16 kHz audio clips, a level meter, the route | `MediaTransport` (getUserMedia) | loopback | inputs, the level, clips only while the host admits them, a route change and a lost input, against a fake audio input |
| `apple-health` | Apple Health (HealthKit) on an iPhone | HealthKit, through the app's native plugin | none | the record mapping is tested with a fake store; the Swift plugin is not compiled yet |
| `health-connect` | Health Connect on Android | Health Connect, through the app's native plugin | spec | the record mapping is tested with a fake store; the Kotlin plugin compiles, not yet run on a phone |
| `file-edf` | EDF, EDF+, BDF, BDF+ | file | loopback | files built from the EDF+ spec and BioSemi's 24-bit layout |
| `file-fit` | Garmin FIT (watches, bike computers) | file | loopback | a file built from the FIT protocol: definitions, compressed timestamps, big-endian messages |
| `file-gpx` | GPX 1.1 with Garmin's TrackPointExtension | file | loopback | a track read through the driver |
| `file-apple-health-export` | Apple Health `export.xml`, streamed | file | loopback | a snippet with its DOCTYPE, records, metadata, sleep and a workout |
| `file-csv` | any CSV with a time column | file | loopback | a regular and an irregular file |

Not built here: `exocortex-cap` (a descriptor; the Exocortex app implements its hub link and registers it). The
health-store drivers need a host that hands them a `HealthStoreTransport` (a native plugin). The catalog
([`src/catalog.ts`](src/catalog.ts)) lists every device family we know of, with the best route for a host and a
sentence: on a computer, `searchCatalog('oura ring', 'chrome-desktop')` says "Works through Health Connect on your
Android phone: use the Android app"; a family with no route says why it is not supported yet.

Also here: `regionOf('Fp1')` (a 10-20 name to frontal, central, parietal, occipital or temporal) and
`bandPowers(samples, fs)` (delta to gamma, Hann window and FFT) for summarising any board's EEG.

## Simulators

`src/sim/` has a simulated device for each live driver and for both health stores, so you can develop against the
whole contract with no hardware. Each one speaks its device's real protocol over a memory transport, and the real
driver reads it: the simulators test the drivers' sessions, not a shortcut around them.

```ts
import { simulatorFor, openbciCytonDaisy } from '@exocortex/devices';

const sim = simulatorFor('openbci-cyton-daisy', { seed: 7, lossRate: 0.01 });
const conn = await openbciCytonDaisy.open(sim.transport, ctx);   // the ctx of "Pair a board" above
await conn.start();                                              // ... later: await conn.close(); sim.stop();
```

| driver | what the simulator does |
|---|---|
| `openbci-cyton` | answers `v` with the v3 banner (`Firmware: v3.1.2`, `$$$`), `b` / `s`, `c` / `C`; 33-byte packets at 250 Hz with the sample counter; the accelerometer in every tenth packet |
| `openbci-cyton-daisy` | the banner names the Daisy; the board's channels on odd sample numbers and the Daisy's on even ones: 16 channels at 125 Hz |
| `openbci-ganglion` | GATT 0xFE84: a raw packet, then 19-bit delta packets (18-bit with the accelerometer) at 100 a second; `z` sends each contact's ohms |
| `ble-heart-rate` | 0x2A37 once a second with the rate and the RR intervals of the beats in it; battery 87 % |
| `polar-h10` | the PMD control point answers; ECG frames of 73 samples at 130 Hz and accelerometer frames of 36 samples at 200 Hz, stamped in ns; heart rate as above |
| `apple-health`, `health-connect` | a `HealthStoreTransport`: 30 days of heart rate, HRV, resting rate, steps, energy, distance, sleep stages, workouts, SpO2, breathing rate, wrist temperature, VO2 max (and a saved ECG on Apple Health), each store's own shapes, uuids and anchors; a workout is deleted a minute after the start |

The signals: EEG as a 1/f background, a posterior alpha rhythm near 10 Hz that rises in the "eyes closed" stretches,
blinks on Fp1/Fp2, 60 Hz mains; ECG with P, QRS and T waves around beats whose RR varies with breathing; heart rate
following a day's rhythm (lower asleep, higher in a workout).

Options (`SimOptions`, and `SIM_SETTINGS` as fields for a settings page; `simulatorSettings(id)` lists those a
simulator reads): `seed` (the same seed, the same samples), `speed` (simulated seconds per second),
`disconnectAfterS` (the link is lost: Cyton and Ganglion report `unknown`, the straps `stale`, a store an `error`),
`lossRate` (packets lost; the Cyton, the Ganglion and the H10 count them as `dropped`, the heart-rate service has no
counter), `stuckChannel`, `badChannel` with `badKind` (`railed` or `flat`), `start` (the simulated clock's start)
and `manual` (no timers: move the clock with `step(ms)`, as `test/sim.test.ts` does). A simulator is not hardware:
no route's `verified` rises because a simulator ran.

## Add a driver

1. Write the descriptor: channels with units and rates, actions, one route with `verified: 'none'`.
2. Write the driver in `src/drivers/<id>.ts`: `open(transport, ctx)` returns a `Connection`. Emit records through
   `ctx.emit`, report state through `ctx.status`, use `ctx.now()` for time. Lost link while running: `unknown`.
3. Add a golden test in `test/<id>.test.ts` from the protocol's documented bytes, and a session against
   `MemoryByteTransport` or `MemoryGattTransport`. Then raise `verified` to what the test earned, and name the test
   in `evidence`.
4. Add it to `src/registry.ts`, `src/catalog.ts` and the table above.

[CONTRIBUTING.md](CONTRIBUTING.md) has the details and what `bench` and `hardware` need.

## Write a manifest (no code)

A device that sends text lines, simple Bluetooth notifications or CSV files needs no driver: describe it.

```json
{
  "format": "exocortex.device/1",
  "descriptor": {
    "id": "custom:emg-band", "name": "My EMG band", "vendor": "Me", "placement": "arm",
    "about": "Two EMG channels from an Arduino.",
    "channels": [{ "id": "emg", "kind": "emg", "label": "EMG", "shape": "samples", "unit": "uV",
                   "rateHz": 500, "count": 2, "names": ["flexor", "extensor"], "defaultOn": true }]
  },
  "driver": {
    "type": "serial-lines", "baudRate": 115200, "init": ["start\n"], "separator": ",", "rateHz": 500,
    "columns": [{ "channel": "emg", "index": 0, "scale": 0.5 }, { "channel": "emg", "index": 1, "scale": 0.5 }]
  }
}
```

- `serial-lines`: `baudRate`, `init` (text sent on start), `separator`, `rateHz`, `columns` (`index` in the line,
  `scale`, `offset`), optional `usbVendorId` / `usbProductId` for the port chooser.
- `ble-gatt`: `service`, `characteristic`, `layout` (`offset` in bytes, `format` one of `u8 i8 u16le i16le u16be
  i16be u24be i24be u32le i32le f32le`, `scale`, `bias`), optional `repeat: { stride, count }` for several samples per
  notification, `rateHz` (without it each value is an event), `namePrefix`.
- `csv-file`: `timeColumn`, `timeFormat` (`iso`, `unix-ms`, `unix-s`), `columns` (`column` by header name or
  index, `scale`, `offset`).

`validateManifest(m)` returns `{ ok, errors }`, a sentence per problem. It is strict: unknown keys, links that are
not https, URLs in other text, control and direction-override characters, oversize manifests and channels that
nothing feeds are refused. `driverFromManifest(m)` returns a driver. Its routes are `verified: 'none'`.

## Tests

```
node --test test/*.test.ts
npx tsc --noEmit -p .        (needs typescript and @types/node)
```

## License

Apache-2.0. Copyright 2026 COMMANDAGI INC.
