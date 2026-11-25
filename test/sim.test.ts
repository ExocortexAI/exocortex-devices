// The simulators, read end to end by the real drivers: each speaks its device's protocol over a memory transport.
// Deterministic with a seed (the clock is stepped by hand), a lossy link is counted as drops where the protocol has a
// counter, and a lost link is the state each driver gives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Driver, SampleChunk, EventRecord, IntervalRecord, Transport } from '../src/contract.ts';
import { driverFor } from '../src/registry.ts';
import { memoryContext } from '../src/transports/memory.ts';
import { bandPowers } from '../src/eeg.ts';
import { simulatorFor, SIMULATED_DRIVERS, simOptions, EegModel, Rng, RAIL_UV } from '../src/sim/index.ts';
import { CYTON_DAISY_NAMES, CYTON_NAMES } from '../src/drivers/openbci-cyton.ts';

const START = Date.UTC(2026, 10, 25, 15);
const tick = () => new Promise((r) => setTimeout(r, 0));

/** open a driver on its simulator, start it, step the clock, stop: what it emitted and the states it went through */
async function run(id: string, o: Record<string, unknown>, ms: number, enabled?: string[]) {
  const sim = simulatorFor(id, { start: START, manual: true, ...o });
  const transport = { 'openbci-cyton': 'web-serial', 'openbci-cyton-daisy': 'web-serial', 'apple-health': 'healthkit', 'health-connect': 'health-connect' }[id] ?? 'web-bluetooth';
  const drv = driverFor(id, transport as never) as Driver<Transport>;
  const ctx = memoryContext({ enabled: enabled ?? drv.descriptor.channels.map((c) => c.id), now: () => sim.now() });
  const conn = await drv.open(sim.transport, ctx);
  await conn.start();
  for (let t = 0; t < ms; t += 100) { sim.step(100); await tick(); }
  await conn.stop().catch(() => {});
  await conn.close().catch(() => {});
  sim.stop();
  const samples = (ch: string) => ctx.records.filter((r): r is SampleChunk => r.shape === 'samples' && r.channel === ch);
  return { ctx, samples, states: ctx.statuses.map((s) => s.state) };
}
const total = (cs: SampleChunk[]) => cs.reduce((a, r) => a + r.data[0].length, 0);
const dropped = (cs: SampleChunk[]) => cs.reduce((a, r) => a + (r.dropped ?? 0), 0);
const rows = (cs: SampleChunk[], i: number) => cs.flatMap((r) => Array.from(r.data[i]));

test('every simulator has a driver, and options come from a plain config', () => {
  const stores: Record<string, 'healthkit' | 'health-connect'> = { 'apple-health': 'healthkit', 'health-connect': 'health-connect' };
  for (const id of SIMULATED_DRIVERS) assert.ok(driverFor(id, stores[id] ?? (id.startsWith('openbci-cyton') ? 'web-serial' : 'web-bluetooth')), id);
  assert.deepEqual(simOptions({ seed: '7', speed: 2, lossRate: 3, badKind: 'flat' }), { seed: 7, speed: 2, disconnectAfterS: undefined, lossRate: undefined, stuckChannel: undefined, badChannel: undefined, badKind: 'flat', start: undefined, manual: undefined });
  assert.throws(() => simulatorFor('no-such-driver'), /no simulator/);
});

test('the EEG looks like EEG: alpha rises with the eyes closed, mostly at the back; blinks on Fp1/Fp2; 60 Hz mains', () => {
  const m = new EegModel(CYTON_NAMES, 250, new Rng(3));
  const s = Array.from({ length: 250 * 90 }, () => m.next());
  const sec = (i: number, c: number) => s.slice(i * 250, (i + 1) * 250).map((x) => x[c]);
  const O1 = CYTON_NAMES.indexOf('O1'), Fp1 = CYTON_NAMES.indexOf('Fp1');
  const closed: number[] = [], open: number[] = [];
  for (let i = 1; i < 89; i++) (m.eyesClosed(i + 0.5) && m.eyesClosed(i) && m.eyesClosed(i + 0.99) ? closed : !m.eyesClosed(i) && !m.eyesClosed(i + 0.99) ? open : []).push(i);
  assert.ok(closed.length > 5 && open.length > 5);
  const alpha = (secs: number[], c: number) => secs.reduce((a, i) => a + bandPowers(sec(i, c), 250).alpha, 0) / secs.length;
  assert.ok(alpha(closed, O1) > 4 * alpha(open, O1), 'alpha rises with the eyes closed');
  assert.ok(alpha(closed, O1) > 5 * alpha(closed, Fp1), 'alpha is posterior');
  const peak = (c: number) => Math.max(...open.map((i) => Math.max(...sec(i, c))));
  assert.ok(peak(Fp1) > 100 && peak(O1) < 100, 'blinks on Fp1, not O1');
  // the mains: power at 60 Hz well above its neighbours
  const at = (x: number[], f: number) => Math.hypot(x.reduce((a, v, i) => a + v * Math.cos((2 * Math.PI * f * i) / 250), 0), x.reduce((a, v, i) => a + v * Math.sin((2 * Math.PI * f * i) / 250), 0));
  assert.ok(at(sec(open[0], O1), 60) > 5 * at(sec(open[0], O1), 52), 'the mains at 60 Hz');
  const flat = new EegModel(CYTON_NAMES, 250, new Rng(3), { badChannel: 2, badKind: 'railed', stuckChannel: 3 });
  const f = Array.from({ length: 50 }, () => flat.next());
  assert.ok(f.every((x) => x[1] === RAIL_UV) && f.every((x) => x[2] === f[0][2]));
});

test('Cyton + Daisy: the driver reads 16 channels at 125 Hz from the simulated board, with its firmware', async () => {
  const { samples, ctx, states } = await run('openbci-cyton-daisy', { seed: 5 }, 2000, ['eeg', 'accel']);
  const eeg = samples('eeg');
  assert.equal(eeg[0].names.length, 16);
  assert.deepEqual(eeg[0].names, CYTON_DAISY_NAMES);
  assert.equal(eeg[0].rateHz, 125);
  assert.equal(eeg[0].prov.firmware, 'v3.1.2');
  assert.ok(Math.abs(total(eeg) - 249) <= 2, `${total(eeg)} samples in 2 s`);
  assert.equal(dropped(eeg), 0);
  assert.ok(samples('accel').length > 0);
  assert.ok(rows(samples('accel'), 2).every((z) => Math.abs(z - 1) < 0.1), 'gravity on z');
  assert.ok(states.includes('streaming'));
  assert.ok(ctx.records.every((r) => r.prov.descriptor === 'openbci-cyton-daisy'));
});

test('a seed gives the same samples; another seed other samples', async () => {
  const a = rows((await run('openbci-cyton', { seed: 11 }, 600, ['eeg'])).samples('eeg'), 0);
  const b = rows((await run('openbci-cyton', { seed: 11 }, 600, ['eeg'])).samples('eeg'), 0);
  const c = rows((await run('openbci-cyton', { seed: 12 }, 600, ['eeg'])).samples('eeg'), 0);
  assert.equal(a.length, 151);   // the first packet at 0 ms, then one every 4 ms
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const h1 = (await run('apple-health', { seed: 4 }, 0)).ctx.records, h2 = (await run('apple-health', { seed: 4 }, 0)).ctx.records;
  assert.deepEqual(h1.map((r) => r.prov.providerRecordId), h2.map((r) => r.prov.providerRecordId));
});

test('a lossy link: the drivers count what was lost (Cyton, Daisy, Ganglion, H10)', async () => {
  const cy = (await run('openbci-cyton', { seed: 2, lossRate: 0.05 }, 4000, ['eeg'])).samples('eeg');
  assert.ok(dropped(cy) > 20, `${dropped(cy)} lost`);
  // every packet sent in 4 s is a sample or a counted drop (a loss at the very end has nothing after it to show it)
  assert.ok(total(cy) + dropped(cy) >= 995 && total(cy) + dropped(cy) <= 1001, `${total(cy)} + ${dropped(cy)}`);
  const dz = (await run('openbci-cyton-daisy', { seed: 2, lossRate: 0.05 }, 4000, ['eeg'])).samples('eeg');
  assert.ok(dropped(dz) > 10 && total(dz) + dropped(dz) >= 495 && total(dz) + dropped(dz) <= 501, `${total(dz)} + ${dropped(dz)}`);
  const g = (await run('openbci-ganglion', { seed: 2, lossRate: 0.05 }, 4000, ['eeg'])).samples('eeg');
  assert.ok(dropped(g) > 10, `${dropped(g)} lost`);
  // the values come back after a loss: the EEG stays within a few hundred µV
  assert.ok(rows(g, 0).every((v) => Math.abs(v) < 2000));
  const h = (await run('polar-h10', { seed: 2, lossRate: 0.2 }, 20000, ['ecg'])).samples('ecg');
  assert.ok(dropped(h) >= 73, `${dropped(h)} lost`);
});

test('Ganglion: 4 channels at 200 Hz from the compressed packets, and the contact check', async () => {
  const { samples, ctx } = await run('openbci-ganglion', { seed: 1, badChannel: 3 }, 2000, ['eeg', 'impedance']);
  const eeg = samples('eeg');
  assert.ok(Math.abs(total(eeg) - 400) <= 2, `${total(eeg)}`);
  assert.equal(eeg[0].rateHz, 200);
  assert.equal(dropped(eeg), 0);
  // the decoded signal matches what the board meant within the format's lost bit
  const m = new EegModel(['1', '2', '3', '4'], 200, new Rng(1).fork(1), { badChannel: 3 });
  const want = Array.from({ length: 50 }, () => m.next()[0]);
  rows(eeg, 0).slice(0, 50).forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.05, `${v} vs ${want[i]}`));
  void ctx;
});

test('a heart-rate strap: heart rate near 60 and RR intervals that vary', async () => {
  const { ctx } = await run('ble-heart-rate', { seed: 1 }, 30000);
  const hr = ctx.records.filter((r): r is EventRecord => r.channel === 'hr');
  const rr = ctx.records.filter((r): r is EventRecord => r.channel === 'rr').map((r) => r.value!);
  assert.ok(hr.length >= 28);
  assert.ok(hr.every((r) => r.value! > 45 && r.value! < 80));
  assert.ok(rr.length > 25 && Math.max(...rr) - Math.min(...rr) > 30, 'RR varies');
});

test('Polar H10: ECG at 130 Hz with one R peak a beat, and the accelerometer', async () => {
  const { samples, ctx } = await run('polar-h10', { seed: 1 }, 10000, ['ecg', 'accel', 'hr', 'rr']);
  const ecg = rows(samples('ecg'), 0);
  assert.ok(ecg.length >= 73 * 17, `${ecg.length}`);
  assert.equal(samples('ecg')[0].rateHz, 130);
  const peaks = ecg.filter((v, i) => v > 700 && v >= ecg[i - 1] && v > (ecg[i + 1] ?? -Infinity)).length;
  const beats = ctx.records.filter((r) => r.channel === 'rr').length;
  assert.ok(Math.abs(peaks - beats) <= 2, `${peaks} R peaks, ${beats} beats`);
  assert.ok(rows(samples('accel'), 0).every((x) => Math.abs(x - 980) < 60));
});

test('a lost link: Cyton and Ganglion unknown, the straps stale, a health store an error', async () => {
  assert.equal((await run('openbci-cyton', { disconnectAfterS: 1 }, 1500, ['eeg'])).states.find((s) => s === 'unknown'), 'unknown');
  assert.ok((await run('openbci-ganglion', { disconnectAfterS: 1 }, 1500, ['eeg'])).states.includes('unknown'));
  assert.ok((await run('ble-heart-rate', { disconnectAfterS: 1 }, 1500)).states.includes('stale'));
  assert.ok((await run('polar-h10', { disconnectAfterS: 1 }, 1500, ['ecg'])).states.includes('stale'));
  const sim = simulatorFor('health-connect', { start: START, manual: true, disconnectAfterS: 1 });
  const drv = driverFor('health-connect', 'health-connect')!;
  const ctx = memoryContext({ enabled: ['hr'], now: () => sim.now() });
  const conn = await drv.open(sim.transport as never, ctx);
  sim.step(2000);
  await conn.start();
  assert.equal(ctx.statuses.at(-1)?.state, 'error');
});

for (const id of ['apple-health', 'health-connect']) {
  test(`${id}: 30 days of heart rate, HRV, steps, sleep stages and workouts, with uuids, anchors and a deletion`, async () => {
    const sim = simulatorFor(id, { start: START, manual: true, seed: 3 });
    const drv = driverFor(id, id === 'apple-health' ? 'healthkit' : 'health-connect')!;
    const ctx = memoryContext({ enabled: drv.descriptor.channels.map((c) => c.id), now: () => sim.now() });
    const conn = await drv.open(sim.transport as never, ctx);
    await conn.start();
    const by = (ch: string) => ctx.records.filter((r) => r.channel === ch);
    const hr = by('hr') as EventRecord[];
    assert.ok(hr.length > 8000, `${hr.length} heart rates`);
    assert.ok(hr[0].time.t0 < START - 29 * 86400_000 && hr.at(-1)!.time.t0 <= START);
    assert.ok(hr.every((r) => r.value! > 35 && r.value! < 200));
    const sleep = by('sleep') as IntervalRecord[];
    assert.ok(['deep', 'rem', 'light', 'awake'].every((s) => sleep.some((r) => r.label === s)));
    assert.ok(by('workout').length >= 10);
    assert.ok(by(id === 'apple-health' ? 'hrv-sdnn' : 'hrv-rmssd').length >= 30);
    assert.ok(by('steps').length > 300);
    assert.ok(ctx.records.every((r) => r.prov.providerRecordId && /^[0-9a-fA-F-]{36}(:\d+)?$/.test(r.prov.providerRecordId) || (r.shape === 'events' && r.label === 'device.deleted')));
    if (id === 'apple-health') assert.ok(by('ecg').some((r) => r.shape === 'samples'));
    // a minute later: the deleted workout, and new heart rates since; nothing old again (the anchors)
    const before = ctx.records.length;
    sim.step(5 * 60_000);
    assert.equal((await conn.act('sync')).outcome, 'done');
    const later = ctx.records.slice(before);
    const del = later.find((r) => r.shape === 'events' && r.label === 'device.deleted') as EventRecord;
    assert.ok(del && by('workout').some((w) => w.prov.providerRecordId === (del.fields!.ids as string[])[0]));
    assert.ok(later.length < 20, `${later.length} new records`);
    await conn.close();
    sim.stop();
  });
}
