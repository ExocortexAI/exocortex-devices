// Simulated devices: each speaks its device's real protocol over a memory transport, so the real driver opens it as
// it opens the device (README § Simulators). A simulator is not hardware: no route's `verified` is raised by it.
//
//   const sim = simulatorFor('openbci-cyton-daisy', { seed: 7, lossRate: 0.01 });
//   const conn = await openbciCytonDaisy.open(sim.transport, ctx);   // ... later: await conn.close(); sim.stop();

import type { HealthStoreTransport, Transport } from '../contract.ts';
import type { MemoryByteTransport, MemoryGattTransport } from '../transports/memory.ts';
import { SIM_SETTINGS, type SimOptions, type Simulator } from './clock.ts';
import { simulateCyton } from './openbci-cyton.ts';
import { simulateGanglion } from './openbci-ganglion.ts';
import { simulateHeartRate, simulatePolarH10 } from './heart.ts';
import { simulateHealthStore, type HealthSimOptions } from './health-store.ts';

export { SIM_SETTINGS, simOptions, Rng, SimClock } from './clock.ts';
export type { SimOptions, Simulator } from './clock.ts';
export { EegModel, HeartModel, ecgAt, dayRate, RAIL_UV } from './signals.ts';
export { simulateCyton, cytonBanner } from './openbci-cyton.ts';
export { simulateGanglion } from './openbci-ganglion.ts';
export { simulateHeartRate, simulatePolarH10 } from './heart.ts';
export { simulateHealthStore } from './health-store.ts';
export type { HealthSimOptions } from './health-store.ts';

const MAKERS: Record<string, (o: HealthSimOptions) => Simulator<MemoryByteTransport | MemoryGattTransport | HealthStoreTransport>> = {
  'openbci-cyton': (o) => simulateCyton(o),
  'openbci-cyton-daisy': (o) => simulateCyton({ ...o, daisy: true }),
  'openbci-ganglion': (o) => simulateGanglion(o),
  'ble-heart-rate': (o) => simulateHeartRate(o),
  'polar-h10': (o) => simulatePolarH10(o),
  'apple-health': (o) => simulateHealthStore('healthkit', o),
  'health-connect': (o) => simulateHealthStore('health-connect', o),
};

/** the drivers that have a simulator */
export const SIMULATED_DRIVERS: readonly string[] = Object.keys(MAKERS);
export const hasSimulator = (driverId: string): boolean => Object.hasOwn(MAKERS, driverId);

/** the options a driver's simulator reads (a health store has no packets and no electrodes; a strap no electrodes) */
export function simulatorSettings(driverId: string) {
  const store = driverId === 'apple-health' || driverId === 'health-connect';
  const strap = driverId === 'ble-heart-rate' || driverId === 'polar-h10';
  const electrodes = ['stuckChannel', 'badChannel', 'badKind'];
  return SIM_SETTINGS.filter((s) => !(store && (s.id === 'lossRate' || electrodes.includes(s.id))) && !(strap && electrodes.includes(s.id)));
}

/** a simulated device for a driver: its transport (hand it to the driver's open), and stop() */
export function simulatorFor(driverId: string, options: SimOptions = {}): Simulator<Transport> {
  const make = hasSimulator(driverId) ? MAKERS[driverId] : undefined;
  if (!make) throw new Error(`There is no simulator for ${driverId}.`);
  return make(options) as Simulator<Transport>;
}
