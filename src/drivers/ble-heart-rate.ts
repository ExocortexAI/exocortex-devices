// Any Bluetooth LE heart-rate sensor: the standard Heart Rate service (0x180D) and its Heart Rate Measurement
// characteristic (0x2A37), and the Battery service (0x180F / 0x2A19). Chest straps (Polar, Garmin HRM, Wahoo TICKR,
// COROS), and the watches and bands that broadcast heart rate, speak it. Bluetooth SIG, Heart Rate Service 1.0.
//
// A measurement: a flags byte, then the heart rate (uint8, or uint16 LE when flags bit 0 is set), then the energy
// expended (uint16 LE kJ, when bit 3), then zero or more RR intervals (uint16 LE in 1/1024 s, when bit 4).
// Flags bits 1-2: sensor contact (bit 2 = the sensor reports contact; bit 1 = contact is detected).

import type { Connection, Descriptor, Driver, GattTransport, OpenContext } from '../contract.ts';
import { Counter, emitter, event, prov, uuid } from '../util.ts';

export const HR_SERVICE = uuid('180d');
export const HR_MEASUREMENT = uuid('2a37');
export const BATTERY_SERVICE = uuid('180f');
export const BATTERY_LEVEL = uuid('2a19');

export interface HeartRateMeasurement {
  bpm: number;
  /** undefined when the sensor does not report contact */
  contact?: boolean;
  energyKj?: number;
  /** RR intervals in milliseconds, in order */
  rrMs: number[];
}

export function parseHeartRate(v: DataView): HeartRateMeasurement {
  const flags = v.getUint8(0);
  let o = 1;
  let bpm: number;
  if (flags & 0x01) { bpm = v.getUint16(o, true); o += 2; } else { bpm = v.getUint8(o); o += 1; }
  const m: HeartRateMeasurement = { bpm, rrMs: [] };
  if (flags & 0x04) m.contact = (flags & 0x02) !== 0;
  if (flags & 0x08) { m.energyKj = v.getUint16(o, true); o += 2; }
  if (flags & 0x10) for (; o + 1 < v.byteLength; o += 2) m.rrMs.push((v.getUint16(o, true) * 1000) / 1024);
  return m;
}

export const hrChannels: Descriptor['channels'] = [
  { id: 'hr', kind: 'hr', label: 'Heart rate', shape: 'events', unit: 'bpm', defaultOn: true, sensitive: 'health' },
  { id: 'rr', kind: 'rr', label: 'RR intervals', shape: 'events', unit: 'ms', defaultOn: true, sensitive: 'health' },
  { id: 'energy', kind: 'energy', label: 'Energy expended', shape: 'events', unit: 'kJ', defaultOn: false },
];

export const bleHeartRateDescriptor: Descriptor = {
  id: 'ble-heart-rate',
  name: 'Bluetooth heart-rate sensor',
  vendor: 'Any',
  family: 'ble-heart-rate',
  models: ['Polar H10, H9, Verity Sense', 'Garmin HRM-Pro, HRM-Dual', 'Wahoo TICKR', 'COROS heart rate monitor', 'any sensor with the standard Heart Rate service'],
  placement: 'chest',
  about: 'Heart rate and beat-to-beat (RR) intervals from a chest strap or a watch that broadcasts heart rate.',
  channels: hrChannels,
  actions: [{ id: 'start', label: 'Start' }, { id: 'stop', label: 'Stop', safing: true }],
  routes: [{
    transport: 'web-bluetooth', hosts: ['chrome-desktop', 'android'], driver: 'ble-heart-rate',
    needs: ['Chrome on a computer or on Android'], freshness: 'live', dataLeaves: 'never', verified: 'loopback',
    evidence: 'test/ble-heart-rate.test.ts: flag permutations of the Heart Rate Service spec and a session against a simulated sensor',
  }],
  priority: 'P0',
  links: [{ label: 'Heart Rate Service', url: 'https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/' }],
};

/** the shared session: subscribe to 0x2A37 and emit hr / rr / energy events (the Polar H10 driver uses it too) */
export async function openHeartRate(
  t: GattTransport, ctx: OpenContext, descriptorId: string, emit: ReturnType<typeof emitter>, onContact: (c: boolean | undefined) => void,
): Promise<() => Promise<void>> {
  return t.subscribe(HR_SERVICE, HR_MEASUREMENT, (v) => {
    const m = parseHeartRate(v);
    const now = ctx.now();
    const p = prov(ctx, descriptorId, 'web-bluetooth', { serial: t.id, model: t.label });
    onContact(m.contact);
    // RR intervals arrive after the beats they measure: the last one ends at about `now`
    let end = now;
    const times = m.rrMs.slice().reverse().map((rr) => { const at = end; end -= rr; return at; }).reverse();
    if (m.contact !== false) emit(event('hr', p, { t0: now, receivedAt: now, clock: 'host', uncertaintyMs: 1000 }, 'heart rate', m.bpm, 'bpm'));
    m.rrMs.forEach((rr, i) => emit(event('rr', p, { t0: times[i], receivedAt: now, clock: 'host', uncertaintyMs: 100 }, 'RR interval', rr, 'ms', { source: 'ecg-strap' })));
    if (m.energyKj !== undefined) emit(event('energy', p, { t0: now, receivedAt: now, clock: 'host' }, 'energy expended', m.energyKj, 'kJ'));
  });
}

export async function readBattery(t: GattTransport): Promise<number | undefined> {
  try { return (await t.read(BATTERY_SERVICE, BATTERY_LEVEL)).getUint8(0) / 100; } catch { return undefined; }
}

export const bleHeartRate: Driver<GattTransport> = {
  id: 'ble-heart-rate',
  descriptor: bleHeartRateDescriptor,
  transport: 'web-bluetooth',
  bluetooth: { filters: [{ services: [HR_SERVICE] }], optionalServices: [BATTERY_SERVICE] },
  async open(t, ctx): Promise<Connection> {
    const counter = new Counter();
    const emit = emitter(ctx, counter);
    let unsub: (() => Promise<void>) | null = null;
    let wear: 'on' | 'off' | 'unknown' = 'unknown';
    let battery: number | undefined;
    let closing = false;
    const report = (state: 'streaming' | 'idle' | 'closed') => ctx.status(counter.status(state, { battery, wear }));
    t.onDisconnect(() => {
      if (closing) return;
      ctx.status(counter.status(unsub ? 'stale' : 'closed', { why: 'The sensor went out of range or turned off.', battery, wear }));
      unsub = null;
    });
    const start = async () => {
      if (unsub) return;
      battery = await readBattery(t);
      unsub = await openHeartRate(t, ctx, 'ble-heart-rate', emit, (c) => {
        const w = c === undefined ? 'unknown' : c ? 'on' : 'off';
        if (w !== wear) { wear = w; report('streaming'); }
      });
      report('streaming');
    };
    const stop = async () => { await unsub?.(); unsub = null; report('idle'); };
    return {
      start, stop,
      async act(a) {
        if (a === 'start') { await start(); return { outcome: 'done' }; }
        if (a === 'stop') { await stop(); return { outcome: 'done' }; }
        return { outcome: 'unsupported' };
      },
      async close() { closing = true; await stop(); await t.close(); report('closed'); },
    };
  },
};
