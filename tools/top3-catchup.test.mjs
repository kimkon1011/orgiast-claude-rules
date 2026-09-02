#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decideAction, jstHour, jstToday, parseEnvSecret, readLocalTop3 } from './top3-catchup.mjs';

test('decideAction: 到着済みならnoop', () => {
  assert.equal(decideAction({ cacheAsOf: '2026-09-02', targetDay: '2026-09-02', jstHour: 13, artifactDay: '2026-09-02', dispatchCountToday: 0, allowDispatch: true }).action, 'noop');
});

test('decideAction: 当日artifactがあればingest', () => {
  assert.equal(decideAction({ cacheAsOf: '2026-09-01', targetDay: '2026-09-02', jstHour: 9, artifactDay: '2026-09-02', dispatchCountToday: 0, allowDispatch: true }).action, 'ingest');
});

test('decideAction: 11時JST以降にartifactが無ければdispatch', () => {
  assert.equal(decideAction({ cacheAsOf: null, targetDay: '2026-09-02', jstHour: 11, artifactDay: null, dispatchCountToday: 1, allowDispatch: true }).action, 'dispatch');
});

// 回帰: schedule は実測で1〜3時間遅れる(2026-09-01 は 09:58 JST 起動)。定刻直後の 08:30/09:30 で
// dispatch すると、遅れて来る本来の run と二重生成になり毎朝 Anthropic API を2回焼く。
test('decideAction: 遅延中の午前はdispatchせずwait（二重生成の回帰）', () => {
  for (const hour of [8, 9, 10]) {
    const decision = decideAction({ cacheAsOf: '2026-09-01', targetDay: '2026-09-02', jstHour: hour, artifactDay: null, dispatchCountToday: 0, allowDispatch: true });
    assert.equal(decision.action, 'wait', `JST ${hour}時は dispatch してはいけない`);
  }
});

test('decideAction: 14時JST以降かつdispatch打ち止めならalarm', () => {
  assert.equal(decideAction({ cacheAsOf: null, targetDay: '2026-09-02', jstHour: 14, artifactDay: null, dispatchCountToday: 2, allowDispatch: true }).action, 'alarm');
});

test('decideAction: dispatch打ち止めでも14時JST前はwait', () => {
  assert.equal(decideAction({ cacheAsOf: null, targetDay: '2026-09-02', jstHour: 13, artifactDay: null, dispatchCountToday: 2, allowDispatch: true }).action, 'wait');
});

test('decideAction: --no-dispatch でもalarm/waitの境界は変わらない', () => {
  assert.equal(decideAction({ cacheAsOf: null, targetDay: '2026-09-02', jstHour: 11, artifactDay: null, dispatchCountToday: 0, allowDispatch: false }).action, 'wait');
  assert.equal(decideAction({ cacheAsOf: null, targetDay: '2026-09-02', jstHour: 14, artifactDay: null, dispatchCountToday: 0, allowDispatch: false }).action, 'alarm');
});

test('jstToday: UTC 15:00でJSTの日付が変わる', () => {
  assert.equal(jstToday(new Date('2026-09-01T15:00:00Z')), '2026-09-02');
  assert.equal(jstToday(new Date('2026-09-01T14:59:59Z')), '2026-09-01');
});

test('jstHour: UTC 15:00はJST 0時', () => {
  assert.equal(jstHour(new Date('2026-09-01T15:00:00Z')), 0);
});

test('parseEnvSecret: 通常値と引用符を処理する', () => {
  assert.equal(parseEnvSecret('TOP3_INGEST_SECRET=plain\n', 'TOP3_INGEST_SECRET'), 'plain');
  assert.equal(parseEnvSecret(' TOP3_INGEST_SECRET = "quoted value" \n', 'TOP3_INGEST_SECRET'), 'quoted value');
});

test('parseEnvSecret: キー無しと同名prefixを誤認しない', () => {
  assert.equal(parseEnvSecret('OTHER=value\n', 'TOP3_INGEST_SECRET'), null);
  assert.equal(parseEnvSecret('TOP3_INGEST_SECRET_X=wrong\n', 'TOP3_INGEST_SECRET'), null);
});

test('readLocalTop3: 正常JSONを読む', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top3-catchup-test-'));
  try {
    const file = path.join(dir, 'top3.json');
    fs.writeFileSync(file, JSON.stringify({ asOf: '2026-09-02', generatedAt: '2026-09-02T00:00:00Z', top3: [] }));
    assert.deepEqual(readLocalTop3(file), { asOf: '2026-09-02', generatedAt: '2026-09-02T00:00:00Z' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readLocalTop3: ファイル無しと壊れたJSONはnull', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top3-catchup-test-'));
  try {
    assert.equal(readLocalTop3(path.join(dir, 'missing.json')), null);
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{broken');
    assert.equal(readLocalTop3(broken), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
