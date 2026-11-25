// In-memory transports: a device simulated in the same process. Tests drive drivers through them, and the example
// page uses them for its demo with no hardware. What a simulated device answers is the caller's code (`onWrite`).

import type { ByteTransport, DeviceRecord, FileTransport, GattTransport, OpenContext, Status } from '../contract.ts';
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

/** an OpenContext that keeps what a driver emits: for tests and the demo */
export function memoryContext(o: { enabled: string[]; config?: Record<string, unknown>; now?: () => number; instance?: string }): OpenContext & { records: DeviceRecord[]; statuses: Status[] } {
  const records: DeviceRecord[] = [];
  const statuses: Status[] = [];
  return {
    instance: o.instance ?? 'test-1',
    host: 'chrome-desktop',
    enabled: new Set(o.enabled),
    config: o.config ?? {},
    emit: (r) => { records.push(r); },
    status: (s) => { statuses.push(s); },
    now: o.now ?? (() => Date.now()),
    records,
    statuses,
  };
}

export type { FileTransport };
