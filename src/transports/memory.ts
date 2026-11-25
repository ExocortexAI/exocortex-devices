// In-memory transports: a device simulated in the same process. Tests drive drivers through them, and the example
// page uses them for its demo with no hardware. What a simulated device answers is the caller's code (`onWrite`).

import type { AudioInput, AudioInputInfo, ByteTransport, DeviceRecord, FileTransport, GattTransport, MediaTransport, OpenContext, Status } from '../contract.ts';
import { fileFrom, uuid } from '../util.ts';

export { fileFrom as memoryFile };

/** a byte stream whose other end is a function: `onWrite` sees what the driver sends, `push` feeds it bytes */
export class MemoryByteTransport implements ByteTransport {
  kind: 'web-serial' | 'tcp' | 'web-usb' = 'web-serial';
  label: string;
  written: Uint8Array[] = [];
  baudRate: number | null = null;
  opened = false;
  onWrite: ((bytes: Uint8Array, t: MemoryByteTransport) => void) | null = null;
  private sink: ((b: Uint8Array) => void) | null = null;
  private pending: Uint8Array[] = [];
  private ended: (() => void) | null = null;

  constructor(label = 'Memory port', onWrite?: (bytes: Uint8Array, t: MemoryByteTransport) => void) {
    this.label = label;
    if (onWrite) this.onWrite = onWrite;
  }
  async open(o: { baudRate: number }): Promise<void> {
    this.baudRate = o.baudRate;
    this.opened = true;
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error('The port is not open.');
    this.written.push(bytes.slice());
    this.onWrite?.(bytes, this);
  }
  /** what the driver has written, as text */
  writtenText(): string {
    return this.written.map((b) => new TextDecoder().decode(b)).join('');
  }
  /** the device sends bytes (buffered until the driver reads) */
  push(bytes: Uint8Array | string): void {
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    if (this.sink) this.sink(b);
    else this.pending.push(b);
  }
  read(onBytes: (b: Uint8Array) => void): Promise<void> {
    this.sink = onBytes;
    for (const b of this.pending.splice(0)) onBytes(b);
    return new Promise((resolve) => { this.ended = resolve; });
  }
  async close(): Promise<void> {
    this.opened = false;
    this.sink = null;
    this.ended?.();
    this.ended = null;
  }
}

/** a GATT server in memory: characteristics to read, notifications to send, writes recorded */
export class MemoryGattTransport implements GattTransport {
  kind = 'web-bluetooth' as const;
  label: string;
  id: string;
  writes: { service: string; characteristic: string; bytes: Uint8Array }[] = [];
  values = new Map<string, Uint8Array>();
  onWrite: ((service: string, characteristic: string, bytes: Uint8Array, t: MemoryGattTransport) => void) | null = null;
  private subs = new Map<string, Set<(v: DataView) => void>>();
  private disconnects: (() => void)[] = [];
  closed = false;

  constructor(label = 'Memory device', id = 'memory-1') {
    this.label = label;
    this.id = id;
  }
  private key(s: string, c: string) { return `${uuid(s)}/${uuid(c)}`; }
  /** set what a read of this characteristic returns */
  setValue(service: string, characteristic: string, bytes: Uint8Array | number[]): void {
    this.values.set(this.key(service, characteristic), Uint8Array.from(bytes));
  }
  /** send a notification on a characteristic; returns how many subscribers got it */
  notify(service: string, characteristic: string, bytes: Uint8Array | number[]): number {
    const b = Uint8Array.from(bytes);
    const set = this.subs.get(this.key(service, characteristic));
    for (const f of set ?? []) f(new DataView(b.buffer, b.byteOffset, b.byteLength));
    return set?.size ?? 0;
  }
  subscribed(service: string, characteristic: string): boolean {
    return (this.subs.get(this.key(service, characteristic))?.size ?? 0) > 0;
  }
  async subscribe(service: string, characteristic: string, onValue: (v: DataView) => void): Promise<() => Promise<void>> {
    const k = this.key(service, characteristic);
    let set = this.subs.get(k);
    if (!set) this.subs.set(k, (set = new Set()));
    set.add(onValue);
    return async () => { set.delete(onValue); };
  }
  async write(service: string, characteristic: string, bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Disconnected.');
    this.writes.push({ service: uuid(service), characteristic: uuid(characteristic), bytes: bytes.slice() });
    this.onWrite?.(uuid(service), uuid(characteristic), bytes, this);
  }
  async read(service: string, characteristic: string): Promise<DataView> {
    const b = this.values.get(this.key(service, characteristic));
    if (!b) throw new Error(`No characteristic ${characteristic} in service ${service}.`);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  onDisconnect(f: () => void): void { this.disconnects.push(f); }
  /** the device goes out of range */
  drop(): void { for (const f of this.disconnects) f(); }
  async close(): Promise<void> { this.closed = true; }
}

/**
 * The system's audio inputs in memory: a fake microphone stream. `plug` and `unplug` change the list (a headset put on
 * or taken off) and `push` speaks into the open input; `setDefault` moves the system's own choice.
 */
export class MemoryMediaTransport implements MediaTransport {
  kind = 'media' as const;
  label = 'Memory audio';
  list: AudioInputInfo[];
  defaultId: string;
  opened: MemoryAudioInput[] = [];
  private subs = new Set<() => void>();
  constructor(list: AudioInputInfo[] = [{ id: 'mic-1', label: 'Built-in Microphone' }], defaultId = list[0]?.id ?? '') { this.list = list; this.defaultId = defaultId; }
  async inputs(): Promise<AudioInputInfo[]> {
    const d = this.list.find((x) => x.id === this.defaultId);
    return [...(d ? [{ ...d, id: 'default' }] : []), ...this.list];
  }
  async open(o: { input?: string; sampleRate: number }): Promise<AudioInput> {
    const id = !o.input || o.input === 'default' ? this.defaultId : o.input;
    const info = this.list.find((x) => x.id === id);
    if (!info) throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
    const a = new MemoryAudioInput(info, o.sampleRate);
    this.opened.push(a);
    return a;
  }
  onChange(f: () => void): () => void { this.subs.add(f); return () => { this.subs.delete(f); }; }
  /** the open input that is still open */
  get current(): MemoryAudioInput | undefined { return this.opened.filter((x) => !x.closed).at(-1); }
  plug(info: AudioInputInfo, asDefault = false): void { this.list.push(info); if (asDefault) this.defaultId = info.id; this.changed(); }
  unplug(id: string): void {
    this.list = this.list.filter((x) => x.id !== id);
    if (this.defaultId === id) this.defaultId = this.list[0]?.id ?? '';
    for (const a of this.opened) if (a.id === id && !a.closed) a.end();
    this.changed();
  }
  setDefault(id: string): void { this.defaultId = id; this.changed(); }
  private changed() { for (const f of this.subs) f(); }
}

export class MemoryAudioInput implements AudioInput {
  id: string; label: string; sampleRate: number; closed = false;
  private sink: ((pcm: Float32Array) => void) | null = null;
  private ended: (() => void)[] = [];
  constructor(info: AudioInputInfo, rate: number) { this.id = info.id; this.label = info.label; this.sampleRate = rate; }
  read(onBlock: (pcm: Float32Array) => void): void { this.sink = onBlock; }
  onEnded(f: () => void): void { this.ended.push(f); }
  /** speak: blocks of `seconds` of a tone at `amp` (0..1), in 100 ms blocks */
  push(seconds: number, amp = 0.1, hz = 220): void {
    const n = Math.round(seconds * this.sampleRate), step = Math.round(this.sampleRate / 10);
    for (let i = 0; i < n && !this.closed; i += step) {
      const b = new Float32Array(Math.min(step, n - i));
      for (let k = 0; k < b.length; k++) b[k] = amp * Math.sin((2 * Math.PI * hz * (i + k)) / this.sampleRate);
      this.sink?.(b);
    }
  }
  /** the input ends by itself */
  end(): void { if (this.closed) return; this.closed = true; for (const f of this.ended) f(); }
  async close(): Promise<void> { this.closed = true; this.sink = null; }
}

/** an OpenContext that keeps what a driver emits: for tests and the demo */
export function memoryContext(o: { enabled: string[]; config?: Record<string, unknown>; now?: () => number; instance?: string; admits?: () => boolean }): OpenContext & { records: DeviceRecord[]; statuses: Status[]; meters: { channel: string; level: number }[] } {
  const records: DeviceRecord[] = [];
  const statuses: Status[] = [];
  const meters: { channel: string; level: number }[] = [];
  return {
    instance: o.instance ?? 'test-1',
    host: 'chrome-desktop',
    enabled: new Set(o.enabled),
    config: o.config ?? {},
    emit: (r) => { records.push(r); },
    status: (s) => { statuses.push(s); },
    now: o.now ?? (() => Date.now()),
    meter: (channel, level) => { meters.push({ channel, level }); },
    ...(o.admits ? { admits: o.admits } : {}),
    records,
    statuses,
    meters,
  };
}

export type { FileTransport };
