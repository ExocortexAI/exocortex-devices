// Small helpers the drivers share. No dependencies, no DOM, no Node: they run in browsers and in Node alike.

import type {
  DeviceRecord, EventRecord, FileTransport, IntervalRecord, OpenContext, Provenance, SampleChunk, Status, Timing,
  TransportKind,
} from './contract.ts';

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** a 24-bit two's complement integer, most significant byte first */
export function int24be(b: Uint8Array, o: number): number {
  const v = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  return v & 0x800000 ? v - 0x1000000 : v;
}

/** a 24-bit two's complement integer, least significant byte first */
export function int24le(b: Uint8Array, o: number): number {
  const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  return v & 0x800000 ? v - 0x1000000 : v;
}

export function int16be(b: Uint8Array, o: number): number {
  const v = (b[o] << 8) | b[o + 1];
  return v & 0x8000 ? v - 0x10000 : v;
}

/** normalise a Bluetooth UUID: a 16-bit '180d' / 0x180d becomes the full lower-case 128-bit form */
export function uuid(u: string | number): string {
  if (typeof u === 'number') u = u.toString(16);
  const s = u.toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{32}$/.test(s)) return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  return s;
}

export function prov(ctx: OpenContext, descriptor: string, transport: TransportKind, extra?: Partial<Provenance>): Provenance {
  return { instance: ctx.instance, descriptor, host: ctx.host, transport, ...extra };
}

/** a timing on the host's clock for a chunk of `n` samples that just arrived at `rateHz` */
export function hostTiming(ctx: OpenContext, n: number, rateHz: number, extra?: Partial<Timing>): Timing {
  const receivedAt = ctx.now();
  return { t0: receivedAt - (n * 1000) / rateHz, receivedAt, clock: 'host', ...extra };
}

/** rows of numbers → a SampleChunk's data: one Float32Array per signal */
export function columns(rows: number[][], signals: number): Float32Array[] {
  const data: Float32Array[] = [];
  for (let s = 0; s < signals; s++) {
    const a = new Float32Array(rows.length);
    for (let i = 0; i < rows.length; i++) a[i] = rows[i][s];
    data.push(a);
  }
  return data;
}

/** counts a driver keeps for its Status */
export class Counter {
  records = 0;
  samples = 0;
  dropped = 0;
  lastRecordAt: number | undefined = undefined;
  note(r: DeviceRecord): void {
    this.records++;
    if (r.shape === 'samples') {
      this.samples += r.data[0]?.length ?? 0;
      this.dropped += r.dropped ?? 0;
    }
    this.lastRecordAt = r.time.receivedAt;
  }
  status(state: Status['state'], more?: Partial<Status>): Status {
    return {
      state, lastRecordAt: this.lastRecordAt,
      counts: { records: this.records, samples: this.samples, dropped: this.dropped }, ...more,
    };
  }
}

/** wraps ctx.emit so the counter sees every record and disabled channels are dropped */
export function emitter(ctx: OpenContext, counter: Counter): (r: DeviceRecord) => void {
  return (r) => {
    if (!ctx.enabled.has(r.channel)) return;
    counter.note(r);
    ctx.emit(r);
  };
}

/** a pull-based byte reader over a file's chunks: `need(n)` waits until n bytes are buffered */
export class ByteQueue {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private it: AsyncIterator<Uint8Array>;
  private done = false;
  /** bytes consumed so far */
  offset = 0;
  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.it = chunks[Symbol.asyncIterator]();
  }
  /** true when n bytes are available (false at the end of the file) */
  async need(n: number): Promise<boolean> {
    while (this.buf.length - this.pos < n) {
      if (this.done) return false;
      const r = await this.it.next();
      if (r.done) { this.done = true; return false; }
      const rest = this.buf.subarray(this.pos);
      this.buf = concatBytes(rest.length ? rest.slice() : new Uint8Array(0), r.value);
      this.pos = 0;
    }
    return true;
  }
  /** take n bytes (call need(n) first) */
  take(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    this.offset += n;
    return out;
  }
  async read(n: number): Promise<Uint8Array | null> {
    return (await this.need(n)) ? this.take(n) : null;
  }
}

/** UTF-8 text of a file, a chunk at a time (multi-byte characters split across chunks are kept whole) */
export async function* textChunks(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder('utf-8');
  for await (const c of chunks) {
    const s = dec.decode(c, { stream: true });
    if (s) yield s;
  }
  const tail = dec.decode();
  if (tail) yield tail;
}

/** lines of a text stream, without their line ends */
export async function* lines(text: AsyncIterable<string>): AsyncGenerator<string> {
  let rest = '';
  for await (const s of text) {
    rest += s;
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      yield rest.slice(0, i).replace(/\r$/, '');
      rest = rest.slice(i + 1);
    }
  }
  if (rest.length) yield rest.replace(/\r$/, '');
}

/** a file transport over bytes or a string already in memory (tests, the loopback demo, a pasted file) */
export function fileFrom(name: string, content: Uint8Array | string, chunkSize = 64 * 1024): FileTransport {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    kind: 'file', name, size: bytes.length,
    async *chunks() {
      for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function event(
  channel: string, p: Provenance, time: Timing, label: string, value?: number, unit?: string,
  fields?: Record<string, unknown>,
): EventRecord {
  const r: EventRecord = { shape: 'events', channel, prov: p, time, label };
  if (value !== undefined) r.value = value;
  if (unit !== undefined) r.unit = unit;
  if (fields !== undefined) r.fields = fields;
  return r;
}

export function interval(
  channel: string, p: Provenance, time: Timing, end: number, label: string,
  more?: Partial<Omit<IntervalRecord, 'shape' | 'channel' | 'prov' | 'time' | 'end' | 'label'>>,
): IntervalRecord {
  return { shape: 'intervals', channel, prov: p, time, end, label, ...more };
}

export function chunk(
  channel: string, p: Provenance, time: Timing, rateHz: number, names: string[], unit: string, data: Float32Array[],
  more?: Partial<Pick<SampleChunk, 'dropped' | 'quality'>>,
): SampleChunk {
  return { shape: 'samples', channel, prov: p, time, rateHz, names, unit, data, ...more };
}

/** a stable short hash (FNV-1a, 52 bits as hex) for ids synthesized from a record's own fields */
export function stableId(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + (h2 >>> 12).toString(16).padStart(5, '0');
}
