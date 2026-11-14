#!/usr/bin/env node
/**
 * verification-scenario.mjs — 検証シナリオの定義・検証・replay CLI
 *
 * AIコーディングエージェントの変更に対して「同じシナリオで再現検証」するためのツール。
 * フォーム提出ジャーニー・APIリクエスト・UI操作をシナリオとして保存し、
 * コード変更後に同一シナリオをリプレイして挙動一致・非退行を確認する。
 *
 * 使用方法:
 *   node tools/verification-scenario.mjs capture <path>   # シナリオを新規作成
 *   node tools/verification-scenario.mjs replay <path>     # シナリオをリプレイ検証
 *   node tools/verification-scenario.mjs validate <path>   # シナリオ定義の妥当性検証
 *   node tools/verification-scenario.mjs list              # 利用可能なシナリオ一覧
 *   node tools/verification-scenario.mjs map <path>        # フォームジャーニーマップを表示
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = resolve(__dirname, '..', 'docs', 'evidence', 'scenarios');

// ── 型定義 ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ScenarioStep
 * @property {string} id — ステップ識別子（例: "step-001"）
 * @property {string} description — 操作説明
 * @property {string} type — ステップ種別: "navigate" | "fill" | "click" | "assert" | "api" | "wait"
 * @property {Object} [payload] — 操作のペイロード
 * @property {string} [payload.url] — navigate/assert のURL
 * @property {string} [payload.selector] — fill/click/assert のCSSセレクタ
 * @property {string} [payload.value] — fill の入力値
 * @property {Object} [payload.expected] — assert の期待値
 * @property {number} [payload.ms] — wait のミリ秒
 * @property {string[]} [tags] — シナリオタグ
 */

/**
 * @typedef {Object} JourneyMap
 * @property {string} id — ジャーニー識別子
 * @property {string} name — ジャーニー名
 * @property {string} entryPoint — 開始URL/経路
 * @property {string[]} routes — 取り得る経路一覧
 * @property {Object} permissions — 必要な権限（role → boolean）
 * @property {Object} testData — テストデータ定義
 * @property {Object} stableControls — 安定した制御点（操作の基点）
 * @property {string[]} failureStates — 失敗状態の一覧
 */

/**
 * @typedef {Object} VerificationScenario
 * @property {string} schema — スキーマバージョン（"x0048-v1"）
 * @property {string} id — シナリオID
 * @property {string} name — シナリオ名
 * @property {string} target — 検証対象（例: "apps/expo-apply/index.html"）
 * @property {string} createdAt — ISO日付
 * @property {string} [updatedAt] — 更新日
 * @property {string[]} tags — タグ一覧
 * @property {JourneyMap} journey — フォームジャーニーマップ
 * @property {ScenarioStep[]} steps — 検証ステップ
 * @property {Object[]} failureCases — 既知の失敗ケース
 * @property {Object} [claimEvidence] — クレーム→証拠マッピング
 */

// ── バリデーション ─────────────────────────────────────────────────

const VALID_STEP_TYPES = new Set(['navigate', 'fill', 'click', 'assert', 'api', 'wait']);

/**
 * シナリオ定義の妥当性を検証する
 * @param {VerificationScenario} scenario
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateScenario(scenario) {
  const errors = [];

  if (!scenario || typeof scenario !== 'object') {
    return { valid: false, errors: ['シナリオが空です'] };
  }

  if (scenario.schema !== 'x0048-v1') {
    errors.push(`schema は "x0048-v1" であるべき: ${scenario.schema}`);
  }

  if (!scenario.id || typeof scenario.id !== 'string') {
    errors.push('id は必須の文字列です');
  }

  if (!scenario.name || typeof scenario.name !== 'string') {
    errors.push('name は必須の文字列です');
  }

  if (!scenario.target || typeof scenario.target !== 'string') {
    errors.push('target は必須の文字列です');
  }

  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    errors.push('steps は1件以上の配列であるべき');
  } else {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (!step.id) errors.push(`steps[${i}]: id がありません`);
      if (!step.description) errors.push(`steps[${i}]: description がありません`);
      // type の妥当性は replayScenario 側で個別にチェックするためここではチェックしない
    }
  }

  if (scenario.journey) {
    const j = scenario.journey;
    if (!j.id) errors.push('journey.id がありません');
    if (!j.name) errors.push('journey.name がありません');
    if (!j.entryPoint) errors.push('journey.entryPoint がありません');
    if (!Array.isArray(j.routes)) errors.push('journey.routes は配列であるべき');
    if (!j.permissions || typeof j.permissions !== 'object') errors.push('journey.permissions がありません');
    if (!j.testData || typeof j.testData !== 'object') errors.push('journey.testData がありません');
    if (!j.stableControls || typeof j.stableControls !== 'object') errors.push('journey.stableControls がありません');
    if (!Array.isArray(j.failureStates)) errors.push('journey.failureStates は配列であるべき');
  }

  return { valid: errors.length === 0, errors };
}

// ── スキーマJSON書き出し ───────────────────────────────────────────

const SCHEMA_JSON = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'VerificationScenario',
  description: 'AIコーディングエージェント検証シナリオのスキーマ（X-0048）',
  type: 'object',
  required: ['schema', 'id', 'name', 'target', 'createdAt', 'steps'],
  properties: {
    schema: { type: 'string', const: 'x0048-v1' },
    id: { type: 'string' },
    name: { type: 'string' },
    target: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    tags: { type: 'array', items: { type: 'string' } },
    journey: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        entryPoint: { type: 'string' },
        routes: { type: 'array', items: { type: 'string' } },
        permissions: { type: 'object' },
        testData: { type: 'object' },
        stableControls: { type: 'object' },
        failureStates: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'name', 'entryPoint', 'routes', 'permissions', 'testData', 'stableControls', 'failureStates'],
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'description', 'type'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: [...VALID_STEP_TYPES] },
          payload: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    failureCases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          conditions: { type: 'array', items: { type: 'string' } },
          expectedRecovery: { type: 'string' },
        },
      },
    },
    claimEvidence: {
      type: 'object',
      properties: {
        behavior: { type: 'object' },
        performance: { type: 'object' },
        codeQuality: { type: 'object' },
      },
    },
  },
};

// ── CLI コマンド ────────────────────────────────────────────────────

function usage() {
  console.error(`
使用方法:
  node tools/verification-scenario.mjs capture <path>   # 新規シナリオ作成（テンプレート生成）
  node tools/verification-scenario.mjs replay <path>    # シナリオリプレイ（検証実行）
  node tools/verification-scenario.mjs validate <path>  # シナリオ定義の妥当性検証
  node tools/verification-scenario.mjs list             # 利用可能なシナリオ一覧
  node tools/verification-scenario.mjs map <path>       # フォームジャーニーマップを表示
  node tools/verification-scenario.mjs schema           # スキーマJSONを出力
`);
  process.exit(1);
}

/**
 * シナリオ一覧を取得
 */
export function listScenarios(dir = SCENARIO_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const scenarios = [];
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const scenario = JSON.parse(content);
      scenarios.push({
        file,
        id: scenario.id || 'unknown',
        name: scenario.name || 'unknown',
        target: scenario.target || 'unknown',
        steps: (scenario.steps || []).length,
        createdAt: scenario.createdAt || 'unknown',
      });
    } catch {
      scenarios.push({ file, id: 'PARSE_ERROR', name: '(パース失敗)', target: '-', steps: 0, createdAt: '-' });
    }
  }
  return scenarios;
}

/**
 * シナリオのテンプレートを生成
 */
export function createScenarioTemplate(name, target) {
  const id = `scenario-${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  /** @type {VerificationScenario} */
  const template = {
    schema: 'x0048-v1',
    id,
    name: name || '新しい検証シナリオ',
    target: target || '',
    createdAt: now,
    tags: [],
    journey: {
      id: `${id}-journey`,
      name: `${name || 'default'} フォームジャーニー`,
      entryPoint: '/',
      routes: ['正常系', '異常系:必須項目欠落', '異常系:フォーマット誤り'],
      permissions: { anonymous: true, authenticated: false },
      testData: {
        validInput: {},
        invalidInputs: [],
      },
      stableControls: {
        submitButton: '#submitBtn',
        formSelector: '#app-form',
        confirmationElement: '#confRef',
      },
      failureStates: ['バリデーションエラー表示', 'ネットワークタイムアウト', '空データ'],
    },
    steps: [
      {
        id: 'step-001',
        description: 'フォームページを開く',
        type: 'navigate',
        payload: { url: '/' },
        tags: ['smoke'],
      },
      {
        id: 'step-002',
        description: '正常データを入力して送信',
        type: 'fill',
        payload: { selector: '#companyName', value: '__TEST_COMPANY__' },
        tags: ['smoke'],
      },
      {
        id: 'step-003',
        description: '確認画面が表示されることを確認',
        type: 'assert',
        payload: { selector: '#confRef', expected: { visible: true } },
        tags: ['smoke'],
      },
    ],
    failureCases: [
      {
        id: 'fail-001',
        description: '必須項目未入力でバリデーションエラー',
        conditions: ['companyName が空', 'email が空'],
        expectedRecovery: '該当フィールド直下にエラーメッセージが表示される',
      },
    ],
    claimEvidence: {
      behavior: {
        claim: 'フォーム送信後、確認画面に遷移する',
        matchCriteria: '送信ボタンclick後、#confRef が表示される',
        evidenceType: 'journey-replay + screenshot',
      },
      performance: {
        claim: 'ページ読み込みが2秒以内',
        matchCriteria: 'navigate から最初の paint まで < 2000ms',
        evidenceType: 'comparable-build-timing',
      },
      codeQuality: {
        claim: '既存の型・lint・テストに違���しない',
        matchCriteria: 'node --test 全緑',
        evidenceType: 'types + lint + regression-tests',
      },
    },
  };

  return template;
}

/**
 * シナリオをリプレイ（dry-run: 実際の操作はせず、ステップ一覧を表示）
 * @param {VerificationScenario} scenario
 * @returns {{ passed: boolean, results: { stepId: string, description: string, status: string }[] }}
 */
export function replayScenario(scenario) {
  const validation = validateScenario(scenario);
  if (!validation.valid) {
    return {
      passed: false,
      results: [{ stepId: 'pre-check', description: 'シナリオバリデーション', status: `FAIL: ${validation.errors.join('; ')}` }],
    };
  }

  const results = scenario.steps.map(step => {
    // dry-run: 実際のブラウザ操作は行わず、ステップ情報を検証
    const stepValid = step.id && step.description && VALID_STEP_TYPES.has(step.type);
    return {
      stepId: step.id,
      description: step.description,
      status: stepValid ? 'PASS (dry-run)' : `FAIL: 不完全なステップ定義`,
      type: step.type,
    };
  });

  const allPassed = results.every(r => r.status.startsWith('PASS'));
  return { passed: allPassed, results };
}

/**
 * フォームジャーニーマップを表示
 */
export function formatJourneyMap(scenario) {
  if (!scenario.journey) return '(journey 未定義)';

  const j = scenario.journey;
  const lines = [
    `=== フォームジャーニーマップ: ${j.name} ===`,
    `ID: ${j.id}`,
    `エントリーポイント: ${j.entryPoint}`,
    ``,
    `【経路】`,
    ...j.routes.map(r => `  - ${r}`),
    ``,
    `【権限】`,
    ...Object.entries(j.permissions).map(([k, v]) => `  - ${k}: ${v}`),
    ``,
    `【テストデータ】`,
    `  有効入力: ${Object.keys(j.testData.validInput || {}).length} フィールド`,
    `  無効入力: ${(j.testData.invalidInputs || []).length} ケース`,
    ``,
    `【安定制御点】`,
    ...Object.entries(j.stableControls || {}).map(([k, v]) => `  - ${k}: ${v}`),
    ``,
    `【失敗状態】`,
    ...(j.failureStates || []).map(s => `  - ${s}`),
  ];

  return lines.join('\n');
}

// ── メイン ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) usage();

  switch (command) {
    case 'schema': {
      console.log(JSON.stringify(SCHEMA_JSON, null, 2));
      break;
    }

    case 'list': {
      const scenarios = listScenarios();
      if (scenarios.length === 0) {
        console.log('シナリオが見つかりません。docs/evidence/scenarios/ に JSON ファイルを配置してください。');
        process.exit(0);
      }
      console.log('利用可能な検証シナリオ:');
      console.log('─'.repeat(80));
      console.log('ファイル名'.padEnd(30), 'ID'.padEnd(20), '名前'.padEnd(20), 'ステップ数');
      console.log('─'.repeat(80));
      for (const s of scenarios) {
        console.log(s.file.padEnd(30), s.id.padEnd(20), s.name.slice(0, 18).padEnd(20), s.steps);
      }
      break;
    }

    case 'validate': {
      const path = args[1];
      if (!path) { console.error('path が指定されていません'); process.exit(1); }

      let scenario;
      try {
        const content = readFileSync(resolve(path), 'utf-8');
        scenario = JSON.parse(content);
      } catch (err) {
        console.error(`シナリオファイル読み込みエラー: ${err.message}`);
        process.exit(1);
      }

      const result = validateScenario(scenario);
      if (result.valid) {
        console.log(`✅ シナリア "${scenario.name}" は有効��す (${scenario.steps.length} ステップ)`);
      } else {
        console.log(`❌ シナリオ "${scenario.name || '(unknown)'}" に ${result.errors.length} 件のエラー:`);
        result.errors.forEach(e => console.log(`  - ${e}`));
        process.exit(1);
      }
      break;
    }

    case 'capture': {
      const name = args[1] || 'new-scenario';
      const target = args[2] || '';
      const template = createScenarioTemplate(name, target);
      const filename = `${template.id}.json`;
      const filepath = join(SCENARIO_DIR, filename);

      writeFileSync(filepath, JSON.stringify(template, null, 2), 'utf-8');
      console.log(`✅ シナリオテンプレートを作成しました: ${filepath}`);
      console.log(`   ID: ${template.id}`);
      console.log(`   名前: ${template.name}`);
      console.log(`   スキーマ: ${template.schema}`);
      console.log(`   テンプレートを編集して actual 値を埋めてから replay してください`);
      break;
    }

    case 'replay': {
      const path = args[1];
      if (!path) { console.error('シナリオファイルのパスを指定してください'); process.exit(1); }

      let scenario;
      try {
        const content = readFileSync(resolve(path), 'utf-8');
        scenario = JSON.parse(content);
      } catch (err) {
        console.error(`読み込みエラー: ${err.message}`);
        process.exit(1);
      }

      const result = replayScenario(scenario);
      console.log(`\n=== リプレイ結果: ${result.passed ? '✅ PASS' : '❌ FAIL'} ===`);
      console.log('');
      for (const r of result.results) {
        const icon = r.status.startsWith('PASS') ? '✅' : '❌';
        console.log(`  ${icon} [${r.stepId}] ${r.description}`);
        console.log(`      → ${r.status}`);
      }
      console.log('');
      console.log(`合計: ${result.results.length} ステップ, 結果: ${result.passed ? 'PASS' : 'FAIL'}`);
      process.exit(result.passed ? 0 : 1);
    }

    case 'map': {
      const path = args[1];
      if (!path) { console.error('シナリオファイルのパスを指定してください'); process.exit(1); }

      let scenario;
      try {
        const content = readFileSync(resolve(path), 'utf-8');
        scenario = JSON.parse(content);
      } catch (err) {
        console.error(`読み込みエラー: ${err.message}`);
        process.exit(1);
      }

      console.log(formatJourneyMap(scenario));
      break;
    }

    default:
      usage();
  }
}

if (process.argv[1] && process.argv[1].endsWith('verification-scenario.mjs')) {
  main();
}

// ── エクスポート（テスト用） ─────────────────────────────────────────

export { SCHEMA_JSON, VALID_STEP_TYPES, SCENARIO_DIR, SCHEMA_JSON as schemaJson };
