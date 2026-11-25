// A simulated OpenBCI Ganglion over Bluetooth LE: the board's GATT service (0xFE84), the commands written to its send
// characteristic, and notifications of the Ganglion Data Format on its receive characteristic.
//
//   'b'  start: one raw packet (id 0, four 24-bit counts), then 19-bit delta packets (ids 101..200, two samples
//        each) at 100 a second; with 'n' (the accelerometer on) 18-bit packets (ids 1..100) carrying one axis each
//   's'  stop; 'n' / 'N' the accelerometer on / off
//   'z'  the contact check: the signal stops and the impedance of channels 1-4 and the reference (ids 201..205, ASCII
//        ohms) comes once a second; 'Z' ends it
//
// Each delta is computed from what the receiver has decoded so far (a decoder that sees only the delivered packets),
// so a lost notification is one gap the driver counts and the values after it are right again.

import { MemoryGattTransport } from '../transports/memory.ts';
import {
  GANGLION_RECEIVE, GANGLION_SEND, GANGLION_SERVICE, GANGLION_UV_PER_COUNT, GanglionDecoder, encodeGanglionDeltas, GANGLION_NAMES,
} from '../drivers/openbci-ganglion.ts';
import { uuid } from '../util.ts';
import { Rng, SimClock, type SimOptions, type Simulator } from './clock.ts';
import { EegModel } from './signals.ts';

const MAX24 = 2 ** 23 - 1;

export function simulateGanglion(o: SimOptions = {}): Simulator<MemoryGattTransport> {
  const rng = new Rng(o.seed ?? 1);
  const clock = new SimClock(o);
  const loss = rng.fork(2), motion = rng.fork(3), contact = rng.fork(4);
  const eeg = new EegModel(GANGLION_NAMES, 200, rng.fork(1), o);
  const t = new MemoryGattTransport('Simulated Ganglion', 'sim-ganglion');
  const mirror = new GanglionDecoder();
  let streaming = false, accel = false, impedance = false, gone = false;
  let sample = 0, startedAt = 0, packet = 0, lastImp = 0;
  const notify = (b: Uint8Array) => { if (!(o.lossRate && loss.next() < o.lossRate)) { t.notify(GANGLION_SERVICE, GANGLION_RECEIVE, b); return true; } return false; };
  const toCounts = (uv: number) => Math.max(-MAX24 - 1, Math.min(MAX24, Math.round(uv / GANGLION_UV_PER_COUNT)));

  t.onWrite = (service, characteristic, bytes) => {
    if (gone || uuid(characteristic) !== uuid(GANGLION_SEND)) return;
    for (const c of new TextDecoder().decode(bytes)) {
      if (c === 'b' && !streaming) {
        streaming = true; startedAt = clock.elapsed; sample = 0; packet = 0;
        // the first sample whole: the deltas apply to it
        const first = eeg.next().map(toCounts);
        sample = 1;
        const raw = new Uint8Array(20);
        first.forEach((v, i) => { const x = v & 0xffffff; raw.set([(x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff], 1 + i * 3); });
        queueMicrotask(() => { if (!gone) { t.notify(GANGLION_SERVICE, GANGLION_RECEIVE, raw); mirror.decode(raw); } });
      } else if (c === 's') streaming = false;
      else if (c === 'n') accel = true;
      else if (c === 'N') accel = false;
      else if (c === 'z') { impedance = true; lastImp = clock.elapsed - 1000; }
      else if (c === 'Z') impedance = false;
    }
  };
  if (o.disconnectAfterS && o.disconnectAfterS > 0) clock.at(o.disconnectAfterS * 1000, () => { gone = true; streaming = false; t.drop(); t.closed = true; });

  clock.every((elapsed) => {
    if (!streaming || gone) return;
    if (impedance) {
      if (elapsed - lastImp < 1000) return;
      lastImp = elapsed;
      for (let ch = 1; ch <= 5; ch++) {
        const ohms = o.badChannel === ch ? 950_000 : Math.round(contact.range(4_000, 18_000));
        const b = new Uint8Array(20);
        b.set([200 + ch, ...new TextEncoder().encode(`${ohms}Z`)]);
        notify(b);
      }
      return;
    }
    // two samples per packet: send while the second one is due
    while (startedAt + ((sample + 1) * 1000) / 200 <= elapsed) {
      const a = eeg.next().map(toCounts), b = eeg.next().map(toCounts);
      sample += 2;
      const id = accel ? 1 + (packet % 100) : 101 + (packet % 100);
      packet++;
      const d1 = mirror.last.map((v, c) => v - a[c]);
      const lim = 2 ** ((accel ? 18 : 19) - 1) - 1;
      const clamp = (x: number) => Math.max(-lim, Math.min(lim, x));
      // the second delta from what the receiver will have after the first (the LSB the format loses)
      const p1 = encodeGanglionDeltas(id, [...d1.map(clamp), 0, 0, 0, 0]);
      const probe = new GanglionDecoder();
      probe.last = mirror.last.slice();
      const after1 = (probe.decode(p1) as { samples: number[][] }).samples[0];
      const axis = (id % 10) - 1;
      const g = axis === 2 ? 1 : 0;
      const accelByte = accel && axis >= 0 && axis <= 2 ? Math.round((g + motion.normal() * 0.02) / 0.032) : 0;
      const pk = encodeGanglionDeltas(id, [...d1.map(clamp), ...after1.map((v, c) => clamp(v - b[c]))], accelByte);
      if (notify(pk)) mirror.decode(pk);
    }
  });

  return {
    transport: t,
    step: (ms) => clock.step(ms),
    now: () => clock.now(),
    stop() { clock.stop(); gone = true; t.closed = true; },
  };
}
