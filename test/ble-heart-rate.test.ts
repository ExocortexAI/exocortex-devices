// The Bluetooth Heart Rate Service: every flag of the Heart Rate Measurement characteristic, and a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate, bleHeartRate, HR_SERVICE, HR_MEASUREMENT, BATTERY_SERVICE, BATTERY_LEVEL } from '../src/drivers/ble-heart-rate.ts';
import { MemoryGattTransport, memoryContext } from '../src/transports/memory.ts';
import type { EventRecord } from '../src/contract.ts';

const dv = (bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);

test('heart rate flags, as the Heart Rate Service spec lays them out', () => {
  // bit 0 clear: uint8 heart rate
  assert.deepEqual(parseHeartRate(dv([0x00, 72])), { bpm: 72, rrMs: [] });
  // bit 0 set: uint16 LE heart rate
  assert.deepEqual(parseHeartRate(dv([0x01, 0x2c, 0x01])), { bpm: 300, rrMs: [] });
  // bits 1-2: contact supported (bit 2), detected (bit 1)
  assert.equal(parseHeartRate(dv([0x06, 60])).contact, true);
  assert.equal(parseHeartRate(dv([0x04, 60])).contact, false);
  assert.equal(parseHeartRate(dv([0x02, 60])).contact, undefined);   // detected without support: not reported
  // bit 3: energy expended, uint16 LE kJ
  assert.deepEqual(parseHeartRate(dv([0x08, 70, 0x10, 0x00])), { bpm: 70, energyKj: 16, rrMs: [] });
  // bit 4: RR intervals in 1/1024 s
  assert.deepEqual(parseHeartRate(dv([0x10, 60, 0x00, 0x04])), { bpm: 60, rrMs: [1000] });
  // all of them: uint16 HR, contact, energy, two RR intervals
  assert.deepEqual(parseHeartRate(dv([0x1f, 0x50, 0x00, 0x20, 0x00, 0x00, 0x04, 0x00, 0x02])), { bpm: 80, contact: true, energyKj: 32, rrMs: [1000, 500] });
});

test('heart-rate session: battery, events with RR times ending at arrival, wear from contact', async () => {
  const t = new MemoryGattTransport('Polar H9 1234');
  t.setValue(BATTERY_SERVICE, BATTERY_LEVEL, [87]);
  let now = 10_000;
  const ctx = memoryContext({ enabled: ['hr', 'rr'], now: () => now });
  const conn = await bleHeartRate.open(t, ctx);
  await conn.start();
  assert.equal(ctx.statuses.at(-1)?.battery, 0.87);
  t.notify(HR_SERVICE, HR_MEASUREMENT, [0x16, 60, 0x00, 0x04, 0x00, 0x02]);
  now = 11_000;
  t.notify(HR_SERVICE, HR_MEASUREMENT, [0x04, 0]);   // contact lost: no heart rate event, wear off
  const ev = ctx.records as EventRecord[];
  assert.deepEqual(ev.filter((r) => r.channel === 'hr').map((r) => r.value), [60]);
  const rr = ev.filter((r) => r.channel === 'rr');
  assert.deepEqual(rr.map((r) => [r.value, r.time.t0]), [[1000, 9500], [500, 10_000]]);
  assert.equal(ctx.statuses.at(-1)?.wear, 'off');
  assert.equal(rr[0].prov.descriptor, 'ble-heart-rate');
  await conn.close();
  assert.equal(t.subscribed(HR_SERVICE, HR_MEASUREMENT), false);
});
