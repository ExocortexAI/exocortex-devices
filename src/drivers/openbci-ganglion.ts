// OpenBCI Ganglion: 4 channels at 200 Hz over Bluetooth LE. Protocol: docs.openbci.com, Ganglion Data Format.
//
// A notification is 20 bytes: a packet id and 19 data bytes.
//   id 0          raw: 4 × 24-bit two's complement counts, MSB first (one sample)
//   id 1..100     18-bit compression (the accelerometer is on): 8 deltas of 18 bits (2 samples × 4 channels), byte 19
//                 carries one accelerometer axis (id % 10 = 1, 2, 3 → x, y, z)
//   id 101..200   19-bit compression: 8 deltas of 19 bits
//   id 201..205   the impedance of channels 1-4 and the reference, as ASCII ohms
//   id 206, 207   part of / the end of an ASCII message
// The deltas are packed most significant bit first, one after another. The sign is in the LSB: a delta whose last
// bit is 1 is negative (sign-extend it from its width). Each sample is the previous sample minus its delta.
// µV per count: 15686 / 8388607 (the MCP3912's range). Accelerometer: 0.032 g per count.
//
// Verified 'spec': the test builds packets from this layout; it has not run against bytes a Ganglion recorded.

import type { Connection, Descriptor, Driver, GattTransport, OpenContext } from '../contract.ts';
import { Counter, ascii, chunk, columns, emitter, event, int24be, prov, uuid } from '../util.ts';

export const GANGLION_SERVICE = uuid('fe84');
export const GANGLION_RECEIVE = '2d30c082-f39f-4ce6-923f-3484ea480596';
export const GANGLION_SEND = '2d30c083-f39f-4ce6-923f-3484ea480596';
export const GANGLION_UV_PER_COUNT = 15686 / 8388607;
export const GANGLION_ACCEL_G = 0.032;
export const GANGLION_NAMES = ['1', '2', '3', '4'];

/** read `width` bits starting at bit `bit` (MSB first) of `b`; sign from the LSB */
function deltaAt(b: Uint8Array, bit: number, width: number): number {
  let v = 0;
  for (let k = 0; k < width; k++) {
    const i = bit + k;
    v = v * 2 + ((b[i >> 3] >> (7 - (i & 7))) & 1);
  }
  return v & 1 ? v - 2 ** width : v;
}

export type GanglionPacket =
  | { kind: 'samples'; id: number; samples: number[][]; accel?: { axis: 0 | 1 | 2; g: number } }
  | { kind: 'impedance'; id: number; channel: number | 'ref'; ohms: number }
  | { kind: 'text'; id: number; text: string; end: boolean }
  | { kind: 'unknown'; id: number };

/** turns notifications into counts; keeps the last sample (deltas apply to it) */
export class GanglionDecoder {
  last: number[] = [0, 0, 0, 0];
  lastId = -1;
  /** packets known to be missing (a gap in the packet ids) */
  dropped = 0;
  decode(p: Uint8Array): GanglionPacket {
    const id = p[0];
    if (id === 0) {
      this.last = [0, 1, 2, 3].map((c) => int24be(p, 1 + c * 3));
      this.lastId = 0;
      return { kind: 'samples', id, samples: [this.last.slice()] };
    }
    if (id >= 1 && id <= 200) {
      const width = id <= 100 ? 18 : 19;
      if (this.lastId > 0 && id > 1 && id !== 101) {
        const gap = id - this.lastId - 1;
        if (gap > 0) this.dropped += gap;
      }
      this.lastId = id;
      const d: number[] = [];
      for (let k = 0; k < 8; k++) d.push(deltaAt(p, 8 + k * width, width));
      const s1 = this.last.map((v, c) => v - d[c]);
      const s2 = s1.map((v, c) => v - d[4 + c]);
      this.last = s2;
      const out: GanglionPacket = { kind: 'samples', id, samples: [s1, s2] };
      if (width === 18) {
        const axis = (id % 10) - 1;
        if (axis >= 0 && axis <= 2) {
          const raw = p[19] & 0x80 ? p[19] - 256 : p[19];
          out.accel = { axis: axis as 0 | 1 | 2, g: raw * GANGLION_ACCEL_G };
        }
      }
      return out;
    }
    if (id >= 201 && id <= 205) {
      let s = '';
      for (let i = 1; i < p.length && p[i] >= 0x30 && p[i] <= 0x39; i++) s += String.fromCharCode(p[i]);
      return { kind: 'impedance', id, channel: id === 205 ? 'ref' : id - 200, ohms: Number(s || 'NaN') };
    }
    if (id === 206 || id === 207) {
      return { kind: 'text', id, text: new TextDecoder().decode(p.subarray(1)).replace(/\0+$/, ''), end: id === 207 };
    }
    return { kind: 'unknown', id };
  }
}

/**
 * Pack 8 deltas into a 20-byte compressed packet (tests and the simulator). The LSB carries the sign, so a positive
 * delta is sent even and a negative one odd: the last bit of an odd positive or an even negative delta is lost, as on
 * the board.
 */
export function encodeGanglionDeltas(id: number, deltas: number[], accelByte = 0): Uint8Array {
  const width = id <= 100 ? 18 : 19;
  const p = new Uint8Array(20);
  p[0] = id;
  let bit = 8;
  for (const d of deltas) {
    const v = d < 0 ? (d + 2 ** width) | 1 : d - (d & 1);
    for (let k = width - 1; k >= 0; k--, bit++) if (Math.floor(v / 2 ** k) & 1) p[bit >> 3] |= 1 << (7 - (bit & 7));
  }
  if (width === 18) p[19] = accelByte & 0xff;
  return p;
}

export const ganglionDescriptor: Descriptor = {
  id: 'openbci-ganglion',
  name: 'OpenBCI Ganglion',
  vendor: 'OpenBCI',
  family: 'openbci',
  models: ['Ganglion (firmware v2)'],
  placement: 'head',
  about: '4 channels of EEG, EMG or ECG at 200 Hz over Bluetooth.',
  channels: [
    { id: 'eeg', kind: 'eeg', label: '4 EEG channels', shape: 'samples', unit: 'uV', rateHz: 200, count: 4, names: GANGLION_NAMES, defaultOn: true, sensitive: 'neural' },
    { id: 'accel', kind: 'accel', label: 'Accelerometer', shape: 'events', unit: 'g', defaultOn: false },
    { id: 'impedance', kind: 'impedance', label: 'Contact check', shape: 'events', unit: 'ohm', defaultOn: true },
    { id: 'marker', kind: 'marker', label: 'Marks', shape: 'events', defaultOn: true },
  ],
  actions: [
    { id: 'start', label: 'Start streaming' },
    { id: 'stop', label: 'Stop streaming', safing: true },
    { id: 'mark', label: 'Mark this moment', args: { label: { type: 'string', label: 'Label' } } },
    { id: 'impedance', label: 'Contact check', args: { on: { type: 'boolean', label: 'On' } } },
  ],
  routes: [{
    transport: 'web-bluetooth', hosts: ['chrome-desktop', 'android'], driver: 'openbci-ganglion',
    needs: ['Chrome on a computer or on Android'], freshness: 'live', dataLeaves: 'never', verified: 'spec',
    evidence: 'test/openbci-ganglion.test.ts: packets built from the Ganglion Data Format; not yet run against recorded bytes',
  }],
  priority: 'P1',
  links: [{ label: 'Ganglion data format', url: 'https://docs.openbci.com/Ganglion/GanglionDataFormat/' }],
};

export const openbciGanglion: Driver<GattTransport> = {
  id: 'openbci-ganglion',
  descriptor: ganglionDescriptor,
  transport: 'web-bluetooth',
  bluetooth: { filters: [{ namePrefix: 'Ganglion' }, { services: [GANGLION_SERVICE] }], optionalServices: [GANGLION_SERVICE] },
  settings: [{ id: 'accel', label: 'Send the accelerometer (18-bit packets)', type: 'boolean', default: false }],
  async open(t, ctx) { return openGanglion(t, ctx); },
};

async function openGanglion(t: GattTransport, ctx: OpenContext): Promise<Connection> {
  const counter = new Counter();
  const emit = emitter(ctx, counter);
  const dec = new GanglionDecoder();
  const p = () => prov(ctx, 'openbci-ganglion', 'web-bluetooth', { serial: t.id, model: 'Ganglion' });
  let rows: number[][] = [];
  let seq = 0;
  let streaming = false;
  let closing = false;
  let unsub: (() => Promise<void>) | null = null;
  let message = '';
  const info: Record<string, string> = {};

  const flush = () => {
    if (!rows.length) return;
    const now = ctx.now();
    const n = rows.length;
    const dropped = dec.dropped * 2;
    dec.dropped = 0;
    emit(chunk('eeg', p(), { t0: now - (n * 1000) / 200, receivedAt: now, clock: 'host', seq, uncertaintyMs: 150 }, 200, GANGLION_NAMES, 'uV',
      columns(rows.map((r) => r.map((c) => c * GANGLION_UV_PER_COUNT)), 4), dropped ? { dropped } : undefined));
    seq += n;
    rows = [];
  };

  const onValue = (v: DataView) => {
    const pk = dec.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    const now = ctx.now();
    if (pk.kind === 'samples') {
      rows.push(...pk.samples);
      if (pk.accel) emit(event('accel', p(), { t0: now, receivedAt: now, clock: 'host' }, 'xyz'[pk.accel.axis], pk.accel.g, 'g'));
      if (rows.length >= 20) flush();
    } else if (pk.kind === 'impedance') {
      emit(event('impedance', p(), { t0: now, receivedAt: now, clock: 'host' }, pk.channel === 'ref' ? 'REF' : String(pk.channel), pk.ohms, 'ohm', { channel: pk.channel }));
    } else if (pk.kind === 'text') {
      message += pk.text;
      if (pk.end) { info.message = message.trim(); message = ''; ctx.status(counter.status(streaming ? 'streaming' : 'idle', { info })); }
    }
  };

  t.onDisconnect(() => {
    if (closing) return;
    flush();
    ctx.status(counter.status(streaming ? 'unknown' : 'closed', { why: streaming ? 'The Bluetooth link was lost while the board was streaming: it may still be on.' : 'The board disconnected.', info }));
    streaming = false;
  });

  const send = (s: string) => t.write(GANGLION_SERVICE, GANGLION_SEND, ascii(s), true);

  ctx.status({ state: 'connecting', why: 'Subscribing to the board.' });
  unsub = await t.subscribe(GANGLION_SERVICE, GANGLION_RECEIVE, onValue);

  const start = async () => {
    if (streaming) return;
    await send(ctx.config.accel ? 'n' : 'N');
    await send('b');
    streaming = true;
    ctx.status(counter.status('streaming', { info }));
  };
  const stop = async () => {
    try { await send('s'); } catch { /* disconnected: reported by onDisconnect */ }
    flush();
    streaming = false;
    ctx.status(counter.status('idle', { info }));
  };

  return {
    start,
    stop,
    async act(action, args) {
      if (action === 'start') { await start(); return { outcome: 'done' }; }
      if (action === 'stop') { await stop(); return { outcome: 'done' }; }
      if (action === 'mark') {
        const now = ctx.now();
        emit(event('marker', p(), { t0: now, receivedAt: now, clock: 'host' }, String(args?.label ?? 'mark')));
        return { outcome: 'done' };
      }
      if (action === 'impedance') {
        const on = args?.on !== false;
        await send(on ? 'z' : 'Z');
        return { outcome: 'accepted', why: on ? 'The board stops its signal and sends each channel\'s contact value.' : undefined };
      }
      return { outcome: 'unsupported' };
    },
    async close() {
      if (streaming) await stop();
      closing = true;
      await unsub?.();
      await t.close();
      ctx.status(counter.status('closed', { info }));
    },
  };
}
