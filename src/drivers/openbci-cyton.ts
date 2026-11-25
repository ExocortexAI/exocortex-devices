// OpenBCI Cyton (8 channels at 250 Hz) over its USB dongle (FTDI, 115200 baud), and the shared code of the Cyton +
// Daisy driver (./openbci-cyton-daisy.ts). Protocol: docs.openbci.com, Cyton Data Format and Cyton SDK.
//
// A packet is 33 bytes: 0xA0, the sample number, 8 × 24-bit two's complement channel values (MSB first), 6 aux bytes,
// and a footer 0xC0..0xC6. Footer 0xC0 carries the accelerometer in the aux bytes (3 × int16 MSB first,
// 0.002 / 2^4 g per count; zero when there is no new reading, about every tenth packet has one). Volts per count:
// 4.5 / gain / (2^23 − 1), gain 24 by default.
//
// Daisy: the board averages pairs of samples and sends its own channels (1-8) on odd sample numbers and the Daisy's
// (9-16) on even sample numbers, each at 125 Hz. The first sample after start is invalid (nothing to average with).
//
// Commands: 's' stop, 'v' soft reset (prints a banner that ends with '$$$'; a Daisy shows as "On Daisy …"),
// 'b' start, 'c' / 'C' remove / attach the Daisy, 'z{ch}{p}{n}Z' lead-off (impedance) test on a channel.

import type { ByteTransport, Connection, Descriptor, Driver, OpenContext } from '../contract.ts';
import { Counter, ascii, chunk, columns, concatBytes, eegQuality, emitter, event, int16be, int24be, prov } from '../util.ts';

export const CYTON_NAMES = ['Fp1', 'Fp2', 'C3', 'C4', 'P7', 'P8', 'O1', 'O2'];
/** the default 10-20 positions of a Cyton + Daisy (BrainFlow's default montage): 1-8 on the Cyton, 9-16 on the Daisy */
export const CYTON_DAISY_NAMES = [...CYTON_NAMES, 'F7', 'F8', 'F3', 'F4', 'T7', 'T8', 'P3', 'P4'];
export const PACKET = 33;
export const ACCEL_G_PER_COUNT = 0.002 / 16;
export const uvPerCount = (gain = 24): number => (4.5 / gain / (2 ** 23 - 1)) * 1e6;

export interface CytonPacket {
  sample: number;          // the board's sample number, 0..255
  counts: number[];        // 8 signed ADC counts
  aux: Uint8Array;         // the 6 aux bytes
  footer: number;          // 0xC0..0xC6
  /** accelerometer in g, when the footer is 0xC0 and the reading is new (the aux bytes are not all zero) */
  accel?: [number, number, number];
}

/** turns bytes into packets; slides one byte at a time until a header and a footer line up (resync) */
export class CytonParser {
  private buf = new Uint8Array(0);
  /** bytes skipped while looking for a packet boundary */
  skipped = 0;
  push(bytes: Uint8Array): CytonPacket[] {
    const b = concatBytes(this.buf, bytes);
    const out: CytonPacket[] = [];
    let i = 0;
    while (i + PACKET <= b.length) {
      const foot = b[i + PACKET - 1];
      if (b[i] !== 0xa0 || foot < 0xc0 || foot > 0xc6) { i++; this.skipped++; continue; }
      const counts: number[] = [];
      for (let c = 0; c < 8; c++) counts.push(int24be(b, i + 2 + c * 3));
      const aux = b.slice(i + 26, i + 32);
      const p: CytonPacket = { sample: b[i + 1], counts, aux, footer: foot };
      if (foot === 0xc0 && aux.some((x) => x !== 0)) {
        p.accel = [int16be(aux, 0), int16be(aux, 2), int16be(aux, 4)].map((v) => v * ACCEL_G_PER_COUNT) as [number, number, number];
      }
      out.push(p);
      i += PACKET;
    }
    this.buf = b.slice(i);
    // never hold more than one packet's worth of garbage
    if (this.buf.length > 4 * PACKET) { this.skipped += this.buf.length - PACKET; this.buf = this.buf.slice(-PACKET); }
    return out;
  }
}

/** one packet's bytes (tests and the simulator); `accel` in raw counts */
export function encodeCytonPacket(sample: number, counts: number[], accel?: [number, number, number], footer = 0xc0): Uint8Array {
  const b = new Uint8Array(PACKET);
  b[0] = 0xa0;
  b[1] = sample & 0xff;
  for (let c = 0; c < 8; c++) {
    const v = (counts[c] ?? 0) & 0xffffff;
    b[2 + c * 3] = (v >> 16) & 0xff;
    b[3 + c * 3] = (v >> 8) & 0xff;
    b[4 + c * 3] = v & 0xff;
  }
  if (accel) accel.forEach((a, k) => { b[26 + k * 2] = (a >> 8) & 0xff; b[27 + k * 2] = a & 0xff; });
  b[32] = footer;
  return b;
}

/** what a 'v' banner says */
export function readBanner(text: string): { daisy: boolean; firmware?: string; ok: boolean } {
  const fw = /Firmware:\s*(v[\d.]+)/i.exec(text)?.[1];
  return { daisy: /Daisy/i.test(text) && !/no daisy/i.test(text), firmware: fw, ok: text.includes('$$$') };
}

/** the lead-off current the ADS1299 drives (6 nA) and the series resistor on a Cyton input (2.2 kΩ) */
export function impedanceOhms(stdUv: number): number {
  return Math.max(0, (Math.SQRT2 * stdUv * 1e-6) / 6e-9 - 2200);
}

const channelsFor = (daisy: boolean): Descriptor['channels'] => [
  {
    id: 'eeg', kind: 'eeg', label: daisy ? '16 EEG channels' : '8 EEG channels', shape: 'samples', unit: 'uV',
    rateHz: daisy ? 125 : 250, count: daisy ? 16 : 8, names: daisy ? CYTON_DAISY_NAMES : CYTON_NAMES,
    defaultOn: true, sensitive: 'neural',
  },
  { id: 'accel', kind: 'accel', label: 'Accelerometer', shape: 'samples', unit: 'g', rateHz: 25, count: 3, names: ['x', 'y', 'z'], defaultOn: true },
  { id: 'impedance', kind: 'impedance', label: 'Contact check', shape: 'events', unit: 'ohm', defaultOn: true },
  { id: 'marker', kind: 'marker', label: 'Marks', shape: 'events', defaultOn: true },
];

export const cytonActions: Descriptor['actions'] = [
  { id: 'start', label: 'Start streaming' },
  { id: 'stop', label: 'Stop streaming', safing: true },
  { id: 'mark', label: 'Mark this moment', args: { label: { type: 'string', label: 'Label' } } },
  {
    id: 'impedance', label: 'Contact check',
    args: { channel: { type: 'number', label: 'Channel', min: 1, max: 16 }, on: { type: 'boolean', label: 'On' } },
  },
];

export function cytonDescriptor(daisy: boolean): Descriptor {
  const id = daisy ? 'openbci-cyton-daisy' : 'openbci-cyton';
  return {
    id,
    name: daisy ? 'OpenBCI Cyton + Daisy' : 'OpenBCI Cyton',
    vendor: 'OpenBCI',
    family: 'openbci',
    models: daisy ? ['Cyton + Daisy (32-bit, firmware v2 and v3)'] : ['Cyton (32-bit, firmware v2 and v3)'],
    placement: 'head',
    about: daisy ? '16 channels of EEG at 125 Hz, and motion.' : '8 channels of EEG at 250 Hz, and motion.',
    channels: channelsFor(daisy),
    actions: cytonActions,
    routes: [{
      transport: 'web-serial', hosts: ['chrome-desktop', 'desktop-app'], driver: id,
      needs: ['the OpenBCI USB dongle', 'Chrome or Edge on a computer, or the desktop app'],
      freshness: 'live', dataLeaves: 'never', verified: 'loopback',
      evidence: 'test/openbci-cyton.test.ts: packets of the Cyton Data Format (resync, a Daisy pair) and the open/stream/stop handshake against a simulated board',
    }],
    priority: 'P1',
    links: [
      { label: 'Cyton data format', url: 'https://docs.openbci.com/Cyton/CytonDataFormat/' },
      { label: 'Cyton SDK', url: 'https://docs.openbci.com/Cyton/CytonSDK/' },
    ],
  };
}

const settings: Driver['settings'] = [
  { id: 'gain', label: 'Amplifier gain', type: 'select', default: '24', options: ['1', '2', '4', '6', '8', '12', '24'].map((v) => ({ value: v, label: `×${v}` })) },
  { id: 'bannerTimeoutMs', label: 'Wait for the board (ms)', type: 'number', default: 3000 },
];

/** the Cyton driver; `daisy` makes the 16-channel one */
export function makeCytonDriver(daisy: boolean): Driver<ByteTransport> {
  const descriptor = cytonDescriptor(daisy);
  return {
    id: descriptor.id,
    descriptor,
    transport: 'web-serial',
    settings,
    serial: { filters: [{ usbVendorId: 0x0403 }], baudRate: 115200 },
    async open(t, ctx) { return openCyton(t, ctx, daisy, descriptor.id); },
  };
}

async function openCyton(t: ByteTransport, ctx: OpenContext, daisy: boolean, descriptorId: string): Promise<Connection> {
  const counter = new Counter();
  const emit = emitter(ctx, counter);
  const gain = Number(ctx.config.gain ?? 24) || 24;
  const scale = uvPerCount(gain);
  const fs = daisy ? 125 : 250;
  const names = daisy ? CYTON_DAISY_NAMES : CYTON_NAMES;
  const nCh = names.length;
  const timeout = Number(ctx.config.bannerTimeoutMs ?? 3000);
  const info: Record<string, string> = {};
  const p = (extra?: { firmware?: string }) => prov(ctx, descriptorId, t.kind, { model: daisy ? 'Cyton + Daisy' : 'Cyton', serial: t.label, ...extra });

  let mode: 'text' | 'stream' = 'text';
  let text = '';
  let waiter: { token: string; resolve: (s: string) => void } | null = null;
  const parser = new CytonParser();
  let closing = false;
  let streaming = false;
  let lastSample = -1;
  let lastPair = -1;               // the board's sample number of the last whole Daisy pair
  let pendingBoard: CytonPacket | null = null;
  let firstPair = true;
  let rows: number[][] = [];
  let accelRows: number[][] = [];
  let dropped = 0;
  let seq = 0;
  let impedanceCh = 0;          // 1-based channel under a lead-off test, 0 for none
  let impedanceBuf: number[] = [];

  const flush = () => {
    const now = ctx.now();
    if (rows.length) {
      const n = rows.length;
      const data = columns(rows, nCh);
      emit(chunk('eeg', p({ firmware: info.firmware }), { t0: now - (n * 1000) / fs, receivedAt: now, clock: 'host', seq, uncertaintyMs: 100 },
        fs, names, 'uV', data, { quality: eegQuality(data, 4.5e6 / gain), ...(dropped ? { dropped } : {}) }));
      seq += n;
      rows = [];
      dropped = 0;
    }
    if (accelRows.length) {
      const n = accelRows.length;
      emit(chunk('accel', p({ firmware: info.firmware }), { t0: now - (n * 1000) / 25, receivedAt: now, clock: 'host', uncertaintyMs: 100 },
        25, ['x', 'y', 'z'], 'g', columns(accelRows, 3)));
      accelRows = [];
    }
  };

  const addSample = (values: number[], accel?: number[]) => {
    rows.push(values);
    if (accel) accelRows.push(accel);
    if (impedanceCh) {
      impedanceBuf.push(values[impedanceCh - 1]);
      if (impedanceBuf.length >= fs) {
        const m = impedanceBuf.reduce((a, b) => a + b, 0) / impedanceBuf.length;
        const sd = Math.sqrt(impedanceBuf.reduce((a, b) => a + (b - m) ** 2, 0) / impedanceBuf.length);
        const now = ctx.now();
        emit(event('impedance', p(), { t0: now - 1000, receivedAt: now, clock: 'host' }, names[impedanceCh - 1], impedanceOhms(sd), 'ohm',
          { channel: impedanceCh, method: 'lead-off 6 nA at 31.5 Hz: √2·σ/6 nA − 2.2 kΩ' }));
        impedanceBuf = [];
      }
    }
    if (rows.length >= fs / 10) flush();
  };

  const onPacket = (k: CytonPacket) => {
    if (!daisy && lastSample >= 0) dropped += (k.sample - lastSample - 1) & 0xff;
    lastSample = k.sample;
    const uv = k.counts.map((c) => c * scale);
    if (!daisy) { addSample(uv, k.accel); return; }
    if (k.sample % 2 === 1) { pendingBoard = k; return; }          // odd: the Cyton's channels 1-8
    const board = pendingBoard;                                     // even: the Daisy's 9-16, paired with the odd before
    pendingBoard = null;
    if (!board || ((board.sample + 1) & 0xff) !== k.sample) return;  // half a pair: drop it
    // a 125 Hz sample is a pair: the pairs missing between this one and the last whole one were lost
    if (lastPair >= 0) dropped += Math.max(0, (((board.sample - lastPair) & 0xff) >> 1) - 1);
    lastPair = board.sample;
    if (firstPair) { firstPair = false; return; }                   // the first average has nothing before it
    addSample([...board.counts.map((c) => c * scale), ...uv], board.accel ?? k.accel);
  };

  const onBytes = (b: Uint8Array) => {
    if (mode === 'text') {
      text += new TextDecoder().decode(b);
      if (waiter && text.includes(waiter.token)) { const w = waiter; waiter = null; w.resolve(text); }
      return;
    }
    for (const k of parser.push(b)) onPacket(k);
  };

  const waitFor = (token: string, ms: number) => new Promise<string>((resolve) => {
    if (text.includes(token)) { resolve(text); return; }
    waiter = { token, resolve };
    setTimeout(() => { if (waiter?.resolve === resolve) { waiter = null; resolve(text); } }, ms);
  });

  const command = async (s: string) => t.write(ascii(s));

  ctx.status({ state: 'connecting', why: 'Opening the port.' });
  try {
    await t.open({ baudRate: 115200 });
  } catch (e) {
    const why = `The port did not open (${e instanceof Error ? e.message : String(e)}). Close the OpenBCI GUI or any other program that holds it: only one program can use the port.`;
    ctx.status({ state: 'error', why });
    throw new Error(why);
  }
  const loop = t.read(onBytes).then(
    () => { if (!closing) { flush(); ctx.status(counter.status(streaming ? 'unknown' : 'closed', { why: streaming ? 'The link was lost while the board was streaming: it may still be on.' : undefined, info })); } },
    (e) => { if (!closing) ctx.status(counter.status('error', { why: `Reading the port failed: ${e instanceof Error ? e.message : String(e)}`, info })); },
  );

  const handshake = async () => {
    mode = 'text';
    text = '';
    await command('s');
    await command('v');
    const banner = await waitFor('$$$', timeout);
    const b = readBanner(banner);
    if (!banner.trim()) {
      throw new Error('The dongle opened, but the board did not answer. Turn the Cyton on (PC position), set the dongle switch to GPIO_6, and charge the battery.');
    }
    if (b.firmware) info.firmware = b.firmware;
    if (daisy && !b.daisy) {
      text = '';
      await command('C');
      const r = await waitFor('$$$', timeout);
      if (!/16/.test(r) || /no daisy/i.test(r)) throw new Error('No Daisy board answered. Seat the Daisy fully on the Cyton\'s pins, or pair this board as an OpenBCI Cyton (8 channels).');
    }
    if (!daisy && b.daisy) {
      text = '';
      await command('c');           // a Daisy is attached: use the Cyton's 8 channels at 250 Hz
      await waitFor('$$$', timeout);
      info.daisy = 'attached, not used';
    }
    info.mode = daisy ? '16 channels at 125 Hz' : '8 channels at 250 Hz';
  };

  const start = async () => {
    if (streaming) return;
    ctx.status({ state: 'connecting', why: 'Resetting the board.', info });
    try {
      await handshake();
    } catch (e) {
      ctx.status(counter.status('error', { why: e instanceof Error ? e.message : String(e), info }));
      throw e;
    }
    lastSample = -1;
    lastPair = -1;
    pendingBoard = null;
    firstPair = true;
    mode = 'stream';
    await command('b');
    streaming = true;
    ctx.status(counter.status('streaming', { info }));
  };

  const stop = async () => {
    try { await command('s'); } catch { /* the port is gone: state unknown is reported by the loop */ }
    flush();
    streaming = false;
    mode = 'text';
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
        const ch = Number(args?.channel ?? 1);
        if (!Number.isInteger(ch) || ch < 1 || ch > nCh) return { outcome: 'failed', why: `Choose a channel from 1 to ${nCh}.` };
        const on = args?.on !== false;
        // channels 9-16 are addressed by the letters Q..I on a Daisy
        const code = ch <= 8 ? String(ch) : 'QWERTYUI'[ch - 9];
        await command(`z${code}${on ? '01' : '00'}Z`);
        impedanceCh = on ? ch : 0;
        impedanceBuf = [];
        return { outcome: 'accepted', why: on ? 'The contact value arrives once a second while streaming.' : undefined };
      }
      return { outcome: 'unsupported' };
    },
    async close() {
      if (streaming) await stop();
      closing = true;
      await t.close();
      await loop;
      ctx.status(counter.status('closed', { info }));
    },
  };
}

export const openbciCyton: Driver<ByteTransport> = makeCytonDriver(false);
