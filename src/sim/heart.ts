// A simulated Bluetooth heart-rate strap (the standard Heart Rate service) and a simulated Polar H10 (the same, plus
// Polar's Measurement Data service).
//
// Heart rate (0x2A37): one notification a second, flags 0x16 (contact supported and detected, RR intervals present),
// the rate as uint8, then the RR intervals of the beats that ended in that second in 1/1024 s. Battery (0x2A19): 87 %.
// The H10's PMD control point answers [0xF0, op, type, 0 (success), 0]; started, ECG comes in frames of 73 samples at
// 130 Hz (3-byte signed LE µV) and the accelerometer in frames of 36 samples at 200 Hz (int16 LE mg), each frame
// stamped with its last sample's time in ns.

import { MemoryGattTransport } from '../transports/memory.ts';
import { BATTERY_LEVEL, BATTERY_SERVICE, HR_MEASUREMENT, HR_SERVICE } from '../drivers/ble-heart-rate.ts';
import { PMD_CONTROL, PMD_DATA, PMD_SERVICE } from '../drivers/polar-h10.ts';
import { uuid } from '../util.ts';
import { Rng, SimClock, type SimOptions, type Simulator } from './clock.ts';
import { HeartModel, ecgAt } from './signals.ts';

const ECG_FRAME = 73, ACC_FRAME = 36;
const EPOCH_2000 = Date.UTC(2000, 0, 1);

function strap(o: SimOptions, label: string, id: string, polar: boolean): Simulator<MemoryGattTransport> {
  const rng = new Rng(o.seed ?? 1);
  const clock = new SimClock(o);
  const loss = rng.fork(2), noise = rng.fork(3), motion = rng.fork(4);
  const heart = new HeartModel(clock.start, rng.fork(1), (t) => 60 + 6 * Math.sin((2 * Math.PI * (t - clock.start)) / 600_000));
  const t = new MemoryGattTransport(label, id);
  t.setValue(BATTERY_SERVICE, BATTERY_LEVEL, [87]);
  let gone = false, lastHr = clock.start;
  let ecg: { from: number; n: number; buf: number[] } | null = null;
  let acc: { from: number; n: number; buf: number[][] } | null = null;
  const lost = () => !!o.lossRate && loss.next() < o.lossRate;
  const notify = (s: string, c: string, b: Uint8Array) => { if (!gone && !lost()) t.notify(s, c, b); };

  if (polar) {
    t.onWrite = (service, characteristic, bytes) => {
      if (gone || uuid(characteristic) !== uuid(PMD_CONTROL)) return;
      const op = bytes[0], type = bytes[1];
      if (op === 2 && type === 0) ecg = { from: clock.now(), n: 0, buf: [] };
      if (op === 2 && type === 2) acc = { from: clock.now(), n: 0, buf: [] };
      if (op === 3 && type === 0) ecg = null;
      if (op === 3 && type === 2) acc = null;
      queueMicrotask(() => { if (!gone) t.notify(PMD_SERVICE, PMD_CONTROL, [0xf0, op, type, 0, 0]); });
    };
  }
  if (o.disconnectAfterS && o.disconnectAfterS > 0) clock.at(o.disconnectAfterS * 1000, () => { gone = true; t.drop(); t.closed = true; });

  const frame = (type: number, frameType: number, lastAt: number, body: Uint8Array) => {
    const b = new Uint8Array(10 + body.length);
    b[0] = type;
    new DataView(b.buffer).setBigUint64(1, BigInt(Math.round((lastAt - EPOCH_2000) * 1e6)), true);
    b[9] = frameType;
    b.set(body, 10);
    return b;
  };

  clock.every(() => {
    if (gone) return;
    const now = clock.now();
    while (lastHr + 1000 <= now) {
      const from = lastHr, to = lastHr + 1000;
      lastHr = to;
      const beats = heart.between(from, to);
      const all = heart.until(to);
      const k = all.findIndex((x) => x > to);
      const rrNow = k > 1 ? all[k - 1] - all[k - 2] : 1000;
      const rr = beats.map((b) => { const i = all.indexOf(b); return i > 0 ? b - all[i - 1] : rrNow; });
      const bytes = [0x16, Math.round(60_000 / rrNow)];
      for (const x of rr) { const v = Math.round((x * 1024) / 1000); bytes.push(v & 0xff, (v >> 8) & 0xff); }
      notify(HR_SERVICE, HR_MEASUREMENT, Uint8Array.from(bytes));
    }
    if (ecg) {
      const e = ecg;
      while (e.from + ((e.n + 1) * 1000) / 130 <= now) {
        const at = e.from + (e.n * 1000) / 130;
        e.buf.push(Math.round(ecgAt(at, heart.until(at, at - 3000), noise)));
        e.n++;
        if (e.buf.length === ECG_FRAME) {
          const body = new Uint8Array(ECG_FRAME * 3);
          e.buf.forEach((v, i) => { const x = v & 0xffffff; body.set([x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff], i * 3); });
          notify(PMD_SERVICE, PMD_DATA, frame(0x00, 0x00, at, body));
          e.buf = [];
        }
      }
    }
    if (acc) {
      const a = acc;
      while (a.from + ((a.n + 1) * 1000) / 200 <= now) {
        const at = a.from + (a.n * 1000) / 200;
        // the chest: gravity on x (the strap upright), breathing on z
        a.buf.push([Math.round(980 + motion.normal() * 6), Math.round(motion.normal() * 6), Math.round(25 * Math.sin((2 * Math.PI * 0.25 * at) / 1000) + motion.normal() * 6)]);
        a.n++;
        if (a.buf.length === ACC_FRAME) {
          const body = new Uint8Array(ACC_FRAME * 6), v = new DataView(body.buffer);
          a.buf.forEach((s, i) => s.forEach((x, j) => v.setInt16(i * 6 + j * 2, x, true)));
          notify(PMD_SERVICE, PMD_DATA, frame(0x02, 0x01, at, body));
          a.buf = [];
        }
      }
    }
  });

  return { transport: t, step: (ms) => clock.step(ms), now: () => clock.now(), stop() { clock.stop(); gone = true; t.closed = true; } };
}

export const simulateHeartRate = (o: SimOptions = {}) => strap(o, 'Simulated heart-rate strap', 'sim-hr', false);
export const simulatePolarH10 = (o: SimOptions = {}) => strap(o, 'Polar H10 SIM00001', 'sim-h10', true);
