// The catalog: search by model, and the sentence each host gets. And the registry's lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, searchCatalog, compatibility } from '../src/catalog.ts';
import { builtinDrivers, driverFor } from '../src/registry.ts';

const first = (q: string, host: Parameters<typeof searchCatalog>[1]) => searchCatalog(q, host)[0];

test('search by model, with the sentence for this host', () => {
  assert.equal(first('H10', 'chrome-desktop').descriptor.id, 'polar-h10');
  assert.equal(first('H10', 'chrome-desktop').compatibility.sentence, 'Works in Chrome on a computer over Bluetooth');
  assert.equal(first('cyton daisy', 'chrome-desktop').descriptor.id, 'openbci-cyton-daisy');
  assert.equal(first('cyton', 'chrome-desktop').compatibility.sentence, 'Works in Chrome on a computer over USB');
  assert.equal(first('cyton', 'desktop-app').compatibility.sentence, 'Works in the desktop app over USB');
  assert.equal(first('fenix', 'chrome-desktop').descriptor.id, 'garmin');   // "fēnix", folded
  assert.equal(first('garmin', 'chrome-desktop').compatibility.sentence, 'Import its FIT files');
});

test('a family reached through a phone hub says where it works', () => {
  const oura = first('oura ring 4', 'chrome-desktop');
  assert.equal(oura.descriptor.id, 'oura');
  assert.equal(oura.compatibility.status, 'elsewhere');
  assert.match(oura.compatibility.sentence, /^Works through Apple Health on your iPhone: use the iPhone app/);
  assert.equal(first('oura', 'ios').compatibility.sentence, 'Works through Apple Health on your iPhone');
  assert.equal(first('oura', 'android').compatibility.sentence, 'Works through Health Connect on your Android phone');
});

test('a family with no built route says why', () => {
  const huawei = first('huawei watch gt', 'android');
  assert.equal(huawei.compatibility.status, 'not-yet');
  assert.equal(huawei.compatibility.sentence, 'Not supported yet: Huawei Health Kit needs approved scopes and a partner account');
  assert.equal(searchCatalog('no such device xyz', 'chrome-desktop').length, 0);
});

test('an empty search lists everything, P0 first', () => {
  const all = searchCatalog('', 'chrome-desktop');
  assert.equal(all.length, catalog.length);
  assert.equal(all[0].descriptor.priority, 'P0');
});

test('every entry is honest: unique ids, routes, and no claim past loopback in this package', () => {
  const ids = catalog.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of catalog) {
    assert.ok(d.routes.length > 0, d.id);
    for (const r of d.routes) {
      assert.ok(['none', 'spec', 'loopback'].includes(r.verified), `${d.id} claims ${r.verified}`);
      if (r.verified !== 'none') assert.ok(r.driver, `${d.id}: a verified route names its driver`);
    }
    assert.equal(compatibility(d, 'chrome-desktop').badge, false);
  }
});

test('the registry finds each built-in driver by descriptor and transport', () => {
  for (const d of builtinDrivers) assert.equal(driverFor(d.descriptor.id, d.transport), d);
  assert.equal(driverFor('polar-h10', 'web-serial'), null);
  // every route this package names as its own has a driver here
  const mine = new Set(builtinDrivers.map((d) => d.id));
  for (const d of catalog) for (const r of d.routes) if (r.driver && !['apple-health', 'health-connect', 'exocortex-cap'].includes(r.driver)) assert.ok(mine.has(r.driver), `${d.id} → ${r.driver}`);
});
