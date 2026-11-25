// A MediaTransport over getUserMedia (any browser with a microphone, the desktop app's window). The page calls
// requestMedia() from a person's gesture the first time: the browser asks for the microphone, and after that the
// inputs have their names (AirPods Pro, USB Audio Device). An open input is a MediaStream through an AudioContext at
// the rate the driver asks for (the browser resamples), read by a small AudioWorklet in blocks.

import type { AudioInput, AudioInputInfo, MediaTransport } from '../contract.ts';

// the few members of the DOM this file uses, so the package needs no DOM library to type-check
interface TrackLike { label: string; readyState: string; stop(): void; getSettings(): { deviceId?: string }; addEventListener(e: 'ended', f: () => void): void }
interface StreamLike { getAudioTracks(): TrackLike[]; getTracks(): TrackLike[] }
interface DevicesLike {
  getUserMedia(c: unknown): Promise<StreamLike>;
  enumerateDevices(): Promise<{ kind: string; deviceId: string; label: string; groupId: string }[]>;
  addEventListener(e: 'devicechange', f: () => void): void;
  removeEventListener(e: 'devicechange', f: () => void): void;
}
interface PortLike { onmessage: ((e: { data: Float32Array }) => void) | null }
interface CtxLike {
  sampleRate: number;
  audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(s: StreamLike): { connect(n: unknown): void; disconnect(): void };
  close(): Promise<void>;
}
const g = globalThis as unknown as {
  navigator?: { mediaDevices?: DevicesLike };
  AudioContext?: new (o?: { sampleRate?: number }) => CtxLike;
  AudioWorkletNode?: new (c: CtxLike, name: string) => { port: PortLike; disconnect(): void };
  URL: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  Blob: new (parts: string[], o: { type: string }) => unknown;
};

export const webMediaSupported = (): boolean => !!g.navigator?.mediaDevices?.getUserMedia && !!g.AudioContext;

/** ask for the microphone (on a person's click); resolves when it is allowed, throws with the browser's error if not */
export async function requestMedia(): Promise<MediaTransport> {
  const md = g.navigator?.mediaDevices;
  if (!md || !g.AudioContext) throw new Error('This browser has no microphone access.');
  const s = await md.getUserMedia({ audio: true });
  for (const t of s.getTracks()) t.stop();
  return mediaTransport();
}

// one block = 1,600 samples at 16 kHz (100 ms): the worklet gathers the 128-sample render quanta
const WORKLET = `class B extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1600);this.n=0}
process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===this.b.length){this.port.postMessage(this.b);this.b=new Float32Array(1600);this.n=0}}}return true}}
registerProcessor('exo-audio-blocks',B)`;

/** the system's audio inputs as a MediaTransport (permission asked first: requestMedia) */
export function mediaTransport(): MediaTransport {
  const md = g.navigator?.mediaDevices;
  if (!md) throw new Error('This browser has no microphone access.');
  return {
    kind: 'media',
    label: 'This computer’s audio inputs',
    async inputs(): Promise<AudioInputInfo[]> {
      return (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput')
        .map((d) => ({ id: d.deviceId, label: d.label.replace(/^Default - /, '') || (d.deviceId === 'default' ? 'The system’s microphone' : 'A microphone'), group: d.groupId }));
    },
    async open(o): Promise<AudioInput> {
      const id = o.input && o.input !== 'default' ? o.input : undefined;
      const stream = await md.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const track = stream.getAudioTracks()[0];
      const ac = new g.AudioContext!({ sampleRate: o.sampleRate });
      const url = g.URL.createObjectURL(new g.Blob([WORKLET], { type: 'text/javascript' }));
      try { await ac.audioWorklet.addModule(url); } finally { g.URL.revokeObjectURL(url); }
      const src = ac.createMediaStreamSource(stream);
      const node = new g.AudioWorkletNode!(ac, 'exo-audio-blocks');
      src.connect(node);
      const ended: (() => void)[] = [];
      let closed = false;
      track?.addEventListener('ended', () => { if (!closed) for (const f of ended) f(); });
      return {
        id: track?.getSettings().deviceId ?? id ?? 'default',
        label: track?.label.replace(/^Default - /, '') || 'Microphone',
        sampleRate: ac.sampleRate,
        read(onBlock) { node.port.onmessage = (e) => onBlock(e.data); },
        onEnded(f) { ended.push(f); },
        async close() {
          if (closed) return;
          closed = true;
          node.port.onmessage = null;
          try { src.disconnect(); node.disconnect(); } catch { /* gone */ }
          for (const t of stream.getTracks()) t.stop();
          await ac.close().catch(() => {});
        },
      };
    },
    onChange(f) { md.addEventListener('devicechange', f); return () => md.removeEventListener('devicechange', f); },
  };
}
