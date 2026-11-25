// EEG helpers: the region of an electrode name, and band powers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionOf, groupByRegion, bandPowers, relativeBandPowers } from '../src/eeg.ts';
import { CYTON_DAISY_NAMES } from '../src/drivers/openbci-cyton.ts';

test('10-20 names map to regions; references and numbers do not', () => {
  const cases: [string, string | null][] = [
    ['Fp1', 'frontal'], ['AF4', 'frontal'], ['F7', 'frontal'], ['FC3', 'frontal'], ['Fz', 'frontal'],
    ['C3', 'central'], ['Cz', 'central'], ['CP2', 'central'],
    ['P7', 'parietal'], ['Pz', 'parietal'], ['PO8', 'parietal'],
    ['O1', 'occipital'], ['Oz', 'occipital'], ['Iz', 'occipital'],
    ['T7', 'temporal'], ['T3', 'temporal'], ['FT9', 'temporal'], ['TP10', 'temporal'],
    ['EEG Fp1-REF', 'frontal'], ['C3-A2', 'central'], ['FCC3h', null],
    ['A1', null], ['M2', null], ['1', null], ['ECG', null],
  ];
  for (const [name, region] of cases) assert.equal(regionOf(name), region, name);
  const g = groupByRegion(CYTON_DAISY_NAMES);
  assert.deepEqual(g.occipital, [6, 7]);
  assert.deepEqual(g.temporal, [12, 13]);
});

test('band powers: a 10 Hz sine of amplitude 10 µV has its power, 50 µV², in alpha', () => {
  const fs = 250;
  const x = Array.from({ length: 2 * fs }, (_, i) => 10 * Math.sin((2 * Math.PI * 10 * i) / fs) + 3);
  const p = bandPowers(x, fs);
  assert.ok(Math.abs(p.alpha - 50) < 2.5, `alpha ${p.alpha}`);
  assert.ok(p.delta < 1 && p.theta < 1 && p.beta < 1 && p.gamma < 1);
  assert.ok(relativeBandPowers(p).alpha > 0.97);
  // a 20 Hz sine at 125 Hz goes to beta; gamma above Nyquist stays 0 at a low rate
  assert.ok(relativeBandPowers(bandPowers(Array.from({ length: 250 }, (_, i) => Math.sin((2 * Math.PI * 20 * i) / 125)), 125)).beta > 0.95);
  assert.equal(bandPowers(Array.from({ length: 64 }, () => 1), 50).gamma, 0);
  assert.equal(bandPowers([1, 2], 250).total, 0);
});
