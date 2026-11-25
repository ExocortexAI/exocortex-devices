// The health-store drivers against a fake store that behaves as HealthKit and Health Connect do: pages by anchor,
// deletions, Health Connect's series records and changed records, a store that refuses access. Golden: the records
// each store record becomes, with their provenance and timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceRecord, HealthSample, HealthStoreTransport, OpenContext, Status } from '../src/contract.ts';
import { appleHealthDriver } from '../src/drivers/apple-health.ts';
import { healthConnectDriver } from '../src/drivers/health-connect.ts';
import { HEALTH_TYPES, ECG_CHUNK, typesOf } from '../src/health.ts';

const NOW = Date.UTC(2026, 10, 25, 12);
const T = Date.UTC(2026, 10, 24, 23);

/** a store: per type a list of records and deletions in arrival order; the anchor is the index reached */
function fakeStore(kind: 'healthkit' | 'health-connect', data: Record<string, (HealthSample | { deleted: string })[]>, o: { grant?: 'all' | 'none' | 'unknown'; available?: boolean } = {}) {
  const asked: string[][] = [], queries: { type: string; anchor: string | null; limit: number }[] = [];
  const t: HealthStoreTransport = {
    kind,
    async available() { return o.available ?? true; },
    async authorize(types) {
      asked.push(types);
      if (o.grant === 'none') return { granted: [], unknown: [] };
      if (o.grant === 'unknown' || kind === 'healthkit') return { granted: [], unknown: types };   // HealthKit never says
      return { granted: types, unknown: [] };
    },
    async query(type, anchor, limit) {
      queries.push({ type, anchor, limit });
      const all = data[type] ?? [];
      const from = anchor === null ? 0 : Number(anchor);
      const page = all.slice(from, from + limit);
      return {
        records: page.filter((x): x is HealthSample => !('deleted' in x)),
        deleted: page.filter((x): x is { deleted: string } => 'deleted' in x).map((x) => x.deleted),
        anchor: String(from + page.length),
      };
    },
  };
  return { t, asked, queries };
}

function context(host: 'ios' | 'android', enabled: string[], config: Record<string, unknown> = {}) {
  const out: DeviceRecord[] = [], statuses: Status[] = [];
  const ctx: OpenContext = { instance: 'inst-1', host, enabled: new Set(enabled), config, emit: (r) => out.push(r), status: (s) => statuses.push(s), now: () => NOW };
  return { ctx, out, statuses };
}

const hk = (uuid: string, type: string, start: number, end: number, extra: Partial<HealthSample> = {}): HealthSample =>
  ({ uuid, type, start, end, sourceApp: 'Apple Watch', device: { name: 'Apple Watch', model: 'Watch', manufacturer: 'Apple Inc.', firmware: '11.1' }, tzOffsetMin: -360, ...extra });

test('every type has a native name on at least one store; vendor scores are not in the table', () => {
  for (const t of HEALTH_TYPES) assert.ok(t.healthkit || t.healthConnect, t.key);
  assert.ok(!HEALTH_TYPES.some((t) => /readiness|recovery|strain/i.test(t.key + t.label)));
  assert.deepEqual(typesOf('healthkit').map((t) => t.key).includes('ecg'), true);
  assert.deepEqual(typesOf('health-connect').map((t) => t.key).includes('ecg'), false);
  assert.ok(appleHealthDriver.descriptor.channels.every((c) => c.sensitive === 'health'));
  assert.equal(appleHealthDriver.descriptor.routes[0].verified, 'none');
});

test('Apple Health: heart rate, SpO2 scaled to percent, HRV with its statistic, sleep stages, a workout, golden', async () => {
  const s = fakeStore('healthkit', {
    HKQuantityTypeIdentifierHeartRate: [hk('A1', 'HKQuantityTypeIdentifierHeartRate', T, T, { value: 61, unit: 'count/min' })],
    HKQuantityTypeIdentifierOxygenSaturation: [hk('A2', 'HKQuantityTypeIdentifierOxygenSaturation', T, T, { value: 0.97, unit: '%' })],
    HKQuantityTypeIdentifierHeartRateVariabilitySDNN: [hk('A3', 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', T, T + 60_000, { value: 48.5, unit: 'ms' })],
    HKCategoryTypeIdentifierSleepAnalysis: [
      hk('S1', 'HKCategoryTypeIdentifierSleepAnalysis', T, T + 1_800_000, { category: 'asleepCore', sourceApp: 'Oura', device: undefined }),
      hk('S2', 'HKCategoryTypeIdentifierSleepAnalysis', T + 1_800_000, T + 3_600_000, { category: 'asleepREM', sourceApp: 'Oura', device: undefined }),
    ],
    HKWorkoutTypeIdentifier: [hk('W1', 'HKWorkoutTypeIdentifier', T, T + 2_400_000, { category: 'running', fields: { energyKcal: 310, distanceM: 5020 } })],
  });
  const { ctx, out, statuses } = context('ios', ['hr', 'spo2', 'hrv-sdnn', 'sleep', 'workout']);
  const c = await appleHealthDriver.open(s.t, ctx);
  await c.start();
  assert.deepEqual(s.asked[0], ['HKQuantityTypeIdentifierHeartRate', 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'HKQuantityTypeIdentifierOxygenSaturation', 'HKCategoryTypeIdentifierSleepAnalysis', 'HKWorkoutTypeIdentifier']);
  const prov = { instance: 'inst-1', descriptor: 'apple-health', host: 'ios', transport: 'healthkit', sourceApp: 'Apple Watch', model: 'Watch', firmware: '11.1' };
  const time = { t0: T, receivedAt: NOW, tzOffsetMin: -360, clock: 'vendor' };
  const dev = { deviceName: 'Apple Watch', manufacturer: 'Apple Inc.' };
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [
    { channel: 'hr', prov: { ...prov, providerRecordId: 'A1' }, time, shape: 'events', label: 'heart rate', value: 61, unit: 'bpm', fields: dev },
    { channel: 'hrv-sdnn', prov: { ...prov, providerRecordId: 'A3' }, time, shape: 'intervals', end: T + 60_000, label: 'heart rate variability (sdnn)', value: 48.5, unit: 'ms', method: 'SDNN', fields: dev },
    { channel: 'spo2', prov: { ...prov, providerRecordId: 'A2' }, time, shape: 'events', label: 'blood oxygen', value: 97, unit: '%', fields: dev },
    { channel: 'sleep', prov: { instance: 'inst-1', descriptor: 'apple-health', host: 'ios', transport: 'healthkit', providerRecordId: 'S1', sourceApp: 'Oura' }, time, shape: 'intervals', end: T + 1_800_000, label: 'light', method: 'Oura', fields: { stage: 'asleepCore' } },
    { channel: 'sleep', prov: { instance: 'inst-1', descriptor: 'apple-health', host: 'ios', transport: 'healthkit', providerRecordId: 'S2', sourceApp: 'Oura' }, time: { ...time, t0: T + 1_800_000 }, shape: 'intervals', end: T + 3_600_000, label: 'rem', method: 'Oura', fields: { stage: 'asleepREM' } },
    { channel: 'workout', prov: { ...prov, providerRecordId: 'W1' }, time, shape: 'intervals', end: T + 2_400_000, label: 'running', method: 'Apple Watch', fields: { ...dev, energyKcal: 310, distanceM: 5020 } },
  ]);
  assert.equal(statuses.at(-1)?.state, 'streaming');
  assert.equal(statuses.at(-1)?.info?.caughtUp, 'yes');
  // the anchors are kept in the config: a re-open asks from where it stopped
  assert.equal((ctx.config.anchors as Record<string, string>).HKQuantityTypeIdentifierHeartRate, '1');
});

test('Apple Health: an ECG becomes a summary and chunks of voltages', async () => {
  const volts = Array.from({ length: 15_360 }, (_, i) => Math.sin(i / 10) * 800);
  const s = fakeStore('healthkit', { HKDataTypeIdentifierElectrocardiogram: [hk('E1', 'HKDataTypeIdentifierElectrocardiogram', T, T + 30_000, { fields: { hz: 512, voltages: volts, classification: 'sinusRhythm', averageHeartRate: 64, lead: 'I' } })] });
  const { ctx, out } = context('ios', ['ecg']);
  await (await appleHealthDriver.open(s.t, ctx)).start();
  assert.equal(out.length, 1 + Math.ceil(15_360 / ECG_CHUNK));
  const [sum, first, second] = out;
  assert.equal(sum.shape, 'intervals');
  assert.deepEqual(sum.shape === 'intervals' && sum.fields, { deviceName: 'Apple Watch', manufacturer: 'Apple Inc.', classification: 'sinusRhythm', symptoms: undefined, lead: 'I', hz: 512, voltages: 15_360 });
  assert.equal(first.shape === 'samples' && first.data[0].length, ECG_CHUNK);
  assert.equal(first.prov.providerRecordId, 'E1:0');
  assert.equal(second.time.t0, T + (ECG_CHUNK / 512) * 1000);
  assert.equal(second.shape === 'samples' && second.unit, 'uV');
});

test('pages until the store has no more; a pass stops at its budget and the next resumes; deletions are events', async () => {
  const recs: (HealthSample | { deleted: string })[] = Array.from({ length: 25 }, (_, i) => hk(`H${i}`, 'HKQuantityTypeIdentifierHeartRate', T + i * 1000, T + i * 1000, { value: 60 + i }));
  recs.push({ deleted: 'H3' });
  const s = fakeStore('healthkit', { HKQuantityTypeIdentifierHeartRate: recs });
  const config: Record<string, unknown> = { pageSize: 10, pagesPerPass: 2 };
  const { ctx, out } = context('ios', ['hr'], config);
  const c = await appleHealthDriver.open(s.t, ctx);
  await c.start();
  assert.equal(out.length, 20);
  assert.deepEqual(config.anchors, { HKQuantityTypeIdentifierHeartRate: '20' });
  assert.deepEqual(await c.act('sync'), { outcome: 'done' });
  assert.equal(out.length, 26);
  const del = out.at(-6)!;
  assert.equal(del.shape === 'events' && del.label, 'device.deleted');
  assert.deepEqual(del.shape === 'events' && del.fields, { ids: ['H3'] });
  // a re-open with the saved config asks from the anchor, and finds nothing new
  const again = context('ios', ['hr'], JSON.parse(JSON.stringify(config)));
  await (await appleHealthDriver.open(s.t, again.ctx)).start();
  assert.equal(again.out.length, 0);
  assert.equal(s.queries.at(-1)!.anchor, '26');
});

test('Health Connect: a heart-rate series, a sleep session with stages, a changed record, skin temperature deltas, golden', async () => {
  const hc = (uuid: string, type: string, start: number, end: number, extra: Partial<HealthSample> = {}): HealthSample =>
    ({ uuid, type, start, end, sourceApp: 'com.sec.android.app.shealth', device: { manufacturer: 'samsung', model: 'SM-R960' }, tzOffsetMin: 60, ...extra });
  const s = fakeStore('health-connect', {
    HeartRateRecord: [hc('hr-1', 'HeartRateRecord', T, T + 2000, { fields: { samples: [{ t: T, bpm: 58 }, { t: T + 1000, bpm: 59 }] } })],
    SleepSessionRecord: [hc('sl-1', 'SleepSessionRecord', T, T + 3_000_000, { sourceApp: 'com.ouraring.oura', device: undefined, fields: { changed: true, stages: [{ start: T, end: T + 1_000_000, stage: 'light' }, { start: T + 1_000_000, end: T + 3_000_000, stage: 'deep' }] } })],
    SkinTemperatureRecord: [hc('sk-1', 'SkinTemperatureRecord', T, T + 3_000_000, { fields: { baseline: 33.5, deltas: [{ t: T, delta: 0.2 }, { t: T + 60_000, delta: 0.4 }] } })],
  });
  const { ctx, out } = context('android', ['hr', 'sleep', 'wrist-temp']);
  await (await healthConnectDriver.open(s.t, ctx)).start();
  const prov = { instance: 'inst-1', descriptor: 'health-connect', host: 'android', transport: 'health-connect', sourceApp: 'com.sec.android.app.shealth', model: 'SM-R960' };
  const time = { t0: T, receivedAt: NOW, tzOffsetMin: 60, clock: 'vendor' };
  const g = JSON.parse(JSON.stringify(out));
  assert.deepEqual(g.slice(0, 2), [
    { channel: 'hr', prov: { ...prov, providerRecordId: 'hr-1:0' }, time, shape: 'events', label: 'heart rate', value: 58, unit: 'bpm', fields: { manufacturer: 'samsung' } },
    { channel: 'hr', prov: { ...prov, providerRecordId: 'hr-1:1' }, time: { ...time, t0: T + 1000 }, shape: 'events', label: 'heart rate', value: 59, unit: 'bpm', fields: { manufacturer: 'samsung' } },
  ]);
  // the table's order: wrist temperature, then sleep
  assert.equal(g[2].channel, 'wrist-temp');
  assert.equal(g[2].value, 33.8);
  assert.equal(g[2].method, 'baseline plus the mean delta');
  // the changed session: removed first, then its stages again
  assert.deepEqual(g[3], { channel: 'sleep', shape: 'events', label: 'device.deleted', fields: { ids: ['sl-1'] }, prov: { instance: 'inst-1', descriptor: 'health-connect', host: 'android', transport: 'health-connect' }, time: { t0: NOW, receivedAt: NOW, clock: 'host' } });
  assert.deepEqual(g.slice(4, 6).map((r: any) => [r.prov.providerRecordId, r.label, r.time.t0, r.end, r.method, r.fields.stage]), [
    ['sl-1:0', 'light', T, T + 1_000_000, 'com.ouraring.oura', 'light'],
    ['sl-1:1', 'deep', T + 1_000_000, T + 3_000_000, 'com.ouraring.oura', 'deep'],
  ]);
  assert.equal(g.length, 6);
});

test('a store with no access says so; an unavailable store is an error a person can act on', async () => {
  const none = fakeStore('health-connect', {}, { grant: 'none' });
  const a = context('android', ['hr']);
  await (await healthConnectDriver.open(none.t, a.ctx)).start();
  assert.equal(a.statuses.at(-1)?.state, 'revoked');
  assert.equal(none.queries.length, 0);
  const gone = fakeStore('health-connect', {}, { available: false });
  const b = context('android', ['hr']);
  await (await healthConnectDriver.open(gone.t, b.ctx)).start();
  assert.equal(b.statuses.at(-1)?.state, 'error');
  assert.match(b.statuses.at(-1)?.why ?? '', /Health Connect/);
});

test('only the enabled channels are asked for and read', async () => {
  const s = fakeStore('healthkit', { HKQuantityTypeIdentifierStepCount: [hk('st', 'HKQuantityTypeIdentifierStepCount', T, T + 3_600_000, { value: 812 })] });
  const { ctx, out } = context('ios', ['steps']);
  await (await appleHealthDriver.open(s.t, ctx)).start();
  assert.deepEqual(s.asked[0], ['HKQuantityTypeIdentifierStepCount']);
  assert.deepEqual(s.queries.map((q) => q.type), ['HKQuantityTypeIdentifierStepCount']);
  assert.equal(out.length, 1);
  assert.equal(out[0].shape === 'intervals' && out[0].value, 812);
});
