// A ByteTransport over the Web Serial API (Chromium on a computer). The page must call requestSerial() from a
// person's gesture (a click): the browser then shows its own port chooser, filtered to the driver's USB ids.

import type { ByteTransport, Driver } from '../contract.ts';

// The Web Serial types are not in TypeScript's DOM library: the few members this file uses.
export interface SerialPortLike {
  open(o: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}
export interface SerialLike {
  requestPort(o?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

function serialApi(): SerialLike | null {
  const n = (globalThis as { navigator?: { serial?: SerialLike } }).navigator;
  return n?.serial ?? null;
}

export const webSerialSupported = (): boolean => serialApi() !== null;

const hex4 = (n: number | undefined) => (n ?? 0).toString(16).padStart(4, '0');

/** wraps a port the browser handed us */
export function serialTransport(port: SerialPortLike): ByteTransport {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let closing = false;
  const info = port.getInfo?.() ?? {};
  return {
    kind: 'web-serial',
    label: info.usbVendorId !== undefined ? `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}` : 'Serial port',
    async open({ baudRate }) {
      closing = false;
      await port.open({ baudRate, bufferSize: 1 << 16 });
    },
    async write(bytes) {
      const w = port.writable?.getWriter();
      if (!w) throw new Error('The port is not open.');
      try { await w.write(bytes); } finally { w.releaseLock(); }
    },
    async read(onBytes) {
      if (!port.readable) throw new Error('The port is not open.');
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) onBytes(value);
        }
      } catch (e) {
        if (!closing) throw e;
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
        reader = null;
      }
    },
    async close() {
      closing = true;
      try { await reader?.cancel(); } catch { /* the port is gone */ }
      try { await port.close(); } catch { /* already closed */ }
    },
  };
}

/** asks the person to choose a port for this driver (call from a click). Throws when Web Serial is missing. */
export async function requestSerial(driver: Driver): Promise<ByteTransport> {
  const serial = serialApi();
  if (!serial) throw new Error('This browser cannot reach USB serial devices. Use Chrome or Edge on a computer.');
  const filters = driver.serial?.filters ?? [];
  const port = await serial.requestPort(filters.length ? { filters } : {});
  return serialTransport(port);
}
