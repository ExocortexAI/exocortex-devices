// The simulators' shared parts: their options, a seeded random source and a simulated clock.
//
// A simulator's values depend only on its seed and the index of each sample, never on when a timer fired, so two
// runs with one seed give the same samples whatever the machine's load. The clock decides only when bytes are sent:
// in real time times `speed` (a 20 ms timer), or, with `manual`, only when the caller steps it (tests).

import type { SettingSpec } from '../contract.ts';

export interface SimOptions {
  /** the random seed: the same seed gives the same signals, packets and losses */
  seed?: number;
  /** simulated seconds per real second (1: real time) */
  speed?: number;
  /** the link is lost this many simulated seconds after the device was opened (0 or absent: never) */
  disconnectAfterS?: number;
  /** the share of packets (notifications, frames) lost on the way, 0 to 1 */
  lossRate?: number;
  /** a channel (1-based) whose value does not change: the ADC holds one value */
  stuckChannel?: number;
  /** a channel (1-based) with a bad contact: railed (at full scale) or flat (zero) */
  badChannel?: number;
  badKind?: 'railed' | 'flat';
  /** the simulated clock's start, ms since the epoch (default: now) */
  start?: number;
  /** no timers: the clock moves only by `step(ms)` */
  manual?: boolean;
}

/** what every simulator gives back */
export interface Simulator<T> {
  transport: T;
  /** stop the simulated device: its timers end and its link is closed */
  stop(): void;
  /** move the simulated clock on by `ms` (with `manual`; also works with timers) */
  step(ms: number): void;
  /** the simulated clock, ms since the epoch */
  now(): number;
}

/** the options as a device page's fields (the drivers' SettingSpec): a simulator's settings */
export const SIM_SETTINGS: SettingSpec[] = [
  { id: 'seed', label: 'Seed', type: 'number', default: 1, help: 'The same seed gives the same signals.' },
  { id: 'speed', label: 'Speed', type: 'number', default: 1, help: 'Simulated seconds per second.' },
  { id: 'disconnectAfterS', label: 'Lose the link after (s)', type: 'number', default: 0, help: '0: never.' },
  { id: 'lossRate', label: 'Packets lost (0 to 1)', type: 'number', default: 0 },
  { id: 'stuckChannel', label: 'Stuck channel', type: 'number', default: 0, help: 'Its number; 0: none.' },
  { id: 'badChannel', label: 'Bad channel', type: 'number', default: 0, help: 'Its number; 0: none.' },
  { id: 'badKind', label: 'Bad as', type: 'select', default: 'railed', options: [{ value: 'railed', label: 'Railed' }, { value: 'flat', label: 'Flat' }] },
];

/** options read from a plain config (a paired device's `config`): unknown or bad values fall back to the defaults */
export function simOptions(x: Record<string, unknown> | undefined): SimOptions {
  const n = (k: string, min: number, max: number) => {
    const v = Number(x?.[k]);
    return Number.isFinite(v) && v >= min && v <= max ? v : undefined;
  };
  return {
    seed: n('seed', -(2 ** 31), 2 ** 32), speed: n('speed', 0.01, 1000), disconnectAfterS: n('disconnectAfterS', 0, 1e7),
    lossRate: n('lossRate', 0, 1), stuckChannel: n('stuckChannel', 0, 256), badChannel: n('badChannel', 0, 256),
    badKind: x?.badKind === 'flat' ? 'flat' : x?.badKind === 'railed' ? 'railed' : undefined,
    start: n('start', 0, 1e14), manual: x?.manual === true ? true : undefined,
  };
}

/** a small seeded random source (mulberry32) with a normal draw */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed = 1) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** a uniform number in [a, b) */
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  /** a standard normal (Box-Muller) */
  normal(): number {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return v; }
    let u = 0;
    while (u === 0) u = this.next();
    const r = Math.sqrt(-2 * Math.log(u)), a = 2 * Math.PI * this.next();
    this.spare = r * Math.sin(a);
    return r * Math.cos(a);
  }
  /** an independent stream for one part of a simulator, so one part's draws never shift another's */
  fork(k: number): Rng { return new Rng((Math.imul(this.s ^ (k * 0x85ebca6b), 0xc2b2ae35) ^ k) >>> 0); }
  /** a v4-shaped uuid from this stream */
  uuid(upper = false): string {
    const h = Array.from({ length: 32 }, () => Math.floor(this.next() * 16).toString(16));
    h[12] = '4';
    h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
    const s = `${h.slice(0, 8).join('')}-${h.slice(8, 12).join('')}-${h.slice(12, 16).join('')}-${h.slice(16, 20).join('')}-${h.slice(20).join('')}`;
    return upper ? s.toUpperCase() : s;
  }
}

/** simulated time: `elapsed` ms since the start; jobs run as it moves on */
export class SimClock {
  readonly start: number;
  readonly speed: number;
  elapsed = 0;
  private jobs = new Set<(elapsed: number) => void>();
  private once: { at: number; f: () => void }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private wall0 = 0;
  private stopped = false;

  constructor(o: SimOptions) {
    this.start = o.start ?? Date.now();
    this.speed = o.speed && o.speed > 0 ? o.speed : 1;
    if (!o.manual) {
      this.wall0 = Date.now();
      this.timer = setInterval(() => this.advanceTo((Date.now() - this.wall0) * this.speed), 20);
      // a simulator must not keep a Node process alive on its own
      (this.timer as { unref?: () => void }).unref?.();
    }
  }
  now(): number { return this.start + this.elapsed; }
  /** run `f(elapsed)` each time the clock moves */
  every(f: (elapsed: number) => void): void { this.jobs.add(f); }
  /** run `f` once when the clock reaches `at` (ms after the start) */
  at(at: number, f: () => void): void { this.once.push({ at, f }); this.once.sort((a, b) => a.at - b.at); }
  step(ms: number): void {
    if (this.timer) this.wall0 -= ms / this.speed;
    this.advanceTo(this.elapsed + ms);
  }
  private advanceTo(t: number): void {
    if (this.stopped || t <= this.elapsed) return;
    // move in steps of at most 50 ms, so a one-shot (a lost link) falls between the right packets
    while (this.elapsed < t && !this.stopped) {
      this.elapsed = Math.min(t, this.elapsed + 50);
      for (const f of this.jobs) f(this.elapsed);
      while (this.once.length && this.once[0].at <= this.elapsed) this.once.shift()!.f();
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.jobs.clear();
    this.once = [];
  }
}
