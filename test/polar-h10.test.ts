// Polar H10 over the Polar Measurement Data service: commands and frames as polar-ble-sdk lays them out, and a
// session against a simulated strap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  polarH10, parsePmdFrame, parsePmdResponse, START_ECG, START_ACC, PMD_SERVICE, PMD_CONTROL, PMD_DATA,
} from '../src/drivers/polar-h10.ts';
import { HR_SERVICE, HR_MEASUREMENT } from '../src/drivers/ble-heart-rate.ts';
import { MemoryGattTransport, memoryContext } from '../src/transports/memory.ts';
import type { SampleChunk } from '../src/contract.ts';

test('the start commands: ECG 130 Hz 14-bit, ACC 200 Hz 16-bit ±8 g', () => {
  assert.deepEqual([...START_ECG], [0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
  assert.deepEqual([...START_ACC], [0x02, 0x02, 0x00, 0x01, 0xc8, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00]);
});

/** a frame: type, uint64 LE ns timestamp, frame type, payload */
function frame(type: number, tsNs: bigint, frameType: number, payload: number[]): Uint8Array {
  const b = new Uint8Array(10 + payload.length);
  b[0] = type;
  new DataView(b.buffer).setBigUint64(1, tsNs, true);
  b[9] = frameType;
  b.set(payload, 10);
  return b;
}

test('an ECG frame (type 0): 3-byte signed LE µV samples; the timestamp is the last sample\'s', () => {
  const f = parsePmdFrame(frame(0x00, 599_634_516_000_000_000n, 0x00, [0xff, 0xff, 0xff, 0xe8, 0x03, 0x00, 0x18, 0xfc, 0xff]));
  assert.deepEqual(f, { type: 'ecg', timestampNs: 599_634_516_000_000_000n, uv: [-1, 1000, -1000] });
});

test('an ACC frame (type 1): int16 LE x, y, z in mg', () => {
  const f = parsePmdFrame(frame(0x02, 1n, 0x01, [0xe8, 0x03, 0x18, 0xfc, 0x00, 0x00]));
  assert.deepEqual(f, { type: 'acc', timestampNs: 1n, mg: [[1000, -1000, 0]] });
  assert.equal(parsePmdFrame(frame(0x02, 1n, 0x81, [1, 2, 3]))?.type, 'other');   // compressed: not read
  assert.equal(parsePmdFrame(Uint8Array.from([0, 1, 2])), null);
});

test('control point responses', () => {
  assert.deepEqual(parsePmdResponse(Uint8Array.from([0xf0, 0x02, 0x00, 0x00, 0x00])), { op: 2, measurement: 0, status: 0, why: 'success' });
  assert.equal(parsePmdResponse(Uint8Array.from([0xf0, 0x02, 0x00, 0x0d, 0x00]))?.why, 'the device is in its charger');
});

function strap(status = 0) {
  const t = new MemoryGattTransport('Polar H10 ABCD1234');
  t.onWrite = (s, c, bytes, g) => {
    if (c === PMD_CONTROL) queueMicrotask(() => g.notify(PMD_SERVICE, PMD_CONTROL, [0xf0, bytes[0], bytes[1], status, 0]));
  };
  return t;
}

test('H10 session: ECG starts, frames become 130 Hz chunks on the strap\'s spacing, HR alongside', async () => {
  const t = strap();
  let now = 50_000;
  const ctx = memoryContext({ enabled: ['ecg', 'hr', 'rr'], now: () => now });
  const conn = await polarH10.open(t, ctx);
  await conn.start();
  assert.deepEqual([...t.writes[0].bytes], [...START_ECG]);
  assert.equal(t.writes.length, 1);   // the accelerometer is off
  assert.equal(ctx.statuses.at(-1)?.state, 'streaming');
  const ms = 1_000_000n;
  // two frames of 73 samples; the second ends 73/130 s after the first
  const samples = Array.from({ length: 73 }, (_, i) => [i, 0, 0]).flat();
  t.notify(PMD_SERVICE, PMD_DATA, frame(0x00, 1_000n * ms, 0x00, samples));
  now += 562;
  t.notify(PMD_SERVICE, PMD_DATA, frame(0x00, 1_000n * ms + 561_538_461n, 0x00, samples));
  t.notify(HR_SERVICE, HR_MEASUREMENT, [0x00, 64]);
  await conn.stop();
  const ecg = ctx.records.filter((r): r is SampleChunk => r.channel === 'ecg');
  assert.equal(ecg.length, 2);
  assert.equal(ecg[0].data[0][72], 72);
  assert.equal(ecg[0].time.clock, 'device');
  // the first frame's last sample is at the host time it arrived; the chunk starts 72 samples earlier
  assert.ok(Math.abs(ecg[0].time.t0 - (50_000 - (72 * 1000) / 130)) < 1e-6);
  // the second frame continues on the strap's clock
  assert.ok(Math.abs(ecg[1].time.t0 - (50_000 + 1000 / 130)) < 0.01);
  assert.ok(ctx.records.some((r) => r.channel === 'hr'));
  assert.deepEqual([...t.writes.at(-1)!.bytes], [0x03, 0x00]);
  await conn.close();
});

test('H10 refusal: the strap in its charger is an error with the reason', async () => {
  const t = strap(13);
  const ctx = memoryContext({ enabled: ['ecg'] });
  const conn = await polarH10.open(t, ctx);
  await assert.rejects(conn.start(), /in its charger/);
  assert.equal(ctx.statuses.at(-1)?.state, 'error');
});
