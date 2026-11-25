// Health Connect on Android: what Samsung Health (Galaxy Watch and Ring), Fitbit and Pixel Watch, Oura, RingConn,
// Mi Fitness and the person's other apps wrote to it. Read only, through the app's own native plugin (apps/mobile,
// "Health": readRecords for the first import, getChanges with a changes token after it). The records and the anchors
// are ../health.ts's. A history import: nothing is recorded here, and nothing leaves the phone but to the person's own
// node.
import type { Descriptor, Driver, HealthStoreTransport } from '../contract.ts';
import { HEALTH_SETTINGS, healthChannels, openHealthStore } from '../health.ts';

export const healthConnectDescriptor: Descriptor = {
  id: 'health-connect',
  name: 'Health Connect',
  vendor: 'Google',
  family: 'health-store',
  placement: 'phone',
  about: 'Heart rate, HRV, sleep stages, workouts, blood oxygen, temperature and activity from the watches, rings and apps that write to Health Connect.',
  channels: healthChannels('health-connect'),
  actions: [
    { id: 'sync', label: 'Sync now' },
    { id: 'authorize', label: 'Ask for access again' },
  ],
  routes: [{
    transport: 'health-connect', hosts: ['android'], driver: 'health-connect',
    needs: ['the Exocortex app on Android 9 or later', 'Health Connect (part of Android 14 and later; an app from Play before it)', 'read access, given in Health Connect'],
    freshness: 'when the app is open',
    dataLeaves: 'never',
    // the Kotlin plugin compiles in the app's Gradle build; it has not run on a phone with Health Connect yet
    verified: 'spec',
    evidence: 'app/packages/devices/test/health.test.ts (golden, fake Health Connect store); apps/mobile/android HealthPlugin.kt compiles in assembleDebug',
  }],
  priority: 'P0',
  links: [{ label: 'Health Connect', url: 'https://developer.android.com/health-and-fitness/guides/health-connect' }],
};

export const healthConnectDriver: Driver<HealthStoreTransport> = {
  id: 'health-connect',
  descriptor: healthConnectDescriptor,
  transport: 'health-connect',
  settings: HEALTH_SETTINGS,
  async open(t, ctx) { return openHealthStore('health-connect', healthConnectDescriptor, t, ctx); },
};
