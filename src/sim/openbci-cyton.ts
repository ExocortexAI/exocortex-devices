// A simulated OpenBCI Cyton (and Cyton + Daisy) behind its USB dongle: it answers the Cyton SDK's commands with the
// firmware's own words and streams 33-byte packets of the Cyton Data Format at 250 packets a second.
//
//   'v'  soft reset: the v3 banner ("On Daisy ADS1299 …" when a Daisy is seated), ending in '$$$'
//   'b'  start streaming; 's' stop
//   'c'  remove the Daisy ("daisy removed$$$"); 'C' attach it ("daisy attached16$$$", or "no daisy to attach!8$$$")
//   'z…Z' lead-off settings: taken, nothing streams differently
//
// The Cyton alone: one packet per 250 Hz sample, channels 1-8, the accelerometer in every tenth packet (footer 0xC0).
// With the Daisy: the board's channels on odd sample numbers and the Daisy's on even ones, one pair per 125 Hz sample.
// The sample number counts packets, 0..255, so a lost packet is a gap the driver counts.

import { MemoryByteTransport } from '../transports/memory.ts';
import { CYTON_DAISY_NAMES, CYTON_NAMES, encodeCytonPacket, uvPerCount } from '../drivers/openbci-cyton.ts';
import { Rng, SimClock, type SimOptions, type Simulator } from './clock.ts';
import { EegModel } from './signals.ts';

const FIRMWARE = 'v3.1.2';
export const cytonBanner = (daisy: boolean) => `OpenBCI V3 8-16 channel\nOn Board ADS1299 Device ID: 0x3E\n${daisy ? 'On Daisy ADS1299 Device ID: 0x3E\n' : ''}LIS3DH Device ID: 0x33\nFirmware: ${FIRMWARE}\n$$$`;

const MAX = 2 ** 23 - 1;
const counts = (uv: number, scale: number) => Math.max(-MAX - 1, Math.min(MAX, Math.round(uv / scale)));

export function simulateCyton(o: SimOptions & { daisy?: boolean } = {}): Simulator<MemoryByteTransport> {
  const seated = !!o.daisy;
  const rng = new Rng(o.seed ?? 1);
  const clock = new SimClock(o);
  const loss = rng.fork(2);
  const motion = rng.fork(3);
  const scale = uvPerCount(24);
  let daisy = seated;
  const models = { 8: new EegModel(CYTON_NAMES, 250, rng.fork(1), o), 16: new EegModel(CYTON_DAISY_NAMES, 125, rng.fork(1), o) };
  let streaming = false, packet = 0, startedAt = 0, gone = false;
  let pair: number[] | null = null;
  let tilt = 0;

  const t = new MemoryByteTransport(seated ? 'Simulated Cyton + Daisy' : 'Simulated Cyton', (bytes, port) => {
    if (gone) return;
    const cmd = new TextDecoder().decode(bytes);
    const say = (s: string) => queueMicrotask(() => { if (!gone) port.push(s); });
    switch (cmd[0]) {
      case 'v': streaming = false; say(cytonBanner(daisy)); break;
      case 'b': if (!streaming) { streaming = true; startedAt = clock.elapsed; packet = 0; pair = null; } break;
      case 's': streaming = false; break;
      case 'c': daisy = false; say('daisy removed$$$'); break;
      case 'C': if (seated) { daisy = true; say('daisy attached16$$$'); } else say('no daisy to attach!8$$$'); break;
      default: break;
    }
  });
  const open = t.open.bind(t);
  t.open = async (x) => {
    await open(x);
    if (o.disconnectAfterS && o.disconnectAfterS > 0) clock.at(clock.elapsed + o.disconnectAfterS * 1000, () => { gone = true; streaming = false; void t.close(); });
  };

  const accel = (): [number, number, number] => {
    tilt += motion.normal() * 0.01;
    tilt *= 0.995;
    // 1 g is 8000 counts (0.002 / 16 g per count): the board flat, the head tilting a little
    return [Math.round(8000 * Math.sin(tilt) + motion.normal() * 30), Math.round(motion.normal() * 30), Math.round(8000 * Math.cos(tilt) + motion.normal() * 30)];
  };

  clock.every((elapsed) => {
    if (!streaming || gone) return;
    while (startedAt + (packet * 1000) / 250 <= elapsed) {
      const s = (packet + 1) & 0xff;
      let ch: number[];
      if (!daisy) ch = models[8].next();
      else {
        // odd: a new 125 Hz sample, the board's half; even: the Daisy's half of the same sample
        if (s % 2 === 1 || !pair) pair = models[16].next();
        ch = s % 2 === 1 ? pair.slice(0, 8) : pair.slice(8, 16);
      }
      const a = packet % 10 === 0 ? accel() : undefined;
      const lost = o.lossRate ? loss.next() < o.lossRate : false;
      if (!lost) t.push(encodeCytonPacket(s, ch.map((v) => counts(v, scale)), a));
      packet++;
    }
  });

  return {
    transport: t,
    step: (ms) => clock.step(ms),
    now: () => clock.now(),
    stop() { clock.stop(); gone = true; streaming = false; void t.close(); },
  };
}
