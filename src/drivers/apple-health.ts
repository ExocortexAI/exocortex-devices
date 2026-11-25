// Apple Health (HealthKit) on iOS: what the Apple Watch, the iPhone and the person's other apps (Oura, RingConn, Polar
// Flow, Mi Fitness …) wrote to Health. Read only, through the app's own native plugin (apps/mobile, "Health":
// HKAnchoredObjectQuery per type, HKElectrocardiogramQuery for the voltages). The records and the anchors are
// ../health.ts's. A history import: nothing is recorded here, and nothing leaves the phone but to the person's own node.
import type { Descriptor, Driver, HealthStoreTransport } from '../contract.ts';
import { HEALTH_SETTINGS, healthChannels, openHealthStore } from '../health.ts';

export const appleHealthDescriptor: Descriptor = {
  id: 'apple-health',
  name: 'Apple Health',
  vendor: 'Apple',
  family: 'health-store',
  placement: 'phone',
  about: 'Heart rate, HRV, sleep stages, workouts, blood oxygen, temperature, activity and saved ECGs from Apple Watch and the apps that write to Health.',
  channels: healthChannels('healthkit'),
  actions: [
    { id: 'sync', label: 'Sync now' },
    { id: 'authorize', label: 'Ask for access again' },
  ],
  routes: [{
    transport: 'healthkit', hosts: ['ios'], driver: 'apple-health',
    needs: ['the Exocortex app on an iPhone', 'read access to Health, given in the system sheet'],
    freshness: 'when the app is open',
    dataLeaves: 'never',
    // the Swift plugin has not been compiled (no Mac here); the record mapping is tested with a fake store
    verified: 'none',
    evidence: 'app/packages/devices/test/health.test.ts (golden, fake HealthKit store); apps/mobile/ios/App/App/HealthPlugin.swift is not built yet',
  }],
  priority: 'P0',
  links: [{ label: 'HealthKit', url: 'https://developer.apple.com/documentation/healthkit' }],
};

export const appleHealthDriver: Driver<HealthStoreTransport> = {
  id: 'apple-health',
  descriptor: appleHealthDescriptor,
  transport: 'healthkit',
  settings: HEALTH_SETTINGS,
  async open(t, ctx) { return openHealthStore('healthkit', appleHealthDescriptor, t, ctx); },
};
