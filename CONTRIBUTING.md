# Contributing a driver

Thank you for adding a device. A driver is four things: a descriptor, the driver, a golden test, and the evidence for
its `verified` level.

## 1. The descriptor

Plain data (`Descriptor` in `src/contract.ts`):

- `id`: lower-case, stable, the vendor and model (`polar-h10`).
- `channels`: each signal the device gives, with its `kind`, `unit`, `rateHz` and `count`. Mark `sensitive`
  (`health`, `neural`, `biometric`, `location`, `audio`, `video`) where it applies: apps gate these.
- `actions`: only what the driver executes. A stop is `safing: true`.
- `routes`: one per transport, with `hosts`, `needs` (what a person must have first), `freshness`, `dataLeaves`
  (`never` for a local link) and `verified`.
- `links`: the protocol's documentation.

## 2. The driver

`src/drivers/<id>.ts` exports a `Driver`. Rules:

- Use only the transport and the `OpenContext` you are handed. No DOM, no `fetch`, no timers that outlive `close()`.
- Emit records with provenance (`prov(...)` in `src/util.ts`) and timing: whose clock `t0` is on, and how far off it
  may be (`uncertaintyMs`). Never invent a time a device did not give: say `clock: 'host'`.
- Report state through `ctx.status` with a sentence a person can act on (`why`). A link lost while a device may still
  be running is `unknown`, not `idle`.
- A sequence gap is `dropped` on the next chunk. Never fill it.
- Erasable TypeScript only (no `enum`, no parameter properties, no `namespace`). No dependencies.

## 3. The golden test

`test/<id>.test.ts`, with `node:test`:

- Bytes written out from the protocol's documentation (a packet, a frame, a file), and what they decode to.
- The odd cases the documentation names: resync after garbage, a bad footer, every flag combination, an invalid value.
- A session through `MemoryByteTransport` or `MemoryGattTransport` (or `fileFrom` for a file): open, start, records,
  stop, close, and the commands the driver sent.

## 4. The evidence for `verified`

| level | what earns it | what to put in `evidence` |
|---|---|---|
| `none` | nothing yet | |
| `spec` | the golden test, from documented bytes | the test file |
| `loopback` | the driver's whole session ran against a simulated device | the test file |
| `bench` | the driver ran against the real device on a bench, with a short report: model, firmware, host, what was checked | the report's path |
| `hardware` | the same, worn, for a real session | the report's path |

Do not raise `verified` past what you did. A "works with" badge needs `bench` or `hardware`. Recorded bytes from a
real device (a capture file next to the test) are welcome: they make `spec` stronger, but they are not `bench`.

## Checks

```
node --test test/*.test.ts
npx tsc --noEmit -p .
```

By contributing you agree that your contribution is licensed under the Apache License 2.0.
