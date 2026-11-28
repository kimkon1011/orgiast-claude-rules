import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../tools/lane-doctor.mjs';

test('alive:false かつ probeResult:alive のレーンに probe記録の注釈が付く', () => {
  const health = {
    ts: '2026-11-29T00:00:00.000Z',
    lanes: {
      codex: {
        alive: false,
        reason: 'quota_wait',
        probeResult: 'alive',
        probedAt: '2026-11-28T13:53:00.000Z',
        until: Date.parse('2026-12-02T00:00:00.000Z'),
      },
    },
    repairs: [],
    errors: [],
  };
  const result = summarize(health);
  assert.ok(result.includes('（probe記録は alive・607分前）'),
    `expected probe note in summary, got: ${result}`);
});

test('alive:false かつ probeResult:fail のレーンに probe記録の注釈が付かない', () => {
  const health = {
    ts: '2026-11-29T00:00:00.000Z',
    lanes: {
      codex: {
        alive: false,
        reason: 'probe_failed',
        probeResult: 'fail',
        probedAt: '2026-11-28T13:53:00.000Z',
      },
    },
    repairs: [],
    errors: [],
  };
  const result = summarize(health);
  assert.ok(!result.includes('probe記録は alive'),
    `unexpected probe note in summary, got: ${result}`);
});

test('alive:true のレーンだけを渡した戻り値は probe記録の注釈を含まず「生存: 」で始まる', () => {
  const health = {
    ts: '2026-11-29T00:00:00.000Z',
    lanes: {
      codex: {
        alive: true,
        reason: 'auth_ok:probe_ok',
        probeResult: 'alive',
        probedAt: '2026-11-29T00:00:00.000Z',
      },
    },
    repairs: [],
    errors: [],
  };
  const result = summarize(health);
  assert.ok(result.startsWith('生存: '),
    `expected summary to start with '生存: ', got: ${result}`);
  assert.ok(!result.includes('probe記録は alive'),
    `unexpected probe note in summary, got: ${result}`);
});