// The health stores (Apple Health on iOS, Health Connect on Android) as one table, and the one connection both drivers
// open over a HealthStoreTransport (./contract.ts). The drivers (./drivers/apple-health.ts, ./drivers/health-connect.ts)
// are this table's descriptors; the phone's native plugin (apps/mobile, "Health") reads the native type names below.
//
// What a store holds is what the person's apps wrote to it: the Apple Watch, an Oura or RingConn ring through its app,
// Samsung Health, Mi Fitness. `sourceApp` says which. Vendor scores (readiness, recovery, strain) are not in the stores
// and not in this table: they are separate metrics of a vendor's own route.
//
// Records:
//   - one store record -> one DeviceRecord, `prov.providerRecordId` = the store's id (HealthKit's UUID, Health
//     Connect's metadata id). A store record that holds a series (Health Connect's heart rate samples, a sleep
//     session's stages, an ECG's voltages) becomes several, with the ids `<id>:<n>`.
//   - a deleted store record -> an event labelled `device.deleted` on the channel it was on, `fields.ids` the store's
//     ids. The node removes every record whose providerRecordId is one of them or begins with `<id>:`.
//   - a changed store record (Health Connect only: HealthKit's samples never change) -> `device.deleted` for its id,
//     then the record again.
// Timing: t0 = the store's start, clock 'vendor', the observation's UTC offset when the store has it.
// Anchors: each type's cursor in the store is kept in `ctx.config.anchors[<store type>]`, so a re-open resumes.
import type { Channel, Connection, Descriptor, DeviceRecord, HealthSample, HealthStoreTransport, OpenContext, SettingSpec, SignalKind } from './contract.ts';

export type HealthStore = 'healthkit' | 'health-connect';

/** one store's name for a type: the native type, the unit asked for, and the factor that turns it into ours */
export interface NativeType { type: string; unit: string; scale?: number }

export interface HealthType {
  key: string;                 // the channel id, the same on both stores
  label: string;
  kind: SignalKind;
  shape: 'samples' | 'intervals' | 'events';
  unit?: string;               // ours
  method?: string;             // the statistic, when the type is one (HRV: SDNN on iOS, RMSSD on Android)
  healthkit?: NativeType;
  healthConnect?: NativeType;
}

// The units are HealthKit's unit strings (HKUnit(from:)) and Health Connect's accessors (the Kotlin plugin reads the
// value in that unit). SpO2 comes from HealthKit as a fraction (0.97), so it is scaled to percent.
export const HEALTH_TYPES: HealthType[] = [
  { key: 'hr', label: 'Heart rate', kind: 'hr', shape: 'events', unit: 'bpm',
    healthkit: { type: 'HKQuantityTypeIdentifierHeartRate', unit: 'count/min' },
    healthConnect: { type: 'HeartRateRecord', unit: 'bpm' } },
  { key: 'resting-hr', label: 'Resting heart rate', kind: 'hr', shape: 'intervals', unit: 'bpm',
    healthkit: { type: 'HKQuantityTypeIdentifierRestingHeartRate', unit: 'count/min' },
    healthConnect: { type: 'RestingHeartRateRecord', unit: 'bpm' } },
  { key: 'hrv-sdnn', label: 'Heart rate variability (SDNN)', kind: 'hrv', shape: 'intervals', unit: 'ms', method: 'SDNN',
    healthkit: { type: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', unit: 'ms' } },
  { key: 'hrv-rmssd', label: 'Heart rate variability (RMSSD)', kind: 'hrv', shape: 'intervals', unit: 'ms', method: 'RMSSD',
    healthConnect: { type: 'HeartRateVariabilityRmssdRecord', unit: 'ms' } },
  { key: 'spo2', label: 'Blood oxygen', kind: 'spo2', shape: 'events', unit: '%',
    healthkit: { type: 'HKQuantityTypeIdentifierOxygenSaturation', unit: '%', scale: 100 },
    healthConnect: { type: 'OxygenSaturationRecord', unit: '%' } },
  { key: 'resp-rate', label: 'Respiratory rate', kind: 'resp', shape: 'events', unit: 'breaths/min',
    healthkit: { type: 'HKQuantityTypeIdentifierRespiratoryRate', unit: 'count/min' },
    healthConnect: { type: 'RespiratoryRateRecord', unit: 'breaths/min' } },
  { key: 'body-temp', label: 'Body temperature', kind: 'temp', shape: 'events', unit: 'degC',
    healthkit: { type: 'HKQuantityTypeIdentifierBodyTemperature', unit: 'degC' },
    healthConnect: { type: 'BodyTemperatureRecord', unit: 'degC' } },
  // Apple: the absolute wrist temperature over a night (iOS 16+). Health Connect: the skin temperature's deltas from
  // the person's baseline over a window; the value is the baseline plus the mean delta when there is a baseline, else
  // the mean delta (method says which).
  { key: 'wrist-temp', label: 'Wrist temperature during sleep', kind: 'temp', shape: 'intervals', unit: 'degC',
    healthkit: { type: 'HKQuantityTypeIdentifierAppleSleepingWristTemperature', unit: 'degC' },
    healthConnect: { type: 'SkinTemperatureRecord', unit: 'degC' } },
  { key: 'steps', label: 'Steps', kind: 'steps', shape: 'intervals', unit: 'count',
    healthkit: { type: 'HKQuantityTypeIdentifierStepCount', unit: 'count' },
    healthConnect: { type: 'StepsRecord', unit: 'count' } },
  { key: 'active-energy', label: 'Active energy', kind: 'energy', shape: 'intervals', unit: 'kcal',
    healthkit: { type: 'HKQuantityTypeIdentifierActiveEnergyBurned', unit: 'kcal' },
    healthConnect: { type: 'ActiveCaloriesBurnedRecord', unit: 'kcal' } },
  { key: 'distance', label: 'Walking and running distance', kind: 'distance', shape: 'intervals', unit: 'm',
    healthkit: { type: 'HKQuantityTypeIdentifierDistanceWalkingRunning', unit: 'm' },
    healthConnect: { type: 'DistanceRecord', unit: 'm' } },
  { key: 'sleep', label: 'Sleep stages', kind: 'sleep', shape: 'intervals',
    healthkit: { type: 'HKCategoryTypeIdentifierSleepAnalysis', unit: '' },
    healthConnect: { type: 'SleepSessionRecord', unit: '' } },
  { key: 'workout', label: 'Workouts', kind: 'workout', shape: 'intervals',
    healthkit: { type: 'HKWorkoutTypeIdentifier', unit: '' },
    healthConnect: { type: 'ExerciseSessionRecord', unit: '' } },
  // Apple Watch's saved ECGs (lead I), in microvolts; Health Connect has no ECG type
  { key: 'ecg', label: 'ECG recordings (Apple Watch)', kind: 'ecg', shape: 'samples', unit: 'uV',
    healthkit: { type: 'HKDataTypeIdentifierElectrocardiogram', unit: 'uV' } },
  { key: 'vo2max', label: 'VO2 max', kind: 'other', shape: 'events', unit: 'mL/(kg·min)',
    healthkit: { type: 'HKQuantityTypeIdentifierVO2Max', unit: 'ml/kg*min' },
    healthConnect: { type: 'Vo2MaxRecord', unit: 'mL/(kg·min)' } },
  { key: 'glucose', label: 'Blood glucose', kind: 'glucose', shape: 'events', unit: 'mg/dL',
    healthkit: { type: 'HKQuantityTypeIdentifierBloodGlucose', unit: 'mg/dL' },
    healthConnect: { type: 'BloodGlucoseRecord', unit: 'mg/dL' } },
];

export const nativeOf = (t: HealthType, store: HealthStore) => (store === 'healthkit' ? t.healthkit : t.healthConnect);
/** the types a store has */
export const typesOf = (store: HealthStore) => HEALTH_TYPES.filter((t) => nativeOf(t, store));

/** the descriptor's channels for a store: one per type, all on, each a gated health category (compliance rule 5) */
export function healthChannels(store: HealthStore): Channel[] {
  return typesOf(store).map((t) => ({ id: t.key, kind: t.kind, label: t.label, shape: t.shape, unit: t.unit, defaultOn: true, sensitive: 'health' as const }));
}

// Sleep stages, the stores' names to ours. HealthKit's HKCategoryValueSleepAnalysis (by its case name) and Health
// Connect's SleepSessionRecord.STAGE_TYPE_* (lower case). The store's own name stays in fields.stage.
const SLEEP_STAGE: Record<string, string> = {
  inBed: 'in bed', asleepUnspecified: 'asleep', asleep: 'asleep', awake: 'awake', asleepCore: 'light', asleepDeep: 'deep', asleepREM: 'rem',
  unknown: 'asleep', sleeping: 'asleep', out_of_bed: 'out of bed', light: 'light', deep: 'deep', rem: 'rem', awake_in_bed: 'awake',
};
export const sleepStage = (s: string | undefined) => (s && SLEEP_STAGE[s]) || 'asleep';

/** how many voltages one ECG chunk carries (the node's event payloads stay small) */
export const ECG_CHUNK = 2048;

export const HEALTH_SETTINGS: SettingSpec[] = [
  { id: 'pageSize', label: 'Records per request to the store', type: 'number', default: 500 },
  { id: 'pagesPerPass', label: 'Requests per sync pass', type: 'number', default: 40, help: 'A pass stops after this many; the next pass resumes from the saved place.' },
];

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

/** a sample's provenance and timing */
function base(s: HealthSample, channel: string, store: HealthStore, descriptor: Descriptor, ctx: OpenContext, id = s.uuid) {
  return {
    channel,
    prov: {
      instance: ctx.instance, descriptor: descriptor.id, host: ctx.host, transport: store,
      providerRecordId: id, sourceApp: s.sourceApp,
      model: s.device?.model ?? s.device?.name, firmware: s.device?.firmware,
    },
    time: { t0: s.start, receivedAt: ctx.now(), tzOffsetMin: s.tzOffsetMin, clock: 'vendor' as const },
  };
}

const deviceFields = (s: HealthSample) => (s.device?.manufacturer || s.device?.name ? { deviceName: s.device?.name, manufacturer: s.device?.manufacturer } : {});

/** the DeviceRecords of one store record */
export function recordsOf(s: HealthSample, t: HealthType, store: HealthStore, descriptor: Descriptor, ctx: OpenContext): DeviceRecord[] {
  const n = nativeOf(t, store)!;
  const scale = n.scale ?? 1;
  const v = typeof s.value === 'number' ? s.value * scale : undefined;
  const f = (s.fields ?? {}) as Record<string, any>;
  const df = deviceFields(s);
  switch (t.key) {
    case 'hr': {
      // Health Connect: one record holds a series of samples
      if (Array.isArray(f.samples)) {
        return (f.samples as { t: number; bpm: number }[]).map((x, i) => {
          const b = base(s, t.key, store, descriptor, ctx, `${s.uuid}:${i}`);
          return { ...b, time: { ...b.time, t0: x.t }, shape: 'events' as const, label: 'heart rate', value: x.bpm, unit: 'bpm', fields: df };
        });
      }
      return [{ ...base(s, t.key, store, descriptor, ctx), shape: 'events', label: 'heart rate', value: v, unit: t.unit, fields: { ...df, ...(f.motion ? { motion: f.motion } : {}) } }];
    }
    case 'sleep': {
      const stages = Array.isArray(f.stages) && f.stages.length ? f.stages as { start: number; end: number; stage: string }[] : null;
      if (stages) {
        return stages.map((x, i) => {
          const b = base(s, t.key, store, descriptor, ctx, `${s.uuid}:${i}`);
          return { ...b, time: { ...b.time, t0: x.start }, shape: 'intervals' as const, end: x.end, label: sleepStage(x.stage), method: s.sourceApp, fields: { ...df, stage: x.stage, session: s.uuid } };
        });
      }
      return [{ ...base(s, t.key, store, descriptor, ctx), shape: 'intervals', end: s.end, label: sleepStage(s.category), method: s.sourceApp, fields: { ...df, stage: s.category ?? 'sleeping' } }];
    }
    case 'workout':
      return [{ ...base(s, t.key, store, descriptor, ctx), shape: 'intervals', end: s.end, label: s.category ?? 'workout', method: s.sourceApp, fields: { ...df, ...f } }];
    case 'ecg': {
      const volts = Array.isArray(f.voltages) ? (f.voltages as number[]) : [];
      const hz = num(f.hz, 512);
      const summary: DeviceRecord = { ...base(s, t.key, store, descriptor, ctx), shape: 'intervals', end: s.end, label: 'ecg', value: typeof f.averageHeartRate === 'number' ? f.averageHeartRate : undefined, unit: 'bpm',
        method: s.sourceApp, fields: { ...df, classification: f.classification, symptoms: f.symptoms, lead: f.lead ?? 'I', hz, voltages: volts.length } };
      const out: DeviceRecord[] = [summary];
      for (let i = 0, k = 0; i < volts.length; i += ECG_CHUNK, k++) {
        const b = base(s, t.key, store, descriptor, ctx, `${s.uuid}:${k}`);
        out.push({ ...b, time: { ...b.time, t0: s.start + (i / hz) * 1000, seq: i }, shape: 'samples', rateHz: hz, names: [`lead ${f.lead ?? 'I'}`], unit: 'uV', data: [Float32Array.from(volts.slice(i, i + ECG_CHUNK))] });
      }
      return out;
    }
    case 'wrist-temp': {
      if (Array.isArray(f.deltas)) {
        const d = (f.deltas as { t: number; delta: number }[]).map((x) => x.delta);
        const mean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : undefined;
        const baseline = typeof f.baseline === 'number' ? f.baseline : undefined;
        const value = mean === undefined ? baseline : baseline === undefined ? mean : baseline + mean;
        return [{ ...base(s, t.key, store, descriptor, ctx), shape: 'intervals', end: s.end, label: t.label.toLowerCase(), value, unit: t.unit,
          method: baseline === undefined ? 'mean delta from the baseline' : 'baseline plus the mean delta', fields: { ...df, baseline, deltas: f.deltas, measurementLocation: f.measurementLocation } }];
      }
      break;
    }
  }
  const b = base(s, t.key, store, descriptor, ctx);
  const fields = Object.keys(df).length || Object.keys(f).length ? { ...df, ...f } : undefined;
  if (t.shape === 'intervals') return [{ ...b, shape: 'intervals', end: s.end, label: t.label.toLowerCase(), value: v, unit: t.unit, method: t.method, fields }];
  return [{ ...b, shape: 'events', label: t.label.toLowerCase(), value: v, unit: t.unit, fields }];
}

/** the event that tells the node to remove what came from these store ids */
export function deletedRecord(ids: string[], channel: string, store: HealthStore, descriptor: Descriptor, ctx: OpenContext): DeviceRecord {
  const t = ctx.now();
  return { channel, shape: 'events', label: 'device.deleted', fields: { ids },
    prov: { instance: ctx.instance, descriptor: descriptor.id, host: ctx.host, transport: store }, time: { t0: t, receivedAt: t, clock: 'host' } };
}

/** the store's cursors, kept in the connection's config so a re-open resumes */
export function anchorsOf(ctx: OpenContext): Record<string, string | null> {
  const a = ctx.config.anchors;
  if (a && typeof a === 'object') return a as Record<string, string | null>;
  return (ctx.config.anchors = {}) as Record<string, string | null>;
}

/**
 * The connection both drivers open. start(): checks the store, asks for read access to the enabled channels' types,
 * then runs one pass. act('sync'): another pass ('done' when every type is caught up, 'accepted' when a pass stopped
 * at its page budget and more remains). act('authorize'): asks again.
 */
export function openHealthStore(store: HealthStore, descriptor: Descriptor, t: HealthStoreTransport, ctx: OpenContext): Connection {
  let stopped = false, running: Promise<boolean> | null = null;
  let counts = { records: 0, samples: 0, dropped: 0 };
  const types = () => typesOf(store).filter((x) => ctx.enabled.has(x.key));
  const status = (s: Parameters<OpenContext['status']>[0]) => ctx.status({ counts, ...s });

  async function authorize() {
    const want = types().map((x) => nativeOf(x, store)!.type);
    const r = await t.authorize(want);
    return { want, ...r };
  }

  /** one pass over every enabled type; true when more remains */
  async function pass(): Promise<boolean> {
    const anchors = anchorsOf(ctx);
    const limit = num(ctx.config.pageSize, 500);
    let budget = num(ctx.config.pagesPerPass, 40), more = false;
    for (const ty of types()) {
      const native = nativeOf(ty, store)!.type;
      for (;;) {
        if (stopped) return true;
        if (budget-- <= 0) { more = true; break; }
        const before = anchors[native] ?? null;
        const q = await t.query(native, before, limit);
        const changed = q.records.filter((r) => (r.fields as any)?.changed).map((r) => r.uuid);
        const gone = [...q.deleted, ...changed];
        if (gone.length) ctx.emit(deletedRecord(gone, ty.key, store, descriptor, ctx));
        for (const s of q.records) {
          for (const r of recordsOf(s, ty, store, descriptor, ctx)) {
            ctx.emit(r);
            counts = { ...counts, records: counts.records + 1, samples: counts.samples + (r.shape === 'samples' ? r.data[0].length : 0) };
          }
        }
        anchors[native] = q.anchor;
        if (q.records.length < limit || q.anchor === before) break;
      }
    }
    status({ state: 'streaming', lastRecordAt: ctx.now(), info: { caughtUp: more ? 'no' : 'yes' } });
    return more;
  }

  const once = () => (running ??= pass().finally(() => { running = null; }));

  return {
    async start() {
      stopped = false;
      status({ state: 'connecting' });
      if (!(await t.available())) {
        status({ state: 'error', why: store === 'healthkit' ? 'Apple Health is not available on this device.' : 'Health Connect is not installed or needs an update on this phone.' });
        return;
      }
      const a = await authorize();
      if (!a.granted.length && !a.unknown.length) { status({ state: 'revoked', why: 'Read access was not given. Allow it in the health app\'s settings, then connect again.' }); return; }
      await once();
    },
    async stop() { stopped = true; await running?.catch(() => {}); status({ state: 'idle' }); },
    async act(action) {
      if (action === 'sync') {
        try { return (await once()) ? { outcome: 'accepted', why: 'more history remains' } : { outcome: 'done' }; }
        catch (e) { status({ state: 'error', why: String((e as Error).message ?? e) }); return { outcome: 'failed', why: String((e as Error).message ?? e) }; }
      }
      if (action === 'authorize') { const a = await authorize(); return { outcome: 'done', why: `${a.granted.length} granted, ${a.unknown.length} unknown` }; }
      return { outcome: 'unsupported' };
    },
    async close() { stopped = true; await running?.catch(() => {}); status({ state: 'closed' }); },
  };
}
