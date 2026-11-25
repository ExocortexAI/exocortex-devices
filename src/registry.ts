// The drivers this package ships, and the lookup a host uses to open a paired device. The Exocortex cap's driver is
// registered by the app that implements it (`register`).

import type { Driver, TransportKind } from './contract.ts';
import { openbciCyton } from './drivers/openbci-cyton.ts';
import { openbciCytonDaisy } from './drivers/openbci-cyton-daisy.ts';
import { openbciGanglion } from './drivers/openbci-ganglion.ts';
import { bleHeartRate } from './drivers/ble-heart-rate.ts';
import { polarH10 } from './drivers/polar-h10.ts';
import { edf } from './drivers/edf.ts';
import { fit } from './drivers/fit.ts';
import { gpx } from './drivers/gpx.ts';
import { appleHealthExport } from './drivers/apple-health-export.ts';
import { csv } from './drivers/csv.ts';
import { appleHealthDriver } from './drivers/apple-health.ts';
import { healthConnectDriver } from './drivers/health-connect.ts';
import { mediaAudioHeadset, mediaAudioClipMic } from './drivers/media-audio.ts';

// each driver is typed by its own transport; the registry holds them as the contract's general Driver
export const builtinDrivers: readonly Driver[] = [
  openbciCyton, openbciCytonDaisy, openbciGanglion, bleHeartRate, polarH10, appleHealthDriver, healthConnectDriver,
  mediaAudioHeadset, mediaAudioClipMic, edf, fit, gpx, appleHealthExport, csv,
] as unknown as Driver[];

const extra: Driver[] = [];

/** add a driver this package does not ship (the cap's, a manifest's) */
export function register(d: Driver): void {
  const i = extra.findIndex((x) => x.id === d.id && x.transport === d.transport);
  if (i >= 0) extra[i] = d;
  else extra.push(d);
}

/** the driver for a descriptor over a transport, or null. Registered drivers come before built-in ones. */
export function driverFor(descriptorId: string, transport: TransportKind): Driver | null {
  return [...extra, ...builtinDrivers].find((d) => d.descriptor.id === descriptorId && d.transport === transport) ?? null;
}
