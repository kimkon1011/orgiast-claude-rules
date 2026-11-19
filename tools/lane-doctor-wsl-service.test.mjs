import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, laneDoctorProbe } from './lane-doctor.mjs';

const now = Date.parse('2026-11-19T00:00:00Z');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-doctor-wsl-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  const token = `x.${Buffer.from(JSON.stringify({ email: 'test@example.com' })).toString('base64url')}.x`;
  atomicJson(path.join(home, '.codex/auth.json'), { tokens: { id_token: token } });
  fs.writeFileSync(path.join(home, '.claude/deepseek.env'), 'DEEPSEEK_API_KEY=test\n');
  fs.writeFileSync(path.join(home, '.claude/openrouter.env'), 'OPENROUTER_API_KEY=test\n');
  return home;
}

async function classify(t, provider, text, listWsl = () => 'Ubuntu') {
  const home = fixture(t);
  return laneDoctorProbe({ home, now, platform: 'win32', providers: [provider], listWsl,
    probe: async () => ({ code: 1, text }), notify: async () => ({ delivered: 'test' }) });
}

for (const text of [
  'Wsl/Service/CreateInstance failed with ERROR_SERVICE_DISABLED',
  'LxssManager cannot be started because サービスは無効です',
  'HCS: 要素が見つかりません'
]) test(`Codex の WSL サービス障害を物理操作に分類: ${text}`, async t => {
  const result = await classify(t, 'codex', text);
  assert.equal(result.lanes.codex.reason, 'dead:physical_operation');
  assert.match(result.lanes.codex.tried, /WSL/);
  assert.match(result.lanes.codex.userFix, /LxssManager.*wsl\.exe --install --no-distribution/);
});

test('Codex の空エラーかつ WSL 列挙 null を物理操作に分類', async t => {
  const result = await classify(t, 'codex', '', () => null);
  assert.equal(result.lanes.codex.reason, 'dead:physical_operation');
});

for (const provider of ['deepseek', 'openrouter']) test(`${provider} は同じ汎用文言でも物理操作に誤分類しない`, async t => {
  const result = await classify(t, provider, 'cannot be started: LxssManager');
  assert.equal(result.lanes[provider].reason, 'probe_failed');
  assert.equal(result.lanes[provider].tried, undefined);
});
