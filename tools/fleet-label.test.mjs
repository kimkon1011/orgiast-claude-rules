import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeFleetLabel, resolveFleetLabel } from './lib/fleet-label.mjs';

function fixture(t, fleetMap = null, reporterLabel = undefined) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-label-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  if (fleetMap !== null) {
    fs.writeFileSync(path.join(home, '.claude', 'fleet-pc-map.json'), JSON.stringify(fleetMap));
  }
  if (reporterLabel !== undefined) {
    fs.writeFileSync(path.join(home, '.claude', 'cost-reporter.env'), `REPORTER_LABEL=${reporterLabel}`);
  }
  return home;
}

test('文字列値のエントリをそのまま返す', t => {
  const home = fixture(t, { 'my-pc': 'MyLabel' });
  assert.equal(resolveFleetLabel(home, { hostname: 'my-pc' }), 'MyLabel');
});

test('label 付きオブジェクトから label を返す', t => {
  const home = fixture(t, { 'my-pc': { label: 'LabelFromObj', hostname: 'my-pc', aliases: ['alias1', 'alias2'] } });
  assert.equal(resolveFleetLabel(home, { hostname: 'my-pc' }), 'LabelFromObj');
});

test('label なし・hostname 付きオブジェクトから hostname を返す', t => {
  const home = fixture(t, { 'my-pc': { hostname: 'HostnameFromObj', aliases: ['alias1'] } });
  assert.equal(resolveFleetLabel(home, { hostname: 'my-pc' }), 'HostnameFromObj');
});

test('label と hostname なし・aliases だけのオブジェクトから aliases[0] を返す', t => {
  const home = fixture(t, { 'my-pc': { aliases: ['PrimaryAlias', 'SecondaryAlias'] } });
  assert.equal(resolveFleetLabel(home, { hostname: 'my-pc' }), 'PrimaryAlias');
});

test('使える文字列が無いオブジェクトは hostname にフォールバック', t => {
  const home = fixture(t, { 'my-pc': { unrelated: true } });
  assert.equal(resolveFleetLabel(home, { hostname: 'my-pc' }), 'my-pc');
});

test('地図なし→REPORTER_LABEL を返す', t => {
  const home = fixture(t, null, 'EnvLabel');
  assert.equal(resolveFleetLabel(home, { hostname: 'whatever' }), 'EnvLabel');
});

test('地図なし・REPORTER_LABEL なし→KimPC 正規化→kim-PC', t => {
  const home = fixture(t);
  assert.equal(resolveFleetLabel(home, { hostname: '000KimPC' }), 'kim-PC');
});

test('地図なし・REPORTER_LABEL なし・通常 hostname→hostname をそのまま返す', t => {
  const home = fixture(t);
  assert.equal(resolveFleetLabel(home, { hostname: 'my-workstation' }), 'my-workstation');
});

test('REPORTER_LABEL=000KimPC → kim-PC に正規化', t => {
  const home = fixture(t, null, '000KimPC');
  assert.equal(resolveFleetLabel(home, { hostname: 'whatever' }), 'kim-PC');
});

test('fleet-pc-map の label が 000KimPC → kim-PC に正規化', t => {
  const home = fixture(t, { 'my-pc': { label: '000KimPC' } });
  assert.equal(resolveFleetLabel(home, { hostname: 'my-pc' }), 'kim-PC');
});

test('REPORTER_LABEL=作業用018 / cafe015-PC は変えない', t => {
  const work = fixture(t, null, '作業用018');
  assert.equal(resolveFleetLabel(work, { hostname: 'whatever' }), '作業用018');
  const cafe = fixture(t, null, 'cafe015-PC');
  assert.equal(resolveFleetLabel(cafe, { hostname: 'whatever' }), 'cafe015-PC');
});

test('normalizeFleetLabel はゆれを kim-PC に揃え、他は不変', () => {
  for (const input of ['000KimPC', 'kimpc', '000-kim-PC', '000｜kim-PC', 'kim-PC', 'KimPC']) {
    assert.equal(normalizeFleetLabel(input), 'kim-PC', input);
  }
  for (const input of ['作業用018', 'cafe015-PC', 'EnvLabel', 'my-workstation']) {
    assert.equal(normalizeFleetLabel(input), input, input);
  }
});
