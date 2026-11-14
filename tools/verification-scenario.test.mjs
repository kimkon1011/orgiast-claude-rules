import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateScenario,
  createScenarioTemplate,
  replayScenario,
  listScenarios,
  formatJourneyMap,
  VALID_STEP_TYPES,
} from '../tools/verification-scenario.mjs';

// ── ヘルパー ───────────────────────────────────────────────────────

function validScenario(overrides = {}) {
  return {
    schema: 'x0048-v1',
    id: 'test-001',
    name: 'テストシナリオ',
    target: 'apps/expo-apply/index.html',
    createdAt: '2026-11-14T00:00:00Z',
    tags: ['test'],
    journey: {
      id: 'test-001-journey',
      name: 'テストジャーニー',
      entryPoint: '/',
      routes: ['正常系'],
      permissions: { anonymous: true },
      testData: { validInput: { companyName: 'Test' }, invalidInputs: [] },
      stableControls: { submitButton: '#submitBtn', formSelector: '#app-form' },
      failureStates: ['バリデーションエラー'],
    },
    steps: [
      { id: 'step-001', description: 'ページを開く', type: 'navigate', payload: { url: '/' } },
      { id: 'step-002', description: '入力を検証', type: 'assert', payload: { selector: '#confRef', expected: { visible: true } } },
    ],
    failureCases: [],
    ...overrides,
  };
}

// ── validateScenario ────────────────────────────────────────────────

describe('validateScenario', () => {
  test('有効なシナリオは valid=true', () => {
    const result = validateScenario(validScenario());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test('null/undefined は invalid', () => {
    assert.equal(validateScenario(null).valid, false);
    assert.equal(validateScenario(undefined).valid, false);
  });

  test('schema 不一致を検出', () => {
    const result = validateScenario(validScenario({ schema: 'v0' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('schema')));
  });

  test('id 欠落を検出', () => {
    const { id, ...rest } = validScenario();
    const result = validateScenario(rest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('id')));
  });

  test('name 欠落を検出', () => {
    const { name, ...rest } = validScenario();
    const result = validateScenario(rest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('name')));
  });

  test('target 欠落を検出', () => {
    const { target, ...rest } = validScenario();
    const result = validateScenario(rest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('target')));
  });

  test('steps 空を検出', () => {
    const result = validateScenario(validScenario({ steps: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('steps')));
  });

  test('steps 未定義を検出', () => {
    const { steps, ...rest } = validScenario();
    const result = validateScenario(rest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('steps')));
  });

  test('無効な step.type は validateScenario を通過する（replayScenario 側で検出）', () => {
    const result = validateScenario(validScenario({
      steps: [{ id: 'bad', description: 'bad', type: 'invalid_type' }],
    }));
    // validateScenario は type を検証しない（replayScenario が個別チェックするため）
    assert.equal(result.valid, true);
  });

  test('step の id/description 欠落を検出', () => {
    const result = validateScenario(validScenario({
      steps: [{ type: 'click' }],
    }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('id')));
    assert.ok(result.errors.some(e => e.includes('description')));
  });

  test('journey の必須項目欠落を検出', () => {
    const result = validateScenario(validScenario({
      journey: { id: 'partial' },
    }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('journey.name')));
    assert.ok(result.errors.some(e => e.includes('journey.entryPoint')));
    assert.ok(result.errors.some(e => e.includes('journey.routes')));
  });
});

// ── createScenarioTemplate ─────────────────────────────────────────

describe('createScenarioTemplate', () => {
  test('テンプレートが正しい構造を持つ', () => {
    const tpl = createScenarioTemplate('My Test', 'target/file.html');
    assert.equal(tpl.schema, 'x0048-v1');
    assert.equal(tpl.name, 'My Test');
    assert.equal(tpl.target, 'target/file.html');
    assert.ok(tpl.id.startsWith('scenario-'));
    assert.ok(tpl.createdAt);
    assert.ok(Array.isArray(tpl.steps));
    assert.ok(tpl.steps.length > 0);
    assert.ok(tpl.journey);
    assert.ok(Array.isArray(tpl.failureCases));
    assert.ok(tpl.claimEvidence);
    assert.equal(tpl.claimEvidence.behavior.evidenceType, 'journey-replay + screenshot');
    assert.equal(tpl.claimEvidence.performance.evidenceType, 'comparable-build-timing');
    assert.equal(tpl.claimEvidence.codeQuality.evidenceType, 'types + lint + regression-tests');
  });

  test('名前なしでも生成できる', () => {
    const tpl = createScenarioTemplate();
    assert.ok(tpl.name);
    assert.equal(tpl.target, '');
  });
});

// ── replayScenario ─────────────────────────────────────────────────

describe('replayScenario', () => {
  test('有効なシナリオは全ステップPASS (dry-run)', () => {
    const result = replayScenario(validScenario());
    assert.equal(result.passed, true);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every(r => r.status.startsWith('PASS')));
  });

  test('無効なシナリオは pre-check FAIL', () => {
    const result = replayScenario({ schema: 'bad' });
    assert.equal(result.passed, false);
    assert.equal(result.results[0].stepId, 'pre-check');
    assert.ok(result.results[0].status.startsWith('FAIL'));
  });

  test('不完全なステップは個別FAIL', () => {
    const result = replayScenario(validScenario({
      steps: [
        { id: 'ok', description: 'OK', type: 'click' },
        { id: 'bad', description: 'Bad', type: 'hover' }, // hover は VALID_STEP_TYPES にない
      ],
    }));
    assert.equal(result.passed, false);
    assert.equal(result.results[0].status.startsWith('PASS'), true);
    assert.equal(result.results[1].status.startsWith('FAIL'), true);
  });
});

// ── listScenarios ──────────────────────────────────────────────────

describe('listScenarios', () => {
  test('空ディレクトリは空配列を返す', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scenario-test-'));
    try {
      const result = listScenarios(tmp);
      assert.deepEqual(result, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('JSONファイルを正しくパースする', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scenario-test-'));
    try {
      const scenario = validScenario();
      writeFileSync(join(tmp, 'test-001.json'), JSON.stringify(scenario), 'utf-8');
      writeFileSync(join(tmp, 'test-002.json'), JSON.stringify(validScenario({
        id: 'test-002',
        name: 'Second',
        target: 'other.html',
      })), 'utf-8');

      const result = listScenarios(tmp);
      assert.equal(result.length, 2);
      assert.equal(result[0].id, 'test-001');
      assert.equal(result[0].name, 'テストシナリオ');
      assert.equal(result[1].id, 'test-002');
      assert.equal(result[1].name, 'Second');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('壊れたJSONはPARSE_ERRORとして報告', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scenario-test-'));
    try {
      writeFileSync(join(tmp, 'broken.json'), 'not json', 'utf-8');
      const result = listScenarios(tmp);
      assert.equal(result.length, 1);
      assert.equal(result[0].id, 'PARSE_ERROR');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── formatJourneyMap ────────────────────────────────────────────────

describe('formatJourneyMap', () => {
  test('journey ありのシナリオはマップ文字列を返す', () => {
    const scenario = validScenario();
    const map = formatJourneyMap(scenario);
    assert.ok(map.includes('フォームジャーニーマップ'));
    assert.ok(map.includes(scenario.journey.name));
    assert.ok(map.includes(scenario.journey.entryPoint));
    assert.ok(map.includes('【経路】'));
    assert.ok(map.includes('【権限】'));
    assert.ok(map.includes('【テストデータ】'));
    assert.ok(map.includes('【安定制御点】'));
    assert.ok(map.includes('【失敗状態】'));
  });

  test('journey なしは "(journey 未定義)"', () => {
    assert.equal(formatJourneyMap({}), '(journey 未定義)');
  });
});

// ── VALID_STEP_TYPES ───────────────────────────────────────────────

describe('VALID_STEP_TYPES', () => {
  test('6種の有効なステップタイプを持つ', () => {
    assert.deepEqual(
      [...VALID_STEP_TYPES].sort(),
      ['api', 'assert', 'click', 'fill', 'navigate', 'wait'],
    );
  });
});
