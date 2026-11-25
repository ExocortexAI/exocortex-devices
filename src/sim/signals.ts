// Signals that look real enough to develop against. Each model makes one sample at a time, in order, from its own
// seeded stream, so the values depend only on the seed and the sample's index.
//
// EEG: a 1/f background per channel (Paul Kellet's pink filter over white noise), a posterior alpha rhythm near
// 10 Hz whose amplitude rises in the "eyes closed" stretches, blinks on Fp1/Fp2 (and less on the other frontal
// sites) while the eyes are open, 60 Hz mains on every channel, a small DC offset; optionally a bad (railed or flat)
// channel and a stuck one. Heart: beat times with a day's rhythm in the rate, respiratory sinus arrhythmia (0.25 Hz),
// a Mayer wave (0.1 Hz) and a little randomness; ECG as P, Q, R, S and T waves (sums of Gaussians) around each beat.

import { regionOf } from '../eeg.ts';
import { Rng, type SimOptions } from './clock.ts';

/** full scale of the Cyton's ADS1299 at gain 24, in µV: a railed electrode reads this */
export const RAIL_UV = 187_500;

const ALPHA_WEIGHT: Record<string, number> = { occipital: 1, parietal: 0.7, temporal: 0.35, central: 0.3, frontal: 0.15 };

/** one stretch of the eyes' state, in seconds since the signal began */
interface Stretch { from: number; to: number; closed: boolean }

export class EegModel {
  readonly names: string[];
  readonly fs: number;
  private rng: Rng;
  private o: SimOptions;
  private pink: Float64Array[];
  private offset: number[];
  private alphaW: number[];
  private blinkW: number[];
  private mainsPhase: number[];
  private alphaHz: number;
  private env = 1;
  private stretches: Stretch[] = [];
  private blinks: number[] = [];       // blink start times, s
  private stuck: number | null = null;
  n = 0;

  constructor(names: string[], fs: number, rng: Rng, o: SimOptions = {}) {
    this.names = names; this.fs = fs; this.rng = rng; this.o = o;
    this.pink = names.map(() => new Float64Array(7));
    this.offset = names.map(() => rng.range(-40, 40));
    const region = names.map((x) => regionOf(x));
    // a board with no 10-20 names (a Ganglion's 1..4): the first two are frontal-like, the last two occipital-like
    this.alphaW = names.map((x, i) => (region[i] ? ALPHA_WEIGHT[region[i]!] : i >= names.length / 2 ? 0.9 : 0.2));
    this.blinkW = names.map((x, i) => (/^Fp/i.test(x) ? 1 : region[i] === 'frontal' ? 0.3 : region[i] ? 0.05 : i === 0 ? 0.6 : 0.05));
    this.mainsPhase = names.map(() => rng.range(-0.3, 0.3));
    this.alphaHz = rng.range(9.4, 10.6);
    this.plan(0);
  }

  /** the eyes' stretches and the blinks until `until` seconds */
  private plan(until: number) {
    let end = this.stretches.at(-1)?.to ?? 0;
    while (end <= until + 30) {
      const closed = this.stretches.length % 2 === 1;
      const len = closed ? this.rng.range(8, 16) : this.rng.range(12, 24);
      this.stretches.push({ from: end, to: end + len, closed });
      if (!closed) for (let t = end + this.rng.range(0.5, 2); t < end + len - 0.4; t += this.rng.range(2, 6)) this.blinks.push(t);
      else this.blinks.push(end + len - 0.2);       // the eyes open with a blink
      end += len;
    }
  }

  /** whether the eyes are closed at `t` seconds, and how far into the change (0..1 closed) */
  closedness(t: number): number {
    let i = this.stretches.findIndex((x) => t >= x.from && t < x.to);
    if (i < 0) i = this.stretches.length - 1;
    const s = this.stretches[i];
    const ramp = Math.min(1, (t - s.from) / 0.5);
    return s.closed ? ramp : i > 0 ? 1 - ramp : 0;
  }
  eyesClosed(t: number): boolean { return !!this.stretches.find((x) => t >= x.from && t < x.to)?.closed; }

  /** the next sample of every channel, in µV */
  next(): number[] {
    const t = this.n / this.fs;
    this.n++;
    if (t > (this.stretches.at(-1)?.to ?? 0) - 30) this.plan(t);
    // the alpha envelope wanders slowly (an AR(1) around 1)
    this.env += (1 - this.env) * (1 / this.fs) + this.rng.normal() * 0.02;
    const closed = this.closedness(t);
    const alphaAmp = (6 + 24 * closed) * Math.max(0.3, this.env);
    const alpha = Math.sin(2 * Math.PI * this.alphaHz * t);
    while (this.blinks.length && this.blinks[0] < t - 1) this.blinks.shift();
    let blink = 0;
    for (const b of this.blinks) {
      const d = t - b;
      if (d >= 0 && d < 0.35) blink += 150 * Math.sin((Math.PI * d) / 0.35) ** 2;
    }
    const out: number[] = [];
    for (let c = 0; c < this.names.length; c++) {
      const w = this.rng.normal();
      const p = this.pink[c];
      // Kellet's filter: -3 dB per octave over the band
      p[0] = 0.99886 * p[0] + w * 0.0555179; p[1] = 0.99332 * p[1] + w * 0.0750759; p[2] = 0.969 * p[2] + w * 0.153852;
      p[3] = 0.8665 * p[3] + w * 0.3104856; p[4] = 0.55 * p[4] + w * 0.5329522; p[5] = -0.7616 * p[5] - w * 0.016898;
      const pink = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + w * 0.5362;
      p[6] = w * 0.115926;
      let v = this.offset[c] + pink * 4 + alphaAmp * this.alphaW[c] * alpha + blink * this.blinkW[c]
        + 5 * Math.sin(2 * Math.PI * 60 * t + this.mainsPhase[c]);
      if (this.o.badChannel === c + 1) v = (this.o.badKind ?? 'railed') === 'flat' ? 0 : RAIL_UV;
      if (this.o.stuckChannel === c + 1) { this.stuck ??= v; v = this.stuck; }
      out.push(v);
    }
    return out;
  }
}

/** heart rate over a day: lowest near 4 am, highest in the afternoon, bpm */
export function dayRate(t: number, rest = 60, tzOffsetMin = 0): number {
  const h = (((t / 3_600_000 + tzOffsetMin / 60) % 24) + 24) % 24;
  return rest + 7 - 7 * Math.cos((2 * Math.PI * (h - 4)) / 24);
}

/** beat times (ms since the epoch) with RR variability */
export class HeartModel {
  private rng: Rng;
  private rate: (t: number) => number;
  private beats: number[] = [];
  private noise = 0;
  constructor(start: number, rng: Rng, rate: (t: number) => number = (t) => dayRate(t)) {
    this.rng = rng; this.rate = rate;
    this.beats.push(start - rng.range(0, 800));
  }
  /** the RR interval (ms) of the beat that starts at `t` */
  private rr(t: number): number {
    const base = 60_000 / this.rate(t);
    this.noise = 0.7 * this.noise + this.rng.normal() * 12;
    const s = t / 1000;
    return base + 40 * Math.sin(2 * Math.PI * 0.25 * s) + 20 * Math.sin(2 * Math.PI * 0.1 * s) + this.noise;
  }
  /** every beat up to `t`, kept from `keepFrom` on */
  until(t: number, keepFrom = t - 5000): number[] {
    while (this.beats.at(-1)! <= t + 2000) this.beats.push(this.beats.at(-1)! + this.rr(this.beats.at(-1)!));
    while (this.beats.length > 3 && this.beats[1] < keepFrom) this.beats.shift();
    return this.beats;
  }
  /** the beats in (from, to] */
  between(from: number, to: number): number[] { return this.until(to, from - 3000).filter((b) => b > from && b <= to); }
}

// the waves of one beat, relative to the R peak: centre (s), width (s), amplitude (µV); T moves with the RR (Bazett)
const WAVES: [number, number, number][] = [[-0.17, 0.025, 120], [-0.03, 0.01, -120], [0, 0.011, 1300], [0.03, 0.012, -280]];

/** ECG in µV at time `t` (ms) from the beats around it, with breathing's baseline wander and a little noise */
export function ecgAt(t: number, beats: number[], rng: Rng): number {
  let v = 0;
  for (let i = 0; i < beats.length; i++) {
    const d = (t - beats[i]) / 1000;
    if (d < -0.4 || d > 0.7) continue;
    const rr = ((beats[i + 1] ?? beats[i] + 900) - beats[i]) / 1000;
    for (const [c, w, a] of WAVES) v += a * Math.exp(-(((d - c) / w) ** 2) / 2);
    const tc = 0.25 * Math.sqrt(rr);
    v += 320 * Math.exp(-(((d - tc) / 0.05) ** 2) / 2);
  }
  return v + 60 * Math.sin((2 * Math.PI * 0.25 * t) / 1000) + rng.normal() * 8;
}
