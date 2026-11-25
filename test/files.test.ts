// The file drivers, each over a small file built here from its format's spec and read through the driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edf, readEdf, classifySignal, parseTals, type EdfHeader } from '../src/drivers/edf.ts';
import { fit, readFit, FIT_EPOCH_MS } from '../src/drivers/fit.ts';
import { gpx } from '../src/drivers/gpx.ts';
import { appleHealthExport, parseHealthDate, parseHealthDevice } from '../src/drivers/apple-health-export.ts';
import { csv, csvFields } from '../src/drivers/csv.ts';
import { fileFrom, textChunks } from '../src/util.ts';
import { memoryContext } from '../src/transports/memory.ts';
import type { DeviceRecord, EventRecord, IntervalRecord, SampleChunk } from '../src/contract.ts';

const enc = new TextEncoder();

async function importAll(driver: typeof edf, name: string, content: Uint8Array | string, enabled: string[], config: Record<string, unknown> = {}, chunkSize = 7) {
  const ctx = memoryContext({ enabled, config, now: () => 1 });
  const conn = await driver.open(fileFrom(name, content, chunkSize), ctx);
  await conn.start();
  await conn.close();
  return ctx;
}

// ----- EDF / BDF -------------------------------------------------------------------------------------------------

/** an EDF(+) or BDF file: signals of { label, unit, pmin, pmax, dmin, dmax, n, samples per record } */
function buildEdf(o: {
  bdf?: boolean; reserved: string; recording?: string; date: string; time: string; duration: number;
  signals: { label: string; unit: string; pmin: number; pmax: number; dmin: number; dmax: number; n: number }[];
  records: (number[] | Uint8Array)[][];
}): Uint8Array {
  const pad = (s: string, n: number) => s.padEnd(n, ' ').slice(0, n);
  const ns = o.signals.length;
  const width = o.bdf ? 3 : 2;
  let h = '';
  h += o.bdf ? ' BIOSEMI' : pad('0', 8);
  h += pad('X X X X', 80) + pad(o.recording ?? 'Startdate X X X X', 80) + o.date + o.time;
  h += pad(String(256 + ns * 256), 8) + pad(o.reserved, 44) + pad(String(o.records.length), 8) + pad(String(o.duration), 8) + pad(String(ns), 4);
  const each = (f: (s: (typeof o.signals)[number]) => string, n: number) => o.signals.map((s) => pad(f(s), n)).join('');
  h += each((s) => s.label, 16) + each(() => '', 80) + each((s) => s.unit, 8) + each((s) => String(s.pmin), 8) + each((s) => String(s.pmax), 8);
  h += each((s) => String(s.dmin), 8) + each((s) => String(s.dmax), 8) + each(() => '', 80) + each((s) => String(s.n), 8) + each(() => '', 32);
  const head = Uint8Array.from(h, (c) => c.charCodeAt(0));
  if (o.bdf) head[0] = 0xff;
  const body: number[] = [];
  for (const rec of o.records) {
    rec.forEach((sig, k) => {
      if (sig instanceof Uint8Array) { const b = new Uint8Array(o.signals[k].n * width); b.set(sig); body.push(...b); return; }
      for (const v of sig) { const x = v < 0 ? v + 2 ** (8 * width) : v; for (let i = 0; i < width; i++) body.push((x >> (8 * i)) & 0xff); }
    });
  }
  return Uint8Array.from([...head, ...body]);
}

test('EDF+: physical values, the record times from the timekeeping TAL, annotations as events and intervals', async () => {
  const tal0 = enc.encode('+0\x14\x14\x00+0.5\x15\x31.5\x14Eyes closed\x14\x00');
  const tal1 = enc.encode('+1\x14\x14\x00+1.25\x14Blink\x14\x00');
  const file = buildEdf({
    reserved: 'EDF+C', recording: 'Startdate 02-MAR-2002 X X X', date: '02.03.02', time: '13.14.15', duration: 1,
    signals: [
      { label: 'EEG Fp1-REF', unit: 'uV', pmin: -3200, pmax: 3200, dmin: -32768, dmax: 32767, n: 4 },
      { label: 'ECG', unit: 'mV', pmin: -10, pmax: 10, dmin: -2048, dmax: 2047, n: 2 },
      { label: 'EDF Annotations', unit: '', pmin: -1, pmax: 1, dmin: -32768, dmax: 32767, n: 30 },
    ],
    records: [[[0, 32767, -32768, 100], [2047, -2048], tal0], [[1, 2, 3, 4], [0, 0], tal1]],
  });
  const items = [];
  for await (const x of readEdf(fileFrom('a.edf', file, 13).chunks(), 0)) items.push(x);
  const header = items[0] as EdfHeader;
  assert.equal(header.format, 'EDF+C');
  assert.equal(header.start, Date.UTC(2002, 2, 2, 13, 14, 15));

  const ctx = await importAll(edf, 'a.edf', file, ['eeg', 'ecg', 'annotations'], { tzOffsetMin: 60 });
  const start = Date.UTC(2002, 2, 2, 12, 14, 15);   // 13:14:15 at UTC+1
  const eeg = ctx.records.filter((r): r is SampleChunk => r.channel === 'eeg');
  assert.equal(eeg.length, 2);
  assert.deepEqual(eeg[0].names, ['Fp1-REF']);
  assert.equal(eeg[0].rateHz, 4);
  assert.equal(eeg[0].time.t0, start);
  assert.equal(eeg[1].time.t0, start + 1000);
  const gain = 6400 / 65535;
  assert.ok(Math.abs(eeg[0].data[0][1] - ((32767 + 32768) * gain - 3200)) < 1e-3);
  const ecg = ctx.records.filter((r): r is SampleChunk => r.channel === 'ecg');
  assert.equal(ecg[0].unit, 'uV');            // mV is converted, so boards compare
  assert.ok(Math.abs(ecg[0].data[0][0] - 10_000) < 1e-2);
  const ann = ctx.records.filter((r) => r.channel === 'annotations');
  assert.deepEqual(ann.map((r) => [r.shape, (r as EventRecord).label, r.time.t0]), [['intervals', 'Eyes closed', start + 500], ['events', 'Blink', start + 1250]]);
  assert.equal((ann[0] as IntervalRecord).end, start + 2000);
});

test('BDF: 24-bit samples', async () => {
  const file = buildEdf({
    bdf: true, reserved: '24BIT', date: '25.11.26', time: '08.00.00', duration: 1,
    signals: [{ label: 'Fz', unit: 'uV', pmin: -262144, pmax: 262143, dmin: -8388608, dmax: 8388607, n: 3 }],
    records: [[[-8388608, 0, 8388607]]],
  });
  const ctx = await importAll(edf, 'b.bdf', file, ['eeg'], { tzOffsetMin: 0 });
  const [c] = ctx.records as SampleChunk[];
  assert.equal(c.prov.model, 'BDF');
  assert.equal(c.time.t0, Date.UTC(2026, 10, 25, 8));
  assert.ok(Math.abs(c.data[0][0] + 262144) < 1e-6);
  assert.ok(Math.abs(c.data[0][2] - 262143) < 1e-6);
});

test('EDF labels and TALs', () => {
  assert.deepEqual(classifySignal('EEG C3-A2'), { channel: 'eeg', name: 'C3-A2' });
  assert.deepEqual(classifySignal('EKG'), { channel: 'ecg', name: 'EKG' });
  assert.deepEqual(classifySignal('O2'), { channel: 'eeg', name: 'O2' });
  assert.deepEqual(classifySignal('SpO2'), { channel: 'other', name: 'SpO2' });
  assert.deepEqual(parseTals(enc.encode('+3\x1520\x14Sleep stage W\x14Lights off\x14\x00\x00')), [{ onset: 3, duration: 20, text: ['Sleep stage W', 'Lights off'] }]);
});

test('a file that is not EDF says so', async () => {
  const ctx = memoryContext({ enabled: ['eeg'] });
  const conn = await edf.open(fileFrom('x.edf', 'hello'), ctx);
  await assert.rejects(conn.start(), /shorter than an EDF header/);
  assert.equal(ctx.statuses.at(-1)?.state, 'error');
});

// ----- FIT -------------------------------------------------------------------------------------------------------

/** a FIT file from records already encoded */
function buildFit(records: number[]): Uint8Array {
  const h = new Uint8Array(14);
  const v = new DataView(h.buffer);
  h[0] = 14; h[1] = 0x20; v.setUint16(2, 2132, true); v.setUint32(4, records.length, true);
  h.set(enc.encode('.FIT'), 8);
  return Uint8Array.from([...h, ...records, 0, 0]);
}
const u16 = (x: number) => [x & 0xff, (x >> 8) & 0xff];
const u32 = (x: number) => [x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >>> 24) & 0xff];

test('FIT: file_id, records with a compressed timestamp, hrv, a lap and a session', async () => {
  const ts = 1_100_000_000;                     // seconds since 1989-12-31
  const lat = Math.round(37.5 / (180 / 2 ** 31)), lon = Math.round(-122.25 / (180 / 2 ** 31));
  const rec: number[] = [
    // definition, local 0: file_id: manufacturer (1, uint16), product (2, uint16), serial (3, uint32z)
    0x40, 0, 0, 0, 0, 3, 1, 2, 0x84, 2, 2, 0x84, 3, 4, 0x8c,
    0x00, ...u16(1), ...u16(3121), ...u32(3_456_789_012),
    // definition, local 1: record: timestamp (253, uint32), heart_rate (3, uint8), position_lat (0, sint32), position_long (1, sint32), speed (6, uint16)
    0x41, 0, 0, 20, 0, 5, 253, 4, 0x86, 3, 1, 0x02, 0, 4, 0x85, 1, 4, 0x85, 6, 2, 0x84,
    0x01, ...u32(ts), 120, ...u32(lat), ...u32(lon >>> 0), ...u16(3500),
    // a compressed-timestamp record of local 1, 3 s later (offset = (ts + 3) & 31)
    0x80 | (1 << 5) | ((ts + 3) & 0x1f), 0, 0, 0, 0, 125, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff,
    // definition, local 2: hrv: time (0, 2 × uint16, seconds/1000)
    0x42, 0, 0, 78, 0, 1, 0, 4, 0x84,
    0x02, ...u16(812), ...u16(790),
    // definition, local 3: session: start_time (2), total_elapsed_time (7, ms), sport (5, enum), avg_heart_rate (16), max_heart_rate (17)
    0x43, 0, 0, 18, 0, 5, 2, 4, 0x86, 7, 4, 0x86, 5, 1, 0x00, 16, 1, 0x02, 17, 1, 0x02,
    0x03, ...u32(ts), ...u32(1_800_000), 1, 122, 171,
    // definition, local 4: lap (big-endian, to read the architecture byte): start_time (2), total_elapsed_time (7)
    0x44, 0, 1, 0, 19, 2, 2, 4, 0x86, 7, 4, 0x86,
    0x04, ...u32(ts).reverse(), ...u32(900_000).reverse(),
  ];
  const file = buildFit(rec);
  const msgs = [];
  for await (const m of readFit(fileFrom('a.fit', file, 5).chunks())) msgs.push(m);
  assert.deepEqual(msgs.map((m) => m.global), [0, 20, 20, 78, 18, 19]);
  assert.equal(msgs[2].fields[253], ts + 3);    // the compressed timestamp
  assert.equal(msgs[2].fields[0], null);        // 0x7FFFFFFF: invalid
  assert.deepEqual(msgs[3].fields[0], [812, 790]);

  const ctx = await importAll(fit, 'a.fit', file, ['workout', 'lap', 'hr', 'rr', 'location', 'speed']);
  const t0 = FIT_EPOCH_MS + ts * 1000;
  const by = (c: string) => ctx.records.filter((r) => r.channel === c);
  assert.deepEqual(by('hr').map((r) => [(r as EventRecord).value, r.time.t0]), [[120, t0], [125, t0 + 3000]]);
  const loc = by('location') as EventRecord[];
  assert.equal(loc.length, 1);
  assert.ok(Math.abs((loc[0].fields!.lat as number) - 37.5) < 1e-6 && Math.abs((loc[0].fields!.lon as number) + 122.25) < 1e-6);
  assert.deepEqual(by('speed').map((r) => (r as EventRecord).value), [3.5]);
  assert.deepEqual(by('rr').map((r) => (r as EventRecord).value), [812, 790]);
  const [w] = by('workout') as IntervalRecord[];
  assert.deepEqual([w.label, w.time.t0, w.end, w.fields?.avgHr, w.fields?.maxHr], ['running', t0, t0 + 1_800_000, 122, 171]);
  assert.equal(w.prov.model, 'Garmin product 3121');
  assert.equal(w.prov.serial, '3456789012');
  assert.equal((by('lap')[0] as IntervalRecord).end, t0 + 900_000);
});

test('a file that is not FIT says so', async () => {
  await assert.rejects(async () => { for await (const _ of readFit(fileFrom('x', enc.encode('not a fit file at all')).chunks())) { /* none */ } }, /not a FIT file/);
});

// ----- GPX -------------------------------------------------------------------------------------------------------

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>Morning</name></metadata>
  <trk><name>Morning &amp; run</name><type>running</type><trkseg>
    <trkpt lat="47.6062" lon="-122.3321"><ele>56.2</ele><time>2026-11-20T15:00:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>131</gpxtpx:hr><gpxtpx:cad>84</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="47.6065" lon="-122.3325"><time>2026-11-20T15:00:05Z</time></trkpt>
    <trkpt lat="47.6070" lon="-122.3330"/>
  </trkseg></trk>
</gpx>`;

test('GPX: points with time become locations; the Garmin extension gives heart rate; the track an interval', async () => {
  const ctx = await importAll(gpx as typeof edf, 'run.gpx', GPX, ['location', 'track', 'hr', 'cadence']);
  const by = (c: string) => ctx.records.filter((r) => r.channel === c) as EventRecord[];
  assert.equal(by('location').length, 2);
  assert.deepEqual(by('location')[0].fields, { lat: 47.6062, lon: -122.3321, altitudeM: 56.2 });
  assert.deepEqual(by('hr').map((r) => r.value), [131]);
  assert.deepEqual(by('cadence').map((r) => r.value), [84]);
  const [trk] = ctx.records.filter((r) => r.channel === 'track') as IntervalRecord[];
  assert.deepEqual([trk.label, trk.time.t0, trk.end, trk.fields?.name], ['running', Date.parse('2026-11-20T15:00:00Z'), Date.parse('2026-11-20T15:00:05Z'), 'Morning & run']);
});

// ----- Apple Health export.xml -----------------------------------------------------------------------------------

const EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord)*)>
<!ATTLIST HealthData locale CDATA #REQUIRED>
]>
<HealthData locale="en_US">
 <ExportDate value="2026-11-24 21:00:00 -0800"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth=""/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Jo’s Apple Watch" sourceVersion="11.0" device="&lt;&lt;HKDevice: 0x3027&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch7,1, software:11.0&gt;" unit="count/min" creationDate="2026-11-24 08:00:05 -0800" startDate="2026-11-24 08:00:00 -0800" endDate="2026-11-24 08:00:00 -0800" value="62"/>
 <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Jo’s Apple Watch" unit="ms" startDate="2026-11-24 07:00:00 -0800" endDate="2026-11-24 07:01:00 -0800" value="48.5">
  <HeartRateVariabilityMetadataList>
   <InstantaneousBeatsPerMinute bpm="61" time="7:00:01.00 AM"/>
  </HeartRateVariabilityMetadataList>
  <MetadataEntry key="HKAlgorithmVersion" value="2"/>
 </Record>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Oura" unit="" startDate="2026-11-24 02:00:00 -0800" endDate="2026-11-24 03:30:00 -0800" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-11-24 09:00:00 -0800" endDate="2026-11-24 09:10:00 -0800" value="840"/>
 <Record type="HKQuantityTypeIdentifierDietaryWater" sourceName="WaterMinder" unit="mL" startDate="2026-11-24 10:00:00 -0800" endDate="2026-11-24 10:00:00 -0800" value="250"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" durationUnit="min" sourceName="Strava" startDate="2026-11-24 17:00:00 -0800" endDate="2026-11-24 17:30:30 -0800">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="2026-11-24 17:00:00 -0800" endDate="2026-11-24 17:30:30 -0800" sum="5.01" unit="km"/>
 </Workout>
</HealthData>`;

test('Apple Health export: records by type, sleep stages, workouts, a stable id for de-duplication', async () => {
  const all = ['hr', 'hrv', 'sleep', 'steps', 'workout', 'other'];
  const ctx = await importAll(appleHealthExport as typeof edf, 'export.xml', EXPORT, all, {}, 11);
  const by = (c: string) => ctx.records.filter((r) => r.channel === c);
  const [hr] = by('hr') as EventRecord[];
  assert.equal(hr.value, 62);
  assert.equal(hr.time.t0, Date.parse('2026-11-24T16:00:00Z'));
  assert.equal(hr.time.tzOffsetMin, -480);
  assert.equal(hr.prov.sourceApp, 'Jo’s Apple Watch');
  assert.equal(hr.prov.model, 'Watch7,1');
  assert.equal(hr.prov.firmware, '11.0');
  const [hrv] = by('hrv') as IntervalRecord[];
  assert.deepEqual([hrv.shape, hrv.value, (hrv.fields?.metadata as Record<string, string>).HKAlgorithmVersion], ['intervals', 48.5, '2']);
  const [sleep] = by('sleep') as IntervalRecord[];
  assert.deepEqual([sleep.label, sleep.end - sleep.time.t0, sleep.prov.sourceApp], ['deep', 90 * 60_000, 'Oura']);
  assert.equal((by('steps')[0] as IntervalRecord).value, 840);
  assert.equal((by('other')[0] as EventRecord).label, 'dietary water');
  const [w] = by('workout') as IntervalRecord[];
  assert.equal(w.label, 'running');
  assert.equal((w.fields?.metadata as Record<string, string>)['distance walking running (km)'], '5.01');
  // the same file imported twice gives the same ids
  const again = await importAll(appleHealthExport as typeof edf, 'export.xml', EXPORT, all, {}, 4096);
  assert.deepEqual(again.records.map((r) => r.prov.providerRecordId), ctx.records.map((r) => r.prov.providerRecordId));
  assert.equal(new Set(ctx.records.map((r) => r.prov.providerRecordId)).size, ctx.records.length);
});

test('Apple Health dates and devices', () => {
  assert.deepEqual(parseHealthDate('2026-01-02 03:04:05 +0530'), { ms: Date.parse('2026-01-01T21:34:05Z'), tzOffsetMin: 330 });
  assert.deepEqual(parseHealthDevice('<<HKDevice: 0x1>, name:iPhone, manufacturer:Apple Inc., model:iPhone, hardware:iPhone16,2, software:26.1>'),
    { name: 'iPhone', manufacturer: 'Apple Inc.', model: 'iPhone', hardware: 'iPhone16,2', firmware: '26.1' });
});

test('a multi-byte character split across chunks survives', async () => {
  const chunks = [];
  for await (const s of textChunks(fileFrom('x', 'Jo’s', 3).chunks())) chunks.push(s);
  assert.equal(chunks.join(''), 'Jo’s');
});

// ----- CSV -------------------------------------------------------------------------------------------------------

test('CSV: evenly spaced rows become samples; a text column is left out', async () => {
  const rows = ['timestamp,temp,humidity,note'];
  for (let i = 0; i < 5; i++) rows.push(`${1_700_000_000 + i},${20 + i},${50 - i},"ok, fine"`);
  const ctx = await importAll(csv as typeof edf, 'log.csv', rows.join('\r\n') + '\r\n', ['values']);
  const [c] = ctx.records as SampleChunk[];
  assert.equal(c.shape, 'samples');
  assert.equal(c.rateHz, 1);
  assert.deepEqual(c.names, ['temp', 'humidity']);
  assert.deepEqual([...c.data[0]], [20, 21, 22, 23, 24]);
  assert.equal(c.time.t0, 1_700_000_000_000);
});

test('CSV: irregular rows become events', async () => {
  const text = 'time;glucose\n2026-11-24T08:00:00Z;98\n2026-11-24T08:07:00Z;104\n2026-11-24T09:30:00Z;121\n';
  const ctx = await importAll(csv as typeof edf, 'g.csv', text, ['values']);
  const ev = ctx.records as DeviceRecord[];
  assert.ok(ev.every((r) => r.shape === 'events'));
  assert.deepEqual(ev.map((r) => (r as EventRecord).value), [98, 104, 121]);
  assert.deepEqual(csvFields('a,"b ""c""",d'), ['a', 'b "c"', 'd']);
});
