// The headset and microphone driver against a fake audio input (MemoryMediaTransport): the route and its level, no
// audio kept unless the host admits it, clips of 16 kHz PCM while it does, the system's route followed when a headset
// is put on, and a picked input that leaves is lost and comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMediaTransport, memoryContext } from '../src/transports/memory.ts';
import { mediaAudioHeadset, fromPcm16, AUDIO_MIME, AUDIO_RATE } from '../src/drivers/media-audio.ts';
import { compatibility, searchCatalog } from '../src/catalog.ts';
import { driverFor } from '../src/registry.ts';
import type { MediaRecord } from '../src/contract.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('headphones are a built route on any browser, verified only as far as the fake input', () => {
  const hit = searchCatalog('airpods pro 3', 'any-browser').find((h) => h.descriptor.id === 'headset')!;
  assert.equal(hit.compatibility.status, 'works');
  assert.equal(hit.compatibility.route?.verified, 'loopback');
  assert.equal(compatibility(hit.descriptor, 'ios').status, 'works');
  assert.equal(driverFor('headset', 'media'), mediaAudioHeadset);
  assert.ok(driverFor('clip-mic', 'media'));
});

test('the route and a level, and no audio while the host does not keep it', async () => {
  const t = new MemoryMediaTransport([{ id: 'mic-1', label: 'Built-in Microphone' }, { id: 'pods', label: 'AirPods Pro' }]);
  let admit = false;
  const ctx = memoryContext({ enabled: ['audio'], config: { input: 'pods', chunkSec: 2 }, admits: () => admit });
  const c = await mediaAudioHeadset.open(t, ctx);
  await c.start();
  assert.equal(ctx.statuses.at(-1)?.state, 'streaming');
  assert.equal(ctx.statuses.at(-1)?.info?.route, 'AirPods Pro');
  assert.equal((await t.inputs())[0].id, 'default');

  t.current!.push(3, 0.3);
  assert.equal(ctx.records.length, 0, 'not admitted: nothing kept, nothing buffered');
  assert.equal(ctx.meters.length, 30, 'ten levels a second');
  assert.ok(ctx.meters.every((m) => m.channel === 'audio' && m.level > 0.6 && m.level <= 1));
  t.current!.push(0.5, 0);
  assert.equal(ctx.meters.at(-1)?.level, 0, 'silence reads 0');

  admit = true;
  t.current!.push(5, 0.1);
  assert.equal(ctx.records.length, 2, 'two clips of 2 s; the last second waits');
  const r = ctx.records[0] as MediaRecord;
  assert.equal(r.shape, 'media'); assert.equal(r.mime, AUDIO_MIME); assert.equal(r.durationMs, 2000);
  assert.equal(r.bytes!.length, 2 * 2 * AUDIO_RATE);
  const pcm = fromPcm16(r.bytes!);
  assert.ok(Math.max(...pcm) > 0.09 && Math.max(...pcm) < 0.11, 'the samples as they were spoken');
  assert.equal(r.prov.model, 'AirPods Pro'); assert.equal(r.prov.transport, 'media');

  // the session ends: the clip so far goes, then nothing
  admit = false;
  t.current!.push(1, 0.1);
  assert.equal(ctx.records.length, 3);
  assert.equal((ctx.records[2] as MediaRecord).durationMs, 1000);
  t.current!.push(3, 0.1);
  assert.equal(ctx.records.length, 3);

  // a channel turned off passes nothing either
  await c.stop();
  assert.equal(ctx.statuses.at(-1)?.state, 'idle');
  assert.ok(t.opened.every((x) => x.closed));
});

test('the system route is followed, and a picked input that leaves is lost until it returns', async () => {
  const t = new MemoryMediaTransport([{ id: 'mic-1', label: 'Built-in Microphone' }]);
  const ctx = memoryContext({ enabled: ['audio'] });
  const c = await mediaAudioHeadset.open(t, ctx);
  await c.start();
  assert.equal(ctx.statuses.at(-1)?.info?.route, 'Built-in Microphone');
  t.plug({ id: 'pods', label: 'AirPods Pro' }, true);   // put on: the system makes them the route
  await tick(); await tick();
  assert.equal(ctx.statuses.at(-1)?.state, 'streaming');
  assert.equal(ctx.statuses.at(-1)?.info?.route, 'AirPods Pro');
  assert.match(ctx.statuses.at(-1)?.why ?? '', /Built-in Microphone → AirPods Pro/);
  assert.equal(t.current!.label, 'AirPods Pro');
  await c.close();

  const t2 = new MemoryMediaTransport([{ id: 'mic-1', label: 'Built-in Microphone' }, { id: 'rode', label: 'Wireless GO RX' }]);
  const ctx2 = memoryContext({ enabled: ['audio'], config: { input: 'rode' } });
  const c2 = await mediaAudioHeadset.open(t2, ctx2);
  await c2.start();
  t2.current!.push(2, 0.2);
  assert.equal(ctx2.records.length, 0, 'clips wait for 10 s');
  t2.unplug('rode');
  await tick(); await tick();
  assert.equal(ctx2.statuses.at(-1)?.state, 'stale');
  assert.match(ctx2.statuses.at(-1)?.why ?? '', /Wireless GO RX is gone/);
  assert.equal(ctx2.records.length, 1, 'what was recorded before it left is kept');
  t2.plug({ id: 'rode', label: 'Wireless GO RX' });
  await tick(); await tick();
  assert.equal(ctx2.statuses.at(-1)?.state, 'streaming');
  await c2.close();
});

test('a refused permission says what to do', async () => {
  const t = new MemoryMediaTransport([{ id: 'mic-1', label: 'Built-in Microphone' }]);
  t.open = async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); };
  const ctx = memoryContext({ enabled: ['audio'] });
  const c = await mediaAudioHeadset.open(t, ctx);
  await assert.rejects(c.start(), /permission was refused/);
  assert.equal(ctx.statuses.at(-1)?.state, 'error');
});
