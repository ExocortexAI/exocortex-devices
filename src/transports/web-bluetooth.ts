// A GattTransport over the Web Bluetooth API (Chromium on a computer and on Android). The page must call
// requestGatt() from a person's gesture: the browser shows its own chooser, filtered to the driver's services.

import type { Driver, GattTransport } from '../contract.ts';
import { uuid } from '../util.ts';

// The Web Bluetooth types are not in TypeScript's DOM library: the few members this file uses.
interface CharacteristicLike extends EventTarget {
  value: DataView | null;
  startNotifications(): Promise<CharacteristicLike>;
  stopNotifications(): Promise<CharacteristicLike>;
  writeValueWithResponse(v: BufferSource): Promise<void>;
  writeValueWithoutResponse(v: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
}
interface ServiceLike { getCharacteristic(c: string): Promise<CharacteristicLike> }
interface ServerLike {
  connected: boolean;
  connect(): Promise<ServerLike>;
  disconnect(): void;
  getPrimaryService(s: string): Promise<ServiceLike>;
}
export interface BluetoothDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: ServerLike;
}
interface BluetoothLike {
  requestDevice(o: {
    filters?: { services?: string[]; namePrefix?: string; name?: string }[];
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }): Promise<BluetoothDeviceLike>;
}

function bluetoothApi(): BluetoothLike | null {
  const n = (globalThis as { navigator?: { bluetooth?: BluetoothLike } }).navigator;
  return n?.bluetooth ?? null;
}

export const webBluetoothSupported = (): boolean => bluetoothApi() !== null;

/** wraps a device the browser handed us; connects its GATT server */
export async function gattTransport(device: BluetoothDeviceLike): Promise<GattTransport> {
  if (!device.gatt) throw new Error('This device has no GATT server.');
  const server = await device.gatt.connect();
  const chars = new Map<string, Promise<CharacteristicLike>>();
  const char = (s: string, c: string) => {
    const key = `${uuid(s)}/${uuid(c)}`;
    let p = chars.get(key);
    if (!p) {
      p = server.getPrimaryService(uuid(s)).then((svc) => svc.getCharacteristic(uuid(c)));
      chars.set(key, p);
    }
    return p;
  };
  return {
    kind: 'web-bluetooth',
    label: device.name ?? 'Bluetooth device',
    id: device.id,
    async subscribe(s, c, onValue) {
      const ch = await char(s, c);
      const listener = () => { if (ch.value) onValue(ch.value); };
      ch.addEventListener('characteristicvaluechanged', listener);
      await ch.startNotifications();
      return async () => {
        ch.removeEventListener('characteristicvaluechanged', listener);
        try { await ch.stopNotifications(); } catch { /* disconnected */ }
      };
    },
    async write(s, c, bytes, withResponse = true) {
      const ch = await char(s, c);
      const copy = new Uint8Array(bytes);
      if (withResponse) await ch.writeValueWithResponse(copy);
      else await ch.writeValueWithoutResponse(copy);
    },
    async read(s, c) {
      return (await char(s, c)).readValue();
    },
    onDisconnect(f) {
      device.addEventListener('gattserverdisconnected', () => f());
    },
    async close() {
      if (server.connected) server.disconnect();
    },
  };
}

/** asks the person to choose a device for this driver (call from a click) and connects it */
export async function requestGatt(driver: Driver): Promise<GattTransport> {
  const bt = bluetoothApi();
  if (!bt) throw new Error('This browser cannot reach Bluetooth devices. Use Chrome on a computer or on Android.');
  const b = driver.bluetooth;
  if (!b) throw new Error(`${driver.descriptor.name} does not connect over Bluetooth.`);
  const filters = b.filters.map((f) => ({ ...f, services: f.services?.map(uuid) }));
  const device = await bt.requestDevice({ filters, optionalServices: (b.optionalServices ?? []).map(uuid) });
  return gattTransport(device);
}
