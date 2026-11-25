// The Exocortex cap: 1,118 dry EEG contacts under a beanie, five cameras in its cuff, each with a microphone, and a
// hub at the back that gathers them. This file is its descriptor only. The hub's protocol is implemented by the
// Exocortex app, which registers a driver with the id 'exocortex-cap' for these routes; this package ships no code
// for it, so the routes say what the app does, not what this package verified.

import type { Descriptor } from '../contract.ts';

// the five cuff cameras, numbered as the hub numbers them
export const CAP_CAMERAS = ['1', '2', '3', '4', '5'];

export const exocortexCapDescriptor: Descriptor = {
  id: 'exocortex-cap',
  name: 'Exocortex cap',
  vendor: 'Exocortex',
  family: 'exocortex',
  models: ['Exocortex cap S, M, L'],
  placement: 'head',
  about: 'High-density EEG from 1,118 dry contacts, five first-person cameras and their microphones.',
  channels: [
    { id: 'eeg', kind: 'eeg', label: '1,118 EEG contacts', shape: 'samples', unit: 'uV', rateHz: 500, count: 1118, defaultOn: true, sensitive: 'neural' },
    { id: 'impedance', kind: 'impedance', label: 'Contact check', shape: 'events', unit: 'ohm', defaultOn: true },
    ...CAP_CAMERAS.map((c) => ({ id: `camera-${c}`, kind: 'video' as const, label: `Camera ${c}`, shape: 'media' as const, defaultOn: false, sensitive: 'video' as const })),
    ...CAP_CAMERAS.map((c) => ({ id: `mic-${c}`, kind: 'audio' as const, label: `Microphone ${c}`, shape: 'media' as const, defaultOn: false, sensitive: 'audio' as const })),
    { id: 'marker', kind: 'marker', label: 'Marks', shape: 'events', defaultOn: true },
  ],
  actions: [
    { id: 'start', label: 'Start' },
    { id: 'stop', label: 'Stop', safing: true },
    { id: 'impedance', label: 'Contact check' },
    { id: 'mark', label: 'Mark this moment', args: { label: { type: 'string', label: 'Label' } } },
  ],
  routes: [
    // implemented by the Exocortex app (its hub link), not by this package
    { transport: 'tcp', hosts: ['desktop-app', 'chrome-desktop'], driver: 'exocortex-cap', needs: ['the cap\'s hub on the same Wi-Fi'], freshness: 'live', dataLeaves: 'never', verified: 'none' },
    { transport: 'web-serial', hosts: ['chrome-desktop', 'desktop-app'], driver: 'exocortex-cap', needs: ['the cap\'s USB-C cable'], freshness: 'live', dataLeaves: 'never', verified: 'none' },
  ],
  priority: 'P0',
};
