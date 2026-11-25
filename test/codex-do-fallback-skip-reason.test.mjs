import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cheapCodeBackendWithReason } from '../tools/codex-do.mjs';

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-do-fallback-reason-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('未知の cheap-code provider は unknown-provider を返す', (t) => {
  const result = cheapCodeBackendWithReason('cheap-code:other', temporaryHome(t));
  assert.equal(result.backend, null);
  assert.equal(result.reason, 'unknown-provider');
});

test('deepseek の OpenRouter cooldown は billing-openrouter を返す', (t) => {
  const home = temporaryHome(t);
  fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify({
    openrouter: { until: Date.now() + 60_000, reason: 'http_402' },
  }));
  const result = cheapCodeBackendWithReason('cheap-code:deepseek', home);
  assert.equal(result.backend, null);
  assert.equal(result.reason, 'billing-openrouter');
});

test('deepseek のキーファイルが無い場合は missing-key と対象キーを返す', (t) => {
  const result = cheapCodeBackendWithReason('cheap-code:deepseek', temporaryHome(t));
  assert.equal(result.backend, null);
  assert.equal(result.reason, 'missing-key');
  assert.equal(result.keyFile, 'openrouter.env');
  assert.equal(result.keyEnv, 'OPENROUTER_API_KEY');
});

test('deepseek のキーがあり cooldown が無ければ backend を返し reason は無い', (t) => {
  const home = temporaryHome(t);
  fs.writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'OPENROUTER_API_KEY=test-key\n');
  const result = cheapCodeBackendWithReason('cheap-code:deepseek', home);
  assert.equal(result.reason, undefined);
  assert.equal(result.backend?.name, 'cheap-code:deepseek');
  assert.equal(result.backend?.provider, 'deepseek');
});
