// 2026-11-08: kim-discord-allowlist 復活。allowlist.json には許可カテゴリ4件が入っている。
// 見出しは本体ソースから取り出し、手写しの定数にしない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discordAllowed, loadAllowlist } from './lib/kim-discord-allowlist.mjs';
import { deliverKim } from './notify-kim.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-allowlist-'));
fs.mkdirSync(path.join(emptyHome, '.claude'), { recursive: true });
fs.writeFileSync(path.join(emptyHome, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
const repoOnly = { home: emptyHome, repoRoot };

function sourceLiteral(file, regex) {
  const src = fs.readFileSync(path.join(repoRoot, 'tools', file), 'utf8');
  const m = regex.exec(src);
  assert.ok(m, `${file} に見出しの文字列が見つからない: ${regex}`);
  return m[1];
}

const HELP = 'config/kim-discord-allowlist.json';
test('正本の許可リストは空でなく、4件の許可カテゴリが定義されている', () => {
  const entries = JSON.parse(fs.readFileSync(path.join(repoRoot, HELP))).entries;
  assert.ok(Array.isArray(entries) && entries.length > 0, '許可リストが空です');
  const loaded = loadAllowlist(repoOnly);
  assert.ok(loaded.length >= 4, `許可リストが4件未満: ${loaded.length}`);
  assert.ok(loaded.some(e => e.category === 'progress-digest'));
  assert.ok(loaded.some(e => e.category === 'progress-done'));
  assert.ok(loaded.some(e => e.category === 'progress-health'));
  assert.ok(loaded.some(e => e.category === 'external-waiting'));
});

test('auto-progress-digest の実見出しは DM を許可する', () => {
  const template = sourceLiteral('auto-progress-digest.mjs', /const header = `(【\$\{pcLabel\} の自動進行】[^`]*)`/);
  const sample = template.replace('${pcLabel}', '作業用011').replace(/\$\{[^}]+\}/g, '0');
  assert.ok(discordAllowed(sample, repoOnly).allowed, `進捗まとめ見出しが許可されない: ${sample}`);
  const summary = sourceLiteral('auto-progress-digest.mjs', /`(【進捗まとめ】)\\n/);
  assert.ok(discordAllowed(`${summary}\nテスト`, repoOnly).allowed);
});

test('auto-progress-watch の完了通知と未通知一覧の実見出しは DM を許可する', () => {
  const done = sourceLiteral('auto-progress-watch.mjs', /'(✅ 自動進行が完了しました)'/);
  const backlog = sourceLiteral('auto-progress-watch.mjs', /'(📋 未通知だった自動進行の完了一覧)/);
  assert.ok(discordAllowed(`${done}\n約束: x`, repoOnly).allowed);
  assert.ok(discordAllowed(`${backlog}\n…`, repoOnly).allowed);
});

test('マージ依頼・作業共有の文は許可されない（kim 宛 DM は要対応・定期報告だけ）', () => {
  assert.equal(discordAllowed('PR #123 をマージしてください', repoOnly).allowed, false);
  assert.equal(discordAllowed('作業の共有です。ファイルを更新しました', repoOnly).allowed, false);
});

test('許可カテゴリに該当する本文は DM で配送される', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (String(url).endsWith('/users/@me/channels')) return { ok: true, status: 200, json: async () => ({ id: 'ch1' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'msg1' }) };
  };
  const result = await deliverKim('【作業用011 の自動進行】 完了 1件・止まっている 0件', {
    home: emptyHome, repoRoot, fetchImpl, token: 'test-token',
    plainJa: true, plainJaImpl: async () => '自動で進めている作業のまとめです。完了 1件、止まっているもの 0件。',
  });
  assert.equal(result.delivered, 'dm', JSON.stringify(result));
  assert.ok(calls.length > 0, 'Discord API が呼ばれていません');
});

test('許可カテゴリ非該当の本文は kim-inbox に配送される', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (String(url).endsWith('/users/@me/channels')) return { ok: true, status: 200, json: async () => ({ id: 'ch1' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'msg1' }) };
  };
  const result = await deliverKim('PR #123 をマージしてください', {
    home: emptyHome, repoRoot, fetchImpl, token: 'test-token',
    plainJa: true, plainJaImpl: async () => 'PR #123 をマージしてください。',
  });
  assert.equal(result.delivered, 'session-inbox', JSON.stringify(result));
  assert.equal(calls.length, 0, 'Discord API が呼ばれてはいけません');
});
