// Apple Health's export (Health → your picture → Export All Health Data → export.zip → apple_health_export/export.xml).
// For a person without the iPhone app, or for their whole history at once. The file is streamed: a 2 GB export is
// never held in memory.
//
// <Record type sourceName sourceVersion device unit creationDate startDate endDate value> (with <MetadataEntry key
// value> children) becomes an event when it has one time and an interval when it spans time. <Workout
// workoutActivityType duration durationUnit totalDistance totalEnergyBurned …> becomes a workout interval.
// The export has no record ids: providerRecordId is a stable hash of type, start, end, source and value, so a second
// import of the same file de-duplicates. The phone's live route is the apple-health driver (HealthKit), not this one.

import type { Descriptor } from '../contract.ts';
import { event, interval, stableId, textChunks } from '../util.ts';
import { xmlTokens } from '../xml.ts';
import { fileDriver, fileRoute, importAction } from '../file-driver.ts';

/** "2024-01-02 08:00:00 -0500" → ms and the offset in minutes */
export function parseHealthDate(s: string): { ms: number; tzOffsetMin?: number } {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
  if (!m) return { ms: Date.parse(s) };
  const off = (m[3] === '-' ? -1 : 1) * (Number(m[4]) * 60 + Number(m[5]));
  return { ms: Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`), tzOffsetMin: off };
}

/** "<<HKDevice: 0x…>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,1, software:10.0>" */
export function parseHealthDevice(s: string | undefined): { name?: string; manufacturer?: string; model?: string; hardware?: string; firmware?: string } {
  if (!s) return {};
  const get = (k: string) => new RegExp(`${k}:([^,>]*(?:,\\d+)?)`).exec(s)?.[1]?.trim();
  return { name: get('name'), manufacturer: get('manufacturer'), model: get('model'), hardware: get('hardware'), firmware: get('software') };
}

const SLEEP: Record<string, string> = {
  HKCategoryValueSleepAnalysisInBed: 'in bed',
  HKCategoryValueSleepAnalysisAsleep: 'asleep',
  HKCategoryValueSleepAnalysisAsleepUnspecified: 'asleep',
  HKCategoryValueSleepAnalysisAwake: 'awake',
  HKCategoryValueSleepAnalysisAsleepCore: 'core',
  HKCategoryValueSleepAnalysisAsleepDeep: 'deep',
  HKCategoryValueSleepAnalysisAsleepREM: 'rem',
};

/** the channel a HealthKit type goes to */
export function channelOfType(type: string): string {
  const t = type.replace(/^HK(Quantity|Category|Correlation|DataType)TypeIdentifier/, '');
  switch (t) {
    case 'HeartRate': return 'hr';
    case 'RestingHeartRate': case 'WalkingHeartRateAverage': return 'resting-hr';
    case 'HeartRateVariabilitySDNN': return 'hrv';
    case 'OxygenSaturation': return 'spo2';
    case 'StepCount': return 'steps';
    case 'ActiveEnergyBurned': case 'BasalEnergyBurned': return 'energy';
    case 'DistanceWalkingRunning': case 'DistanceCycling': case 'DistanceSwimming': return 'distance';
    case 'RespiratoryRate': return 'resp';
    case 'BodyTemperature': case 'AppleSleepingWristTemperature': return 'temp';
    case 'SleepAnalysis': return 'sleep';
    default: return 'other';
  }
}

const label = (type: string) => type.replace(/^HK(Quantity|Category|Correlation|DataType)TypeIdentifier/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

export interface HealthExportItem {
  kind: 'record' | 'workout';
  attrs: Record<string, string>;
  metadata: Record<string, string>;
}

/** each Record and Workout of an export.xml, with its metadata */
export async function* readHealthExport(text: AsyncIterable<string>): AsyncGenerator<HealthExportItem> {
  let cur: HealthExportItem | null = null;
  let depth = 0;
  for await (const t of xmlTokens(text)) {
    if (t.type === 'open') {
      if (!cur && (t.name === 'Record' || t.name === 'Workout')) {
        const item: HealthExportItem = { kind: t.name === 'Record' ? 'record' : 'workout', attrs: t.attrs, metadata: {} };
        if (t.selfClosing) yield item;
        else { cur = item; depth = 1; }
        continue;
      }
      if (cur) {
        if (t.name === 'MetadataEntry' && depth === 1 && t.attrs.key) cur.metadata[t.attrs.key] = t.attrs.value ?? '';
        if (t.name === 'WorkoutStatistics' && t.attrs.type) {
          const v = t.attrs.sum ?? t.attrs.average;
          if (v !== undefined) cur.metadata[`${label(t.attrs.type)} (${t.attrs.unit ?? ''})`] = v;
        }
        if (!t.selfClosing) depth++;
      }
    } else if (t.type === 'close' && cur) {
      depth--;
      if (depth === 0) { yield cur; cur = null; }
    }
  }
}

const ch = (id: string, kind: Descriptor['channels'][number]['kind'], l: string, shape: 'events' | 'intervals', unit?: string, sensitive: 'health' | undefined = 'health') =>
  ({ id, kind, label: l, shape, unit, defaultOn: true, sensitive });

export const appleHealthExportDescriptor: Descriptor = {
  id: 'file-apple-health-export',
  name: 'Apple Health export',
  vendor: 'Apple',
  family: 'apple-health',
  models: ['export.xml from Health → Export All Health Data'],
  placement: 'file',
  about: 'Import your whole Apple Health history from its export: heart rate, HRV, sleep, steps, workouts and more.',
  channels: [
    ch('hr', 'hr', 'Heart rate', 'events', 'count/min'),
    ch('resting-hr', 'hr', 'Resting heart rate', 'events', 'count/min'),
    ch('hrv', 'hrv', 'Heart rate variability (SDNN)', 'events', 'ms'),
    ch('spo2', 'spo2', 'Blood oxygen', 'events', '%'),
    ch('resp', 'resp', 'Respiratory rate', 'events', 'count/min'),
    ch('temp', 'temp', 'Temperature', 'events', 'degC'),
    ch('steps', 'steps', 'Steps', 'intervals', 'count', undefined),
    ch('energy', 'energy', 'Energy', 'intervals', 'kcal', undefined),
    ch('distance', 'distance', 'Distance', 'intervals', 'km', undefined),
    ch('sleep', 'sleep', 'Sleep', 'intervals'),
    ch('workout', 'workout', 'Workouts', 'intervals'),
    ch('other', 'other', 'Everything else', 'events'),
  ],
  actions: importAction,
  routes: [fileRoute('file-apple-health-export', 'loopback', 'test/files.test.ts: an export.xml snippet with its DOCTYPE, records, metadata, sleep and a workout, read through the driver')],
  priority: 'P0',
  links: [{ label: 'Export your Health data', url: 'https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/ios' }],
};

export const appleHealthExport = fileDriver({
  id: 'file-apple-health-export',
  descriptor: appleHealthExportDescriptor,
  files: { extensions: ['.xml'], mime: ['text/xml', 'application/xml'] },
  async run({ file, ctx, emit, prov, stopped, info }) {
    let n = 0;
    for await (const it of readHealthExport(textChunks(file.chunks()))) {
      if (stopped()) return;
      const a = it.attrs;
      const start = parseHealthDate(a.startDate ?? '');
      const end = parseHealthDate(a.endDate ?? a.startDate ?? '');
      if (!Number.isFinite(start.ms) || !Number.isFinite(end.ms)) continue;
      const dev = parseHealthDevice(a.device);
      const type = it.kind === 'workout' ? (a.workoutActivityType ?? 'HKWorkoutActivityTypeOther') : (a.type ?? '');
      const channel = it.kind === 'workout' ? 'workout' : channelOfType(type);
      const p = prov({
        model: dev.hardware ?? dev.model ?? dev.name, firmware: dev.firmware, sourceApp: a.sourceName,
        providerRecordId: `apple-export:${stableId([type, a.startDate, a.endDate, a.sourceName, a.value ?? a.duration ?? ''].join('|'))}`,
      });
      const time = { t0: start.ms, receivedAt: ctx.now(), tzOffsetMin: start.tzOffsetMin, clock: 'vendor' as const };
      const fields: Record<string, unknown> = { type };
      if (Object.keys(it.metadata).length) fields.metadata = it.metadata;
      if (dev.manufacturer) fields.manufacturer = dev.manufacturer;
      if (it.kind === 'workout') {
        const activity = type.replace(/^HKWorkoutActivityType/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
        for (const k of ['duration', 'durationUnit', 'totalDistance', 'totalDistanceUnit', 'totalEnergyBurned', 'totalEnergyBurnedUnit']) if (a[k]) fields[k] = a[k];
        emit(interval('workout', p, time, end.ms, activity, { method: a.sourceName, fields }));
      } else {
        const raw = a.value;
        const num = raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
        const l = channel === 'sleep' ? SLEEP[raw ?? ''] ?? (raw ?? 'sleep') : label(type);
        if (num === undefined && raw && channel !== 'sleep') fields.value = raw;
        const unit = a.unit;
        if (end.ms > start.ms) emit(interval(channel, p, time, end.ms, l, { value: num, unit, method: a.sourceName, fields }));
        else emit(event(channel, p, time, l, num, unit, fields));
      }
      if (++n % 50_000 === 0) info.read = `${n} records`;
    }
    info.read = `${n} records`;
  },
});
