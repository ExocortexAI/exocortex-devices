// The contract every device, health source, account and custom integration meets. An app that speaks it can pair
// any of them without knowing which one it is: an OpenBCI board, a heart-rate strap, Apple Health, the Exocortex cap.
//
// Three parts:
//   1. Descriptor: what a kind of device IS (a catalog entry). Plain data: it can be listed, searched, shared by a
//      private link and reviewed for the marketplace without running any code.
//   2. Driver: the code that opens one device of that kind over a transport and turns its bytes into records.
//   3. Records: what comes out. Four shapes cover everything: samples (a chunk of a regular signal), intervals (a
//      sleep stage, a workout), events (a button, a marker, a gesture) and media (an audio clip, a photo).
//
// Every record carries its provenance (which device, which host, which transport, when it was observed, when it
// arrived, how sure we are of the time), so one physical source that arrives two ways can be told apart and
// de-duplicated. Nothing here reaches the network or the DOM: transports are handed in (./transports/).
//
// TypeScript with erasable syntax only (no enums, no parameter properties): Node runs it directly.

// ---------------------------------------------------------------------------------------------------------------
// 1. Descriptor
// ---------------------------------------------------------------------------------------------------------------

/** where on the body (or off it) a device is: the Connections sheet groups by this */
export type Placement =
  | 'head' | 'ear' | 'eyes' | 'wrist' | 'finger' | 'chest' | 'arm' | 'body' | 'foot'
  | 'phone' | 'computer' | 'home' | 'account' | 'file' | 'other';

/** how bytes reach the app. A driver names the transports it can use; the host offers the ones it has. */
export type TransportKind =
  | 'web-serial'        // navigator.serial (Chromium desktop), or a Node serial port on the desktop app
  | 'web-bluetooth'     // navigator.bluetooth GATT (Chromium desktop and Android), or a native BLE bridge on a phone
  | 'web-usb'
  | 'web-hid'
  | 'tcp'               // a device on the local network (the cap's Wi-Fi)
  | 'healthkit'         // Apple Health on iOS (native plugin)
  | 'health-connect'    // Health Connect on Android (native plugin)
  | 'oauth'             // a vendor's cloud API with the person's consent (Oura, WHOOP, Google Health …)
  | 'file'              // an export the person picks: EDF, FIT, GPX, Apple Health export.xml, CSV …
  | 'media'             // getUserMedia: the system's microphone / camera route (headsets, clip mics, webcams)
  | 'lsl'               // Lab Streaming Layer, on the desktop app
  | 'native-sdk';       // a vendor SDK on a phone (Meta glasses, Samsung sensors): the host bridges it

/** the host the app runs on: a transport is only offered where the host has it */
export type Host = 'chrome-desktop' | 'desktop-app' | 'ios' | 'android' | 'any-browser' | 'server';

/** what a device measures. `kind` is from one vocabulary so the timeline can lay lanes out by it. */
export type SignalKind =
  | 'eeg' | 'ecg' | 'emg' | 'eog' | 'ppg' | 'eda' | 'resp'
  | 'hr' | 'rr' | 'hrv' | 'spo2' | 'temp' | 'bp' | 'glucose'
  | 'accel' | 'gyro' | 'mag' | 'orientation'
  | 'audio' | 'video' | 'image'
  | 'steps' | 'energy' | 'distance' | 'speed' | 'cadence' | 'power' | 'location'
  | 'sleep' | 'workout' | 'activity' | 'readiness'
  | 'impedance' | 'battery' | 'marker' | 'other';

/** one signal a device can produce: the person can turn each one on or off */
export interface Channel {
  id: string;                    // stable within the descriptor: 'eeg', 'ecg', 'hr', 'accel' …
  kind: SignalKind;
  label: string;                 // "16 EEG channels", "Heart rate"
  shape: 'samples' | 'intervals' | 'events' | 'media';
  unit?: string;                 // 'uV', 'bpm', 'ms', 'g', 'degC' …
  rateHz?: number;               // nominal sample rate of a 'samples' channel
  count?: number;                // how many parallel signals (16 electrodes)
  names?: string[];              // their names, in order (10-20 positions for EEG)
  defaultOn: boolean;            // turned on when the device is paired
  sensitive?: 'health' | 'neural' | 'biometric' | 'location' | 'audio' | 'video'; // compliance: gated categories
}

/** what the app can ask a device to do. Only actions a connection can execute are drawn. */
export interface Action {
  id: string;                    // 'start', 'stop', 'mark', 'haptic', 'impedance', 'snapshot' …
  label: string;
  args?: Record<string, { type: 'number' | 'string' | 'boolean'; label: string; min?: number; max?: number; options?: string[] }>;
  safing?: boolean;              // a stop: always allowed
}

/** how far a support claim was checked. Never more than what was done (a badge reads this). */
export type Verified = 'none' | 'spec' | 'loopback' | 'bench' | 'hardware';

/** one way to reach a kind of device */
export interface Route {
  transport: TransportKind;
  hosts: Host[];                 // where this route works
  driver?: string;               // the driver id that implements it (absent: catalog only, not built yet)
  /** what a person must do or have first: "the Oura app", "a developer licence", "Chrome on a computer" */
  needs?: string[];
  freshness?: string;            // "live", "minutes", "after the vendor app syncs", "3 h delay"
  dataLeaves?: 'never' | 'vendor-cloud' | 'our-api';   // where the data goes on this route (compliance rule 2)
  verified: Verified;
  evidence?: string;             // what earned `verified` (a test file, a bench report)
}

export interface Descriptor {
  id: string;                    // 'openbci-cyton-daisy', 'polar-h10', 'apple-health' … ; custom: 'custom:<uuid>'
  name: string;                  // "OpenBCI Cyton + Daisy"
  vendor: string;
  family?: string;               // groups variants: 'openbci', 'polar'
  models?: string[];             // the exact models a claim covers
  placement: Placement;
  about: string;                 // one line: what it gives you
  channels: Channel[];
  actions: Action[];
  routes: Route[];
  priority?: 'P0' | 'P1' | 'P2';
  links?: { label: string; url: string }[];
  /** a custom integration's declarative driver (./manifest.ts); built-ins leave it out */
  manifest?: unknown;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Records
// ---------------------------------------------------------------------------------------------------------------

/** where a record came from and how sure its time is */
export interface Provenance {
  instance: string;              // the paired device instance's id (one per physical device per app)
  descriptor: string;            // Descriptor.id
  model?: string;
  firmware?: string;
  serial?: string;               // the device's own id when it has one (a BLE address, a board serial)
  host: Host;
  transport: TransportKind;
  providerRecordId?: string;     // a vendor's record id (HealthKit UUID, Oura id): the key to de-duplicate on
  sourceApp?: string;            // the app that wrote it to a hub (Apple Health's source: "Oura", "Polar Flow")
  /** made by a simulator (./sim/), not measured: a simulated record never counts as a physical one */
  simulated?: boolean;
}

/** time of a record. Observed is when it happened; received is when the app got it. */
export interface Timing {
  t0: number;                    // ms since epoch, observed: the first sample's acquisition time
  receivedAt: number;            // ms since epoch: when this host got it
  tzOffsetMin?: number;          // the observation's own UTC offset, when the source says
  seq?: number;                  // the device's own sequence / sample counter, if any
  clock?: 'device' | 'host' | 'vendor';   // whose clock t0 is on
  uncertaintyMs?: number;        // how far t0 may be off (BLE latency, a vendor's minute rounding)
}

interface Base { channel: string; prov: Provenance; time: Timing }

/** a chunk of a regular signal: data[signal][sample], in `unit` */
export interface SampleChunk extends Base {
  shape: 'samples';
  rateHz: number;
  names: string[];               // one per row of data
  unit: string;
  data: Float32Array[];
  dropped?: number;              // samples known to be missing before this chunk (a sequence gap)
  quality?: ('ok' | 'flat' | 'railed' | 'noisy' | 'off')[];   // per signal, when the driver can tell
}

/** something with a start and an end: a sleep stage, a workout, a measured value over a window */
export interface IntervalRecord extends Base {
  shape: 'intervals';
  end: number;                   // ms since epoch
  label: string;                 // 'deep', 'rem', 'running', 'resting heart rate'
  value?: number;
  unit?: string;
  method?: string;               // the vendor's algorithm or statistic ("RMSSD over 5 min", "Oura readiness v2")
  fields?: Record<string, unknown>;
}

/** a discrete thing at one time: a heart beat's RR interval, a button press, a gesture, a marker */
export interface EventRecord extends Base {
  shape: 'events';
  label: string;
  value?: number;
  unit?: string;
  fields?: Record<string, unknown>;
}

/** a media asset: the bytes, or where the host keeps them */
export interface MediaRecord extends Base {
  shape: 'media';
  mime: string;
  durationMs?: number;
  bytes?: Uint8Array;
  ref?: string;                  // a host path / URL when the bytes are not inline
}

export type DeviceRecord = SampleChunk | IntervalRecord | EventRecord | MediaRecord;

// ---------------------------------------------------------------------------------------------------------------
// 2. Driver and transports
// ---------------------------------------------------------------------------------------------------------------

/** a byte stream: a serial port, a TCP socket. Web Serial and Node serial both fit it (./transports/). */
export interface ByteTransport {
  kind: 'web-serial' | 'tcp' | 'web-usb';
  label: string;                 // "USB 0403:6015"
  open(o: { baudRate: number }): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  /** start reading; `onBytes` is called for each chunk until close(). Resolves when the read loop ends. */
  read(onBytes: (b: Uint8Array) => void): Promise<void>;
  close(): Promise<void>;
}

/** a GATT connection: Web Bluetooth and a phone's native BLE plugin both fit it */
export interface GattTransport {
  kind: 'web-bluetooth';
  label: string;                 // the device's advertised name
  id: string;                    // the platform's id for the device (stable per origin / app)
  subscribe(service: string, characteristic: string, onValue: (v: DataView) => void): Promise<() => Promise<void>>;
  write(service: string, characteristic: string, bytes: Uint8Array, withResponse?: boolean): Promise<void>;
  read(service: string, characteristic: string): Promise<DataView>;
  onDisconnect(f: () => void): void;
  close(): Promise<void>;
}

/** a native health store (HealthKit, Health Connect): queries by type and anchor */
export interface HealthStoreTransport {
  kind: 'healthkit' | 'health-connect';
  available(): Promise<boolean>;
  /** ask for read access to these record types; resolves with the ones granted (may be fewer, or unknowable) */
  authorize(types: string[]): Promise<{ granted: string[]; unknown: string[] }>;
  /** records of one type after `anchor` (the store's own cursor), oldest first, at most `limit` */
  query(type: string, anchor: string | null, limit: number): Promise<{ records: HealthSample[]; anchor: string | null; deleted: string[] }>;
}

/** one record as a health store hands it over, before a driver turns it into a DeviceRecord */
export interface HealthSample {
  uuid: string;
  type: string;                  // the store's own type name ('HKQuantityTypeIdentifierHeartRate', 'HeartRateRecord')
  start: number;
  end: number;
  value?: number;
  unit?: string;
  category?: string;             // a sleep stage, a workout type
  sourceApp?: string;
  device?: { name?: string; model?: string; manufacturer?: string; firmware?: string };
  tzOffsetMin?: number;
  fields?: Record<string, unknown>;
}

/** a file the person picked */
export interface FileTransport {
  kind: 'file';
  name: string;
  size: number;
  /** the bytes, a chunk at a time (a 2 GB Apple Health export is never read whole) */
  chunks(): AsyncIterable<Uint8Array>;
}

export type Transport = ByteTransport | GattTransport | HealthStoreTransport | FileTransport;

/** the state of one open connection. `unknown`: a link was lost while the device may still be doing something. */
export type ConnState = 'idle' | 'connecting' | 'streaming' | 'stale' | 'unknown' | 'revoked' | 'error' | 'closed';

export interface Status {
  state: ConnState;
  why?: string;                  // a sentence a person can act on
  battery?: number;              // 0..1, when the device reports it
  wear?: 'on' | 'off' | 'unknown';   // device-reported only (an inferred wear is a guess, not a status)
  lastRecordAt?: number;
  counts?: { records: number; samples: number; dropped: number };
  info?: Record<string, string>; // firmware, board mode, sample rate actually set …
}

/** what the host hands a driver when it opens a device */
export interface OpenContext {
  instance: string;
  host: Host;
  /** the channels the person has turned on (a driver may skip work for the rest) */
  enabled: Set<string>;
  /** driver-specific settings the person chose (`Driver.settings` says which) */
  config: Record<string, unknown>;
  emit(r: DeviceRecord): void;
  status(s: Status): void;
  now(): number;
}

/** an open device. Every method may be called more than once; stop() after a lost link records `unknown`. */
export interface Connection {
  start(): Promise<void>;
  stop(): Promise<void>;
  act(action: string, args?: Record<string, unknown>): Promise<{ outcome: 'accepted' | 'done' | 'failed' | 'unsupported'; why?: string }>;
  close(): Promise<void>;
}

/** a setting a driver accepts: rendered as a field on the device's page */
export interface SettingSpec {
  id: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  default: unknown;
  options?: { value: string; label: string }[];
  help?: string;
}

/** the code for one descriptor's routes */
export interface Driver<T extends Transport = Transport> {
  id: string;
  descriptor: Descriptor;
  transport: TransportKind;
  settings?: SettingSpec[];
  /** for a GATT driver: the services to ask for when the person chooses a device */
  bluetooth?: { filters: { services?: string[]; namePrefix?: string; name?: string }[]; optionalServices?: string[] };
  /** for a serial driver: the USB ids to offer when the person chooses a port, and the line rate */
  serial?: { filters: { usbVendorId: number; usbProductId?: number }[]; baudRate: number };
  /** for a file driver: what files it reads */
  files?: { extensions: string[]; mime?: string[] };
  open(t: T, ctx: OpenContext): Promise<Connection>;
}
