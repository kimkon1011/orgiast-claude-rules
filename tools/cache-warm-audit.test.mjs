// tools/cache-warm-audit.test.mjs
// cache-warm-audit.mjs の検証。合成 JSONL を os.tmpdir() 配下の一時ディレクトリに書き、
// 関数レベルの健全性と CLI 経由（--json / --since / --help / 対象なし）の両方を確認する。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeJsonl, isCompactBoundary, isPlaceholderModel, scanDir } from './cache-warm-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(__dirname, 'cache-warm-audit.mjs');
const EXE = process.execPath;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-test-'));
}

function runCli(args) {
  return execFileSync(EXE, [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

// ---- 合成 JSONL ヘルパー ----
function assistantLine({ ts, model, usage, sessionId }) {
  const message = { model };
  if (usage) message.usage = usage;
  return JSON.stringify({ type: 'assistant', timestamp: ts, sessionId, message });
}

function userLine({ ts, compact = false }) {
  const content = compact
    ? [{ type: 'text', text: '<previous-context-summary>', isCompactSummary: true }]
    : [{ type: 'text', text: 'hi' }];
  return JSON.stringify({ type: 'user', timestamp: ts, sessionId: 's', message: { role: 'user', content } });
}

function writeSession(dir, name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

const TS = '2026-11-10T05:00:00.000Z';

// セッションA: モデル固定・cacheRead 大 → フラグなし・savedUsd > 0
function sessionA() {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(
      assistantLine({
        ts: TS,
        model: 'claude-opus-5',
        sessionId: 'A',
        usage: { input_tokens: 2000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: 300 },
      }),
    );
  }
  return lines;
}

// セッションB: 途中でモデル切替 → MODEL_SWITCH + events
function sessionB() {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 10000, output_tokens: 50 };
  return [
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'B', usage }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'B', usage }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'B', usage }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'B', usage }),
  ];
}

// セッションC: 毎ターン cacheWrite 大・cacheRead 0 → COLD_START_LOOP + LOW_HIT
function sessionC() {
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(
      assistantLine({
        ts: TS,
        model: 'claude-sonnet-5-5',
        sessionId: 'C',
        usage: { input_tokens: 1000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 100 },
      }),
    );
  }
  return lines;
}

test('isCompactBoundary: isCompactSummary:true と subtype:compact の両対応', () => {
  assert.equal(isCompactBoundary('{"type":"user","message":{"content":[{"isCompactSummary":true}]}}', null), true);
  assert.equal(isCompactBoundary('{"type":"assistant","subtype":"compact","message":{}}', null), true);
  assert.equal(isCompactBoundary('{"type":"user","message":{"role":"user"}}', null), false);
  const parsed = JSON.parse('{"type":"user","subtype":"compact"}');
  assert.equal(isCompactBoundary('', parsed), true);
});

test('A: モデル固定・cacheRead 大 → フラグなし・savedUsd > 0', () => {
  const p = writeSession(tmpDir(), 'A.jsonl', sessionA());
  const s = analyzeJsonl(p);
  assert.deepEqual(s.flags, []);
  assert.equal(s.modelSwitches, 0);
  assert.ok(s.hitRate > 0.9, 'hitRate が高いこと');
  assert.ok(s.savedUsd > 0, 'キャッシュにより削減額が出ること');
  assert.equal(s.turns, 4);
  assert.equal(s.badLines, 0);
});

test('B: 途中でモデル切替 → MODEL_SWITCH と events の from/to が正しい', () => {
  const p = writeSession(tmpDir(), 'B.jsonl', sessionB());
  const s = analyzeJsonl(p);
  assert.ok(s.flags.includes('MODEL_SWITCH'));
  assert.equal(s.modelSwitches, 1);
  assert.equal(s.events.length, 1);
  const ev = s.events[0];
  assert.equal(ev.at, 2);
  assert.equal(ev.from, 'claude-opus-5');
  assert.equal(ev.to, 'claude-sonnet-5-5');
  const rate = 10000 / (100 + 100 + 10000); // 各行のヒット率 50/51
  assert.ok(Math.abs(ev.beforeHitRate - rate) < 1e-9, 'beforeHitRate は切替前3行の平均');
  assert.ok(Math.abs(ev.afterHitRate - rate) < 1e-9, 'afterHitRate は切替後3行の平均');
  assert.equal(ev.hitDrop, false);
  assert.deepEqual(s.models, ['claude-opus-5', 'claude-sonnet-5-5']);
  assert.ok(!s.flags.includes('COLD_START_LOOP'));
  assert.ok(!s.flags.includes('LOW_HIT'));
});

test('C: 毎ターン cacheWrite 大・cacheRead 0 → COLD_START_LOOP と LOW_HIT', () => {
  const p = writeSession(tmpDir(), 'C.jsonl', sessionC());
  const s = analyzeJsonl(p);
  assert.equal(s.hitRate, 0);
  assert.ok(s.flags.includes('COLD_START_LOOP'));
  assert.ok(s.flags.includes('LOW_HIT'));
  assert.ok(!s.flags.includes('MODEL_SWITCH'));
});

test('壊れた行（{oops）を混ぜても throw せず badLines が増える', () => {
  const lines = [
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'X', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } }),
    '{oops',
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'X', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } }),
    'not json at all',
  ];
  const p = writeSession(tmpDir(), 'broken.jsonl', lines);
  const s = analyzeJsonl(p);
  assert.equal(s.badLines, 2);
  assert.equal(s.turns, 2);
});

test('usage 無しの assistant 行のみ → hitRate null で落ちない', () => {
  const lines = [
    '{"type":"user","timestamp":"' + TS + '","sessionId":"N","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"assistant","timestamp":"' + TS + '","sessionId":"N","message":{"model":"claude-opus-5","content":[{"type":"text","text":"ok"}]}}',
    '{"type":"assistant","timestamp":"' + TS + '","sessionId":"N","message":{"model":"claude-opus-5","content":[{"type":"text","text":"ok2"}]}}',
  ];
  const p = writeSession(tmpDir(), 'nousage.jsonl', lines);
  const s = analyzeJsonl(p);
  assert.equal(s.hitRate, null);
  assert.equal(s.turns, 2);
  assert.deepEqual(s.flags, []);
});

test('コンパクト境界 → COMPACT フラグと compactions 件数', () => {
  const lines = [
    userLine({ ts: TS, compact: true }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'K', usage: { input_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 50000, output_tokens: 100 } }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'K', usage: { input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 60000, output_tokens: 100 } }),
  ];
  const p = writeSession(tmpDir(), 'compact.jsonl', lines);
  const s = analyzeJsonl(p);
  assert.equal(s.compactions, 1);
  assert.ok(s.flags.includes('COMPACT'));
});

test('--json の出力が JSON.parse でき、sessions.length が期待どおり', () => {
  const dir = tmpDir();
  writeSession(dir, 'A.jsonl', sessionA());
  writeSession(dir, 'B.jsonl', sessionB());
  writeSession(dir, 'C.jsonl', sessionC());
  const out = runCli(['--json', '--dir', dir]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.dir, dir);
  assert.equal(parsed.sessions.length, 3);
  const ids = parsed.sessions.map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ['A', 'B', 'C']);
});

test('--since で古いセッションが除外される', () => {
  const dir = tmpDir();
  const old = [assistantLine({ ts: '2026-11-01T00:00:00.000Z', model: 'claude-opus-5', sessionId: 'old', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 5 } })];
  const newer = [assistantLine({ ts: '2026-11-10T00:00:00.000Z', model: 'claude-opus-5', sessionId: 'new', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 5 } })];
  writeSession(dir, 'old.jsonl', old);
  writeSession(dir, 'new.jsonl', newer);

  const filtered = JSON.parse(runCli(['--json', '--dir', dir, '--since', '2026-11-05']));
  assert.deepEqual(filtered.sessions.map((s) => s.sessionId), ['new']);

  const all = JSON.parse(runCli(['--json', '--dir', dir, '--since', '2026-10-01']));
  assert.equal(all.sessions.length, 2);
});

test('scanDir: ディレクトリ無し・一致ファイル0件でも空配列（落ちない）', () => {
  assert.deepEqual(scanDir(path.join(tmpDir(), 'no-such-dir')), []);
  assert.deepEqual(scanDir(tmpDir()), []);
});

test('--help は exit 0 でヘルプを出す', () => {
  const out = runCli(['--help']);
  assert.match(out, /cache-warm-audit/);
});

test('対象なしでも exit 0 で「対象なし」', () => {
  const out = runCli(['--dir', tmpDir()]);
  assert.match(out, /対象なし/);
});

test('プレースホルダ（<synthetic>）は models / modelSwitches に数えない', () => {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000, output_tokens: 10 };
  // A → synthetic → A: 切替0
  const noSwitch = [
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'P1', usage }),
    assistantLine({ ts: TS, model: '<synthetic>', sessionId: 'P1', usage }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'P1', usage }),
  ];
  const s1 = analyzeJsonl(writeSession(tmpDir(), 'ph-a.jsonl', noSwitch));
  assert.equal(s1.modelSwitches, 0);
  assert.deepEqual(s1.events, []);
  assert.deepEqual(s1.models, ['claude-opus-5']);

  // A → synthetic → B: 切替1（from=A, to=B）
  const oneSwitch = [
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'P2', usage }),
    assistantLine({ ts: TS, model: '<synthetic>', sessionId: 'P2', usage }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'P2', usage }),
  ];
  const s2 = analyzeJsonl(writeSession(tmpDir(), 'ph-b.jsonl', oneSwitch));
  assert.equal(s2.modelSwitches, 1);
  assert.equal(s2.events.length, 1);
  assert.equal(s2.events[0].from, 'claude-opus-5');
  assert.equal(s2.events[0].to, 'claude-sonnet-5-5');
  assert.deepEqual(s2.models, ['claude-opus-5', 'claude-sonnet-5-5']);
});

test('切替前 0.99・切替後 0.1 の合成データで SWITCH_CACHE_LOSS が立ち hitDrop=true', () => {
  const high = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 9900, output_tokens: 10 };
  const low = { input_tokens: 9000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 10 };
  const switchRow = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 };
  const lines = [
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'Loss', usage: high }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'Loss', usage: high }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'Loss', usage: high }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Loss', usage: switchRow }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Loss', usage: low }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Loss', usage: low }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Loss', usage: low }),
  ];
  const s = analyzeJsonl(writeSession(tmpDir(), 'loss.jsonl', lines));
  assert.ok(s.flags.includes('MODEL_SWITCH'));
  assert.ok(s.flags.includes('SWITCH_CACHE_LOSS'));
  assert.equal(s.events.length, 1);
  const ev = s.events[0];
  assert.ok(Math.abs(ev.beforeHitRate - 0.99) < 1e-9, '切替前は 3 行平均 0.99');
  assert.ok(Math.abs(ev.afterHitRate - 0.1) < 1e-9, '切替後は 3 行平均 0.1');
  assert.equal(ev.hitDrop, true);
});

test('切替後も hitRate 0.95 なら SWITCH_CACHE_LOSS は立たない', () => {
  const high = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 9900, output_tokens: 10 };
  const mid = { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 9500, output_tokens: 10 };
  const lines = [
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'Keep', usage: high }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'Keep', usage: high }),
    assistantLine({ ts: TS, model: 'claude-opus-5', sessionId: 'Keep', usage: high }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Keep', usage: mid }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Keep', usage: mid }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Keep', usage: mid }),
    assistantLine({ ts: TS, model: 'claude-sonnet-5-5', sessionId: 'Keep', usage: mid }),
  ];
  const s = analyzeJsonl(writeSession(tmpDir(), 'keep.jsonl', lines));
  assert.ok(s.flags.includes('MODEL_SWITCH'));
  assert.ok(!s.flags.includes('SWITCH_CACHE_LOSS'));
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].hitDrop, false);
});

test('isPlaceholderModel: <placeholder> や synthetic を含むモデル名を正しく判定', () => {
  assert.equal(isPlaceholderModel('<synthetic>'), true);
  assert.equal(isPlaceholderModel('<custom-model>'), true);
  assert.equal(isPlaceholderModel('model-synthetic-v1'), true);
  assert.equal(isPlaceholderModel('SYNTHETIC'), true);
  assert.equal(isPlaceholderModel('claude-opus-5'), false);
  assert.equal(isPlaceholderModel('claude-sonnet-5-5'), false);
  assert.equal(isPlaceholderModel(''), false);
  assert.equal(isPlaceholderModel(null), false);
  assert.equal(isPlaceholderModel(undefined), false);
});