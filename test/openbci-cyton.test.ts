// OpenBCI Cyton and Cyton + Daisy: packets of the Cyton Data Format, and a session against a simulated board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CytonParser, encodeCytonPacket, readBanner, uvPerCount, openbciCyton } from '../src/drivers/openbci-cyton.ts';
import { openbciCytonDaisy } from '../src/drivers/openbci-cyton-daisy.ts';
import { MemoryByteTransport, memoryContext } from '../src/transports/memory.ts';
import type { SampleChunk } from '../src/contract.ts';

// One packet written out byte by byte from the documented layout:
// 0xA0, sample 7, ch1 = 1 count, ch2 = -1, ch3 = full scale 0x7FFFFF, ch4 = 0x800000 (most negative), ch5..8 = 0,
// accel X = 0x0010, Y = 0xFFF0 (-16), Z = 0x2000 (8192), footer 0xC0.
const GOLDEN = Uint8Array.from([
  0xa0, 0x07,
  0x00, 0x00, 0x01, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x10, 0xff, 0xf0, 0x20, 0x00,
  0xc0,
]);

test('a documented packet decodes to counts, µV and g', () => {
  const [p] = new CytonParser().push(GOLDEN);
  assert.equal(p.sample, 7);
  assert.deepEqual(p.counts, [1, -1, 8388607, -8388608, 0, 0, 0, 0]);
  // 4.5 V / 24 / (2^23 − 1) = 0.02235 µV per count; full scale is 187,500 µV
  assert.ok(Math.abs(uvPerCount(24) - 0.0223517) < 1e-6);
  assert.ok(Math.abs(p.counts[2] * uvPerCount(24) - 187500) < 1e-6);
  // 0.002 / 2^4 g per count
  assert.deepEqual(p.accel, [16 * 0.000125, -16 * 0.000125, 8192 * 0.000125]);
  assert.deepEqual(encodeCytonPacket(7, [1, -1, 8388607, -8388608], [16, -16, 8192]), GOLDEN);
});

test('the parser resyncs after garbage and across split reads, and skips a bad footer', () => {
  const parser = new CytonParser();
  const bad = encodeCytonPacket(1, [5]);
  bad[32] = 0xc7;                                   // not a footer: the packet is not taken
  const good1 = encodeCytonPacket(2, [100]);
  const good2 = encodeCytonPacket(3, [200], undefined, 0xc1);   // raw aux: no accelerometer
  const stream = Uint8Array.from([0x13, 0xa0, 0x42, ...bad, ...good1, ...good2]);
  const out = [...parser.push(stream.subarray(0, 20)), ...parser.push(stream.subarray(20, 50)), ...parser.push(stream.subarray(50))];
  assert.deepEqual(out.map((p) => p.sample), [2, 3]);
  assert.equal(out[0].counts[0], 100);
  assert.equal(out[1].footer, 0xc1);
  assert.equal(out[1].accel, undefined);
  assert.ok(parser.skipped >= 36);
});

test('the banner says whether a Daisy is attached', () => {
  const daisy = 'OpenBCI V3 8-16 channel\nOn Board ADS1299 Device ID: 0x3E\nOn Daisy ADS1299 Device ID: 0x3E\nLIS3DH Device ID: 0x33\nFirmware: v3.1.2\n$$$';
  const single = 'OpenBCI V3 8-16 channel\nOn Board ADS1299 Device ID: 0x3E\nLIS3DH Device ID: 0x33\nFirmware: v3.1.2\n$$$';
  assert.deepEqual(readBanner(daisy), { daisy: true, firmware: 'v3.1.2', ok: true });
  assert.equal(readBanner(single).daisy, false);
  assert.equal(readBanner('no daisy to attach!8$$$').daisy, false);
});

/** a simulated Cyton: answers 'v' with a banner, 'b' with packets, and stops on 's' */
function simulatedBoard(banner: string, packets: Uint8Array[], replies: Record<string, string> = {}) {
  return new MemoryByteTransport('USB 0403:6015', (bytes, t) => {
    const cmd = new TextDecoder().decode(bytes);
    if (cmd === 'v') queueMicrotask(() => t.push(banner));
    else if (cmd === 'b') queueMicrotask(() => { for (const p of packets) t.push(p); });
    else if (replies[cmd]) queueMicrotask(() => t.push(replies[cmd]));
  });
}

const BANNER = 'OpenBCI V3 8-16 channel\nOn Board ADS1299 Device ID: 0x3E\nLIS3DH Device ID: 0x33\nFirmware: v3.1.2\n$$$';
const DAISY_BANNER = 'OpenBCI V3 8-16 channel\nOn Board ADS1299 Device ID: 0x3E\nOn Daisy ADS1299 Device ID: 0x3E\nLIS3DH Device ID: 0x33\nFirmware: v3.1.2\n$$$';
const tick = () => new Promise((r) => setTimeout(r, 5));

test('Cyton session: reset, stream, a dropped packet counted, stop', async () => {
  const packets: Uint8Array[] = [];
  for (let s = 0; s < 30; s++) if (s !== 12) packets.push(encodeCytonPacket(s, [s * 1000, -s], s % 10 === 0 ? [16, 0, 8192] : undefined));
  const t = simulatedBoard(BANNER, packets);
  const ctx = memoryContext({ enabled: ['eeg', 'accel', 'marker'], now: () => 1_000_000 });
  const conn = await openbciCyton.open(t, ctx);
  await conn.start();
  await tick();
  await conn.act('mark', { label: 'eyes closed' });
  await conn.stop();
  await conn.close();
  assert.equal(t.baudRate, 115200);
  assert.equal(t.writtenText(), 'svbs');
  const eeg = ctx.records.filter((r): r is SampleChunk => r.shape === 'samples' && r.channel === 'eeg');
  const n = eeg.reduce((a, r) => a + r.data[0].length, 0);
  assert.equal(n, 29);
  assert.equal(eeg.reduce((a, r) => a + (r.dropped ?? 0), 0), 1);
  assert.equal(eeg[0].rateHz, 250);
  assert.deepEqual(eeg[0].names, ['Fp1', 'Fp2', 'C3', 'C4', 'P7', 'P8', 'O1', 'O2']);
  assert.ok(Math.abs(eeg[0].data[0][1] - 1000 * uvPerCount()) < 1e-3);
  assert.equal(eeg[0].prov.firmware, 'v3.1.2');
  assert.equal(eeg[0].prov.descriptor, 'openbci-cyton');
  const accel = ctx.records.filter((r): r is SampleChunk => r.shape === 'samples' && r.channel === 'accel');
  assert.equal(accel.reduce((a, r) => a + r.data[0].length, 0), 3);
  assert.ok(ctx.records.some((r) => r.shape === 'events' && r.label === 'eyes closed'));
  assert.deepEqual(ctx.statuses.map((s) => s.state).filter((s, i, a) => s !== a[i - 1]), ['connecting', 'streaming', 'idle', 'closed']);
});

test('Cyton driver with a Daisy attached detaches it and streams 8 channels', async () => {
  const t = simulatedBoard(DAISY_BANNER, [encodeCytonPacket(1, [1])], { c: 'daisy removed$$$' });
  const ctx = memoryContext({ enabled: ['eeg'] });
  const conn = await openbciCyton.open(t, ctx);
  await conn.start();
  await tick();
  await conn.close();
  assert.equal(t.writtenText(), 'svcbs');
});

test('Cyton + Daisy session: odd packets are the board, even ones the Daisy; the first pair is dropped', async () => {
  const packets: Uint8Array[] = [];
  // samples 1..10: odd = board channels (value 100 + s), even = Daisy channels (value 200 + s)
  for (let s = 1; s <= 10; s++) packets.push(encodeCytonPacket(s, Array(8).fill(s % 2 ? 100 + s : 200 + s)));
  const t = simulatedBoard(DAISY_BANNER, packets);
  const ctx = memoryContext({ enabled: ['eeg'] });
  const conn = await openbciCytonDaisy.open(t, ctx);
  await conn.start();
  await tick();
  await conn.close();
  const eeg = ctx.records.filter((r): r is SampleChunk => r.shape === 'samples');
  const rows = eeg.flatMap((r) => Array.from(r.data[0], (_, i) => r.data.map((d) => Math.round(d[i] / uvPerCount()))));
  // pairs (1,2) dropped as the first average; then (3,4), (5,6), (7,8), (9,10)
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], [...Array(8).fill(103), ...Array(8).fill(204)]);
  assert.deepEqual(rows[3], [...Array(8).fill(109), ...Array(8).fill(210)]);
  assert.equal(eeg[0].rateHz, 125);
  assert.equal(eeg[0].names.length, 16);
  assert.equal(eeg[0].names[8], 'F7');
});

test('Cyton + Daisy refuses a board with no Daisy, with a sentence to act on', async () => {
  const t = simulatedBoard(BANNER, [], { C: 'no daisy to attach!8$$$' });
  const ctx = memoryContext({ enabled: ['eeg'] });
  const conn = await openbciCytonDaisy.open(t, ctx);
  await assert.rejects(conn.start(), /No Daisy board answered/);
  assert.equal(ctx.statuses.at(-1)?.state, 'error');
  await conn.close();
});

test('a board that never answers is an error that says what to check', async () => {
  const t = new MemoryByteTransport();
  const ctx = memoryContext({ enabled: ['eeg'], config: { bannerTimeoutMs: 20 } });
  const conn = await openbciCyton.open(t, ctx);
  await assert.rejects(conn.start(), /did not answer/);
  await conn.close();
});
