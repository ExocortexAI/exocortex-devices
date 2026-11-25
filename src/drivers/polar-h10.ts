// Polar H10: ECG at 130 Hz and the accelerometer through the Polar Measurement Data (PMD) service, and heart rate
// with RR intervals through the standard Heart Rate service (./ble-heart-rate.ts). Layouts follow polar-ble-sdk
// (github.com/polarofficial/polar-ble-sdk: BlePMDClient, PmdControlPointCommand, PmdDataFrame, EcgData, AccData).
//
// Control point (FB005C81, write + notify): [op][measurement type][setting type, count = 1, value LE] …
//   op 1 get settings, 2 start, 3 stop. Types: 0 ECG, 2 ACC. Settings: 0 sample rate (u16), 1 resolution (u16),
//   2 range (u16). Start ECG at 130 Hz, 14 bits: 02 00 00 01 82 00 01 01 0E 00.
//   Start ACC at 200 Hz, 16 bits, ±8 g: 02 02 00 01 C8 00 01 01 10 00 02 01 08 00.
//   A response: F0 [op] [type] [status, 0 = success] [more] [parameters…].
// Data (FB005C82, notify): [type][timestamp: uint64 LE ns, the time of the frame's last sample][frame type][payload].
//   ECG frame type 0: 3-byte signed LE µV per sample. ACC frame type 1: int16 LE x, y, z in mg per sample.
//   Bit 0x80 of the frame type marks a delta-compressed frame (not used by the H10 for these settings; skipped).
// The sensor's clock: Polar documents nanoseconds since 2000-01-01 UTC when the clock was set by the Polar app;
// the driver does not rely on that. It keeps the sensor's sample spacing and anchors it to the host's clock at the
// first frame (clock 'device', with the offset's uncertainty).

import type { Connection, Descriptor, Driver, GattTransport, OpenContext } from '../contract.ts';
import { Counter, chunk, columns, emitter, int24le, prov, uuid } from '../util.ts';
import { BATTERY_SERVICE, HR_SERVICE, hrChannels, openHeartRate, readBattery } from './ble-heart-rate.ts';

export const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';
export const START_ECG = Uint8Array.from([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
export const START_ACC = Uint8Array.from([0x02, 0x02, 0x00, 0x01, 0xc8, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00]);
export const STOP_ECG = Uint8Array.from([0x03, 0x00]);
export const STOP_ACC = Uint8Array.from([0x03, 0x02]);

const PMD_STATUS = [
  'success', 'invalid op code', 'invalid measurement type', 'not supported', 'invalid length', 'invalid parameter',
  'already in state', 'invalid resolution', 'invalid sample rate', 'invalid range', 'invalid MTU',
  'invalid number of channels', 'invalid state', 'the device is in its charger',
];

export type PmdFrame =
  | { type: 'ecg'; timestampNs: bigint; uv: number[] }
  | { type: 'acc'; timestampNs: bigint; mg: [number, number, number][] }
  | { type: 'other'; measurement: number; frameType: number; timestampNs: bigint };

export function parsePmdFrame(b: Uint8Array): PmdFrame | null {
  if (b.length < 10) return null;
  const measurement = b[0] & 0x3f;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const timestampNs = v.getBigUint64(1, true);
  const frameType = b[9];
  const body = b.subarray(10);
  if (measurement === 0 && frameType === 0x00) {
    const uv: number[] = [];
    for (let o = 0; o + 3 <= body.length; o += 3) uv.push(int24le(body, o));
    return { type: 'ecg', timestampNs, uv };
  }
  if (measurement === 2 && frameType === 0x01) {
    const mg: [number, number, number][] = [];
    for (let o = 0; o + 6 <= body.length; o += 6) mg.push([v.getInt16(10 + o, true), v.getInt16(12 + o, true), v.getInt16(14 + o, true)]);
    return { type: 'acc', timestampNs, mg };
  }
  return { type: 'other', measurement, frameType, timestampNs };
}

export function parsePmdResponse(b: Uint8Array): { op: number; measurement: number; status: number; why: string } | null {
  if (b.length < 4 || b[0] !== 0xf0) return null;
  return { op: b[1], measurement: b[2], status: b[3], why: PMD_STATUS[b[3]] ?? `status ${b[3]}` };
}

export const polarH10Descriptor: Descriptor = {
  id: 'polar-h10',
  name: 'Polar H10',
  vendor: 'Polar',
  family: 'polar',
  models: ['H10'],
  placement: 'chest',
  about: 'Raw ECG at 130 Hz, chest motion, heart rate and RR intervals.',
  channels: [
    { id: 'ecg', kind: 'ecg', label: 'ECG', shape: 'samples', unit: 'uV', rateHz: 130, count: 1, names: ['ECG'], defaultOn: true, sensitive: 'health' },
    { id: 'accel', kind: 'accel', label: 'Accelerometer', shape: 'samples', unit: 'mg', rateHz: 200, count: 3, names: ['x', 'y', 'z'], defaultOn: false },
    ...hrChannels,
  ],
  actions: [{ id: 'start', label: 'Start' }, { id: 'stop', label: 'Stop', safing: true }],
  routes: [{
    transport: 'web-bluetooth', hosts: ['chrome-desktop', 'android'], driver: 'polar-h10',
    needs: ['Chrome on a computer or on Android', 'the strap worn (it sleeps without skin contact)'],
    freshness: 'live', dataLeaves: 'never', verified: 'loopback',
    evidence: 'test/polar-h10.test.ts: PMD commands and frames per polar-ble-sdk, a session against a simulated strap',
  }],
  priority: 'P0',
  links: [{ label: 'Polar BLE SDK', url: 'https://github.com/polarofficial/polar-ble-sdk' }],
};

export const polarH10: Driver<GattTransport> = {
  id: 'polar-h10',
  descriptor: polarH10Descriptor,
  transport: 'web-bluetooth',
  bluetooth: { filters: [{ namePrefix: 'Polar H10' }], optionalServices: [PMD_SERVICE, HR_SERVICE, BATTERY_SERVICE] },
  async open(t, ctx) { return openPolar(t, ctx); },
};

async function openPolar(t: GattTransport, ctx: OpenContext): Promise<Connection> {
  const counter = new Counter();
  const emit = emitter(ctx, counter);
  const p = () => prov(ctx, 'polar-h10', 'web-bluetooth', { serial: t.id, model: 'H10' });
  const unsubs: (() => Promise<void>)[] = [];
  let streaming = false;
  let closing = false;
  let battery: number | undefined;
  let wear: 'on' | 'off' | 'unknown' = 'unknown';
  // host ms minus sensor ms, fixed at the first frame
  let offsetMs: number | null = null;
  const last = new Map<string, bigint>();
  let pending: ((r: ReturnType<typeof parsePmdResponse>) => void) | null = null;
  const info: Record<string, string> = {};

  const sampleTimes = (key: string, ts: bigint, n: number, rateHz: number) => {
    const prev = last.get(key);
    last.set(key, ts);
    const tsMs = Number(ts) / 1e6;
    const now = ctx.now();
    if (offsetMs === null) offsetMs = now - tsMs;
    // spacing from the previous frame when there is one, else from the nominal rate
    const dt = prev !== undefined && ts > prev ? (Number(ts - prev) / 1e6) / n : 1000 / rateHz;
    return { t0: tsMs + offsetMs - dt * (n - 1), receivedAt: now, rate: 1000 / dt };
  };

  const onData = (v: DataView) => {
    const f = parsePmdFrame(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (!f) return;
    if (f.type === 'ecg' && f.uv.length) {
      const s = sampleTimes('ecg', f.timestampNs, f.uv.length, 130);
      emit(chunk('ecg', p(), { t0: s.t0, receivedAt: s.receivedAt, clock: 'device', uncertaintyMs: 100 }, 130, ['ECG'], 'uV', [Float32Array.from(f.uv)]));
    } else if (f.type === 'acc' && f.mg.length) {
      const s = sampleTimes('acc', f.timestampNs, f.mg.length, 200);
      emit(chunk('accel', p(), { t0: s.t0, receivedAt: s.receivedAt, clock: 'device', uncertaintyMs: 100 }, 200, ['x', 'y', 'z'], 'mg', columns(f.mg, 3)));
    }
  };
  const onControl = (v: DataView) => {
    const r = parsePmdResponse(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (r && pending) { const f = pending; pending = null; f(r); }
  };
  const command = async (bytes: Uint8Array): Promise<void> => {
    const answer = new Promise<ReturnType<typeof parsePmdResponse>>((resolve) => {
      pending = resolve;
      setTimeout(() => { if (pending === resolve) { pending = null; resolve(null); } }, 3000);
    });
    await t.write(PMD_SERVICE, PMD_CONTROL, bytes, true);
    const r = await answer;
    if (!r) throw new Error('The strap did not answer. Wet the electrodes and wear the strap: the H10 sleeps without skin contact.');
    // 6: already in that state (a second start), which is fine
    if (r.status !== 0 && r.status !== 6) throw new Error(`The strap refused the command: ${r.why}.`);
  };

  t.onDisconnect(() => {
    if (closing) return;
    ctx.status(counter.status(streaming ? 'stale' : 'closed', { why: 'The strap went out of range or went to sleep.', battery, wear, info }));
    streaming = false;
  });

  const start = async () => {
    if (streaming) return;
    ctx.status({ state: 'connecting', why: 'Starting the ECG.' });
    battery = await readBattery(t);
    unsubs.push(await t.subscribe(PMD_SERVICE, PMD_CONTROL, onControl));
    unsubs.push(await t.subscribe(PMD_SERVICE, PMD_DATA, onData));
    unsubs.push(await openHeartRate(t, ctx, 'polar-h10', emit, (c) => { wear = c === undefined ? 'unknown' : c ? 'on' : 'off'; }));
    offsetMs = null;
    last.clear();
    try {
      if (ctx.enabled.has('ecg')) await command(START_ECG);
      if (ctx.enabled.has('accel')) await command(START_ACC);
    } catch (e) {
      ctx.status(counter.status('error', { why: e instanceof Error ? e.message : String(e), battery, wear }));
      throw e;
    }
    info.ecg = ctx.enabled.has('ecg') ? '130 Hz, 14 bits' : 'off';
    info.accel = ctx.enabled.has('accel') ? '200 Hz, ±8 g' : 'off';
    streaming = true;
    ctx.status(counter.status('streaming', { battery, wear, info }));
  };
  const stop = async () => {
    if (streaming) {
      try {
        if (ctx.enabled.has('ecg')) await command(STOP_ECG);
        if (ctx.enabled.has('accel')) await command(STOP_ACC);
      } catch { /* the strap is gone or asleep: nothing more to stop */ }
    }
    for (const u of unsubs.splice(0)) await u();
    streaming = false;
    ctx.status(counter.status('idle', { battery, wear, info }));
  };
  return {
    start, stop,
    async act(a) {
      if (a === 'start') { await start(); return { outcome: 'done' }; }
      if (a === 'stop') { await stop(); return { outcome: 'done' }; }
      return { outcome: 'unsupported' };
    },
    async close() { closing = true; await stop(); await t.close(); ctx.status(counter.status('closed', { battery, wear, info })); },
  };
}
