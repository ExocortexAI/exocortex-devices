// Custom integrations: what a manifest may say, what it may not, and the driver it describes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, driverFromManifest, type Manifest } from '../src/manifest.ts';
import { MemoryByteTransport, MemoryGattTransport, memoryContext } from '../src/transports/memory.ts';
import { fileFrom } from '../src/util.ts';
import type { ByteTransport, EventRecord, FileTransport, GattTransport, SampleChunk } from '../src/contract.ts';

const serial = (): Manifest => ({
  format: 'exocortex.device/1',
  descriptor: {
    id: 'custom:emg-band', name: 'My EMG band', vendor: 'Me', placement: 'arm', about: 'Two EMG channels from an Arduino.',
    channels: [
      { id: 'emg', kind: 'emg', label: 'EMG', shape: 'samples', unit: 'uV', rateHz: 500, count: 2, names: ['flexor', 'extensor'], defaultOn: true, sensitive: 'health' },
      { id: 'temp', kind: 'temp', label: 'Board temperature', shape: 'samples', unit: 'degC', defaultOn: false },
    ],
    links: [{ label: 'Build guide', url: 'https://example.org/emg-band' }],
  },
  driver: {
    type: 'serial-lines', baudRate: 115200, init: ['start\n'], separator: ',', rateHz: 500, usbVendorId: 0x2341,
    columns: [{ channel: 'emg', index: 0, scale: 0.5 }, { channel: 'emg', index: 1, scale: 0.5 }, { channel: 'temp', index: 2, offset: -273.15 }],
  },
});

const gatt = (): Manifest => ({
  format: 'exocortex.device/1',
  descriptor: {
    id: 'custom:breath-belt', name: 'Breath belt', vendor: 'Me', placement: 'chest', about: 'A stretch sensor around the chest.',
    channels: [{ id: 'resp', kind: 'resp', label: 'Breathing', shape: 'samples', unit: 'mV', defaultOn: true }],
  },
  driver: {
    type: 'ble-gatt', service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', characteristic: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    namePrefix: 'Belt', rateHz: 50, layout: [{ channel: 'resp', offset: 0, format: 'i16le', scale: 0.1, bias: 1 }], repeat: { stride: 2, count: 4 },
  },
});

const csvM = (): Manifest => ({
  format: 'exocortex.device/1',
  descriptor: {
    id: 'custom:scale-log', name: 'Kitchen scale log', vendor: 'Me', placement: 'home', about: 'Weights I logged.',
    channels: [{ id: 'weight', kind: 'other', label: 'Weight', shape: 'events', unit: 'kg', defaultOn: true }],
  },
  driver: { type: 'csv-file', timeColumn: 'when', timeFormat: 'unix-s', columns: [{ channel: 'weight', column: 'grams', scale: 0.001 }] },
});

test('good manifests pass', () => {
  for (const m of [serial(), gatt(), csvM()]) assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

/** a manifest broken by `f`, and the error it must give */
function refuses(base: () => Manifest, f: (m: any) => unknown, pattern: RegExp) {
  const m = base() as any;
  const r = f(m);
  const v = validateManifest(r === undefined ? m : r);
  assert.equal(v.ok, false, `expected a refusal matching ${pattern}`);
  assert.ok(v.errors.some((e) => pattern.test(e)), `${pattern} not in ${JSON.stringify(v.errors)}`);
}

test('hostile and broken manifests are refused with a sentence each', () => {
  refuses(serial, (m) => { m.format = 'exocortex.device/2'; }, /format: must be/);
  refuses(serial, (m) => { m.extra = 1; }, /unknown key "extra"/);
  refuses(serial, () => JSON.parse('{"format":"exocortex.device/1","__proto__":{"admin":true},"descriptor":{},"driver":{}}'), /"__proto__" is not allowed/);
  refuses(serial, (m) => { m.descriptor.id = 'polar-h10'; }, /descriptor\.id: has a form/);
  refuses(serial, (m) => { m.descriptor.name = 'x'.repeat(81); }, /at most 80 characters/);
  refuses(serial, (m) => { m.descriptor.about = 'Get it at https://evil.example'; }, /must not hold a link/);
  refuses(serial, (m) => { m.descriptor.about = 'see www.evil.example'; }, /must not hold a link/);
  refuses(serial, (m) => { m.descriptor.name = 'Band‮gnp.exe'; }, /direction-override/);
  refuses(serial, (m) => { m.descriptor.vendor = 'Me\u0007'; }, /control characters/);
  refuses(serial, (m) => { m.descriptor.links[0].url = 'http://example.org'; }, /must start with https/);
  refuses(serial, (m) => { m.descriptor.links[0].url = 'javascript:alert(1)'; }, /https/);
  refuses(serial, (m) => { m.descriptor.links[0].url = 'https://user:pw@example.org/'; }, /user name or a password/);
  refuses(serial, (m) => { m.descriptor.links[0].url = 'https://192.168.1.1/'; }, /domain, not an address/);
  refuses(serial, (m) => { m.descriptor.links[0].url = 'https://router.local/'; }, /public address/);
  refuses(serial, (m) => { m.descriptor.channels = Array.from({ length: 33 }, (_, i) => ({ ...m.descriptor.channels[0], id: `c${i}` })); }, /at most 32 items/);
  refuses(serial, (m) => { m.descriptor.channels[1].id = 'emg'; }, /used twice/);
  refuses(serial, (m) => { m.descriptor.channels[0].kind = 'video'; }, /kind: must be one of/);
  refuses(serial, (m) => { m.descriptor.channels[0].count = 3; }, /says count 3, but 2 values feed it/);
  refuses(serial, (m) => { m.descriptor.actions = [{ id: 'flash-firmware', label: 'Flash' }]; }, /actions\[0\]\.id: must be one of/);
  refuses(serial, (m) => { m.driver.baudRate = 12345; }, /baudRate: must be one of/);
  refuses(serial, (m) => { m.driver.init = ['\u0000ÿ']; }, /printable ASCII/);
  refuses(serial, (m) => { m.driver.columns[0].channel = 'nope'; }, /"nope" is not in descriptor\.channels/);
  refuses(serial, (m) => { m.driver.columns.pop(); }, /nothing feeds the channel "temp"/);
  refuses(serial, (m) => { m.driver.columns[0].scale = Infinity; }, /finite number/);
  refuses(serial, (m) => { m.driver.columns[0].scale = 0; }, /must not be 0/);
  refuses(serial, (m) => { m.driver.type = 'shell'; }, /driver\.type: must be/);
  refuses(gatt, (m) => { m.driver.service = '1812'; }, /may not read/);
  refuses(gatt, (m) => { m.driver.service = 'not-a-uuid'; }, /form that is not allowed/);
  refuses(gatt, (m) => { m.driver.layout[0].offset = 511; m.driver.repeat = undefined; }, /reads past byte 512/);
  refuses(gatt, (m) => { m.driver.layout[0].format = 'i32le'; }, /past the end of its repeated block/);
  refuses(gatt, (m) => { delete m.driver.rateHz; }, /need driver\.rateHz/);
  refuses(csvM, (m) => { m.driver.timeFormat = 'excel'; }, /timeFormat: must be one of/);
  refuses(csvM, (m) => { m.descriptor.channels[0].shape = 'media'; }, /shape: must be one of/);
  // size and depth limits come before anything else
  refuses(serial, (m) => { m.descriptor.about = 'x'.repeat(40_000); }, /bytes; at most 32768/);
  refuses(serial, () => { let o: any = 1; for (let i = 0; i < 12; i++) o = [o]; return { format: 'exocortex.device/1', descriptor: o, driver: {} }; }, /nested more than 8/);
  refuses(serial, () => null, /must be an object/);
  refuses(serial, () => ['a'], /must be an object/);
  const cyclic: any = { format: 'exocortex.device/1' };
  cyclic.self = cyclic;
  assert.equal(validateManifest(cyclic).ok, false);
});

test('driverFromManifest refuses an invalid manifest with the reasons', () => {
  const m = serial() as any;
  m.driver.rateHz = -1;
  assert.throws(() => driverFromManifest(m), /driver\.rateHz: must be more than 0/);
});

test('a serial-lines manifest: init sent, lines parsed and scaled, a partial line skipped', async () => {
  const d = driverFromManifest(serial());
  assert.equal(d.descriptor.routes[0].verified, 'none');
  assert.deepEqual(d.serial, { filters: [{ usbVendorId: 0x2341 }], baudRate: 115200 });
  const t = new MemoryByteTransport();
  const ctx = memoryContext({ enabled: ['emg', 'temp'] });
  const conn = await d.open(t as ByteTransport as never, ctx);
  await conn.start();
  t.push('hello from the board\n');
  for (let i = 0; i < 50; i++) t.push(`${i},${-i},300.15\n`);
  t.push('7,8');   // no line end yet: not a sample
  await conn.stop();
  await conn.close();
  assert.equal(t.baudRate, 115200);
  assert.equal(t.writtenText(), 'start\n');
  const emg = ctx.records.filter((r): r is SampleChunk => r.channel === 'emg');
  assert.equal(emg.reduce((a, r) => a + r.data[0].length, 0), 50);
  assert.deepEqual(emg[0].names, ['flexor', 'extensor']);
  assert.equal(emg[0].data[1][4], -2);
  const temp = ctx.records.filter((r): r is SampleChunk => r.channel === 'temp');
  assert.ok(Math.abs(temp[0].data[0][0] - 27) < 1e-3);
  assert.equal(emg[0].prov.descriptor, 'custom:emg-band');
});

test('a ble-gatt manifest: repeated blocks become samples; a short notification gives fewer', async () => {
  const d = driverFromManifest(gatt());
  assert.deepEqual(d.bluetooth?.filters, [{ namePrefix: 'Belt' }]);
  const t = new MemoryGattTransport('Belt-01');
  const ctx = memoryContext({ enabled: ['resp'] });
  const conn = await d.open(t as GattTransport as never, ctx);
  await conn.start();
  const svc = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', chr = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  t.notify(svc, chr, [10, 0, 20, 0, 0xf6, 0xff, 0, 0]);   // 10, 20, -10, 0
  t.notify(svc, chr, [100, 0, 50]);                       // one whole block, and a byte too few for the second
  await conn.close();
  const c = ctx.records as SampleChunk[];
  assert.deepEqual(Array.from(c[0].data[0], (x) => Math.round(x * 100) / 100), [2, 3, 0, 1]);
  assert.equal(c[1].data[0].length, 1);
  assert.equal(c[0].rateHz, 50);
});

test('a csv-file manifest: named columns, scaled, as events', async () => {
  const d = driverFromManifest(csvM());
  const ctx = memoryContext({ enabled: ['weight'] });
  const conn = await d.open(fileFrom('w.csv', 'when,grams\n1700000000,72500\n1700086400,72300\n1700300000,72100\n') as FileTransport as never, ctx);
  await conn.start();
  const ev = ctx.records as EventRecord[];
  assert.deepEqual(ev.map((r) => [Math.round(r.value! * 1000) / 1000, r.unit, r.time.t0]), [[72.5, 'kg', 1_700_000_000_000], [72.3, 'kg', 1_700_086_400_000], [72.1, 'kg', 1_700_300_000_000]]);
});
