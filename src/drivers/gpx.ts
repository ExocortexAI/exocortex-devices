// GPX files (GPS Exchange Format 1.1): routes from Strava, Komoot, Polar, Suunto, COROS and GPS loggers.
// Each <trkpt lat lon> with its <time> becomes a location event (elevation in fields); the Garmin
// TrackPointExtension's <gpxtpx:hr> and <gpxtpx:cad> become heart-rate and cadence events. A <trk> with a first and a
// last time becomes an interval (its <type> or "track" as the label). Points without a time are skipped: an event
// needs a time.

import type { Descriptor } from '../contract.ts';
import { event, interval, textChunks } from '../util.ts';
import { xmlTokens } from '../xml.ts';
import { fileDriver, fileRoute, importAction } from '../file-driver.ts';

export interface GpxPoint { lat: number; lon: number; time: number; ele?: number; hr?: number; cad?: number }

/** the points of a GPX file, in order, and each track's span */
export async function* readGpx(text: AsyncIterable<string>): AsyncGenerator<{ point: GpxPoint } | { track: { name?: string; type?: string; start: number; end: number; points: number } }> {
  let cur: Partial<GpxPoint> | null = null;
  let field = '';
  let track: { name?: string; type?: string; start?: number; end?: number; points: number } | null = null;
  let inPoint = false;
  for await (const t of xmlTokens(text)) {
    if (t.type === 'open') {
      const n = t.name.replace(/^.*:/, '');
      if (n === 'trk') track = { points: 0 };
      if (n === 'trkpt' || n === 'rtept' || n === 'wpt') {
        cur = { lat: Number(t.attrs.lat), lon: Number(t.attrs.lon) };
        inPoint = true;
        if (t.selfClosing) { cur = null; inPoint = false; }
      }
      field = t.selfClosing ? '' : n;
    } else if (t.type === 'text') {
      const v = t.text.trim();
      if (inPoint && cur) {
        if (field === 'time') cur.time = Date.parse(v);
        else if (field === 'ele') cur.ele = Number(v);
        else if (field === 'hr') cur.hr = Number(v);
        else if (field === 'cad') cur.cad = Number(v);
      } else if (track && !inPoint) {
        if (field === 'name' && track.name === undefined) track.name = v;
        if (field === 'type') track.type = v;
      }
    } else {
      const n = t.name.replace(/^.*:/, '');
      field = '';
      if ((n === 'trkpt' || n === 'rtept' || n === 'wpt') && cur) {
        inPoint = false;
        if (Number.isFinite(cur.lat) && Number.isFinite(cur.lon) && cur.time !== undefined && Number.isFinite(cur.time)) {
          const point = cur as GpxPoint;
          if (track && n === 'trkpt') {
            track.points++;
            track.start = Math.min(track.start ?? point.time, point.time);
            track.end = Math.max(track.end ?? point.time, point.time);
          }
          yield { point };
        }
        cur = null;
      }
      if (n === 'trk' && track) {
        if (track.start !== undefined && track.end !== undefined) yield { track: { name: track.name, type: track.type, start: track.start, end: track.end, points: track.points } };
        track = null;
      }
    }
  }
}

export const gpxDescriptor: Descriptor = {
  id: 'file-gpx',
  name: 'GPX route',
  vendor: 'Any',
  family: 'files',
  models: ['GPX 1.0', 'GPX 1.1', 'Garmin TrackPointExtension'],
  placement: 'file',
  about: 'Import where you went: track points with time, elevation, and heart rate when the file has it.',
  channels: [
    { id: 'location', kind: 'location', label: 'Route', shape: 'events', defaultOn: true, sensitive: 'location' },
    { id: 'track', kind: 'activity', label: 'Tracks', shape: 'intervals', defaultOn: true },
    { id: 'hr', kind: 'hr', label: 'Heart rate', shape: 'events', unit: 'bpm', defaultOn: true, sensitive: 'health' },
    { id: 'cadence', kind: 'cadence', label: 'Cadence', shape: 'events', unit: 'rpm', defaultOn: false },
  ],
  actions: importAction,
  routes: [fileRoute('file-gpx', 'loopback', 'test/files.test.ts: a GPX 1.1 track with the Garmin extension, read through the driver')],
  priority: 'P0',
  links: [{ label: 'GPX 1.1 schema', url: 'https://www.topografix.com/GPX/1/1/' }],
};

export const gpx = fileDriver({
  id: 'file-gpx',
  descriptor: gpxDescriptor,
  files: { extensions: ['.gpx'], mime: ['application/gpx+xml'] },
  async run({ file, ctx, emit, prov, stopped }) {
    const time = (t0: number) => ({ t0, receivedAt: ctx.now(), clock: 'device' as const, uncertaintyMs: 1000 });
    for await (const x of readGpx(textChunks(file.chunks()))) {
      if (stopped()) return;
      if ('point' in x) {
        const pt = x.point;
        const id = `gpx:${pt.time}:${pt.lat.toFixed(6)},${pt.lon.toFixed(6)}`;
        emit(event('location', prov({ providerRecordId: id }), time(pt.time), 'location', undefined, undefined,
          { lat: pt.lat, lon: pt.lon, ...(pt.ele !== undefined && Number.isFinite(pt.ele) ? { altitudeM: pt.ele } : {}) }));
        if (pt.hr !== undefined && Number.isFinite(pt.hr)) emit(event('hr', prov({ providerRecordId: `${id}:hr` }), time(pt.time), 'heart rate', pt.hr, 'bpm'));
        if (pt.cad !== undefined && Number.isFinite(pt.cad)) emit(event('cadence', prov({ providerRecordId: `${id}:cad` }), time(pt.time), 'cadence', pt.cad, 'rpm'));
      } else {
        const tr = x.track;
        emit(interval('track', prov({ providerRecordId: `gpx:${tr.start}:${tr.end}:track` }), time(tr.start), tr.end, tr.type ?? 'track',
          { fields: { name: tr.name, points: tr.points } }));
      }
    }
  },
});
