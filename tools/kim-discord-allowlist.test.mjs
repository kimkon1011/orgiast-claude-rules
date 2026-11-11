// kim 宛 Discord DM 全廃（2026-10-27 / 2026-11-10 kim 再指示）。
// 許可リストは常に空で、discordAllowed は常に false を返す。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discordAllowed, loadAllowlist } from './lib/kim-discord-allowlist.mjs';
import { deliverKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-allowlist-'));
fs.mkdirSync(path.join(emptyHome, '.claude'), { recursive: true });
fs.writeFileSync(path.join(emptyHome, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
const repoOnly = { home: emptyHome, repoRoot };

test('config/kim-discord-allowlist.json の entries は常に空', () => {
  const { entries } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/kim-discord-allowlist.json')));
  assert.ok(Array.isArray(entries) && entries.length === 0, 'entries が空ではありません');
});

test('loadAllowlist は常に空配列を返す', () => {
  const loaded = loadAllowlist(repoOnly);
  assert.ok(Array.isArray(loaded) && loaded.length === 0);
  // 直接のエントリを渡しても無視する
  const explicit = discordAllowed('This includes progress-digest text and ✅ is complete', { allowlist: [{ category: 'test', pattern: '.' }] });
  assert.equal(explicit.allowed, false, 'allowlist オプションを渡されても false');
});

test('任意の本文に対して discordAllowed は常に false', () => {
  for (const text of [
    '【進捗まとめ】',
    '✅ 自動進行が完了しました',
    '⚠️ 進捗ダイジェストが Discord に届いていません',
    '【社外返信待ち】',
    'PR #123 をマージしてください',
    '緊急の障害です',
    '【作業用011 の自動進行】',
  ]) {
    assert.equal(discordAllowed(text, repoOnly).allowed, false, `許可されるべきでない: ${text}`);
  }
});

test('deliverKim は kim 宛なら常に inbox のみ、Discord API を呼ばない', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (String(url).endsWith('/users/@me/channels')) return { ok: true, status: 200, json: async () => ({ id: 'ch1' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'msg1' }) };
  };
  // すべてのカテゴリのテキストで Discord API が呼ばれず inbox へ保存される
  for (const text of [
    '【作業用011 の自動進行】 完了 1件',
    '✅ 自動進行が完了しました',
    'PR #123 をマージしてください',
  ]) {
    calls.length = 0;
    const result = await deliverKim(text, {
      home: emptyHome, repoRoot, fetchImpl, token: 'test-token',
      plainJa: true, plainJaImpl: async t => t,
    });
    assert.equal(result.delivered, 'session-inbox', `kim 宛テキスト「${text}」が DM 配送されました`);
    assert.equal(calls.length, 0, `kim 宛テキスト「${text}」で Discord API が呼ばれました`);
  }
});