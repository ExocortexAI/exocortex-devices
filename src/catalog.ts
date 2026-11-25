// Every family of Exocortex's wearables research (November 2026) as a
// Descriptor, so a person can search a model and learn what works on the computer or phone in front of them. A route
// with a driver is built; a route without one is a candidate, with the reason it is not supported yet. Nothing here
// claims more than its route's `verified` says: a family reached only through a hub (Apple Health, Health Connect)
// or a file is said so, and a vendor's cloud that needs an agreement is "not supported yet".

import type { Channel, Descriptor, Host, Route, TransportKind, Verified } from './contract.ts';
import { cytonDescriptor } from './drivers/openbci-cyton.ts';
import { ganglionDescriptor } from './drivers/openbci-ganglion.ts';
import { bleHeartRateDescriptor } from './drivers/ble-heart-rate.ts';
import { polarH10Descriptor } from './drivers/polar-h10.ts';
import { edfDescriptor } from './drivers/edf.ts';
import { fitDescriptor } from './drivers/fit.ts';
import { gpxDescriptor } from './drivers/gpx.ts';
import { appleHealthExportDescriptor } from './drivers/apple-health-export.ts';
import { csvDescriptor } from './drivers/csv.ts';
import { exocortexCapDescriptor } from './drivers/exocortex-cap.ts';
import { appleHealthDescriptor } from './drivers/apple-health.ts';
import { healthConnectDescriptor } from './drivers/health-connect.ts';
import { headsetDescriptor, clipMicDescriptor } from './drivers/media-audio.ts';

// ---------------------------------------------------------------------------------------------------------------
// routes a catalog entry reuses
// ---------------------------------------------------------------------------------------------------------------

const PHONES: Host[] = ['ios', 'android'];
const BROWSERS: Host[] = ['any-browser', 'chrome-desktop', 'desktop-app', 'ios', 'android'];

/** Apple Health on the iPhone app: the vendor's app writes to it, the apple-health driver reads it */
const viaHealthKit = (freshness = 'after the vendor app syncs to Apple Health'): Route => ({
  transport: 'healthkit', hosts: ['ios'], driver: 'apple-health', needs: ['the Exocortex iPhone app', 'the vendor app set to share with Apple Health'],
  freshness, dataLeaves: 'never', verified: appleHealthDescriptor.routes[0].verified,
});
/** Health Connect on Android: the vendor's app writes to it, the health-connect driver reads it */
const viaHealthConnect = (freshness = 'after the vendor app syncs to Health Connect'): Route => ({
  transport: 'health-connect', hosts: ['android'], driver: 'health-connect', needs: ['the Exocortex Android app', 'the vendor app set to share with Health Connect'],
  freshness, dataLeaves: 'never', verified: healthConnectDescriptor.routes[0].verified,
});
const viaFile = (driver: string, verified: Verified, needs: string[]): Route => ({
  transport: 'file', hosts: BROWSERS, driver, needs, freshness: 'when you import a file', dataLeaves: 'never', verified,
});
const viaBroadcastHr = (needs: string[]): Route => ({
  transport: 'web-bluetooth', hosts: ['chrome-desktop', 'android'], driver: 'ble-heart-rate', needs: ['Chrome on a computer or on Android', ...needs],
  freshness: 'live', dataLeaves: 'never', verified: 'loopback', evidence: 'the ble-heart-rate driver; not yet tested with this model',
});
/** a route not built: `why` is the sentence after "Not supported yet:" */
const notYet = (transport: TransportKind, hosts: Host[], why: string, dataLeaves: Route['dataLeaves'] = 'vendor-cloud'): Route & { why: string } => ({
  transport, hosts, needs: [], dataLeaves, verified: 'none', why,
});
const fileRouteOf = (d: Descriptor) => d.routes[0];

const ch = (id: string, kind: Channel['kind'], label: string, shape: Channel['shape'] = 'events', more: Partial<Channel> = {}): Channel =>
  ({ id, kind, label, shape, defaultOn: true, ...more });
const HEALTH = [
  ch('hr', 'hr', 'Heart rate', 'events', { unit: 'bpm', sensitive: 'health' }),
  ch('hrv', 'hrv', 'Heart rate variability', 'events', { unit: 'ms', sensitive: 'health' }),
  ch('sleep', 'sleep', 'Sleep', 'intervals', { sensitive: 'health' }),
  ch('steps', 'steps', 'Steps', 'intervals'),
  ch('workout', 'workout', 'Workouts', 'intervals'),
];
const AUDIO = [ch('audio', 'audio', 'Microphone', 'media', { sensitive: 'audio' })];

type Entry = Omit<Descriptor, 'actions' | 'routes'> & { actions?: Descriptor['actions']; routes: (Route & { why?: string })[] };
const entry = (e: Entry): Descriptor => ({ actions: [], ...e });

// ---------------------------------------------------------------------------------------------------------------
// the families
// ---------------------------------------------------------------------------------------------------------------

const familyEntries: Descriptor[] = [
  entry({
    id: 'phone', name: 'iPhone or Android phone', vendor: 'Apple, Google, Samsung and others', family: 'phone', placement: 'phone', priority: 'P0',
    about: 'The microphone, camera, location and motion of the phone you carry.',
    channels: [...AUDIO, ch('location', 'location', 'Location', 'events', { sensitive: 'location' }), ch('motion', 'accel', 'Motion', 'samples')],
    routes: [
      { transport: 'media', hosts: BROWSERS, needs: ['permission for the microphone'], freshness: 'live', dataLeaves: 'never', verified: 'none' },
      notYet('native-sdk', ['ios'], 'SensorKit needs Apple\'s approved research access.', 'never'),
    ],
  }),
  headsetDescriptor,
  entry({
    id: 'airpods-motion', name: 'AirPods and Beats head motion', vendor: 'Apple', family: 'headset', placement: 'ear', priority: 'P1',
    models: ['AirPods Pro', 'AirPods Max', 'AirPods (3rd generation and later)', 'Powerbeats Pro 2'],
    about: 'Head motion, and workout heart rate on AirPods Pro 3 and Powerbeats Pro 2.',
    channels: [ch('orientation', 'orientation', 'Head motion', 'samples'), ch('hr', 'hr', 'Heart rate', 'events', { unit: 'bpm', sensitive: 'health' })],
    routes: [viaHealthKit(), notYet('native-sdk', ['ios'], 'the iPhone app does not read Core Motion headphone motion yet.', 'never')],
  }),
  clipMicDescriptor,
  entry({
    id: 'apple-watch', name: 'Apple Watch', vendor: 'Apple', family: 'apple', placement: 'wrist', priority: 'P0',
    models: ['Apple Watch Series 12', 'Apple Watch Ultra', 'Apple Watch SE'],
    about: 'Heart rate, HRV, sleep, activity, workouts and saved ECGs through Apple Health.',
    channels: [...HEALTH, ch('ecg', 'ecg', 'Saved ECGs', 'samples', { unit: 'uV', sensitive: 'health' })],
    routes: [viaHealthKit('after the watch syncs to the iPhone'), fileRouteOf(appleHealthExportDescriptor),
      notYet('native-sdk', ['ios'], 'a watch app for live workouts, marks and haptics is not built.', 'never')],
  }),
  entry({
    id: 'galaxy-watch', name: 'Samsung Galaxy Watch', vendor: 'Samsung', family: 'samsung', placement: 'wrist', priority: 'P0',
    models: ['Galaxy Watch 8', 'Galaxy Watch Ultra', 'Galaxy Watch 7'],
    about: 'Samsung Health data through Health Connect.',
    channels: HEALTH,
    routes: [viaHealthConnect(), notYet('native-sdk', ['android'], 'raw ECG and PPG need Samsung\'s sensor SDK registration.')],
  }),
  entry({
    id: 'pixel-watch', name: 'Google Pixel Watch and Fitbit', vendor: 'Google', family: 'google', placement: 'wrist', priority: 'P0',
    models: ['Pixel Watch 5', 'Pixel Watch 4', 'Fitbit Air', 'Fitbit Charge 6', 'Fitbit Inspire 3'],
    about: 'Sleep, activity and heart rate through Health Connect.',
    channels: HEALTH,
    routes: [viaHealthConnect(), notYet('oauth', ['any-browser', 'chrome-desktop', 'desktop-app', 'ios', 'android'], 'the Google Health API needs a restricted-scope review.')],
  }),
  entry({
    id: 'xiaomi-band', name: 'Xiaomi Smart Band and watches', vendor: 'Xiaomi', family: 'xiaomi', placement: 'wrist', priority: 'P0',
    models: ['Smart Band 10', 'Smart Band 11', 'Redmi Watch', 'Xiaomi Watch'],
    about: 'Mi Fitness writes to Health Connect or Apple Health, depending on the model.',
    channels: HEALTH,
    routes: [viaHealthConnect(), viaHealthKit()],
  }),
  entry({
    id: 'huawei-watch', name: 'Huawei Watch and Band', vendor: 'Huawei', family: 'huawei', placement: 'wrist', priority: 'P1',
    models: ['Watch GT 6', 'Watch Fit 4', 'Band 10'],
    about: 'Huawei Health data through Huawei\'s Health Kit.',
    channels: HEALTH,
    routes: [notYet('oauth', PHONES, 'Huawei Health Kit needs approved scopes and a partner account.')],
  }),
  entry({
    id: 'garmin', name: 'Garmin watches and bike computers', vendor: 'Garmin', family: 'garmin', placement: 'wrist', priority: 'P0',
    models: ['Forerunner', 'fēnix', 'Venu', 'Edge', 'Instinct', 'HRM-Pro'],
    about: 'Workouts with laps, heart rate and the route from FIT files; a subset through Apple Health.',
    channels: [...HEALTH, ch('location', 'location', 'Route', 'events', { sensitive: 'location' })],
    routes: [viaFile('file-fit', fileRouteOf(fitDescriptor).verified, ['the activity\'s FIT file (Garmin Connect → Export Original)']), viaHealthKit(), viaBroadcastHr(['heart-rate broadcast turned on']),
      notYet('oauth', BROWSERS, 'the Garmin Connect Health API needs Garmin\'s approval and a commercial licence.')],
  }),
  entry({
    id: 'whoop', name: 'WHOOP', vendor: 'WHOOP', family: 'whoop', placement: 'wrist', priority: 'P1',
    models: ['WHOOP 4.0', 'WHOOP 5.0', 'WHOOP MG'],
    about: 'Live heart rate when broadcast is on; sleep, recovery and strain from WHOOP\'s cloud.',
    channels: [ch('hr', 'hr', 'Heart rate', 'events', { unit: 'bpm', sensitive: 'health' }), ch('sleep', 'sleep', 'Sleep', 'intervals', { sensitive: 'health' }), ch('readiness', 'readiness', 'Recovery', 'events')],
    routes: [viaBroadcastHr(['Heart Rate Broadcast turned on in the WHOOP app']), notYet('oauth', BROWSERS, 'the WHOOP API connector is not built.')],
  }),
  entry({
    id: 'amazfit', name: 'Amazfit watches, Helio Strap and Ring', vendor: 'Zepp Health', family: 'amazfit', placement: 'wrist', priority: 'P1',
    models: ['Balance', 'T-Rex', 'Active', 'Helio Strap', 'Helio Ring'],
    about: 'Heart rate when broadcast; history through Apple Health or Health Connect.',
    channels: HEALTH,
    routes: [viaBroadcastHr(['heart-rate broadcast turned on in Zepp']), viaHealthKit(), viaHealthConnect()],
  }),
  entry({
    id: 'oura', name: 'Oura Ring', vendor: 'Oura', family: 'oura', placement: 'finger', priority: 'P0',
    models: ['Oura Ring 3', 'Oura Ring 4', 'Oura Ring 5'],
    about: 'Sleep, HRV, temperature trends and readiness.',
    channels: [...HEALTH, ch('temp', 'temp', 'Temperature trend', 'events', { unit: 'degC', sensitive: 'health' }), ch('readiness', 'readiness', 'Readiness', 'events')],
    routes: [viaHealthKit(), viaHealthConnect(), notYet('oauth', BROWSERS, 'the Oura API connector (OAuth) is not built.')],
  }),
  entry({
    id: 'galaxy-ring', name: 'Samsung Galaxy Ring', vendor: 'Samsung', family: 'samsung', placement: 'finger', priority: 'P0',
    about: 'Sleep, heart rate and activity through Health Connect.', channels: HEALTH,
    routes: [viaHealthConnect(), notYet('native-sdk', ['android'], 'the Samsung Health Data SDK needs a partner agreement.')],
  }),
  entry({
    id: 'ringconn', name: 'RingConn', vendor: 'RingConn', family: 'ringconn', placement: 'finger', priority: 'P0',
    models: ['RingConn Gen 2', 'RingConn Gen 2 Air', 'RingConn Gen 3'],
    about: 'Sleep and vitals through Apple Health or Health Connect.', channels: HEALTH,
    routes: [viaHealthKit(), viaHealthConnect()],
  }),
  entry({
    id: 'ultrahuman', name: 'Ultrahuman Ring', vendor: 'Ultrahuman', family: 'ultrahuman', placement: 'finger', priority: 'P1',
    models: ['Ring AIR', 'Ring PRO'],
    about: 'Sleep and recovery; a subset through Apple Health.', channels: HEALTH,
    routes: [viaHealthKit(), notYet('oauth', BROWSERS, 'the Ultrahuman Vision connector is not built.')],
  }),
  entry({
    id: 'gesture-ring', name: 'Gesture rings and remotes', vendor: 'Even Realities and others', family: 'gesture', placement: 'finger', priority: 'P2',
    models: ['Even R1', 'Bluetooth camera remotes'],
    about: 'A press or a gesture to mark a moment.',
    channels: [ch('marker', 'marker', 'Marks')],
    routes: [notYet('native-sdk', PHONES, 'gesture input through Even Hub is not built.', 'never')],
  }),
  entry({
    id: 'bike-sensors', name: 'Footpods, bike speed, cadence and power', vendor: 'Garmin, Wahoo, Stryd, Favero and others', family: 'cycling', placement: 'foot', priority: 'P2',
    models: ['Stryd', 'Wahoo RPM', 'Garmin Speed Sensor', 'Favero Assioma'],
    about: 'Speed, cadence and power, from FIT files now and live later.',
    channels: [ch('speed', 'speed', 'Speed'), ch('cadence', 'cadence', 'Cadence'), ch('power', 'power', 'Power')],
    routes: [viaFile('file-fit', fileRouteOf(fitDescriptor).verified, ['the ride\'s FIT file']),
      notYet('web-bluetooth', ['chrome-desktop', 'android'], 'the cycling speed, cadence and power Bluetooth profiles are not built.', 'never')],
  }),
  entry({
    id: 'multisport-watch', name: 'Polar, Suunto and COROS watches', vendor: 'Polar, Suunto, COROS', family: 'multisport', placement: 'wrist', priority: 'P0',
    models: ['Polar Vantage', 'Polar Grit X', 'Suunto Race', 'Suunto Vertical', 'COROS PACE', 'COROS APEX'],
    about: 'Workouts and routes from FIT or GPX exports; heart rate when broadcast.',
    channels: [ch('workout', 'workout', 'Workouts', 'intervals'), ch('hr', 'hr', 'Heart rate', 'events', { unit: 'bpm', sensitive: 'health' }), ch('location', 'location', 'Route', 'events', { sensitive: 'location' })],
    routes: [viaFile('file-fit', fileRouteOf(fitDescriptor).verified, ['the workout\'s FIT export']), viaFile('file-gpx', fileRouteOf(gpxDescriptor).verified, ['the workout\'s GPX export']),
      viaBroadcastHr(['heart-rate broadcast turned on']), notYet('oauth', BROWSERS, 'Polar AccessLink and the others\' cloud APIs are not connected.')],
  }),
  entry({
    id: 'meta-glasses', name: 'Ray-Ban Meta and Oakley Meta glasses', vendor: 'Meta', family: 'meta', placement: 'eyes', priority: 'P1',
    models: ['Ray-Ban Meta (Gen 2)', 'Oakley Meta HSTN', 'Meta Ray-Ban Display'],
    about: 'First-person photos, video and audio.',
    channels: [ch('video', 'video', 'Camera', 'media', { sensitive: 'video' }), ...AUDIO],
    routes: [notYet('native-sdk', PHONES, 'the Meta Wearables Device Access Toolkit bridge is not built.', 'never')],
  }),
  entry({
    id: 'display-glasses', name: 'Display glasses', vendor: 'Even Realities, Brilliant Labs, Vuzix, XREAL, VITURE, RayNeo, Rokid, Snap',
    family: 'glasses', placement: 'eyes', priority: 'P2',
    models: ['Even G2', 'Brilliant Labs Frame', 'Brilliant Labs Halo', 'Vuzix Z100', 'Android XR glasses', 'Snap Specs'],
    about: 'Prompts on a display, and input; camera and audio on some models.',
    channels: [ch('marker', 'marker', 'Input')],
    routes: [notYet('native-sdk', PHONES, 'each model has its own SDK; none is connected yet.', 'never')],
  }),
  entry({
    id: 'headsets-xr', name: 'Apple Vision Pro and Meta Quest', vendor: 'Apple, Meta', family: 'xr', placement: 'eyes', priority: 'P2',
    about: 'Playback and explicit XR sessions.', channels: AUDIO,
    routes: [notYet('native-sdk', [], 'no XR app is built; the Vision Pro\'s main camera needs an enterprise entitlement.', 'never')],
  }),
  entry({
    id: 'action-camera', name: 'Action and body cameras', vendor: 'GoPro, Insta360, DJI', family: 'camera', placement: 'body', priority: 'P0',
    models: ['GoPro HERO', 'Insta360 GO 3S', 'DJI Osmo Nano', 'body cams', 'webcams'],
    about: 'Clips and photos from a body-worn camera.',
    channels: [ch('video', 'video', 'Clips', 'media', { sensitive: 'video' })],
    routes: [
      { transport: 'media', hosts: ['chrome-desktop', 'desktop-app', 'any-browser'], needs: ['a webcam (UVC) chosen as the system camera'], freshness: 'live', dataLeaves: 'never', verified: 'none' },
      notYet('file', BROWSERS, 'importing video files is not built here yet.', 'never'),
      notYet('web-bluetooth', ['chrome-desktop', 'android'], 'GoPro\'s Bluetooth control is not built.', 'never'),
    ],
  }),
  entry({
    id: 'memory-pendant', name: 'Conversation recorders', vendor: 'Omi, Plaud, Amazon Bee, Limitless', family: 'pendant', placement: 'body', priority: 'P1',
    models: ['Omi', 'Plaud NotePin S', 'Plaud Note', 'Bee', 'Limitless Pendant'],
    about: 'Clips and transcripts from a worn recorder.',
    channels: [...AUDIO, ch('transcript', 'other', 'Transcripts')],
    routes: [notYet('web-bluetooth', ['chrome-desktop', 'android'], 'the Omi open-firmware connection is not built.', 'never'),
      notYet('file', BROWSERS, 'transcript imports from Plaud, Bee and Limitless are not built.', 'never')],
  }),
  entry({
    id: 'brainflow', name: 'BrainFlow boards and Lab Streaming Layer', vendor: 'BrainFlow, LSL', family: 'openbci', placement: 'head', priority: 'P1',
    models: ['any BrainFlow board', 'any LSL outlet'],
    about: 'Lab EEG and markers from any board BrainFlow or LSL speaks.',
    channels: [ch('eeg', 'eeg', 'EEG', 'samples', { unit: 'uV', sensitive: 'neural' }), ch('marker', 'marker', 'Markers')],
    routes: [viaFile('file-edf', fileRouteOf(edfDescriptor).verified, ['a recording saved as EDF or BDF']),
      notYet('lsl', ['desktop-app'], 'the desktop app has no LSL inlet yet.', 'never')],
  }),
  entry({
    id: 'consumer-eeg', name: 'Muse, Neurosity and EMOTIV headsets', vendor: 'Interaxon, Neurosity, EMOTIV', family: 'consumer-eeg', placement: 'head', priority: 'P2',
    models: ['Muse 2', 'Muse S', 'Muse S Athena', 'Neurosity Crown', 'EMOTIV EPOC X', 'EMOTIV Insight', 'EMOTIV MN8'],
    about: 'EEG from a consumer headset, from its exports.',
    channels: [ch('eeg', 'eeg', 'EEG', 'samples', { unit: 'uV', sensitive: 'neural' })],
    routes: [viaFile('file-edf', fileRouteOf(edfDescriptor).verified, ['an EDF export (EmotivPRO)']),
      viaFile('file-csv', fileRouteOf(csvDescriptor).verified, ['a CSV export (Mind Monitor, Neurosity)']),
      notYet('web-bluetooth', ['chrome-desktop', 'android'], 'live streams need each vendor\'s SDK; EMOTIV\'s raw EEG needs a paid licence.', 'never')],
  }),
  entry({
    id: 'ear-eeg', name: 'EEG headphones', vendor: 'Neurable and others', family: 'ear-eeg', placement: 'ear', priority: 'P2',
    models: ['Neurable MW75 Neuro'],
    about: 'Headphone audio now; raw EEG through the vendor\'s research kit.',
    channels: [...AUDIO, ch('eeg', 'eeg', 'EEG', 'samples', { unit: 'uV', sensitive: 'neural' })],
    routes: [{ transport: 'media', hosts: BROWSERS, needs: ['the headphones chosen as the system microphone'], freshness: 'live', dataLeaves: 'never', verified: 'none' },
      notYet('native-sdk', [], 'raw EEG needs the vendor\'s research kit or an agreement.')],
  }),
  entry({
    id: 'research-wearables', name: 'ECG shirts, EDA bands and EMG sensors', vendor: 'Hexoskin, Empatica, bHaptics and others', family: 'research', placement: 'body', priority: 'P2',
    models: ['Hexoskin Smart Shirt', 'Empatica EmbracePlus', 'bHaptics TactSuit'],
    about: 'ECG, breathing, skin conductance and muscle signals from their exports.',
    channels: [ch('ecg', 'ecg', 'ECG', 'samples', { unit: 'uV', sensitive: 'health' }), ch('eda', 'eda', 'Skin conductance', 'samples'), ch('resp', 'resp', 'Breathing', 'samples')],
    routes: [viaFile('file-edf', fileRouteOf(edfDescriptor).verified, ['an EDF export']), viaFile('file-csv', fileRouteOf(csvDescriptor).verified, ['a CSV export']),
      notYet('native-sdk', [], 'live data needs each vendor\'s SDK tier and licence.')],
  }),
  entry({
    id: 'glucose', name: 'Glucose sensors', vendor: 'Dexcom, Abbott', family: 'glucose', placement: 'arm', priority: 'P2',
    models: ['Dexcom G7', 'Dexcom Stelo', 'FreeStyle Libre 3'],
    about: 'Glucose readings, labelled with their delay. Never for real-time safety decisions.',
    channels: [ch('glucose', 'glucose', 'Glucose', 'events', { unit: 'mg/dL', sensitive: 'health' })],
    routes: [viaHealthKit('3 hours after the reading (Dexcom\'s delay)'), viaFile('file-csv', fileRouteOf(csvDescriptor).verified, ['a LibreView or Clarity CSV export']),
      notYet('oauth', BROWSERS, 'the Dexcom partner API needs an agreement.')],
  }),
  entry({
    id: 'withings', name: 'Withings and smart beds', vendor: 'Withings, Eight Sleep, Sleep Number', family: 'home', placement: 'home', priority: 'P2',
    models: ['Withings Sleep Analyzer', 'Withings ScanWatch', 'Body Scan', 'Eight Sleep Pod'],
    about: 'Sleep and vitals from the bedroom; a subset through Apple Health or Health Connect.',
    channels: HEALTH,
    routes: [viaHealthKit(), viaHealthConnect(), notYet('oauth', BROWSERS, 'the Withings cloud connector is not built.')],
  }),
];

/** the descriptors whose driver this package (or the app) implements */
export const builtinDescriptors: Descriptor[] = [
  exocortexCapDescriptor, cytonDescriptor(false), cytonDescriptor(true), ganglionDescriptor, bleHeartRateDescriptor, polarH10Descriptor,
  appleHealthDescriptor, healthConnectDescriptor, appleHealthExportDescriptor, fitDescriptor, gpxDescriptor, edfDescriptor, csvDescriptor,
];

export const catalog: Descriptor[] = [...builtinDescriptors, ...familyEntries];

// ---------------------------------------------------------------------------------------------------------------
// compatibility
// ---------------------------------------------------------------------------------------------------------------

const VERIFIED_RANK: Record<Verified, number> = { none: 0, spec: 1, loopback: 2, bench: 3, hardware: 4 };

export function routeWorksOn(r: Route, host: Host): boolean {
  if (r.hosts.includes(host)) return true;
  return r.hosts.includes('any-browser') && host !== 'server';
}

const HOST_WORDS: Record<Host, string> = {
  'chrome-desktop': 'Chrome on a computer', 'desktop-app': 'the desktop app', ios: 'the iPhone app', android: 'the Android app',
  'any-browser': 'any browser', server: 'a server',
};

function hostsPhrase(hosts: Host[]): string {
  const w = [...new Set(hosts.map((h) => HOST_WORDS[h]))];
  return w.length <= 1 ? (w[0] ?? 'no device yet') : `${w.slice(0, -1).join(', ')} or ${w[w.length - 1]}`;
}

const FILE_WORDS: Record<string, string> = {
  'file-fit': 'FIT files', 'file-gpx': 'GPX files', 'file-edf': 'EDF or BDF files', 'file-csv': 'CSV exports',
  'file-apple-health-export': 'Apple Health export',
};

/** the plain sentence for a route that works on this host */
function worksSentence(r: Route, host: Host): string {
  switch (r.transport) {
    case 'web-serial': return host === 'desktop-app' ? 'Works in the desktop app over USB' : 'Works in Chrome on a computer over USB';
    case 'web-bluetooth': return host === 'android' ? 'Works in Chrome on Android over Bluetooth' : host === 'desktop-app' ? 'Works in the desktop app over Bluetooth' : 'Works in Chrome on a computer over Bluetooth';
    case 'file': return r.driver === 'file-apple-health-export' ? 'Import its Apple Health export' : `Import its ${FILE_WORDS[r.driver ?? ''] ?? 'files'}`;
    case 'healthkit': return 'Works through Apple Health on your iPhone';
    case 'health-connect': return 'Works through Health Connect on your Android phone';
    case 'tcp': return 'Works over Wi-Fi';
    case 'media': return r.driver === 'media-audio' ? 'Works as a microphone of this device, through its audio route' : 'Works as a microphone or camera of this device';
    case 'lsl': return 'Works through Lab Streaming Layer in the desktop app';
    default: return `Works over ${r.transport}`;
  }
}

export interface Compatibility {
  /** works: a built route runs on this host. elsewhere: a built route runs on another host. not-yet: no built route. */
  status: 'works' | 'elsewhere' | 'not-yet';
  route: Route | null;
  sentence: string;
  /** what to do or have first, for the chosen route */
  needs: string[];
  verified: Verified;
  /** a "works with" badge needs bench or hardware evidence */
  badge: boolean;
}

/** the best route of a descriptor for this host, and a sentence a person reads */
export function compatibility(d: Descriptor, host: Host): Compatibility {
  const built = d.routes.filter((r) => r.driver);
  // the most verified route first; among equals, the one the descriptor lists first (its author's main route)
  const rank = (r: Route) => VERIFIED_RANK[r.verified] * 100 - d.routes.indexOf(r);
  const here = built.filter((r) => routeWorksOn(r, host)).sort((a, b) => rank(b) - rank(a));
  const result = (status: Compatibility['status'], route: Route | null, sentence: string): Compatibility => ({
    status, route, sentence, needs: route?.needs ?? [], verified: route?.verified ?? 'none',
    badge: !!route && VERIFIED_RANK[route.verified] >= VERIFIED_RANK.bench,
  });
  if (here.length) return result('works', here[0], worksSentence(here[0], host));
  const there = built.sort((a, b) => rank(b) - rank(a));
  if (there.length) {
    const r = there[0];
    const hosts = r.hosts.filter((h) => h !== 'any-browser');
    return result('elsewhere', r, `${worksSentence(r, hosts[0] ?? host)}: use ${hostsPhrase(hosts)}`);
  }
  const why = (d.routes as (Route & { why?: string })[]).find((r) => r.why)?.why;
  return result('not-yet', null, `Not supported yet${why ? `: ${why.replace(/\.$/, '')}` : ''}`);
}

export interface CatalogHit {
  descriptor: Descriptor;
  score: number;
  compatibility: Compatibility;
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').toLowerCase();

/** search the catalog by model, vendor or signal; ranked by how well it matches, then by what works here */
export function searchCatalog(query: string, host: Host, list: Descriptor[] = catalog): CatalogHit[] {
  const words = fold(query).split(/[^a-z0-9.+]+/).filter((w) => w.length > 0);
  const hits: CatalogHit[] = [];
  for (const d of list) {
    let score = 0;
    if (words.length) {
      const name = fold(d.name), vendor = fold(d.vendor), models = (d.models ?? []).map(fold), family = fold(d.family ?? ''), about = fold(d.about);
      const signals = d.channels.map((c) => `${fold(c.label)} ${c.kind}`).join(' ');
      let matched = 0;
      for (const w of words) {
        let s = 0;
        const word = new RegExp(`(^|[^a-z0-9])${w.replace(/[.+]/g, '\\$&')}`);
        if (word.test(name)) s += 10;
        if (word.test(vendor)) s += 6;
        if (models.some((m) => word.test(m))) s += 5;
        if (word.test(family)) s += 4;
        if (word.test(signals)) s += 2;
        if (word.test(about)) s += 1;
        if (s) matched++;
        score += s;
      }
      // most words must match ("polar h10 strap" finds the H10); a match of every word ranks above a partial one
      if (matched * 2 < words.length || score <= 0) continue;
      if (matched < words.length) score = Math.floor(score / 4);
    } else {
      score = d.priority === 'P0' ? 3 : d.priority === 'P1' ? 2 : 1;
    }
    hits.push({ descriptor: d, score, compatibility: compatibility(d, host) });
  }
  const order = { works: 0, elsewhere: 1, 'not-yet': 2 };
  return hits.sort((a, b) => b.score - a.score || order[a.compatibility.status] - order[b.compatibility.status] || a.descriptor.name.localeCompare(b.descriptor.name));
}
