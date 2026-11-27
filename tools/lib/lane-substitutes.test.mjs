import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LANE_SUBSTITUTES_PATH,
  loadLaneSubstitutes,
  computeSubstituted,
  substituteActive,
} from './lane-substitutes.mjs';

test('台帳に gemini/grok の OpenRouter 代替が正式登録されている', () => {
  const ledger = loadLaneSubstitutes();
  assert.equal(ledger.via, 'openrouter');
  assert.equal(ledger.models.gemini, 'google/gemini-3.6-flash');
  assert.equal(ledger.models.grok, 'x-ai/grok-4.6');
  assert.equal(path.basename(LANE_SUBSTITUTES_PATH), 'lane-openrouter-substitutes.json');
  assert.ok(fs.existsSync(LANE_SUBSTITUTES_PATH));
  const geminiMissing = ledger.rules.find(r => r.providers?.includes('gemini') && r.match?.reasonEquals === 'missing_key');
  assert.ok(geminiMissing);
  assert.equal(geminiMissing.requireViaAlive, true);
  const billing = ledger.rules.find(r => r.match?.reasonEquals === 'billing');
  assert.ok(billing);
  assert.ok(billing.providers.includes('*'));
});

test('billing の gemini/grok は OpenRouter 代替として substituted に載る', () => {
  const lanes = {
    gemini: { alive: false, reason: 'billing' },
    grok: { alive: false, reason: 'billing' },
    openrouter: { alive: true, reason: 'probe_ok' },
  };
  assert.deepEqual(computeSubstituted(lanes, { isLane: p => ['gemini', 'grok', 'openrouter'].includes(p) }), [
    { provider: 'gemini', via: 'openrouter' },
    { provider: 'grok', via: 'openrouter' },
  ]);
  assert.equal(substituteActive({ via: 'openrouter' }, { lanes }), true);
});

test('OpenRouter 停止時は gemini missing_key を代替にしない', () => {
  const lanes = {
    gemini: { alive: false, reason: 'missing_key' },
    openrouter: { alive: false, reason: 'missing_key' },
  };
  assert.deepEqual(computeSubstituted(lanes, { isLane: () => true }), []);
});

test('一時台帳ファイルを読んでルールを適用できる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-substitutes-'));
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify({
    via: 'openrouter',
    rules: [{ providers: ['grok'], match: { reasonEquals: 'billing' }, requireViaAlive: true }],
  }));
  const ledger = loadLaneSubstitutes(file);
  const ok = computeSubstituted(
    { grok: { alive: false, reason: 'billing' }, openrouter: { alive: true } },
    { ledger, isLane: () => true },
  );
  const dead = computeSubstituted(
    { grok: { alive: false, reason: 'billing' }, openrouter: { alive: false } },
    { ledger, isLane: () => true },
  );
  assert.deepEqual(ok, [{ provider: 'grok', via: 'openrouter' }]);
  assert.deepEqual(dead, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
