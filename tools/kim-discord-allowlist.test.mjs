// kim 宛の定期ダイジェスト・完了通知が許可リストで Discord に通ることを守る退行テスト。
// 2026-11-02 の #1279 で許可リストが空のまま全通知が kim-inbox に落ち、kim が「進捗どう？」と聞く状態に戻った（9回目）。
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
const repoOnly = { home: emptyHome, repoRoot };

function sourceLiteral(file, regex) {
  const src = fs.readFileSync(path.join(repoRoot, 'tools', file), 'utf8');
  const m = regex.exec(src);
  assert.ok(m, `${file} に見出しの文字列が見つからない: ${regex}`);
  return m[1];
}

test('正本の許可リストは空ではなく、定期ダイジェスト・完了通知・配送警告の区分を持つ', () => {
  const entries = loadAllowlist(repoOnly);
  const categories = new Set(entries.map((e) => e.category));
  for (const c of ['progress-digest', 'progress-done', 'progress-health']) assert.ok(categories.has(c), `許可リストに ${c} が無い`);
});

test('auto-progress-digest の実見出しは許可される', () => {
  const template = sourceLiteral('auto-progress-digest.mjs', /const header = `(【\$\{pcLabel\} の自動進行】[^`]*)`/);
  const sample = template.replace('${pcLabel}', '作業用011').replace(/\$\{[^}]+\}/g, '0');
  assert.equal(discordAllowed(sample, repoOnly).allowed, true, sample);
  const summary = sourceLiteral('auto-progress-digest.mjs', /`(【進捗まとめ】)\\n/);
  assert.equal(discordAllowed(`${summary}\nテスト`, repoOnly).allowed, true);
});

test('auto-progress-watch の完了通知と未通知一覧の実見出しは許可される', () => {
  const done = sourceLiteral('auto-progress-watch.mjs', /'(✅ 自動進行が完了しました)'/);
  const backlog = sourceLiteral('auto-progress-watch.mjs', /'(📋 未通知だった自動進行の完了一覧)/);
  assert.equal(discordAllowed(`${done}\n約束: x`, repoOnly).allowed, true);
  assert.equal(discordAllowed(`${backlog}\n…`, repoOnly).allowed, true);
});

test('マージ依頼・作業共有の文は許可されない（kim 宛 DM は要対応・定期報告だけ）', () => {
  assert.equal(discordAllowed('PR #123 をマージしてください', repoOnly).allowed, false);
  assert.equal(discordAllowed('作業の共有です。ファイルを更新しました', repoOnly).allowed, false);
});

test('平易化で見出しが書き換わっても、原文が許可リストに合えば Discord へ送る', async () => {
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
  assert.equal(calls.length, 2);
});
