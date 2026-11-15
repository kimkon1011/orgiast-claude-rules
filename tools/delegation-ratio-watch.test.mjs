import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drw-${name}-`));
  return dir;
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

describe('delegation-ratio-watch', () => {
  test('安いAI実作業(out>200, ok)を正しく数える', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test1');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date(Date.now() - 3600000).toISOString(), provider: 'deepseek', model: 'deepseek-flash', status: 'ok', out: 500 },
        { t: new Date(Date.now() - 7200000).toISOString(), provider: 'groq', model: 'gpt-oss-120b', status: 'ok', out: 50 },
        { t: new Date(Date.now() - 1800000).toISOString(), provider: 'gemini', model: 'gemini-flash', status: 'ok', out: 300 },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.cheapAi.workCount, 2);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('deferred の no_fallback_flag と all_backends_failed を分けて数える', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test2');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'no_fallback_flag' },
        { t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'no_fallback_flag' },
        { t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'all_backends_failed' },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.deferred.noFallback, 2);
      assert.equal(result.deferred.allBackendsFailed, 1);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('24時間より古い行は集計しない', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test3');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date(Date.now() - 25 * 3600000).toISOString(), provider: 'deepseek', status: 'ok', out: 500 },
        { t: new Date(Date.now() - 3600000).toISOString(), provider: 'groq', status: 'ok', out: 300 },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.cheapAi.workCount, 1);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('quota_wait 中の呼出し数を lane-health.json から判定', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test4');
    try {
      const lh = path.join(home, '.claude', 'lane-health.json');
      fs.mkdirSync(path.dirname(lh), { recursive: true });
      fs.writeFileSync(lh, JSON.stringify({
        lanes: {
          glm: { alive: false, reason: 'quota_wait', until: Date.now() + 7 * 86400000 },
          groq: { alive: true, reason: 'probe_ok' },
        },
      }));
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date().toISOString(), provider: 'glm', status: 'http_429' },
        { t: new Date().toISOString(), provider: 'glm', status: 'http_429' },
        { t: new Date().toISOString(), provider: 'groq', status: 'ok', out: 500 },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.quotaWaitCalls, 2);
      assert.deepEqual(result.providers, ['glm']);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('deferred ≥ 10 で alert=true', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test5');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      const rows = [];
      for (let i = 0; i < 15; i++) {
        rows.push({ t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'no_fallback_flag' });
      }
      writeLines(usage, rows);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.alert, true);
      assert.ok(result.reasons.some(r => /deferred/.test(r)));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('weightedTokens: Opus=5, Sonnet=3, Haiku=1', async () => {
    const { weightedTokens } = await import('./delegation-ratio-watch.mjs');
    const base = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 };
    // Opus: 5 * (100 + 1.25*10 + 0.1*20 + 5*50) = 5 * 364.5 = 1822.5
    assert.equal(weightedTokens({ ...base, model: 'claude-opus-5-5' }), 1822.5);
    // Sonnet: 3 * 364.5 = 1093.5
    assert.equal(weightedTokens({ ...base, model: 'claude-sonnet-5-5' }), 1093.5);
    // Haiku: 1 * 364.5 = 364.5
    assert.equal(weightedTokens({ ...base, model: 'claude-haiku-5-5' }), 364.5);
  });
});