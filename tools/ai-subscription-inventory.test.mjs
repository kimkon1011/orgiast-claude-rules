import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, extractWiringProviders, collectKeyInventory, collectUsageByProvider, analyzeInventory, renderDoc, formatReport, main } from './ai-subscription-inventory.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 実在の ~/.claude を読むと、そのPCの契約状況でテスト結果が変わってしまう。すべて fixture で組む。
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-subscription-'));
}

function writeEnv(home, file, lines) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', file), lines.join('\n'), 'utf8');
}

const catalog = {
  version: 1,
  purpose: 'テスト用',
  capabilities: { code: 'コーディング', chat: '汎用チャット' },
  aiVendorPrefixes: ['zai', 'openai', 'growi'],
  services: [
    { id: 'glm', name: 'GLM Plan', vendor: 'Z.ai', kind: 'plan', monthlyJpy: null, monthlyUsd: 10, capabilities: ['code'], keyEnvs: ['ZAI_API_KEY'], keyFiles: ['zai.env'] },
    { id: 'codex', name: 'Codex seats', vendor: 'OpenAI', kind: 'seat', monthlyJpy: null, monthlyUsd: null, capabilities: ['code'], keyEnvs: [], keyFiles: [] },
    { id: 'groq', name: 'Groq', vendor: 'Groq', kind: 'metered', monthlyJpy: null, monthlyUsd: null, capabilities: ['chat'], keyEnvs: ['GROQ_API_KEY'], keyFiles: ['groq.env'] },
  ],
};

const fixedConfig = { monthlyBudgetJpy: 150000, usdJpy: 150, fixed: [{ name: 'GLM Plan', id: 'glm', usd: 12.6 }, { name: 'Codex seats', id: 'codex', jpy: null }] };

function analyze(overrides = {}) {
  return analyzeInventory({ catalog, fixedConfig, billing: {}, wiringProviders: [], keyInventory: [], usageByProvider: {}, ...overrides });
}

const ids = (report) => report.findings.map((item) => item.id);

test('extractWiringProviders は実物の llm-ask.mjs から主要プロバイダを拾う', () => {
  const providers = extractWiringProviders(fs.readFileSync(path.join(repoRoot, 'tools', 'llm-ask.mjs'), 'utf8'));
  assert.ok(providers.length >= 8, `8個以上を期待したが ${providers.length} 個: ${providers.join(',')}`);
  assert.ok(providers.includes('openrouter'));
  assert.ok(providers.includes('gemini'));
  // 内側のオブジェクト（base / keyEnv 等）を拾っていないこと。
  assert.ok(!providers.includes('base'));
  assert.ok(!providers.includes('keyEnv'));
});

test('collectKeyInventory はキー名だけを返し、値を持ち出さない', () => {
  const home = tempDir();
  writeEnv(home, 'zai.env', ['# コメント', 'ZAI_API_KEY=super-secret-value', 'export ZAI_EXTRA=another-secret']);
  const inventory = collectKeyInventory(home);
  assert.deepEqual(inventory, [{ file: 'zai.env', keys: ['ZAI_API_KEY', 'ZAI_EXTRA'] }]);
  assert.ok(!JSON.stringify(inventory).includes('secret'));
});

test('collectUsageByProvider は provider 別に件数を数え、壊れた行を無視する', () => {
  const home = tempDir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), [
    '{"provider":"groq"}', '{壊れた行', '{"provider":"groq"}', '{"provider":"glm"}', '{}', '',
  ].join('\n'), 'utf8');
  assert.deepEqual(collectUsageByProvider(home), { groq: 2, glm: 1 });
});

test('collectKeyInventory / collectUsageByProvider はファイルが無ければ空を返す', () => {
  const home = tempDir();
  assert.deepEqual(collectKeyInventory(home), []);
  assert.deepEqual(collectUsageByProvider(home), {});
});

test('duplicate-account は同じキー名の env が2本以上で warn', () => {
  const keyInventory = [{ file: 'zai.env', keys: ['ZAI_API_KEY'] }, { file: 'zai-kim.env', keys: ['ZAI_API_KEY'] }];
  const report = analyze({ keyInventory });
  const finding = report.findings.find((item) => item.id === 'duplicate-account');
  assert.equal(finding.severity, 'warn');
  assert.deepEqual(finding.serviceIds, ['glm']);
  assert.match(finding.detail, /ZAI_API_KEY が 2 本に存在（zai-kim\.env, zai\.env）/);
  assert.equal(analyze({ keyInventory: [keyInventory[0]] }).findings.filter((item) => item.id === 'duplicate-account').length, 0);
});

test('duplicate-capability は固定費が同一用途を2本以上で warn、1本なら出ない', () => {
  const codes = analyze().findings.filter((item) => item.id === 'duplicate-capability' && item.serviceIds.includes('glm'));
  assert.equal(codes.length, 1);
  assert.deepEqual(codes[0].serviceIds, ['glm', 'codex']);
  // codex を metered にすると固定費は glm だけになり重複しない。
  const metered = analyze({ catalog: { ...catalog, services: catalog.services.map((service) => service.id === 'codex' ? { ...service, kind: 'metered' } : service) } });
  assert.equal(metered.findings.filter((item) => item.id === 'duplicate-capability' && item.serviceIds.includes('glm')).length, 0);
});

test('unfilled-cost は固定費の未記入で warn、cap は対象外', () => {
  // glm は usd 12.6 から換算できるので未記入ではない。codex は jpy も usd も無いので未記入。
  const report = analyze();
  assert.deepEqual(report.findings.filter((item) => item.id === 'unfilled-cost').map((item) => item.serviceIds[0]), ['codex']);
  assert.equal(report.services.find((service) => service.id === 'glm').monthlyJpy, 1890);
  // cap は「上限」であって確定額ではないため、固定費にも未記入にも数えない。
  const capped = analyze({ catalog: { ...catalog, services: catalog.services.map((service) => service.id === 'codex' ? { ...service, kind: 'cap', monthlyJpy: 20000 } : service) } });
  assert.equal(capped.findings.filter((item) => item.id === 'unfilled-cost').length, 0);
  assert.equal(capped.counts.fixed, 1);
});

test('unused-service は配線済みで実使用ゼロのときだけ warn、metered は対象外', () => {
  const unused = analyze({ wiringProviders: ['glm'], keyInventory: [{ file: 'zai.env', keys: ['ZAI_API_KEY'] }] });
  assert.equal(unused.findings.filter((item) => item.id === 'unused-service').length, 1);
  assert.equal(unused.savings.confirmedJpy, 1890, 'usd 12.6 × 150 が判明分として加算される');
  // 使用実績があれば出ない。
  assert.equal(analyze({ wiringProviders: ['glm'], usageByProvider: { glm: 3 } }).findings.filter((item) => item.id === 'unused-service').length, 0);
  // 台帳が観測できないサービスは「実使用ゼロ」と断定せず usage-unknown にする。
  const outside = analyze();
  assert.equal(outside.findings.filter((item) => item.id === 'unused-service').length, 0);
  assert.deepEqual(outside.findings.filter((item) => item.id === 'usage-unknown').map((item) => item.serviceIds[0]), ['glm', 'codex']);
});

test('unknown-capability は error になり ok が false になる', () => {
  const report = analyze({ catalog: { ...catalog, services: catalog.services.map((service) => ({ ...service, capabilities: ['code', 'video'] })) } });
  assert.equal(report.findings.filter((item) => item.id === 'unknown-capability').length, 3);
  assert.equal(report.counts.error, 3);
  assert.equal(report.ok, false);
});

test('uncatalogued-key はAIベンダー名の env ファイルだけを対象にする', () => {
  const keyInventory = [
    { file: 'zai.env', keys: ['ZAI_API_KEY', 'ZAI_NEW_KEY'] },
    { file: 'growi.env', keys: ['GROWI_API_TOKEN', 'GROWI_BASE_URL'] },
    { file: 'task-sheet.env', keys: ['TASK_SHEET_TOKEN'] },
  ];
  const report = analyze({ keyInventory });
  const found = report.findings.filter((item) => item.id === 'uncatalogued-key').map((item) => item.detail);
  // 非AIの task-sheet.env は対象外。URL 系の名前も契約ではないので除外。
  assert.deepEqual(found, ['zai.env: ZAI_NEW_KEY はカタログ未登録＝棚卸し漏れの疑い', 'growi.env: GROWI_API_TOKEN はカタログ未登録＝棚卸し漏れの疑い']);
});

test('savings は判明分だけで計算し、不明が混ざる用途グループは null にする', () => {
  // glm(判明) と codex(不明) が同じ code を担うため candidateJpy は算定不能。
  const unknownGroup = analyze({ wiringProviders: ['glm'], keyInventory: [{ file: 'zai.env', keys: ['ZAI_API_KEY'] }] });
  assert.equal(unknownGroup.savings.candidateJpy, null);
  assert.ok(unknownGroup.savings.unknownCount >= 1);
  // 両方判明していれば、高い方を解約する想定で差額が積まれる。
  const known = analyze({
    fixedConfig: { ...fixedConfig, fixed: [{ name: 'GLM Plan', id: 'glm', jpy: 1000 }, { name: 'Codex seats', id: 'codex', jpy: 4000 }] },
  });
  assert.equal(known.savings.candidateJpy, 1000 + 4000 - 1000);
  assert.equal(known.savings.confirmedJpy, 0);
});

test('renderDoc は揮発値を含まず、同じ入力で完全に同じ文字列になる', () => {
  const report = analyze();
  const first = renderDoc(report, catalog);
  const second = renderDoc(analyze(), catalog);
  assert.equal(first, second);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(first), '生成日時を埋め込んではならない');
  assert.ok(first.startsWith('<!-- tools/ai-subscription-catalog.json から'));
  assert.ok(first.endsWith('\n'));
  assert.ok(!first.includes('\r'));
  for (const service of report.services) assert.ok(first.includes(service.name));
});

test('formatReport は一覧・問題・削減見込みを1つの文字列で返す', () => {
  const text = formatReport(analyze());
  assert.ok(text.includes('検出した問題'));
  assert.ok(text.includes('削減見込み'));
  assert.ok(text.includes('codex seat code 未記入'));
});

test('カタログ本体は実在し、capabilities と用途語が一致している', () => {
  const real = loadCatalog(repoRoot);
  assert.ok(real.services.length >= 10);
  for (const service of real.services) {
    for (const capability of service.capabilities) assert.ok(Object.hasOwn(real.capabilities, capability), `${service.id}: 未知の用途 ${capability}`);
  }
  const report = analyzeInventory({
    catalog: real,
    fixedConfig: JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', 'budget-fixed.json'), 'utf8')),
    billing: JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', 'provider-billing.json'), 'utf8')),
    wiringProviders: [], keyInventory: [], usageByProvider: {},
  });
  assert.equal(report.counts.error, 0);
});

test('main は引数エラーで 2、--check は warn のみなら 0、--strict なら 1 を返す', () => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(main(['--unknown']), 2);
    assert.equal(main(['--strict']), 2, '--strict は --check と併用が必須');
    assert.equal(main(['--check', '--strict', '--repo', repoRoot, '--home', tempDir()]), 1, 'fixture home では warn が出る');
    assert.equal(main(['--json', '--repo', repoRoot, '--home', tempDir()]), 0);
  } finally {
    console.log = log;
    console.error = error;
  }
});
