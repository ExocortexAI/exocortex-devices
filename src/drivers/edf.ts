// EDF, EDF+, BDF and BDF+ files: polysomnography, EEG and ECG recordings from most clinical and research systems.
// Spec: edfplus.info (EDF, EDF+) and BioSemi (BDF: 24-bit samples). Read a data record at a time: a file of any
// size streams.
//
// Header (ASCII, space padded): 8 version ('0', or 0xFF 'BIOSEMI' for BDF), 80 patient, 80 recording,
// 8 start date dd.mm.yy, 8 start time hh.mm.ss, 8 header bytes, 44 reserved ('EDF+C', 'EDF+D', '24BIT', 'BDF+C' …),
// 8 number of data records, 8 duration of a record in seconds, 4 number of signals; then for each field, every
// signal's value: 16 label, 80 transducer, 8 physical dimension, 8 physical min, 8 physical max, 8 digital min,
// 8 digital max, 80 prefiltering, 8 samples per record, 32 reserved.
// A sample is int16 LE (EDF) or int24 LE (BDF). physical = (digital − dmin) × (pmax − pmin) / (dmax − dmin) + pmin.
// An "EDF Annotations" signal holds TALs: +onset[\x15duration]\x14text\x14…\x00; the first TAL of each record
// (with no text) is the record's own start, relative to the file's start.
// The start date and time are the recording's local time with no zone: the driver takes the zone from its
// `tzOffsetMin` setting (default: this computer's) and says so in the timing's uncertainty when it guessed.

import type { Channel, Descriptor, SignalKind } from '../contract.ts';
import { ByteQueue, chunk, event, interval } from '../util.ts';
import { fileDriver, fileRoute, importAction } from '../file-driver.ts';

export interface EdfSignal {
  label: string;
  transducer: string;
  unit: string;
  physMin: number;
  physMax: number;
  digMin: number;
  digMax: number;
  prefilter: string;
  samplesPerRecord: number;
  annotations: boolean;
}

export interface EdfHeader {
  format: 'EDF' | 'EDF+C' | 'EDF+D' | 'BDF' | 'BDF+C' | 'BDF+D';
  patient: string;
  recording: string;
  /** ms since epoch of the start, read with the given UTC offset */
  start: number;
  records: number;
  recordSeconds: number;
  signals: EdfSignal[];
}

export interface EdfRecord {
  index: number;
  /** ms since epoch */
  start: number;
  /** physical values, one array per non-annotation signal, in header order */
  data: Float32Array[];
  annotations: { onset: number; duration?: number; text: string }[];
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function field(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = o; i < o + n; i++) s += String.fromCharCode(b[i]);
  return s.trim();
}

export function parseEdfHeader(fixed: Uint8Array, sig: Uint8Array, tzOffsetMin: number): EdfHeader {
  const bdf = fixed[0] === 0xff;
  const reserved = field(fixed, 192, 44);
  const recording = field(fixed, 88, 80);
  const [dd, mm, yy] = field(fixed, 168, 8).split('.').map(Number);
  const [h, mi, s] = field(fixed, 176, 8).split('.').map(Number);
  let year = yy >= 85 ? 1900 + yy : 2000 + yy;
  // EDF+: the recording field names the four-digit year ("Startdate 02-MAR-2002 …")
  const sd = /^Startdate (\d{2})-([A-Z]{3})-(\d{4})/.exec(recording);
  if (sd && MONTHS.includes(sd[2])) year = Number(sd[3]);
  const start = Date.UTC(year, mm - 1, dd, h, mi, s) - tzOffsetMin * 60_000;
  const ns = Number(field(fixed, 252, 4));
  const at = (k: number, width: number, before: number) => field(sig, before * ns + k * width, width);
  const signals: EdfSignal[] = [];
  for (let k = 0; k < ns; k++) {
    const label = at(k, 16, 0);
    signals.push({
      label,
      transducer: field(sig, ns * 16 + k * 80, 80),
      unit: field(sig, ns * 96 + k * 8, 8),
      physMin: Number(field(sig, ns * 104 + k * 8, 8)),
      physMax: Number(field(sig, ns * 112 + k * 8, 8)),
      digMin: Number(field(sig, ns * 120 + k * 8, 8)),
      digMax: Number(field(sig, ns * 128 + k * 8, 8)),
      prefilter: field(sig, ns * 136 + k * 80, 80),
      samplesPerRecord: Number(field(sig, ns * 216 + k * 8, 8)),
      annotations: /^(EDF|BDF) Annotations$/.test(label),
    });
  }
  let format: EdfHeader['format'] = bdf ? 'BDF' : 'EDF';
  if (/^(EDF|BDF)\+[CD]/.test(reserved)) format = `${bdf ? 'BDF' : 'EDF'}+${reserved[4]}` as EdfHeader['format'];
  return {
    format, patient: field(fixed, 8, 80), recording, start, records: Number(field(fixed, 236, 8)),
    recordSeconds: Number(field(fixed, 244, 8)), signals,
  };
}

/** TALs of one annotation signal's bytes */
export function parseTals(b: Uint8Array): { onset: number; duration?: number; text: string[] }[] {
  const out: { onset: number; duration?: number; text: string[] }[] = [];
  const s = new TextDecoder().decode(b);
  for (const tal of s.split('\x00')) {
    if (!tal || !/^[+-]/.test(tal)) continue;
    const parts = tal.split('\x14');
    const [onset, duration] = parts[0].split('\x15');
    out.push({ onset: Number(onset), duration: duration ? Number(duration) : undefined, text: parts.slice(1).filter((x) => x.length) });
  }
  return out;
}

/** the header, then each data record, a record at a time */
export async function* readEdf(chunks: AsyncIterable<Uint8Array>, tzOffsetMin: number): AsyncGenerator<EdfHeader | EdfRecord> {
  const q = new ByteQueue(chunks);
  const fixed = await q.read(256);
  if (!fixed) throw new Error('The file is shorter than an EDF header.');
  const ns = Number(field(fixed, 252, 4));
  if (!Number.isInteger(ns) || ns < 1 || ns > 4096) throw new Error('This is not an EDF or BDF file (no signal count).');
  const sig = await q.read(ns * 256);
  if (!sig) throw new Error('The signal headers are cut short.');
  const header = parseEdfHeader(fixed.slice(), sig.slice(), tzOffsetMin);
  yield header;
  const width = header.format.startsWith('BDF') ? 3 : 2;
  const recBytes = header.signals.reduce((a, s) => a + s.samplesPerRecord * width, 0);
  for (let index = 0; header.records < 0 || index < header.records; index++) {
    const rec = await q.read(recBytes);
    if (!rec) break;
    const data: Float32Array[] = [];
    const annotations: EdfRecord['annotations'] = [];
    let start = header.start + index * header.recordSeconds * 1000;
    let o = 0;
    for (const s of header.signals) {
      const n = s.samplesPerRecord;
      const bytes = rec.subarray(o, o + n * width);
      o += n * width;
      if (s.annotations) {
        const tals = parseTals(bytes);
        tals.forEach((t, k) => {
          if (k === 0 && t.text.length === 0) start = header.start + t.onset * 1000;   // the record's timekeeping TAL
          else for (const text of t.text) annotations.push({ onset: header.start + t.onset * 1000, duration: t.duration, text });
        });
        continue;
      }
      const gain = (s.physMax - s.physMin) / (s.digMax - s.digMin || 1);
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v: number;
        if (width === 2) { v = bytes[i * 2] | (bytes[i * 2 + 1] << 8); if (v & 0x8000) v -= 0x10000; }
        else { v = bytes[i * 3] | (bytes[i * 3 + 1] << 8) | (bytes[i * 3 + 2] << 16); if (v & 0x800000) v -= 0x1000000; }
        a[i] = (v - s.digMin) * gain + s.physMin;
      }
      data.push(a);
    }
    yield { index, start, data, annotations };
  }
}

/** which channel of the descriptor a signal belongs to, and its name without the type word */
export function classifySignal(label: string): { channel: string; name: string } {
  const m = /^(EEG|ECG|EKG|EMG|EOG|RESP|Resp)\s+(.*)$/i.exec(label);
  if (m) {
    const kind = m[1].toLowerCase();
    return { channel: kind === 'ekg' ? 'ecg' : kind, name: m[2].trim() };
  }
  if (/^(Fp|AF|F|FC|FT|C|CP|T|TP|P|PO|O|I|A|M)[0-9zZ]{1,2}(-.*)?$/.test(label)) return { channel: 'eeg', name: label };
  if (/^(ECG|EKG)/i.test(label)) return { channel: 'ecg', name: label };
  return { channel: 'other', name: label };
}

/** µV for the electrical signals, so the app can compare boards */
function toMicro(unit: string): number | null {
  const u = unit.replace('µ', 'u').replace('μ', 'u');
  if (u === 'uV') return 1;
  if (u === 'mV') return 1e3;
  if (u === 'V') return 1e6;
  if (u === 'nV') return 1e-3;
  return null;
}

const electrical: SignalKind[] = ['eeg', 'ecg', 'emg', 'eog'];
const channels: Channel[] = [
  { id: 'eeg', kind: 'eeg', label: 'EEG', shape: 'samples', unit: 'uV', defaultOn: true, sensitive: 'neural' },
  { id: 'ecg', kind: 'ecg', label: 'ECG', shape: 'samples', unit: 'uV', defaultOn: true, sensitive: 'health' },
  { id: 'emg', kind: 'emg', label: 'EMG', shape: 'samples', unit: 'uV', defaultOn: true, sensitive: 'health' },
  { id: 'eog', kind: 'eog', label: 'EOG', shape: 'samples', unit: 'uV', defaultOn: true, sensitive: 'health' },
  { id: 'resp', kind: 'resp', label: 'Respiration', shape: 'samples', defaultOn: true, sensitive: 'health' },
  { id: 'other', kind: 'other', label: 'Other signals', shape: 'samples', defaultOn: true },
  { id: 'annotations', kind: 'marker', label: 'Annotations', shape: 'events', defaultOn: true },
];

export const edfDescriptor: Descriptor = {
  id: 'file-edf',
  name: 'EDF / BDF recording',
  vendor: 'Any',
  family: 'files',
  models: ['EDF', 'EDF+', 'BDF', 'BDF+'],
  placement: 'file',
  about: 'Import an EEG, sleep or ECG recording saved as EDF or BDF, with its annotations.',
  channels,
  actions: importAction,
  routes: [fileRoute('file-edf', 'loopback', 'test/files.test.ts: an EDF+ file with annotations and a BDF file built from the spec, read through the driver')],
  priority: 'P1',
  links: [{ label: 'EDF+ specification', url: 'https://www.edfplus.info/specs/edfplus.html' }],
};

export const edf = fileDriver({
  id: 'file-edf',
  descriptor: edfDescriptor,
  files: { extensions: ['.edf', '.bdf', '.rec'] },
  settings: [{ id: 'tzOffsetMin', label: 'Time zone of the recording (minutes from UTC)', type: 'number', default: null, help: 'EDF files keep local time with no zone. Leave empty to use this computer\'s.' }],
  async run({ file, ctx, emit, prov, stopped, info }) {
    const given = ctx.config.tzOffsetMin;
    const guessed = given === null || given === undefined || given === '';
    let header: EdfHeader | null = null;
    let groups: { channel: string; idx: number[]; names: string[]; unit: string; rate: number; scale: number[] }[] = [];
    for await (const item of readEdf(file.chunks(), guessed ? 0 : Number(given))) {
      if (stopped()) return;
      if ('signals' in item) {
        header = item;
        // the generator reads record times from this same object, so the zone applies to every record
        if (guessed) header.start += new Date(header.start).getTimezoneOffset() * 60_000;
        info.format = header.format;
        info.signals = String(header.signals.filter((s) => !s.annotations).length);
        // group the signals that share a channel, a rate and a unit: each group is one SampleChunk per record
        const map = new Map<string, (typeof groups)[number]>();
        let k = 0;
        for (const s of header.signals) {
          if (s.annotations) continue;
          const c = classifySignal(s.label);
          const micro = electrical.includes(c.channel as SignalKind) ? toMicro(s.unit) : null;
          const unit = micro !== null ? 'uV' : s.unit || '1';
          const rate = s.samplesPerRecord / header.recordSeconds;
          const key = `${c.channel}|${rate}|${unit}`;
          let g = map.get(key);
          if (!g) map.set(key, (g = { channel: c.channel, idx: [], names: [], unit, rate, scale: [] }));
          g.idx.push(k++);
          g.names.push(c.name);
          g.scale.push(micro ?? 1);
        }
        groups = [...map.values()];
        continue;
      }
      if (!header) return;
      const h = header;
      const start = item.start;
      const time = (t0: number) => ({ t0, receivedAt: ctx.now(), clock: 'device' as const, seq: item.index, uncertaintyMs: guessed ? 14 * 3600_000 : undefined });
      const p = prov({ model: h.format, providerRecordId: `${file.name}#${item.index}` });
      for (const g of groups) {
        const data = g.idx.map((i, j) => {
          const a = item.data[i];
          if (g.scale[j] !== 1) for (let n = 0; n < a.length; n++) a[n] *= g.scale[j];
          return a;
        });
        emit(chunk(g.channel, p, time(start), g.rate, g.names, g.unit, data));
      }
      for (const a of item.annotations) {
        const pa = prov({ model: h.format, providerRecordId: `${file.name}@${a.onset}:${a.text}` });
        if (a.duration) emit(interval('annotations', pa, time(a.onset), a.onset + a.duration * 1000, a.text));
        else emit(event('annotations', pa, time(a.onset), a.text));
      }
    }
  },
});
