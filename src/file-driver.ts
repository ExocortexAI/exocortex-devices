// What every file driver shares: start() reads the file once and emits its records; stop() ends the read early.
// A file is history, not a recording: the host imports it, and nothing leaves the computer on this route.

import type { Connection, DeviceRecord, Driver, FileTransport, OpenContext, Provenance, Route } from './contract.ts';
import { Counter, emitter, prov } from './util.ts';

export interface FileRun {
  file: FileTransport;
  ctx: OpenContext;
  emit: (r: DeviceRecord) => void;
  /** provenance for this file's records */
  prov: (extra?: Partial<Provenance>) => Provenance;
  /** true once stop() was called: a parser checks it between records */
  stopped: () => boolean;
  /** what the status line shows (the file's own device, model, the time span) */
  info: Record<string, string>;
}

export function fileRoute(driver: string, verified: Route['verified'], evidence: string): Route {
  return {
    transport: 'file', hosts: ['any-browser', 'chrome-desktop', 'desktop-app', 'ios', 'android'], driver,
    freshness: 'when you import a file', dataLeaves: 'never', verified, evidence,
  };
}

export function fileDriver(d: Omit<Driver<FileTransport>, 'open' | 'transport'> & { run(r: FileRun): Promise<void> }): Driver<FileTransport> {
  const { run, ...rest } = d;
  return {
    ...rest,
    transport: 'file',
    async open(file, ctx): Promise<Connection> {
      const counter = new Counter();
      const emit = emitter(ctx, counter);
      let stopped = false;
      let running: Promise<void> | null = null;
      const info: Record<string, string> = { file: file.name };
      const start = async () => {
        if (running) return running;
        stopped = false;
        ctx.status(counter.status('streaming', { why: `Reading ${file.name}.`, info }));
        running = run({
          file, ctx, emit, info, stopped: () => stopped,
          prov: (extra) => prov(ctx, d.descriptor.id, 'file', extra),
        }).then(
          () => { ctx.status(counter.status('idle', { why: stopped ? 'Stopped before the end of the file.' : undefined, info })); },
          (e) => { ctx.status(counter.status('error', { why: `${file.name} could not be read: ${e instanceof Error ? e.message : String(e)}`, info })); throw e; },
        ).finally(() => { running = null; });
        return running;
      };
      return {
        start,
        async stop() { stopped = true; await running?.catch(() => {}); },
        async act(a) {
          if (a === 'import' || a === 'start') { await start(); return { outcome: 'done' }; }
          if (a === 'stop') { stopped = true; return { outcome: 'done' }; }
          return { outcome: 'unsupported' };
        },
        async close() { stopped = true; await running?.catch(() => {}); ctx.status(counter.status('closed', { info })); },
      };
    },
  };
}

export const importAction = [{ id: 'import', label: 'Import' }, { id: 'stop', label: 'Stop', safing: true }];
