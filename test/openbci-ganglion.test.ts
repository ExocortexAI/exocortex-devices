// OpenBCI Ganglion: packets laid out by the Ganglion Data Format (ids, 18/19-bit deltas with the sign in the LSB,
// the previous sample minus each delta), and a session over a simulated GATT server. Verified 'spec' only: no bytes a
// Ganglion recorded are in this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GanglionDecoder, encodeGanglionDeltas, openbciGanglion, GANGLION_SERVICE, GANGLION_RECEIVE, GANGLION_SEND, GANGLION_UV_PER_COUNT,
} from '../src/drivers/openbci-ganglion.ts';
import { MemoryGattTransport, memoryContext } from '../src/transports/memory.ts';
import type { SampleChunk } from '../src/contract.ts';

/** an independent bit writer: 8 values of `width` bits, MSB first, after the id byte */
function pack(id: number, raw: number[], width: number): Uint8Array {
  const bits: number[] = [];
  for (let b = 7; b >= 0; b--) bits.push((id >> b) & 1);
  for (const r of raw) for (let b = width - 1; b >= 0; b--) bits.push(Math.floor(r / 2 ** b) & 1);
  const out = new Uint8Array(20);
  bits.forEach((x, i) => { if (x) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}

test('a raw packet (id 0) sets the sample from four 24-bit counts', () => {
  const d = new GanglionDecoder();
  const p = new Uint8Array(20);
  p.set([0x00, 0x00, 0x00, 0x64, 0xff, 0xff, 0x9c, 0x7f, 0xff, 0xff, 0x80, 0x00, 0x00]);
  const r = d.decode(p);
  assert.equal(r.kind, 'samples');
  assert.deepEqual(r.kind === 'samples' && r.samples, [[100, -100, 8388607, -8388608]]);
  // 15686 µV over 2^23 − 1 counts
  assert.ok(Math.abs(8388607 * GANGLION_UV_PER_COUNT - 15686) < 1e-6);
});

test('19-bit deltas: the LSB is the sign, and each sample is the previous minus its delta', () => {
  const d = new GanglionDecoder();
  d.last = [1000, 1000, 1000, 1000];
  // raw 19-bit fields: 4 (positive, even), 2^19 − 3 (LSB 1: negative, = −3), 0, 10 | then 2, 2^19 − 1 (= −1), 0, 0
  const p = pack(101, [4, 2 ** 19 - 3, 0, 10, 2, 2 ** 19 - 1, 0, 0], 19);
  const r = d.decode(p);
  assert.ok(r.kind === 'samples');
  assert.deepEqual(r.samples, [[996, 1003, 1000, 990], [994, 1004, 1000, 990]]);
  assert.deepEqual(encodeGanglionDeltas(101, [4, -3, 0, 10, 2, -1, 0, 0]), p);
});

test('18-bit deltas carry one accelerometer axis in the last byte', () => {
  const d = new GanglionDecoder();
  const p = pack(2, [2, 0, 0, 0, 0, 0, 0, 2 ** 18 - 5], 18);
  p[19] = 0xfe;   // -2 counts on axis y (id % 10 = 2)
  const r = d.decode(p);
  assert.ok(r.kind === 'samples');
  assert.deepEqual(r.samples, [[-2, 0, 0, 0], [-2, 0, 0, 5]]);
  assert.deepEqual(r.accel, { axis: 1, g: -2 * 0.032 });
});

test('impedance and text packets', () => {
  const d = new GanglionDecoder();
  const imp = new Uint8Array(20);
  imp.set([203, ...new TextEncoder().encode('2470Z')]);
  assert.deepEqual(d.decode(imp), { kind: 'impedance', id: 203, channel: 3, ohms: 2470 });
  const txt = new Uint8Array(20);
  txt.set([207, ...new TextEncoder().encode('Ganglion v2')]);
  assert.deepEqual(d.decode(txt), { kind: 'text', id: 207, text: 'Ganglion v2', end: true });
});

test('a lost packet id counts two dropped samples', () => {
  const d = new GanglionDecoder();
  d.decode(encodeGanglionDeltas(101, Array(8).fill(0)));
  d.decode(encodeGanglionDeltas(103, Array(8).fill(0)));
  assert.equal(d.dropped, 1);
});

test('Ganglion session: subscribe, start with N then b, samples in µV, stop', async () => {
  const t = new MemoryGattTransport('Ganglion-1a2b');
  const ctx = memoryContext({ enabled: ['eeg', 'impedance'] });
  const conn = await openbciGanglion.open(t, ctx);
  assert.ok(t.subscribed(GANGLION_SERVICE, GANGLION_RECEIVE));
  await conn.start();
  const raw = new Uint8Array(20);
  raw.set([0, 0, 0x03, 0xe8]);   // channel 1 = 1000 counts
  t.notify(GANGLION_SERVICE, GANGLION_RECEIVE, raw);
  for (let i = 0; i < 10; i++) t.notify(GANGLION_SERVICE, GANGLION_RECEIVE, encodeGanglionDeltas(101 + i, [-3, 0, 0, 0, -3, 0, 0, 0]));
  await conn.stop();
  await conn.close();
  const sent = t.writes.filter((w) => w.characteristic === GANGLION_SEND).map((w) => new TextDecoder().decode(w.bytes)).join('');
  assert.equal(sent, 'Nbs');
  const eeg = ctx.records.filter((r): r is SampleChunk => r.shape === 'samples');
  const ch1 = eeg.flatMap((r) => Array.from(r.data[0]));
  assert.equal(ch1.length, 21);
  assert.ok(Math.abs(ch1[0] - 1000 * GANGLION_UV_PER_COUNT) < 1e-4);
  assert.ok(Math.abs(ch1[20] - 1060 * GANGLION_UV_PER_COUNT) < 1e-4);
  assert.equal(eeg[0].rateHz, 200);
});

test('a lost link while streaming is state unknown, not stopped', async () => {
  const t = new MemoryGattTransport('Ganglion');
  const ctx = memoryContext({ enabled: ['eeg'] });
  const conn = await openbciGanglion.open(t, ctx);
  await conn.start();
  t.drop();
  assert.equal(ctx.statuses.at(-1)?.state, 'unknown');
});
