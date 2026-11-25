// CSV files: a header row, a time column, and numeric columns. The generic import for any logger, and the engine of
// a custom integration's `csv-file` driver (../manifest.ts).
//
// Rows whose times are evenly spaced (within 5 %) become SampleChunks at that rate; the rest become one event per
// value. Times: ISO 8601, Unix milliseconds or Unix seconds ('auto' tells them apart by size).

import type { DeviceRecord, Descriptor, Provenance, Timing } from '../contract.ts';
import { chunk, event, lines, textChunks } from '../util.ts';
import { fileDriver, fileRoute, importAction } from '../file-driver.ts';

export type TimeFormat = 'iso' | 'unix-ms' | 'unix-s' | 'auto';

/** the fields of one CSV line (RFC 4180 quoting; a quoted field does not span lines here) */
export function csvFields(line: string, sep = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"' && cur === '') q = true;
    else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseTime(v: string, f: TimeFormat): number {
  const s = v.trim();
  if (f === 'unix-ms') return Number(s);
  if (f === 'unix-s') return Number(s) * 1000;
  if (f === 'iso') return Date.parse(s);
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Math.abs(n) > 1e11 ? n : n * 1000;   // after 1973 in ms, or a time in seconds
  }
  return Date.parse(s);
}

export interface CsvColumn { channel: string; column: string | number; scale?: number; offset?: number; name?: string }

export interface CsvPlan {
  timeColumn: string | number;
  timeFormat: TimeFormat;
  columns: CsvColumn[] | 'numeric';
  separator?: string;
  /** units per channel, for the records */
  units?: Record<string, string>;
}

/** records of a CSV text stream, by the plan */
export async function* readCsv(
  text: AsyncIterable<string>, plan: CsvPlan, prov: (row: number) => Provenance, now: () => number,
  defaultChannel = 'values',
): AsyncGenerator<DeviceRecord> {
  let header: string[] | null = null;
  let tIdx = -1;
  let cols: { channel: string; idx: number; scale: number; offset: number; name: string }[] = [];
  let block: { t: number; v: number[]; row: number }[] = [];
  let sep = plan.separator;
  let row = 0;
  let firstData = true;
  const timing = (t0: number): Timing => ({ t0, receivedAt: now(), clock: 'device' });

  function* flush(): Generator<DeviceRecord> {
    if (!block.length) return;
    const dt = block.length >= 3 ? block[1].t - block[0].t : 0;
    if (dt > 0) {
      const byChannel = new Map<string, number[]>();
      cols.forEach((c, k) => { const a = byChannel.get(c.channel) ?? []; a.push(k); byChannel.set(c.channel, a); });
      for (const [channel, ks] of byChannel) {
        yield chunk(channel, prov(block[0].row), timing(block[0].t), 1000 / dt, ks.map((k) => cols[k].name), plan.units?.[channel] ?? '',
          ks.map((k) => Float32Array.from(block, (r) => r.v[k])));
      }
    } else {
      for (const r of block) {
        for (let k = 0; k < cols.length; k++) {
          if (!Number.isFinite(r.v[k])) continue;
          yield event(cols[k].channel, prov(r.row), timing(r.t), cols[k].name, r.v[k], plan.units?.[cols[k].channel]);
        }
      }
    }
    block = [];
  }

  for await (const line of lines(text)) {
    row++;
    if (!line.trim()) continue;
    if (!header) {
      if (!sep) sep = [',', ';', '\t'].sort((a, b) => line.split(b).length - line.split(a).length)[0];
      header = csvFields(line, sep);
      const find = (c: string | number) => (typeof c === 'number' ? c : header!.findIndex((h) => h.toLowerCase() === c.toLowerCase()));
      tIdx = plan.timeColumn === '' ? header.findIndex((h) => /^(time|timestamp|date|datetime|t|ts)$/i.test(h)) : find(plan.timeColumn);
      if (tIdx < 0) throw new Error(`No time column "${plan.timeColumn || 'time'}" in the header (${header.join(', ')}).`);
      if (plan.columns === 'numeric') {
        cols = header.map((h, i) => ({ channel: defaultChannel, idx: i, scale: 1, offset: 0, name: h })).filter((c) => c.idx !== tIdx);
      } else {
        cols = plan.columns.map((c) => {
          const idx = find(c.column);
          if (idx < 0 || idx >= header!.length) throw new Error(`No column "${c.column}" in the header.`);
          return { channel: c.channel, idx, scale: c.scale ?? 1, offset: c.offset ?? 0, name: c.name ?? header![idx] };
        });
      }
      continue;
    }
    const f = csvFields(line, sep);
    const t = parseTime(f[tIdx] ?? '', plan.timeFormat);
    if (!Number.isFinite(t)) continue;
    const v = cols.map((c) => { const x = f[c.idx]; return x === undefined || x === '' ? NaN : Number(x) * c.scale + c.offset; });
    if (plan.columns === 'numeric' && firstData) {
      // keep only the columns that hold numbers in the first data row
      const keep = cols.map((_, k) => Number.isFinite(v[k]));
      cols = cols.filter((_, k) => keep[k]);
      v.splice(0, v.length, ...v.filter((_, k) => keep[k]));
    }
    firstData = false;
    if (block.length >= 2) {
      const dt0 = block[1].t - block[0].t;
      const dt = t - block[block.length - 1].t;
      if (dt0 <= 0 || Math.abs(dt - dt0) > 0.05 * dt0) {
        // the spacing changed: the rows before it are one block (or events), this row starts the next
        if (block.length < 3) { const keep = block.slice(1); block = block.slice(0, 1); yield* flush(); block = keep; }
        else yield* flush();
      }
    }
    block.push({ t, v, row });
    if (block.length >= 1000) yield* flush();
  }
  yield* flush();
}

export const csvDescriptor: Descriptor = {
  id: 'file-csv',
  name: 'CSV file',
  vendor: 'Any',
  family: 'files',
  models: ['a header row, a time column and numeric columns'],
  placement: 'file',
  about: 'Import numbers over time from any logger or spreadsheet.',
  channels: [{ id: 'values', kind: 'other', label: 'The file\'s columns', shape: 'samples', defaultOn: true }],
  actions: importAction,
  routes: [fileRoute('file-csv', 'loopback', 'test/files.test.ts: a regular and an irregular CSV read through the driver')],
  priority: 'P0',
};

export const csv = fileDriver({
  id: 'file-csv',
  descriptor: csvDescriptor,
  files: { extensions: ['.csv', '.tsv', '.txt'], mime: ['text/csv'] },
  settings: [
    { id: 'timeColumn', label: 'Time column', type: 'string', default: '', help: 'Leave empty to find "time", "timestamp" or "date".' },
    { id: 'timeFormat', label: 'Time format', type: 'select', default: 'auto', options: ['auto', 'iso', 'unix-ms', 'unix-s'].map((v) => ({ value: v, label: v })) },
  ],
  async run({ file, ctx, emit, prov, stopped }) {
    const plan: CsvPlan = {
      timeColumn: String(ctx.config.timeColumn ?? ''),
      timeFormat: (ctx.config.timeFormat as TimeFormat) ?? 'auto',
      columns: 'numeric',
    };
    for await (const r of readCsv(textChunks(file.chunks()), plan, (row) => prov({ providerRecordId: `${file.name}:${row}` }), ctx.now)) {
      if (stopped()) return;
      emit(r);
    }
  },
});
