import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// インストーラ・テンプレは tools/feedback-kit/ 配下（onboarding-sync の配布対象）にある。
// 動的 import にして、万一欠けた環境では skip する。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = path.join(repoRoot, 'tools', 'feedback-kit', 'widget', 'install.mjs');
const gasRelayPath = path.join(repoRoot, 'tools', 'feedback-kit', 'gas', 'templates', 'FeedbackRelay.js');
const hasPackages = fs.existsSync(installerPath) && fs.existsSync(gasRelayPath);

test('インストーラは有効な Discord user ID だけを開発者IDとして採用する', { skip: hasPackages ? false : 'packages/ が無い配布環境' }, async () => {
  const { readOwnerDiscordId } = await import(pathToFileURL(installerPath).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-discord-id-'));
  const file = path.join(dir, 'orgiast-discord-user-id.txt');
  try {
    fs.writeFileSync(file, '715210673642012733\n', 'utf8');
    assert.equal(readOwnerDiscordId(file), '715210673642012733');
    assert.equal(readOwnerDiscordId(path.join(dir, 'missing.txt')), '');
    fs.writeFileSync(file, 'not-an-id\n', 'utf8');
    assert.equal(readOwnerDiscordId(file), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GAS テンプレは開発者ID・提出者IDの受け渡しを持つ', { skip: hasPackages ? false : 'packages/ が無い配布環境' }, () => {
  const source = fs.readFileSync(gasRelayPath, 'utf8');
  for (const marker of ['owner_discord_id', 'FEEDBACK_OWNER_DISCORD_ID', 'hasOwnerDiscordId', 'submitter_discord_id']) {
    assert.match(source, new RegExp(marker), `FeedbackRelay.js に ${marker} が無い`);
  }
});
