// A simulated health store: a HealthStoreTransport as the phone's native plugin hands it to the apple-health or
// health-connect driver, holding 30 days of a plausible person (and the days to come, as the simulated clock reaches
// them): heart rate every 5 minutes following a day's rhythm (lower asleep, higher in a workout), heart rate
// variability at night, resting heart rate a day, steps, active energy and distance by the hour, sleep stages a night
// (90-minute cycles: light, deep early, REM later, short awakenings), three or four workouts a week, blood oxygen and
// breathing rate at night, wrist temperature, VO2 max a week, and on Apple Health one saved ECG.
//
// As the stores do: each record has its uuid; HealthKit keeps one record per sleep stage (asleepCore, asleepDeep,
// asleepREM, awake) and Health Connect one SleepSessionRecord with its stages, and one HeartRateRecord an hour with
// its samples. A type's anchor is the place reached in its list, so a re-open resumes. One minute after the start a
// workout is deleted (a `deleted` uuid on its type's next query). HealthKit never says what was granted (`unknown`).
// With `disconnectAfterS`, the store stops answering after that many simulated seconds: the next query throws.

import type { HealthSample, HealthStoreTransport } from '../contract.ts';
import { HEALTH_TYPES, nativeOf, type HealthStore } from '../health.ts';
import { Rng, SimClock, type SimOptions, type Simulator } from './clock.ts';
import { HeartModel, dayRate, ecgAt } from './signals.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

type Item = HealthSample | { deleted: string; at: number };
const at = (x: Item) => ('deleted' in x ? x.at : x.end);

export interface HealthSimOptions extends SimOptions {
  /** the person's UTC offset in minutes (default: this host's) */
  tzOffsetMin?: number;
  /** days of history before the start (default 30) */
  days?: number;
}

export function simulateHealthStore(kind: HealthStore, o: HealthSimOptions = {}): Simulator<HealthStoreTransport> {
  const rng = new Rng(o.seed ?? 1);
  const clock = new SimClock(o);
  const tz = o.tzOffsetMin ?? -new Date(clock.start).getTimezoneOffset();
  const hk = kind === 'healthkit';
  const lists = new Map<string, Item[]>();
  const typeOf = (key: string) => { const t = HEALTH_TYPES.find((x) => x.key === key); return t && nativeOf(t, kind)?.type; };
  const add = (key: string, s: Omit<HealthSample, 'uuid' | 'type'> & { uuid?: string }) => {
    const type = typeOf(key);
    if (!type) return null;
    const r: HealthSample = { uuid: s.uuid ?? ids.uuid(hk), type, tzOffsetMin: tz, ...src, ...s } as HealthSample;
    if (!lists.has(type)) lists.set(type, []);
    lists.get(type)!.push(r);
    return r;
  };
  const ids = rng.fork(9);
  const src = hk
    ? { sourceApp: 'Apple Watch', device: { name: 'Apple Watch', model: 'Watch', manufacturer: 'Apple Inc.', firmware: '11.1' } }
    : { sourceApp: 'Samsung Health', device: { name: 'Galaxy Watch', model: 'SM-R930', manufacturer: 'Samsung' } };
  const local = (t: number) => t + tz * MIN;                // ms in the person's day
  const dayStart = (t: number) => Math.floor(local(t) / DAY) * DAY - tz * MIN;

  const days = o.days ?? 30;
  const from = dayStart(clock.start) - days * DAY;
  const until = dayStart(clock.start) + 8 * DAY;
  const r = rng.fork(1);
  const sleeps: [number, number][] = [];
  const workouts: [number, number, string][] = [];

  // the days: a night's sleep (it ends on this day), maybe a workout, then the hourly and 5-minute values
  for (let d = from; d < until; d += DAY) {
    const sleepStart = d - DAY + 23 * HOUR + r.range(-40, 40) * MIN, sleepEnd = d + 7 * HOUR + r.range(-40, 40) * MIN;
    sleeps.push([sleepStart, sleepEnd]);
    const weekday = Math.floor(local(d) / DAY) % 7;
    if ([1, 3, 5].includes(weekday) || r.next() < 0.15) {
      const kind = ['running', 'walking', 'cycling'][Math.floor(r.next() * 3)];
      const start = d + (r.next() < 0.5 ? 7.5 : 18) * HOUR + r.range(0, 45) * MIN;
      workouts.push([start, start + (kind === 'cycling' ? r.range(50, 75) : r.range(30, 50)) * MIN, kind]);
    }
  }
  const asleep = (t: number) => sleeps.some(([a, b]) => t >= a && t < b);
  const working = (t: number) => workouts.find(([a, b]) => t >= a && t < b);

  // sleep stages
  for (const [a, b] of sleeps) {
    const stages: { start: number; end: number; stage: string }[] = [];
    let t = a + r.range(5, 15) * MIN;
    stages.push({ start: a, end: t, stage: 'awake' });
    for (let cycle = 0; t < b; cycle++) {
      const plan: [string, number][] = [['light', r.range(20, 35)], ['deep', cycle < 2 ? r.range(20, 40) : r.range(0, 10)], ['light', r.range(10, 20)], ['rem', 10 + cycle * r.range(5, 10)]];
      if (r.next() < 0.3) plan.push(['awake', r.range(1, 5)]);
      for (const [stage, m] of plan) {
        if (m < 1 || t >= b) continue;
        const end = Math.min(b, t + m * MIN);
        stages.push({ start: t, end, stage });
        t = end;
      }
    }
    if (hk) {
      const name: Record<string, string> = { light: 'asleepCore', deep: 'asleepDeep', rem: 'asleepREM', awake: 'awake' };
      add('sleep', { start: a, end: b, category: 'inBed' });
      for (const s of stages) add('sleep', { start: s.start, end: s.end, category: name[s.stage] });
    } else add('sleep', { start: a, end: b, fields: { stages } });
    // the night's other values
    const mid = (a + b) / 2;
    if (hk) for (let x = a + HOUR; x < b; x += 2 * HOUR) add('hrv-sdnn', { start: x, end: x + MIN, value: +(48 + r.normal() * 10).toFixed(1), unit: 'ms' });
    else add('hrv-rmssd', { start: a, end: b, value: +(42 + r.normal() * 9).toFixed(1), unit: 'ms' });
    for (let x = a + 2 * HOUR; x < b; x += 3 * HOUR) {
      add('spo2', { start: x, end: x, value: hk ? +(0.965 + r.normal() * 0.01).toFixed(3) : +(96.5 + r.normal()).toFixed(1), unit: '%' });
      add('resp-rate', { start: x, end: x, value: +(14.5 + r.normal() * 0.8).toFixed(1) });
    }
    if (hk) add('wrist-temp', { start: a, end: b, value: +(35.6 + r.normal() * 0.25).toFixed(2), unit: 'degC' });
    else add('wrist-temp', { start: a, end: b, fields: { baseline: 33.4, deltas: [0, 1, 2, 3].map((k) => ({ t: a + k * 2 * HOUR, delta: +(r.normal() * 0.3).toFixed(2) })), measurementLocation: 'wrist' } });
    void mid;
  }
  // workouts
  for (const [a, b, what] of workouts) {
    const m = (b - a) / MIN;
    const energyKcal = Math.round(m * (what === 'running' ? 11 : what === 'cycling' ? 8 : 4.5));
    const distanceM = Math.round(m * (what === 'running' ? 170 : what === 'cycling' ? 380 : 85));
    add('workout', { start: a, end: b, category: what, fields: { energyKcal, distanceM } });
  }
  // hours: steps, energy, distance
  for (let h = from; h < until; h += HOUR) {
    const w = working(h + 30 * MIN);
    const hour = Math.floor((local(h) % DAY) / HOUR);
    const steps = asleep(h + 30 * MIN) ? 0 : Math.max(0, Math.round((hour >= 8 && hour <= 20 ? 450 : 80) * (1 + r.normal() * 0.5) + (w && w[2] !== 'cycling' ? 4500 : 0)));
    if (!steps && !w) continue;
    add('steps', { start: h, end: h + HOUR, value: steps, unit: 'count' });
    add('active-energy', { start: h, end: h + HOUR, value: Math.round(steps * 0.04 + (w ? 300 : 0)), unit: 'kcal' });
    add('distance', { start: h, end: h + HOUR, value: Math.round(steps * 0.75), unit: 'm' });
  }
  // heart rate: every 5 minutes; Health Connect keeps an hour's samples in one record
  let hcBatch: { t: number; bpm: number }[] = [];
  let hcFrom = from;
  for (let t = from; t < until; t += 5 * MIN) {
    const w = working(t);
    const bpm = Math.round((asleep(t) ? dayRate(t, 54, tz) - 4 : dayRate(t, 62, tz) + (r.next() < 0.1 ? 20 : 0)) + (w ? 70 : 0) + r.normal() * 3);
    if (hk) add('hr', { start: t, end: t, value: bpm, unit: 'count/min' });
    else {
      hcBatch.push({ t, bpm });
      if (hcBatch.length === 12) { add('hr', { start: hcFrom, end: t, fields: { samples: hcBatch } }); hcBatch = []; hcFrom = t + 5 * MIN; }
    }
  }
  // a day's resting rate, a week's VO2 max
  for (let d = from; d < until; d += DAY) {
    add('resting-hr', { start: d, end: d + DAY, value: Math.round(56 + r.normal() * 2), unit: 'count/min' });
    if (Math.floor((d - from) / DAY) % 7 === 3) add('vo2max', { start: d + 12 * HOUR, end: d + 12 * HOUR, value: +(44 + r.normal()).toFixed(1) });
  }
  // one saved ECG (Apple Watch: 30 s at 512 Hz, lead I) three days ago
  if (hk) {
    const a = dayStart(clock.start) - 3 * DAY + 13 * HOUR, heart = new HeartModel(a, r.fork(5), () => 66), nz = r.fork(6);
    const voltages = Array.from({ length: 30 * 512 }, (_, i) => { const t = a + (i * 1000) / 512; return Math.round(ecgAt(t, heart.until(t, t - 3000), nz)); });
    add('ecg', { start: a, end: a + 30_000, fields: { voltages, hz: 512, lead: 'I', classification: 'sinusRhythm', averageHeartRate: 66, symptoms: [] } });
  }
  for (const l of lists.values()) l.sort((x, y) => at(x) - at(y));
  // a minute after the start, the person deletes the newest past workout in the health app
  const wl = lists.get(typeOf('workout')!);
  const victim = wl?.filter((x): x is HealthSample => !('deleted' in x) && x.end < clock.start).at(-1);
  if (wl && victim) { wl.push({ deleted: victim.uuid, at: clock.start + MIN }); wl.sort((x, y) => at(x) - at(y)); }

  let gone = false;
  if (o.disconnectAfterS && o.disconnectAfterS > 0) clock.at(o.disconnectAfterS * 1000, () => { gone = true; });
  const reachable = () => { if (gone) throw new Error(`${hk ? 'Apple Health' : 'Health Connect'} stopped answering.`); };

  const transport: HealthStoreTransport = {
    kind,
    async available() { return !gone; },
    async authorize(types) { reachable(); return hk ? { granted: [], unknown: types } : { granted: types, unknown: [] }; },
    async query(type, anchor, limit) {
      reachable();
      const list = lists.get(type) ?? [];
      const now = clock.now();
      let i = anchor === null ? 0 : Number(anchor.replace(/^\D+/, '')) || 0;
      const records: HealthSample[] = [], deleted: string[] = [];
      while (i < list.length && records.length < limit && at(list[i]) <= now) {
        const x = list[i++];
        if ('deleted' in x) deleted.push(x.deleted); else records.push(x);
      }
      return { records, deleted, anchor: `${hk ? 'hk' : 'hc'}${i}` };
    },
  };
  return { transport, step: (ms) => clock.step(ms), now: () => clock.now(), stop() { clock.stop(); gone = true; } };
}
