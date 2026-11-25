import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

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