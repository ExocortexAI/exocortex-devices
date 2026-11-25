// Pair any serial or Bluetooth driver of @exocortex/devices in Chrome and plot what it sends.
// Run: npx vite examples   (from the package folder), then open the printed address in Chrome on a computer.
// "Demo" runs a simulated Cyton over the in-memory transport, so the page works with no hardware.

import {
  builtinDrivers, requestGatt, requestSerial, MemoryByteTransport, encodeCytonPacket, openbciCyton,
  webBluetoothSupported, webSerialSupported,
} from '../src/index.ts';
import type { Connection, DeviceRecord, Driver, OpenContext, SampleChunk, Status } from '../src/index.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pick = $<HTMLSelectElement>('driver');
const pairBtn = $<HTMLButtonElement>('pair');
const demoBtn = $<HTMLButtonElement>('demo');
const stopBtn = $<HTMLButtonElement>('stop');
const statusEl = $<HTMLParagraphElement>('status');
const eventsEl = $<HTMLUListElement>('events');
const canvas = $<HTMLCanvasElement>('plot');

const live = builtinDrivers.filter((d) => d.transport === 'web-serial' || d.transport === 'web-bluetooth');
for (const d of live) pick.add(new Option(`${d.descriptor.name} (${d.transport === 'web-serial' ? 'USB' : 'Bluetooth'})`, d.id));
if (!webSerialSupported() && !webBluetoothSupported()) statusEl.textContent = 'This browser has no Web Serial or Web Bluetooth: use Chrome on a computer. The demo still works.';

// the last 5 s of every signal of the first samples channel
const WINDOW_S = 5;
let plotted: { names: string[]; rate: number; rows: number[][] } | null = null;
let conn: Connection | null = null;
let demoTimer = 0;

function onRecord(r: DeviceRecord) {
  if (r.shape === 'samples') {
    const c = r as SampleChunk;
    if (!plotted || plotted.names.join() !== c.names.join()) plotted = { names: c.names, rate: c.rateHz, rows: c.names.map(() => []) };
    const max = Math.round(WINDOW_S * c.rateHz);
    c.data.forEach((a, i) => { const row = plotted!.rows[i]; row.push(...a); if (row.length > max) row.splice(0, row.length - max); });
  } else if (r.shape === 'events') {
    const li = document.createElement('li');
    li.textContent = `${new Date(r.time.t0).toLocaleTimeString()}  ${r.label}${r.value !== undefined ? ` ${Math.round(r.value * 10) / 10} ${r.unit ?? ''}` : ''}`;
    eventsEl.prepend(li);
    while (eventsEl.children.length > 12) eventsEl.lastChild?.remove();
  }
}

function onStatus(s: Status) {
  statusEl.textContent = [s.state, s.why, s.battery !== undefined ? `battery ${Math.round(s.battery * 100)} %` : '', s.counts ? `${s.counts.samples} samples` : '']
    .filter(Boolean).join(' · ');
}

function draw() {
  const ctx = canvas.getContext('2d')!;
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  if (plotted) {
    const n = plotted.rows.length;
    const lane = h / n;
    ctx.font = `${11 * devicePixelRatio}px system-ui`;
    plotted.rows.forEach((row, i) => {
      if (!row.length) return;
      let lo = Infinity, hi = -Infinity;
      for (const v of row) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const span = hi - lo || 1;
      const xs = w / (WINDOW_S * plotted!.rate);
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--ink');
      ctx.lineWidth = devicePixelRatio;
      ctx.beginPath();
      row.forEach((v, k) => { const y = i * lane + lane * 0.9 - ((v - lo) / span) * lane * 0.8; if (k) ctx.lineTo(k * xs, y); else ctx.moveTo(0, y); });
      ctx.stroke();
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
      ctx.fillText(plotted!.names[i], 4, i * lane + 12 * devicePixelRatio);
    });
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function context(d: Driver): OpenContext {
  return {
    instance: `example-${d.id}`,
    host: 'chrome-desktop',
    enabled: new Set(d.descriptor.channels.filter((c) => c.defaultOn).map((c) => c.id)),
    config: Object.fromEntries((d.settings ?? []).map((s) => [s.id, s.default])),
    emit: onRecord,
    status: onStatus,
    now: () => Date.now(),
  };
}

async function stop() {
  clearInterval(demoTimer);
  const c = conn;
  conn = null;
  await c?.close();
  stopBtn.disabled = true;
}

pairBtn.onclick = async () => {
  await stop();
  const d = live.find((x) => x.id === pick.value)!;
  try {
    // the browser's chooser opens here: this must run inside the click
    const t = d.transport === 'web-serial' ? await requestSerial(d) : await requestGatt(d);
    conn = await (d as Driver<typeof t>).open(t, context(d));
    await conn.start();
    stopBtn.disabled = false;
  } catch (e) {
    statusEl.textContent = e instanceof Error ? e.message : String(e);
  }
};

demoBtn.onclick = async () => {
  await stop();
  // a simulated Cyton: alpha at 10 Hz on the occipital channels, slower waves elsewhere
  let sample = 0;
  const t = new MemoryByteTransport('Simulated Cyton', (bytes, port) => {
    const cmd = new TextDecoder().decode(bytes);
    if (cmd === 'v') port.push('OpenBCI V3 8-16 channel\nOn Board ADS1299 Device ID: 0x3E\nLIS3DH Device ID: 0x33\nFirmware: v3.1.2\n$$$');
    if (cmd === 'b') {
      demoTimer = window.setInterval(() => {
        const out: number[] = [];
        for (let k = 0; k < 10; k++, sample++) {
          const s = sample / 250;
          const counts = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => Math.round((c >= 6 ? 20 * Math.sin(2 * Math.PI * 10 * s) : 8 * Math.sin(2 * Math.PI * (2 + c) * s)) / 0.02235 + (Math.random() - 0.5) * 200));
          out.push(...encodeCytonPacket(sample, counts));
        }
        port.push(Uint8Array.from(out));
      }, 40);
    }
    if (cmd === 's') clearInterval(demoTimer);
  });
  conn = await openbciCyton.open(t, context(openbciCyton));
  await conn.start();
  stopBtn.disabled = false;
};

stopBtn.onclick = () => { void stop(); };
