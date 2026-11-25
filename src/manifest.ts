// Custom integrations as manifests: a descriptor and a declarative driver, with no code. A person writes one for a
// device they made; it can be shared by a private link, and the marketplace reviews it, without running anything.
// The marketplace's API imports this same file, so the app and the API check a manifest the same way.
//
//   { format: 'exocortex.device/1',
//     descriptor: { id: 'custom:…', name, vendor, placement, about, channels, actions?, models?, family?, links? },
//     driver: serial-lines | ble-gatt | csv-file }
//
//   serial-lines  text lines from a serial port: { baudRate, init?: string[], separator, rateHz,
//                 columns: [{ channel, index, scale?, offset?, name? }], usbVendorId?, usbProductId? }
//   ble-gatt      notifications of one characteristic: { service, characteristic, namePrefix?, rateHz?,
//                 layout: [{ channel, offset, format, scale?, bias?, name? }], repeat?: { stride, count } }
//                 (`offset` is the byte position; `bias` is added after `scale`)
//   csv-file      { timeColumn, timeFormat, separator?, columns: [{ channel, column, scale?, offset?, name? }] }
//
// A value becomes value × scale + offset (bias for ble-gatt). Validation is strict: unknown keys, oversize strings,
// links that are not https, URLs anywhere else, control and direction-override characters are refused, with a
// sentence for each problem.

import type {
  ByteTransport, Channel, Connection, Descriptor, Driver, FileTransport, GattTransport, OpenContext, Placement, SignalKind,
} from './contract.ts';
import { Counter, ascii, chunk, emitter, event, prov, textChunks, uuid } from './util.ts';
import { readCsv } from './drivers/csv.ts';

export const MANIFEST_FORMAT = 'exocortex.device/1';

export type ByteFormat = 'u8' | 'i8' | 'u16le' | 'i16le' | 'u16be' | 'i16be' | 'u24be' | 'i24be' | 'u32le' | 'i32le' | 'f32le';
export const BYTE_FORMATS: Record<ByteFormat, number> = { u8: 1, i8: 1, u16le: 2, i16le: 2, u16be: 2, i16be: 2, u24be: 3, i24be: 3, u32le: 4, i32le: 4, f32le: 4 };

export interface SerialLinesDriver {
  type: 'serial-lines';
  baudRate: number;
  init?: string[];
  separator: string;
  rateHz: number;
  columns: { channel: string; index: number; scale?: number; offset?: number; name?: string }[];
  usbVendorId?: number;
  usbProductId?: number;
}
export interface BleGattDriver {
  type: 'ble-gatt';
  service: string;
  characteristic: string;
  namePrefix?: string;
  rateHz?: number;
  layout: { channel: string; offset: number; format: ByteFormat; scale?: number; bias?: number; name?: string }[];
  repeat?: { stride: number; count: number };
}
export interface CsvFileDriver {
  type: 'csv-file';
  timeColumn: string | number;
  timeFormat: 'iso' | 'unix-ms' | 'unix-s';
  separator?: string;
  columns: { channel: string; column: string | number; scale?: number; offset?: number; name?: string }[];
}
export type ManifestDriver = SerialLinesDriver | BleGattDriver | CsvFileDriver;
// actions are optional: start and stop are given when a manifest names none
export type ManifestDescriptor = Omit<Descriptor, 'routes' | 'manifest' | 'priority' | 'actions'> & { actions?: Descriptor['actions'] };
export interface Manifest { format: typeof MANIFEST_FORMAT; descriptor: ManifestDescriptor; driver: ManifestDriver }

// ---------------------------------------------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------------------------------------------

export const MANIFEST_LIMITS = {
  bytes: 32 * 1024,
  depth: 8,
  text: 80,
  about: 240,
  models: 16,
  channels: 32,
  names: 256,
  columns: 256,
  layout: 64,
  links: 8,
  url: 300,
  init: 8,
  initLength: 64,
  packet: 512,
  rateHz: 10_000,
  scale: 1e9,
} as const;

const PLACEMENTS: Placement[] = ['head', 'ear', 'eyes', 'wrist', 'finger', 'chest', 'arm', 'body', 'foot', 'phone', 'computer', 'home', 'account', 'file', 'other'];
const KINDS: SignalKind[] = ['eeg', 'ecg', 'emg', 'eog', 'ppg', 'eda', 'resp', 'hr', 'rr', 'hrv', 'spo2', 'temp', 'bp', 'glucose',
  'accel', 'gyro', 'mag', 'orientation', 'steps', 'energy', 'distance', 'speed', 'cadence', 'power', 'location',
  'impedance', 'battery', 'marker', 'other'];   // no audio, video, image, sleep, workout …: a manifest driver cannot make them
const SENSITIVE = ['health', 'neural', 'biometric', 'location'];
// a manifest's driver can start and stop; anything else needs code
const ACTIONS: Record<string, string> = { start: 'Start', stop: 'Stop' };
const BAUD = [300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000];
const SEPARATORS = [',', ';', '\t', ' ', '|', ':'];
// GATT services Chrome refuses (its blocklist) or that hold a person's input or keys: never a sensor's data
const BLOCKED_SERVICES = ['1812', 'fffd', '1530', '00001530-1212-efde-1523-785feabcd123', 'f000ffc0-0451-4000-b000-000000000000'].map(uuid);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const URLISH = /\b(?:https?|ftp|wss?|javascript|data|file|blob|vbscript|mailto|intent):|www\.|\/\//i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[‪-‮⁦-⁩‎‏؜]/;
const ID = /^custom:[a-z0-9][a-z0-9-]{0,62}$/;
const CHANNEL_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UNIT = /^[A-Za-z0-9%/°µ.^*_-]{0,16}$/;
const UUID_RE = /^(?:0x)?(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

// ---------------------------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
function isObj(x: unknown): x is Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

class Checker {
  errors: string[] = [];
  err(path: string, msg: string) { if (this.errors.length < 50) this.errors.push(`${path}: ${msg}`); }

  keys(o: Obj, path: string, required: string[], optional: string[]) {
    for (const k of Object.keys(o)) {
      if (RESERVED_KEYS.has(k)) this.err(path, `the key "${k}" is not allowed.`);
      else if (!required.includes(k) && !optional.includes(k)) this.err(path, `unknown key "${k.slice(0, 40)}".`);
    }
    for (const k of required) if (!(k in o)) this.err(path, `"${k}" is missing.`);
  }

  text(x: unknown, path: string, max: number, o: { required?: boolean; pattern?: RegExp; allowUrl?: boolean; allowEmpty?: boolean } = {}): x is string {
    if (x === undefined && !o.required) return false;
    if (typeof x !== 'string') { this.err(path, 'must be text.'); return false; }
    if (!o.allowEmpty && x.trim() === '') { this.err(path, 'must not be empty.'); return false; }
    if (x.length > max) { this.err(path, `must be at most ${max} characters.`); return false; }
    if (CONTROL.test(x)) { this.err(path, 'must not hold control characters.'); return false; }
    if (BIDI.test(x)) { this.err(path, 'must not hold direction-override characters.'); return false; }
    if (!o.allowUrl && URLISH.test(x)) { this.err(path, 'must not hold a link (put links in descriptor.links).'); return false; }
    if (o.pattern && !o.pattern.test(x)) { this.err(path, `has a form that is not allowed (${o.pattern.source}).`); return false; }
    return true;
  }

  num(x: unknown, path: string, min: number, max: number, o: { required?: boolean; integer?: boolean; exclusiveMin?: boolean } = {}): x is number {
    if (x === undefined && !o.required) return false;
    if (typeof x !== 'number' || !Number.isFinite(x)) { this.err(path, 'must be a finite number.'); return false; }
    if (o.integer && !Number.isInteger(x)) { this.err(path, 'must be a whole number.'); return false; }
    if (o.exclusiveMin ? x <= min : x < min) { this.err(path, `must be ${o.exclusiveMin ? 'more than' : 'at least'} ${min}.`); return false; }
    if (x > max) { this.err(path, `must be at most ${max}.`); return false; }
    return true;
  }

  arr(x: unknown, path: string, min: number, max: number, required = true): x is unknown[] {
    if (x === undefined && !required) return false;
    if (!Array.isArray(x)) { this.err(path, 'must be a list.'); return false; }
    if (x.length < min) { this.err(path, `must have at least ${min} item${min === 1 ? '' : 's'}.`); return false; }
    if (x.length > max) { this.err(path, `must have at most ${max} items.`); return false; }
    return true;
  }

  obj(x: unknown, path: string): x is Obj {
    if (!isObj(x)) { this.err(path, 'must be an object.'); return false; }
    return true;
  }

  oneOf<T extends string | number>(x: unknown, path: string, options: readonly T[], required = true): x is T {
    if (x === undefined && !required) return false;
    if (!options.includes(x as T)) { this.err(path, `must be one of ${options.map((o) => JSON.stringify(o)).join(', ')}.`); return false; }
    return true;
  }
}

function depth(x: unknown, d = 0): number {
  if (d > 32) return d;
  if (Array.isArray(x)) return x.reduce<number>((m, v) => Math.max(m, depth(v, d + 1)), d + 1);
  if (x && typeof x === 'object') return Object.values(x).reduce<number>((m, v) => Math.max(m, depth(v, d + 1)), d + 1);
  return d;
}

function checkDescriptor(c: Checker, d: unknown): Map<string, Channel> {
  const channels = new Map<string, Channel>();
  if (!c.obj(d, 'descriptor')) return channels;
  c.keys(d, 'descriptor', ['id', 'name', 'vendor', 'placement', 'about', 'channels'], ['actions', 'models', 'family', 'links']);
  c.text(d.id, 'descriptor.id', 70, { required: true, pattern: ID });
  c.text(d.name, 'descriptor.name', MANIFEST_LIMITS.text, { required: true });
  c.text(d.vendor, 'descriptor.vendor', MANIFEST_LIMITS.text, { required: true });
  c.oneOf(d.placement, 'descriptor.placement', PLACEMENTS);
  c.text(d.about, 'descriptor.about', MANIFEST_LIMITS.about, { required: true });
  c.text(d.family, 'descriptor.family', 40, { pattern: SLUG });
  if (c.arr(d.models, 'descriptor.models', 1, MANIFEST_LIMITS.models, false)) {
    d.models.forEach((m, i) => c.text(m, `descriptor.models[${i}]`, MANIFEST_LIMITS.text, { required: true }));
  }
  if (c.arr(d.channels, 'descriptor.channels', 1, MANIFEST_LIMITS.channels)) {
    d.channels.forEach((ch, i) => {
      const p = `descriptor.channels[${i}]`;
      if (!c.obj(ch, p)) return;
      c.keys(ch, p, ['id', 'kind', 'label', 'shape', 'defaultOn'], ['unit', 'rateHz', 'count', 'names', 'sensitive']);
      if (c.text(ch.id, `${p}.id`, 32, { required: true, pattern: CHANNEL_ID })) {
        if (channels.has(ch.id)) c.err(`${p}.id`, `"${ch.id}" is used twice.`);
        else channels.set(ch.id, ch as unknown as Channel);
      }
      c.oneOf(ch.kind, `${p}.kind`, KINDS);
      c.text(ch.label, `${p}.label`, MANIFEST_LIMITS.text, { required: true });
      c.oneOf(ch.shape, `${p}.shape`, ['samples', 'events'] as const);
      if (typeof ch.defaultOn !== 'boolean') c.err(`${p}.defaultOn`, 'must be true or false.');
      c.text(ch.unit, `${p}.unit`, 16, { pattern: UNIT, allowEmpty: true });
      c.num(ch.rateHz, `${p}.rateHz`, 0, MANIFEST_LIMITS.rateHz, { exclusiveMin: true });
      c.num(ch.count, `${p}.count`, 1, MANIFEST_LIMITS.names, { integer: true });
      if (c.arr(ch.names, `${p}.names`, 1, MANIFEST_LIMITS.names, false)) {
        ch.names.forEach((n, k) => c.text(n, `${p}.names[${k}]`, 32, { required: true }));
      }
      c.oneOf(ch.sensitive, `${p}.sensitive`, SENSITIVE, false);
    });
  }
  if (c.arr(d.actions, 'descriptor.actions', 0, Object.keys(ACTIONS).length, false)) {
    const seen = new Set<string>();
    d.actions.forEach((a, i) => {
      const p = `descriptor.actions[${i}]`;
      if (!c.obj(a, p)) return;
      c.keys(a, p, ['id', 'label'], ['safing']);
      if (c.oneOf(a.id, `${p}.id`, Object.keys(ACTIONS))) {
        if (seen.has(a.id)) c.err(`${p}.id`, `"${a.id}" is listed twice.`);
        seen.add(a.id);
      }
      c.text(a.label, `${p}.label`, MANIFEST_LIMITS.text, { required: true });
      if (a.safing !== undefined && typeof a.safing !== 'boolean') c.err(`${p}.safing`, 'must be true or false.');
    });
  }
  if (c.arr(d.links, 'descriptor.links', 0, MANIFEST_LIMITS.links, false)) {
    d.links.forEach((l, i) => {
      const p = `descriptor.links[${i}]`;
      if (!c.obj(l, p)) return;
      c.keys(l, p, ['label', 'url'], []);
      c.text(l.label, `${p}.label`, MANIFEST_LIMITS.text, { required: true });
      if (c.text(l.url, `${p}.url`, MANIFEST_LIMITS.url, { required: true, allowUrl: true })) {
        let u: URL | null = null;
        try { u = new URL(l.url); } catch { c.err(`${p}.url`, 'is not a valid address.'); }
        if (u) {
          if (u.protocol !== 'https:') c.err(`${p}.url`, 'must start with https://.');
          if (u.username || u.password) c.err(`${p}.url`, 'must not carry a user name or a password.');
          if (!u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[')) c.err(`${p}.url`, 'must name a domain, not an address.');
          if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) c.err(`${p}.url`, 'must be a public address.');
        }
      }
    });
  }
  return channels;
}

function checkUse(c: Checker, channels: Map<string, Channel>, used: Map<string, number>, path: string, shapes: ('samples' | 'events')[]) {
  for (const [id, n] of used) {
    const ch = channels.get(id);
    if (!ch) { c.err(path, `the channel "${id.slice(0, 32)}" is not in descriptor.channels.`); continue; }
    if (!shapes.includes(ch.shape as 'samples' | 'events')) c.err(path, `the channel "${id}" must have the shape ${shapes.join(' or ')} for this driver.`);
    if (ch.count !== undefined && ch.count !== n) c.err(path, `the channel "${id}" says count ${ch.count}, but ${n} value${n === 1 ? '' : 's'} feed it.`);
    if (ch.names && ch.names.length !== n) c.err(path, `the channel "${id}" names ${ch.names.length} signals, but ${n} value${n === 1 ? '' : 's'} feed it.`);
  }
  for (const id of channels.keys()) if (!used.has(id)) c.err(path, `nothing feeds the channel "${id}".`);
}

function checkScale(c: Checker, x: Obj, p: string, add: 'offset' | 'bias') {
  c.num(x.scale, `${p}.scale`, -MANIFEST_LIMITS.scale, MANIFEST_LIMITS.scale);
  if (x.scale === 0) c.err(`${p}.scale`, 'must not be 0.');
  c.num(x[add], `${p}.${add}`, -MANIFEST_LIMITS.scale, MANIFEST_LIMITS.scale);
  c.text(x.name, `${p}.name`, 32);
}

function checkDriver(c: Checker, d: unknown, channels: Map<string, Channel>) {
  if (!c.obj(d, 'driver')) return;
  const used = new Map<string, number>();
  if (d.type === 'serial-lines') {
    c.keys(d, 'driver', ['type', 'baudRate', 'separator', 'rateHz', 'columns'], ['init', 'usbVendorId', 'usbProductId']);
    c.oneOf(d.baudRate, 'driver.baudRate', BAUD);
    c.oneOf(d.separator, 'driver.separator', SEPARATORS);
    c.num(d.rateHz, 'driver.rateHz', 0, 2000, { required: true, exclusiveMin: true });
    c.num(d.usbVendorId, 'driver.usbVendorId', 0, 0xffff, { integer: true });
    c.num(d.usbProductId, 'driver.usbProductId', 0, 0xffff, { integer: true });
    if (d.usbProductId !== undefined && d.usbVendorId === undefined) c.err('driver.usbProductId', 'needs usbVendorId.');
    if (c.arr(d.init, 'driver.init', 0, MANIFEST_LIMITS.init, false)) {
      d.init.forEach((s, i) => {
        const p = `driver.init[${i}]`;
        if (typeof s !== 'string') { c.err(p, 'must be text.'); return; }
        if (s.length < 1 || s.length > MANIFEST_LIMITS.initLength) c.err(p, `must be 1 to ${MANIFEST_LIMITS.initLength} characters.`);
        if (!/^[\x20-\x7e\r\n\t]*$/.test(s)) c.err(p, 'must be printable ASCII (and \\r, \\n, \\t).');
      });
    }
    if (c.arr(d.columns, 'driver.columns', 1, MANIFEST_LIMITS.columns)) {
      d.columns.forEach((col, i) => {
        const p = `driver.columns[${i}]`;
        if (!c.obj(col, p)) return;
        c.keys(col, p, ['channel', 'index'], ['scale', 'offset', 'name']);
        c.num(col.index, `${p}.index`, 0, 255, { required: true, integer: true });
        if (c.text(col.channel, `${p}.channel`, 32, { required: true, pattern: CHANNEL_ID })) used.set(col.channel, (used.get(col.channel) ?? 0) + 1);
        checkScale(c, col, p, 'offset');
      });
    }
    checkUse(c, channels, used, 'driver.columns', ['samples']);
    return;
  }
  if (d.type === 'ble-gatt') {
    c.keys(d, 'driver', ['type', 'service', 'characteristic', 'layout'], ['namePrefix', 'rateHz', 'repeat']);
    if (c.text(d.service, 'driver.service', 40, { required: true, pattern: UUID_RE }) && BLOCKED_SERVICES.includes(uuid(d.service))) {
      c.err('driver.service', 'is a service a custom integration may not read (input devices, security keys, firmware update).');
    }
    c.text(d.characteristic, 'driver.characteristic', 40, { required: true, pattern: UUID_RE });
    c.text(d.namePrefix, 'driver.namePrefix', 32);
    c.num(d.rateHz, 'driver.rateHz', 0, 2000, { exclusiveMin: true });
    let stride = 0, count = 1;
    if (d.repeat !== undefined && c.obj(d.repeat, 'driver.repeat')) {
      c.keys(d.repeat, 'driver.repeat', ['stride', 'count'], []);
      if (c.num(d.repeat.stride, 'driver.repeat.stride', 1, MANIFEST_LIMITS.packet, { required: true, integer: true })) stride = d.repeat.stride;
      if (c.num(d.repeat.count, 'driver.repeat.count', 1, 64, { required: true, integer: true })) count = d.repeat.count;
      if (d.rateHz === undefined && count > 1) c.err('driver.repeat', 'several samples per notification need driver.rateHz.');
    }
    if (c.arr(d.layout, 'driver.layout', 1, MANIFEST_LIMITS.layout)) {
      d.layout.forEach((f, i) => {
        const p = `driver.layout[${i}]`;
        if (!c.obj(f, p)) return;
        c.keys(f, p, ['channel', 'offset', 'format'], ['scale', 'bias', 'name']);
        const okOff = c.num(f.offset, `${p}.offset`, 0, MANIFEST_LIMITS.packet - 1, { required: true, integer: true });
        const okFmt = c.oneOf(f.format, `${p}.format`, Object.keys(BYTE_FORMATS) as ByteFormat[]);
        if (okOff && okFmt) {
          const last = (f.offset as number) + BYTE_FORMATS[f.format as ByteFormat] + stride * (count - 1);
          if (last > MANIFEST_LIMITS.packet) c.err(p, `reads past byte ${MANIFEST_LIMITS.packet} of a notification.`);
          if (stride && (f.offset as number) + BYTE_FORMATS[f.format as ByteFormat] > stride) c.err(p, 'reads past the end of its repeated block (repeat.stride).');
        }
        if (c.text(f.channel, `${p}.channel`, 32, { required: true, pattern: CHANNEL_ID })) used.set(f.channel, (used.get(f.channel) ?? 0) + 1);
        checkScale(c, f, p, 'bias');
      });
    }
    checkUse(c, channels, used, 'driver.layout', d.rateHz === undefined ? ['events'] : ['samples']);
    return;
  }
  if (d.type === 'csv-file') {
    c.keys(d, 'driver', ['type', 'timeColumn', 'timeFormat', 'columns'], ['separator']);
    if (typeof d.timeColumn === 'number') c.num(d.timeColumn, 'driver.timeColumn', 0, 255, { integer: true });
    else c.text(d.timeColumn, 'driver.timeColumn', 64, { required: true });
    c.oneOf(d.timeFormat, 'driver.timeFormat', ['iso', 'unix-ms', 'unix-s'] as const);
    c.oneOf(d.separator, 'driver.separator', [',', ';', '\t', '|'], false);
    if (c.arr(d.columns, 'driver.columns', 1, MANIFEST_LIMITS.columns)) {
      d.columns.forEach((col, i) => {
        const p = `driver.columns[${i}]`;
        if (!c.obj(col, p)) return;
        c.keys(col, p, ['channel', 'column'], ['scale', 'offset', 'name']);
        if (typeof col.column === 'number') c.num(col.column, `${p}.column`, 0, 255, { integer: true });
        else c.text(col.column, `${p}.column`, 64, { required: true });
        if (c.text(col.channel, `${p}.channel`, 32, { required: true, pattern: CHANNEL_ID })) used.set(col.channel, (used.get(col.channel) ?? 0) + 1);
        checkScale(c, col, p, 'offset');
      });
    }
    checkUse(c, channels, used, 'driver.columns', ['samples', 'events']);
    return;
  }
  c.err('driver.type', 'must be "serial-lines", "ble-gatt" or "csv-file".');
}

/** check a manifest before storing, sharing or installing it. `errors` are sentences a person can act on. */
export function validateManifest(x: unknown): { ok: boolean; errors: string[] } {
  const c = new Checker();
  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(x) ?? '').length; } catch { return { ok: false, errors: ['manifest: is not plain JSON data.'] }; }
  if (size > MANIFEST_LIMITS.bytes) return { ok: false, errors: [`manifest: is ${size} bytes; at most ${MANIFEST_LIMITS.bytes} are allowed.`] };
  if (depth(x) > MANIFEST_LIMITS.depth) return { ok: false, errors: [`manifest: is nested more than ${MANIFEST_LIMITS.depth} levels deep.`] };
  if (!c.obj(x, 'manifest')) return { ok: false, errors: c.errors };
  c.keys(x, 'manifest', ['format', 'descriptor', 'driver'], []);
  if (x.format !== MANIFEST_FORMAT) c.err('manifest.format', `must be "${MANIFEST_FORMAT}".`);
  const channels = checkDescriptor(c, x.descriptor);
  checkDriver(c, x.driver, channels);
  return { ok: c.errors.length === 0, errors: c.errors };
}

// ---------------------------------------------------------------------------------------------------------------
// the driver a manifest describes
// ---------------------------------------------------------------------------------------------------------------

/** the full descriptor of a manifest: its routes follow from the driver type, and nothing is verified */
export function descriptorFromManifest(m: Manifest): Descriptor {
  const d = m.driver;
  const route: Descriptor['routes'][number] =
    d.type === 'serial-lines' ? { transport: 'web-serial', hosts: ['chrome-desktop', 'desktop-app'], driver: m.descriptor.id, freshness: 'live', dataLeaves: 'never', verified: 'none' }
    : d.type === 'ble-gatt' ? { transport: 'web-bluetooth', hosts: ['chrome-desktop', 'android'], driver: m.descriptor.id, freshness: 'live', dataLeaves: 'never', verified: 'none' }
    : { transport: 'file', hosts: ['any-browser', 'chrome-desktop', 'desktop-app', 'ios', 'android'], driver: m.descriptor.id, freshness: 'when you import a file', dataLeaves: 'never', verified: 'none' };
  const actions = m.descriptor.actions?.length ? m.descriptor.actions
    : d.type === 'csv-file' ? [{ id: 'start', label: 'Import' }, { id: 'stop', label: 'Stop', safing: true }]
    : [{ id: 'start', label: 'Start' }, { id: 'stop', label: 'Stop', safing: true }];
  return { ...m.descriptor, actions: actions.map((a) => (a.id === 'stop' ? { ...a, safing: true } : a)), routes: [route], manifest: m };
}

function reader(format: ByteFormat): (v: DataView, o: number) => number {
  switch (format) {
    case 'u8': return (v, o) => v.getUint8(o);
    case 'i8': return (v, o) => v.getInt8(o);
    case 'u16le': return (v, o) => v.getUint16(o, true);
    case 'i16le': return (v, o) => v.getInt16(o, true);
    case 'u16be': return (v, o) => v.getUint16(o, false);
    case 'i16be': return (v, o) => v.getInt16(o, false);
    case 'u24be': return (v, o) => (v.getUint8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2);
    case 'i24be': return (v, o) => { const x = (v.getUint8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2); return x & 0x800000 ? x - 0x1000000 : x; };
    case 'u32le': return (v, o) => v.getUint32(o, true);
    case 'i32le': return (v, o) => v.getInt32(o, true);
    case 'f32le': return (v, o) => v.getFloat32(o, true);
  }
}

/** the signal names of a channel fed by these inputs */
function namesOf(ch: Channel | undefined, inputs: { name?: string }[], fallback: (k: number) => string): string[] {
  return inputs.map((x, k) => x.name ?? ch?.names?.[k] ?? fallback(k));
}


function serialConnection(m: Manifest & { driver: SerialLinesDriver }, descriptor: Descriptor, t: ByteTransport, ctx: OpenContext): Connection {
  const d = m.driver;
  const counter = new Counter();
  const emit = emitter(ctx, counter);
  const channels = new Map(descriptor.channels.map((c) => [c.id, c]));
  const groups = [...new Set(d.columns.map((c) => c.channel))].map((id) => {
    const cols = d.columns.filter((c) => c.channel === id);
    return { id, cols, names: namesOf(channels.get(id), cols, (k) => `${id}${cols.length > 1 ? k + 1 : ''}`), unit: channels.get(id)?.unit ?? '' };
  });
  const p = () => prov(ctx, descriptor.id, t.kind, { serial: t.label });
  let rows: string[][] = [];
  let rest = '';
  let opened = false;
  let streaming = false;
  let closing = false;
  let loop: Promise<void> | null = null;
  let seq = 0;
  const per = Math.max(1, Math.round(d.rateHz / 10));
  const flush = () => {
    if (!rows.length) return;
    const now = ctx.now();
    const n = rows.length;
    for (const g of groups) {
      const data = g.cols.map((c) => Float32Array.from(rows, (r) => Number(r[c.index]) * (c.scale ?? 1) + (c.offset ?? 0)));
      emit(chunk(g.id, p(), { t0: now - (n * 1000) / d.rateHz, receivedAt: now, clock: 'host', seq, uncertaintyMs: 100 }, d.rateHz, g.names, g.unit, data));
    }
    seq += n;
    rows = [];
  };
  const onBytes = (b: Uint8Array) => {
    if (!streaming) return;
    rest += new TextDecoder().decode(b);
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i).replace(/\r$/, '');
      rest = rest.slice(i + 1);
      const f = line.split(d.separator).map((s) => s.trim());
      // a line too short for its columns, or with no number where one belongs, is skipped (a banner, a partial line)
      if (d.columns.every((c) => f[c.index] !== undefined && f[c.index] !== '' && Number.isFinite(Number(f[c.index])))) rows.push(f);
      if (rows.length >= per) flush();
    }
    if (rest.length > 4096) rest = '';
  };
  const start = async () => {
    if (streaming) return;
    if (!opened) {
      await t.open({ baudRate: d.baudRate });
      opened = true;
      loop = t.read(onBytes).then(
        () => { if (!closing) ctx.status(counter.status(streaming ? 'unknown' : 'closed', { why: 'The serial link ended.' })); },
        (e) => { if (!closing) ctx.status(counter.status('error', { why: `Reading the port failed: ${e instanceof Error ? e.message : String(e)}` })); },
      );
    }
    streaming = true;
    for (const s of d.init ?? []) await t.write(ascii(s));
    ctx.status(counter.status('streaming'));
  };
  const stop = async () => { flush(); streaming = false; ctx.status(counter.status('idle')); };
  return {
    start, stop,
    async act(a) {
      if (a === 'start') { await start(); return { outcome: 'done' }; }
      if (a === 'stop') { await stop(); return { outcome: 'done' }; }
      return { outcome: 'unsupported' };
    },
    async close() { await stop(); closing = true; if (opened) await t.close(); await loop; ctx.status(counter.status('closed')); },
  };
}

function gattConnection(m: Manifest & { driver: BleGattDriver }, descriptor: Descriptor, t: GattTransport, ctx: OpenContext): Connection {
  const d = m.driver;
  const counter = new Counter();
  const emit = emitter(ctx, counter);
  const channels = new Map(descriptor.channels.map((c) => [c.id, c]));
  const count = d.repeat?.count ?? 1;
  const stride = d.repeat?.stride ?? 0;
  const fields = d.layout.map((f) => ({ ...f, read: reader(f.format), size: BYTE_FORMATS[f.format] }));
  const groups = [...new Set(d.layout.map((f) => f.channel))].map((id) => {
    const fs = fields.filter((f) => f.channel === id);
    return { id, fs, names: namesOf(channels.get(id), fs, (k) => `${id}${fs.length > 1 ? k + 1 : ''}`), unit: channels.get(id)?.unit ?? '' };
  });
  const p = () => prov(ctx, descriptor.id, 'web-bluetooth', { serial: t.id, model: t.label });
  let unsub: (() => Promise<void>) | null = null;
  let closing = false;
  let seq = 0;
  const onValue = (v: DataView) => {
    const now = ctx.now();
    // how many repeated blocks this notification holds (a short one may hold fewer)
    let n = 0;
    for (let k = 0; k < count; k++) if (fields.every((f) => f.offset + k * stride + f.size <= v.byteLength)) n = k + 1;
    if (!n) return;
    for (const g of groups) {
      const data = g.fs.map((f) => {
        const a = new Float32Array(n);
        for (let k = 0; k < n; k++) a[k] = f.read(v, f.offset + k * stride) * (f.scale ?? 1) + (f.bias ?? 0);
        return a;
      });
      if (d.rateHz) emit(chunk(g.id, p(), { t0: now - (n * 1000) / d.rateHz, receivedAt: now, clock: 'host', seq, uncertaintyMs: 150 }, d.rateHz, g.names, g.unit, data));
      else g.fs.forEach((_, k) => emit(event(g.id, p(), { t0: now, receivedAt: now, clock: 'host', uncertaintyMs: 150 }, g.names[k], data[k][0], g.unit || undefined)));
    }
    seq += n;
  };
  t.onDisconnect(() => { if (!closing) { ctx.status(counter.status(unsub ? 'stale' : 'closed', { why: 'The device went out of range or turned off.' })); unsub = null; } });
  const start = async () => { if (!unsub) unsub = await t.subscribe(d.service, d.characteristic, onValue); ctx.status(counter.status('streaming')); };
  const stop = async () => { await unsub?.(); unsub = null; ctx.status(counter.status('idle')); };
  return {
    start, stop,
    async act(a) {
      if (a === 'start') { await start(); return { outcome: 'done' }; }
      if (a === 'stop') { await stop(); return { outcome: 'done' }; }
      return { outcome: 'unsupported' };
    },
    async close() { closing = true; await stop(); await t.close(); ctx.status(counter.status('closed')); },
  };
}

function csvConnection(m: Manifest & { driver: CsvFileDriver }, descriptor: Descriptor, file: FileTransport, ctx: OpenContext): Connection {
  const d = m.driver;
  const counter = new Counter();
  const emit = emitter(ctx, counter);
  let stopped = false;
  let running: Promise<void> | null = null;
  const units = Object.fromEntries(descriptor.channels.map((c) => [c.id, c.unit ?? '']));
  const start = async () => {
    if (running) return running;
    stopped = false;
    ctx.status(counter.status('streaming', { why: `Reading ${file.name}.` }));
    running = (async () => {
      const plan = { timeColumn: d.timeColumn, timeFormat: d.timeFormat, separator: d.separator, columns: d.columns, units };
      for await (const r of readCsv(textChunks(file.chunks()), plan, (row) => prov(ctx, descriptor.id, 'file', { providerRecordId: `${file.name}:${row}` }), ctx.now)) {
        if (stopped) break;
        emit(r);
      }
    })().then(
      () => ctx.status(counter.status('idle')),
      (e) => { ctx.status(counter.status('error', { why: `${file.name} could not be read: ${e instanceof Error ? e.message : String(e)}` })); throw e; },
    ).finally(() => { running = null; });
    return running;
  };
  return {
    start,
    async stop() { stopped = true; await running?.catch(() => {}); },
    async act(a) {
      if (a === 'start') { await start(); return { outcome: 'done' }; }
      if (a === 'stop') { stopped = true; return { outcome: 'done' }; }
      return { outcome: 'unsupported' };
    },
    async close() { stopped = true; await running?.catch(() => {}); ctx.status(counter.status('closed')); },
  };
}

/** the Driver a manifest describes. Throws with the validation's sentences when the manifest is not valid. */
export function driverFromManifest(x: unknown): Driver {
  const v = validateManifest(x);
  if (!v.ok) throw new Error(`This manifest is not valid:\n${v.errors.join('\n')}`);
  const m = x as Manifest;
  const descriptor = descriptorFromManifest(m);
  const d = m.driver;
  if (d.type === 'serial-lines') {
    const drv: Driver<ByteTransport> = {
      id: descriptor.id, descriptor, transport: 'web-serial',
      serial: { filters: d.usbVendorId !== undefined ? [{ usbVendorId: d.usbVendorId, ...(d.usbProductId !== undefined ? { usbProductId: d.usbProductId } : {}) }] : [], baudRate: d.baudRate },
      async open(t, ctx) { return serialConnection(m as Manifest & { driver: SerialLinesDriver }, descriptor, t, ctx); },
    };
    return drv as Driver;
  }
  if (d.type === 'ble-gatt') {
    const drv: Driver<GattTransport> = {
      id: descriptor.id, descriptor, transport: 'web-bluetooth',
      bluetooth: { filters: [d.namePrefix ? { namePrefix: d.namePrefix } : { services: [uuid(d.service)] }], optionalServices: [uuid(d.service)] },
      async open(t, ctx) { return gattConnection(m as Manifest & { driver: BleGattDriver }, descriptor, t, ctx); },
    };
    return drv as Driver;
  }
  const drv: Driver<FileTransport> = {
    id: descriptor.id, descriptor, transport: 'file', files: { extensions: ['.csv', '.tsv', '.txt'], mime: ['text/csv'] },
    async open(t, ctx) { return csvConnection(m as Manifest & { driver: CsvFileDriver }, descriptor, t, ctx); },
  };
  return drv as Driver;
}
