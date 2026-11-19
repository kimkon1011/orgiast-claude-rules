import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'tools');
const posix = value => value.split(path.sep).join('/');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

function callsBeeperSend(source) {
  if (!/from ['"]\.\/beeper-api\.mjs['"]/u.test(source)) return false;
  if (/\bsendMessage\s*\(/u.test(source)) return true;
  // Dependency injection still dispatches through the production sendMessage by default.
  return [...source.matchAll(/\b(\w+)\s*=\s*sendMessage\b/gu)]
    .some(([, name]) => new RegExp(`\\b${name}\\s*\\(`, 'u').test(source));
}

export function scanExternalSendEntries() {
  const found = [];
  for (const file of files(tools).filter(file => file.endsWith('.mjs') && !file.endsWith('.test.mjs') && !file.includes(`${path.sep}lib${path.sep}`))) {
    const source = fs.readFileSync(file, 'utf8');
    const sends = /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/drafts\/send/u.test(source)
      || (/seisaku-mail\.yml/u.test(source) && /workflow['"],?\s*['"]run/u.test(source))
      || /api\.line\.me\/v2\/bot\/message\/(?:push|multicast|broadcast)/u.test(source)
      || /\/channels\/\$\{[^}]+\}\/messages[^;]{0,300}method:\s*['"]POST['"]/su.test(source)
      || callsBeeperSend(source);
    if (sends) found.push(posix(path.relative(root, file)));
  }
  return found.sort();
}

test('Beeper の直接呼び出しと依存注入された送信を検出し、import だけでは登録を要求しない', () => {
  const header = "import { sendMessage } from './beeper-api.mjs';\n";
  assert.equal(callsBeeperSend(header + 'await sendMessage(chat, text);'), true);
  assert.equal(callsBeeperSend(header + 'async function run({ send = sendMessage } = {}) { await send(chat, text); }'), true);
  assert.equal(callsBeeperSend(header + 'async function run({ dispatch = sendMessage } = {}) { await dispatch(chat, text); }'), true);
  assert.equal(callsBeeperSend(header), false);
  assert.equal(callsBeeperSend(header + 'function run({ send = sendMessage } = {}) {}'), false);
  assert.equal(callsBeeperSend('await sendMessage(chat, text);'), false);
});

test('外部送信 API を呼ぶ全エントリが保護方式付きで登録されている', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'config', 'external-send-registry.json'), 'utf8'));
  const found = scanExternalSendEntries();
  assert.deepEqual(Object.keys(registry).sort(), found, `送信経路の登録表を更新してください: ${JSON.stringify(found)}`);
  for (const [file, row] of Object.entries(registry)) {
    assert.ok(['mail-send-approval-gate', 'send-dedupe', 'tool-send-dedupe', 'send-context-check', 'internal-only'].includes(row.protection), `${file}: protection が不正`);
  }
  assert.equal(registry['tools/gmail-draft.mjs'].protection, 'send-dedupe');
  assert.equal(registry['tools/seisaku-mail.mjs'].protection, 'send-dedupe');
});
