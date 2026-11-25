// Headsets and microphones through the system's audio route: AirPods and other earbuds, open-ear and bone-conduction
// sets, a clip mic's USB receiver, a USB microphone. The host hands over a MediaTransport (getUserMedia in a page,
// ../transports/web-media.ts); this driver lists its inputs, opens the one the person picked (or the system's own
// choice), reports the route by name and a live level, and notices when the route changes or the input is lost.
//
// Audio is the most sensitive thing a person carries. The driver keeps none of it unless the host says it keeps this
// device's records now (`ctx.admits()`: a recording session that names it). Then it emits the audio as clips: 16 kHz
// mono PCM, 16-bit little-endian, `chunkSec` seconds each, as MediaRecords with the bytes inline. The level meter is
// display only (`ctx.meter`): it is never a record.

import type { AudioInput, Connection, Descriptor, Driver, MediaTransport, OpenContext, Route } from '../contract.ts';
import { prov } from '../util.ts';

export const AUDIO_RATE = 16000;
export const AUDIO_MIME = 'audio/pcm;rate=16000;bits=16;channels=1;le';

const route = (needs: string[]): Route => ({
  transport: 'media', hosts: ['any-browser', 'chrome-desktop', 'desktop-app', 'ios', 'android'], driver: 'media-audio', needs: ['a browser with a microphone', ...needs],
  freshness: 'live', dataLeaves: 'never', verified: 'loopback',
  evidence: 'test/media-audio.test.ts: inputs, the level, clips only while admitted, a route change and a lost input, against a fake audio input; not yet run with a named headset',
});
const audio = { id: 'audio', kind: 'audio' as const, label: 'Microphone', shape: 'media' as const, unit: 'pcm', rateHz: AUDIO_RATE, defaultOn: true, sensitive: 'audio' as const };

export const headsetDescriptor: Descriptor = {
  id: 'headset', name: 'Headphones and earbuds', vendor: 'Apple AirPods, Beats, Bose, Sony, Samsung Galaxy Buds, Google Pixel Buds, Jabra, Shokz, Soundcore, Xiaomi, boAt',
  family: 'headset', placement: 'ear', priority: 'P0',
  models: ['AirPods Pro 3', 'AirPods 4', 'Powerbeats Pro 2', 'Bose QuietComfort', 'Sony WF-1000XM5', 'Galaxy Buds', 'Pixel Buds', 'Shokz OpenRun', 'open-ear and bone-conduction sets'],
  about: 'Your voice through the headset’s microphone, by the system’s audio route.',
  channels: [audio], actions: [],
  routes: [route(['the headset connected to this computer or phone'])],
};

export const clipMicDescriptor: Descriptor = {
  id: 'clip-mic', name: 'Clip-on microphones', vendor: 'RØDE, DJI, Hollyland', family: 'clip-mic', placement: 'body', priority: 'P0',
  models: ['RØDE Wireless GO', 'RØDE Wireless Micro', 'DJI Mic 2', 'DJI Mic Mini', 'Hollyland Lark M2', 'any USB microphone'],
  about: 'A clip mic through its USB receiver, or any USB microphone.',
  channels: [audio], actions: [],
  routes: [route(['the receiver plugged in'])],
};

/** a level for a meter from the RMS of a block: -60 dBFS is 0, 0 dBFS is 1 */
export function levelOf(pcm: Float32Array): number {
  let ss = 0;
  for (let i = 0; i < pcm.length; i++) ss += pcm[i] * pcm[i];
  const rms = Math.sqrt(ss / Math.max(1, pcm.length));
  return rms <= 1e-6 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60));
}

/** float32 samples as 16-bit little-endian PCM */
export function toPcm16(parts: Float32Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n * 2), v = new DataView(out.buffer);
  let o = 0;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2) v.setInt16(o, Math.round(Math.max(-1, Math.min(1, p[i])) * 32767), true);
  return out;
}

/** 16-bit little-endian PCM back to float32 (the node's transcriber reads float32) */
export function fromPcm16(b: Uint8Array): Float32Array {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Float32Array(Math.floor(b.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true) / 32767;
  return out;
}

const settings: Driver['settings'] = [
  { id: 'chunkSec', label: 'Seconds per clip', type: 'number', default: 10, help: 'Recorded audio is kept in clips of this length.' },
];

export function makeMediaAudioDriver(descriptor: Descriptor): Driver<MediaTransport> {
  return { id: 'media-audio', descriptor, transport: 'media', settings, open: (t, ctx) => openAudio(t, ctx, descriptor.id) };
}
export const mediaAudioHeadset = makeMediaAudioDriver(headsetDescriptor);
export const mediaAudioClipMic = makeMediaAudioDriver(clipMicDescriptor);

async function openAudio(t: MediaTransport, ctx: OpenContext, descriptorId: string): Promise<Connection> {
  const want = typeof ctx.config.input === 'string' && ctx.config.input ? ctx.config.input : 'default';
  const chunkSamples = Math.max(1, Math.min(60, Number(ctx.config.chunkSec ?? 10) || 10)) * AUDIO_RATE;
  const meterEvery = AUDIO_RATE / 10;      // ten levels a second
  let input: AudioInput | null = null;
  let running = false, gone = false;
  let clip: Float32Array[] = [], clipN = 0, clipStart = 0, inClip = false;
  let meterBuf: Float32Array[] = [], meterN = 0;
  let unsub: (() => void) | null = null;
  const info = () => ({ route: input?.label ?? '', input: want, rate: '16 kHz' });

  const flushClip = () => {
    if (clipN >= AUDIO_RATE / 2 && input) {   // half a second or more: shorter is a click, not speech
      const now = ctx.now();
      ctx.emit({
        shape: 'media', channel: 'audio', mime: AUDIO_MIME, durationMs: Math.round((clipN / AUDIO_RATE) * 1000), bytes: toPcm16(clip),
        prov: prov(ctx, descriptorId, 'media', { model: input.label, serial: input.id }),
        time: { t0: clipStart, receivedAt: now, clock: 'host', uncertaintyMs: 50 },
      });
    }
    clip = []; clipN = 0; inClip = false;
  };

  const block = (pcm: Float32Array) => {
    if (!running) return;
    meterBuf.push(pcm); meterN += pcm.length;
    if (meterN >= meterEvery) {
      const all = new Float32Array(meterN); let o = 0;
      for (const b of meterBuf) { all.set(b, o); o += b.length; }
      ctx.meter?.('audio', levelOf(all));
      meterBuf = []; meterN = 0;
    }
    if (!ctx.enabled.has('audio')) return;
    // nothing is buffered unless the host keeps it now; the moment it stops keeping it, the clip so far goes
    if (ctx.admits && !ctx.admits()) { if (inClip) flushClip(); return; }
    if (!inClip) { inClip = true; clipStart = ctx.now() - (pcm.length / AUDIO_RATE) * 1000; }
    clip.push(pcm.slice()); clipN += pcm.length;
    if (clipN >= chunkSamples) flushClip();
  };

  const lost = (why: string) => {
    if (!running || gone) return;
    gone = true;
    flushClip();
    const was = input; input = null;
    void was?.close().catch(() => {});
    ctx.status({ state: 'stale', why, info: { ...info(), route: was?.label ?? '' } });
  };

  const openInput = async () => {
    input = await t.open({ input: want, sampleRate: AUDIO_RATE });
    gone = false;
    const me = input;
    input.onEnded(() => { if (input === me) lost(`${me.label || 'The microphone'} is gone (taken out, unplugged, or the permission was taken back). Put it back or choose another input.`); });
    input.read(block);
    ctx.status({ state: 'streaming', info: info() });
  };

  // the inputs changed: a picked input that left is lost and comes back when it returns; the system's own choice is
  // followed (a headset put on becomes the route)
  const changed = async () => {
    if (!running) return;
    const list = await t.inputs().catch(() => [] as { id: string; label: string }[]);
    if (want !== 'default') {
      const here = list.some((x) => x.id === want);
      if (!here && input) lost(`${input.label || 'The picked input'} is gone. Put it back, or choose another input.`);
      else if (here && gone) await openInput().catch((e) => ctx.status({ state: 'error', why: (e as Error).message }));
      return;
    }
    const now = list.find((x) => x.id === 'default')?.label ?? list[0]?.label;
    if (!now) { if (input) lost('No microphone is connected.'); return; }
    if (input && now === input.label) return;
    flushClip();
    const was = input?.label;
    await input?.close().catch(() => {});
    input = null;
    try {
      await openInput();
      ctx.status({ state: 'streaming', why: was ? `The route changed: ${was} → ${input!.label}.` : undefined, info: info() });
    } catch (e) { ctx.status({ state: 'error', why: (e as Error).message }); }
  };

  const conn: Connection = {
    async start() {
      if (running) return;
      running = true;
      ctx.status({ state: 'connecting', why: 'Opening the microphone.' });
      try { await openInput(); }
      catch (e) {
        running = false;
        const n = (e as Error).name;
        const why = n === 'NotAllowedError' ? 'The microphone permission was refused: allow it in the browser’s site settings.'
          : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'That microphone is not connected. Choose another input.'
          : (e as Error).message;
        ctx.status({ state: 'error', why });
        throw new Error(why);
      }
      unsub = t.onChange(() => { void changed(); });
    },
    async stop() {
      if (!running) return;
      flushClip();
      running = false;
      unsub?.(); unsub = null;
      const was = input; input = null;
      await was?.close();
      ctx.status({ state: 'idle', info: info() });
    },
    async act() { return { outcome: 'unsupported', why: 'A microphone has no actions.' }; },
    async close() { await conn.stop().catch(() => {}); },
  };
  return conn;
}
