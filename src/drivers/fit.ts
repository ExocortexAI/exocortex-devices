// Garmin FIT files: activities from Garmin, Wahoo, COROS, Polar, Suunto, Zwift and most bike computers.
// Spec: the FIT Protocol (developer.garmin.com/fit/protocol). The CRCs are not checked.
//
// A file: a header (12 or 14 bytes: size, protocol, profile u16, data size u32, ".FIT", [crc u16]), then records,
// then a CRC; chained files follow one another. A record header byte:
//   bit 7 = 1   a compressed-timestamp data message: local type in bits 5-6, a 5-bit time offset in bits 0-4
//   bit 6 = 1   a definition message for local type bits 0-3 (bit 5: it has developer fields)
//   else        a data message of local type bits 0-3
// A definition: reserved, architecture (0 little-endian, 1 big), global message number u16, field count, then
// (field number, size, base type) per field, then developer fields (number, size, index) when bit 5 was set.
// Times are seconds since 1989-12-31 00:00 UTC. Messages read here: file_id (0), session (18), lap (19),
// record (20), device_info (23), hrv (78: RR intervals).

import type { Descriptor } from '../contract.ts';
import { ByteQueue, event, interval } from '../util.ts';
import { fileDriver, fileRoute, importAction } from '../file-driver.ts';

export const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

export interface FitMessage {
  global: number;
  fields: Record<number, number | number[] | string | null>;
}

interface FieldDef { num: number; size: number; base: number }
interface Def { global: number; little: boolean; fields: FieldDef[]; devBytes: number }

// base type (low 5 bits) → [size, signed, float, invalid]
const BASE: Record<number, [number, boolean, boolean, number]> = {
  0x00: [1, false, false, 0xff],          // enum
  0x01: [1, true, false, 0x7f],           // sint8
  0x02: [1, false, false, 0xff],          // uint8
  0x03: [2, true, false, 0x7fff],         // sint16
  0x04: [2, false, false, 0xffff],        // uint16
  0x05: [4, true, false, 0x7fffffff],     // sint32
  0x06: [4, false, false, 0xffffffff],    // uint32
  0x08: [4, false, true, NaN],            // float32
  0x09: [8, false, true, NaN],            // float64
  0x0a: [1, false, false, 0],             // uint8z
  0x0b: [2, false, false, 0],             // uint16z
  0x0c: [4, false, false, 0],             // uint32z
  0x0d: [1, false, false, 0xff],          // byte
  0x0e: [8, true, false, NaN],            // sint64 (read as a number)
  0x0f: [8, false, false, NaN],           // uint64
  0x10: [8, false, false, NaN],           // uint64z
};

function readValue(v: DataView, o: number, base: number, little: boolean): number | null {
  const [size, signed, float, invalid] = BASE[base] ?? [1, false, false, 0xff];
  let x: number;
  if (float) x = size === 4 ? v.getFloat32(o, little) : v.getFloat64(o, little);
  else if (size === 1) x = signed ? v.getInt8(o) : v.getUint8(o);
  else if (size === 2) x = signed ? v.getInt16(o, little) : v.getUint16(o, little);
  else if (size === 4) x = signed ? v.getInt32(o, little) : v.getUint32(o, little);
  else x = Number(signed ? v.getBigInt64(o, little) : v.getBigUint64(o, little));
  if (Number.isNaN(x)) return null;
  if (signed && size <= 4) {
    // a signed invalid value is the type's maximum
    if (x === invalid) return null;
  } else if (x === invalid) return null;
  return x;
}

/** every message of a FIT file, in order, with compressed timestamps expanded into field 253 */
export async function* readFit(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<FitMessage> {
  const q = new ByteQueue(chunks);
  for (;;) {
    const first = await q.read(1);
    if (!first) return;
    const hsize = first[0];
    if (hsize !== 12 && hsize !== 14) throw new Error('This is not a FIT file (its header size is wrong).');
    const rest = await q.read(hsize - 1);
    if (!rest) throw new Error('The FIT header is cut short.');
    const hv = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
    const dataSize = hv.getUint32(3, true);
    if (String.fromCharCode(rest[7], rest[8], rest[9], rest[10]) !== '.FIT') throw new Error('This is not a FIT file (no ".FIT" mark).');
    const defs = new Map<number, Def>();
    let lastTs = 0;
    const end = q.offset + dataSize;
    while (q.offset < end) {
      const hb = await q.read(1);
      if (!hb) return;
      const h = hb[0];
      if (!(h & 0x80) && h & 0x40) {
        const d = await q.read(5);
        if (!d) return;
        const little = d[1] === 0;
        const global = little ? d[2] | (d[3] << 8) : (d[2] << 8) | d[3];
        const n = d[4];
        const fb = await q.read(n * 3);
        if (!fb) return;
        const fields: FieldDef[] = [];
        for (let i = 0; i < n; i++) fields.push({ num: fb[i * 3], size: fb[i * 3 + 1], base: fb[i * 3 + 2] & 0x1f });
        let devBytes = 0;
        if (h & 0x20) {
          const nd = await q.read(1);
          if (!nd) return;
          const db = await q.read(nd[0] * 3);
          if (!db) return;
          for (let i = 0; i < nd[0]; i++) devBytes += db[i * 3 + 1];
        }
        defs.set(h & 0x0f, { global, little, fields, devBytes });
        continue;
      }
      const compressed = (h & 0x80) !== 0;
      const local = compressed ? (h >> 5) & 0x03 : h & 0x0f;
      const def = defs.get(local);
      if (!def) throw new Error(`A data message uses local type ${local} before its definition.`);
      const size = def.fields.reduce((a, f) => a + f.size, 0) + def.devBytes;
      const b = await q.read(size);
      if (!b) return;
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const fields: FitMessage['fields'] = {};
      let o = 0;
      for (const f of def.fields) {
        if (f.base === 0x07) {
          let s = '';
          for (let i = 0; i < f.size && b[o + i] !== 0; i++) s += String.fromCharCode(b[o + i]);
          fields[f.num] = s;
        } else {
          const bs = BASE[f.base]?.[0] ?? 1;
          if (f.size > bs) {
            const arr: number[] = [];
            for (let i = 0; i + bs <= f.size; i += bs) { const x = readValue(v, o + i, f.base, def.little); if (x !== null) arr.push(x); }
            fields[f.num] = arr;
          } else fields[f.num] = f.size === bs ? readValue(v, o, f.base, def.little) : null;
        }
        o += f.size;
      }
      if (compressed) {
        const off = h & 0x1f;
        lastTs = lastTs + ((off - (lastTs & 0x1f)) & 0x1f);
        fields[253] = lastTs;
      } else if (typeof fields[253] === 'number') lastTs = fields[253] as number;
      yield { global: def.global, fields };
    }
    await q.read(2);   // the file's CRC
  }
}

export const fitTime = (s: number): number => FIT_EPOCH_MS + s * 1000;

const SPORTS = ['generic', 'running', 'cycling', 'transition', 'fitness equipment', 'swimming', 'basketball', 'soccer',
  'tennis', 'american football', 'training', 'walking', 'cross-country skiing', 'alpine skiing', 'snowboarding',
  'rowing', 'mountaineering', 'hiking', 'multisport', 'paddling'];
const MAKERS: Record<number, string> = { 1: 'Garmin', 23: 'Suunto', 32: 'Wahoo', 123: 'Polar', 255: 'development', 260: 'Zwift', 294: 'COROS' };

export const fitDescriptor: Descriptor = {
  id: 'file-fit',
  name: 'FIT activity file',
  vendor: 'Any',
  family: 'files',
  models: ['Garmin', 'Wahoo', 'COROS', 'Polar', 'Suunto', 'Zwift', 'any FIT file'],
  placement: 'file',
  about: 'Import workouts from a watch or bike computer: laps, heart rate, RR intervals, the route, speed and power.',
  channels: [
    { id: 'workout', kind: 'workout', label: 'Workouts', shape: 'intervals', defaultOn: true, sensitive: 'health' },
    { id: 'lap', kind: 'workout', label: 'Laps', shape: 'intervals', defaultOn: true },
    { id: 'hr', kind: 'hr', label: 'Heart rate', shape: 'events', unit: 'bpm', defaultOn: true, sensitive: 'health' },
    { id: 'rr', kind: 'rr', label: 'RR intervals', shape: 'events', unit: 'ms', defaultOn: true, sensitive: 'health' },
    { id: 'location', kind: 'location', label: 'Route', shape: 'events', defaultOn: true, sensitive: 'location' },
    { id: 'speed', kind: 'speed', label: 'Speed', shape: 'events', unit: 'm/s', defaultOn: false },
    { id: 'cadence', kind: 'cadence', label: 'Cadence', shape: 'events', unit: 'rpm', defaultOn: false },
    { id: 'power', kind: 'power', label: 'Power', shape: 'events', unit: 'W', defaultOn: false },
  ],
  actions: importAction,
  routes: [fileRoute('file-fit', 'loopback', 'test/files.test.ts: a FIT file with definitions, a compressed timestamp, records, hrv and a session, built from the FIT protocol and read through the driver')],
  priority: 'P0',
  links: [{ label: 'FIT protocol', url: 'https://developer.garmin.com/fit/protocol/' }],
};

const SEMI = 180 / 2 ** 31;

export const fit = fileDriver({
  id: 'file-fit',
  descriptor: fitDescriptor,
  files: { extensions: ['.fit'], mime: ['application/vnd.ant.fit'] },
  async run({ file, ctx, emit, prov, stopped, info }) {
    let maker: string | undefined;
    let product: string | undefined;
    let serial: string | undefined;
    let lastRecordTs = 0;
    const p = (id?: string) => prov({ model: [maker, product].filter(Boolean).join(' ') || undefined, serial, providerRecordId: id });
    const time = (t0: number) => ({ t0, receivedAt: ctx.now(), clock: 'device' as const, uncertaintyMs: 1000 });
    const num = (x: unknown) => (typeof x === 'number' ? x : undefined);
    for await (const m of readFit(file.chunks())) {
      if (stopped()) return;
      const f = m.fields;
      if (m.global === 0) {
        maker = MAKERS[num(f[1]) ?? -1] ?? (num(f[1]) !== undefined ? `manufacturer ${f[1]}` : undefined);
        product = num(f[2]) !== undefined ? `product ${f[2]}` : undefined;
        serial = num(f[3]) !== undefined ? String(f[3]) : undefined;
        if (maker) info.device = maker;
        continue;
      }
      if (m.global === 20) {
        const ts = num(f[253]);
        if (ts === undefined) continue;
        lastRecordTs = ts;
        const t = fitTime(ts);
        const id = `fit:${serial ?? file.name}:${ts}`;
        if (num(f[3]) !== undefined) emit(event('hr', p(`${id}:hr`), time(t), 'heart rate', num(f[3]), 'bpm'));
        const lat = num(f[0]), lon = num(f[1]);
        if (lat !== undefined && lon !== undefined) {
          const alt = num(f[2]);
          emit(event('location', p(`${id}:loc`), time(t), 'location', undefined, undefined, {
            lat: lat * SEMI, lon: lon * SEMI, ...(alt !== undefined ? { altitudeM: alt / 5 - 500 } : {}),
            ...(num(f[5]) !== undefined ? { distanceM: num(f[5])! / 100 } : {}),
          }));
        }
        if (num(f[6]) !== undefined) emit(event('speed', p(`${id}:speed`), time(t), 'speed', num(f[6])! / 1000, 'm/s'));
        if (num(f[4]) !== undefined) emit(event('cadence', p(`${id}:cad`), time(t), 'cadence', num(f[4]), 'rpm'));
        if (num(f[7]) !== undefined) emit(event('power', p(`${id}:pow`), time(t), 'power', num(f[7]), 'W'));
        continue;
      }
      if (m.global === 78) {
        // RR intervals in seconds/1000; the hrv message carries no time of its own: they follow the last record
        const rr = Array.isArray(f[0]) ? f[0] : num(f[0]) !== undefined ? [num(f[0])!] : [];
        let t = fitTime(lastRecordTs);
        for (const x of rr) {
          emit(event('rr', p(`fit:${serial ?? file.name}:${lastRecordTs}:rr:${Math.round(t)}`), { ...time(t), uncertaintyMs: 2000 }, 'RR interval', x, 'ms', { source: 'fit hrv' }));
          t += x;
        }
        continue;
      }
      if (m.global === 18 || m.global === 19) {
        const start = num(f[2]);
        const elapsed = num(f[7]);
        if (start === undefined || elapsed === undefined) continue;
        const session = m.global === 18;
        const sport = session ? SPORTS[num(f[5]) ?? 0] ?? `sport ${f[5]}` : 'lap';
        const fields: Record<string, unknown> = {};
        if (num(f[9]) !== undefined) fields.distanceM = num(f[9])! / 100;
        if (num(f[11]) !== undefined) fields.kcal = num(f[11]);
        if (num(f[8]) !== undefined) fields.timerS = num(f[8])! / 1000;
        const avgHr = num(f[session ? 16 : 15]), maxHr = num(f[session ? 17 : 16]);
        if (avgHr !== undefined) fields.avgHr = avgHr;
        if (maxHr !== undefined) fields.maxHr = maxHr;
        const t0 = fitTime(start);
        emit(interval(session ? 'workout' : 'lap', p(`fit:${serial ?? file.name}:${start}:${session ? 'session' : 'lap'}`), time(t0), t0 + elapsed, sport,
          { value: elapsed / 1000, unit: 's', method: maker ? `${maker} FIT` : 'FIT', fields }));
        if (session) info.sport = sport;
      }
    }
  },
});
