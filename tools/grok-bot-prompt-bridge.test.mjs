// grok-bot-prompt-bridge.test.mjs — テストスイート
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, 'grok-bot-prompt-bridge.mjs');

/**
 * 有効なサンプルリサーチJSON
 */
const VALID_RESEARCH = {
  findings: [
    {
      item: 'React バージョン',
      summary: 'React 19 が最新安定版。Next.js 15 推奨。',
      sources: ['https://react.dev'],
      confidence: 'high'
    },
    {
      item: 'CSSフレームワーク',
      summary: 'Tailwind CSS 4 がデファクト。',
      sources: ['https://tailwindcss.com'],
      confidence: 'high'
    },
    {
      item: '認証方式',
      summary: 'NextAuth.js が主流。',
      sources: ['https://authjs.dev'],
      confidence: 'medium'
    },
    {
      item: '価格情報',
      summary: '推定月額 $20-50。正確な値は未確認。',
      sources: [],
      confidence: 'low'
    }
  ],
  recommended_approach: 'Next.js 15 + Tailwind CSS 4',
  risks: ['既存CSSとの競合リスク'],
  estimated_effort: '2人日'
};

/**
 * `--sample` フラグのテスト
 */
it('--sample が有効なJSONを出力する', () => {
  const result = spawnSync('node', [BRIDGE, '--sample'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.findings));
  assert.ok(parsed.findings.length > 0);
  assert.ok(parsed.findings[0].item);
  assert.ok(parsed.findings[0].summary);
  assert.ok(parsed.findings[0].confidence);
});

/**
 * `--research` と `--output` のテスト
 */
it('research JSON から正しいプロンプトを生成する', () => {
  const tmpJson = path.join(__dirname, `_test_research_${Date.now()}.json`);
  const tmpMd = path.join(__dirname, `_test_prompt_${Date.now()}.md`);
  try {
    fs.writeFileSync(tmpJson, JSON.stringify(VALID_RESEARCH), 'utf8');

    const result = spawnSync('node', [
      BRIDGE, '--research', tmpJson, '--output', tmpMd,
      '--title', 'テストプロジェクト', '--desc', '説明文'
    ], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stderr.includes('実装プロンプトを出力しました'));
    assert.ok(fs.existsSync(tmpMd));

    const md = fs.readFileSync(tmpMd, 'utf8');
    assert.ok(md.includes('テストプロジェクト'));
    assert.ok(md.includes('説明文'));
    assert.ok(md.includes('React 19'));  // high confidence → 実装要件
    assert.ok(md.includes('Tailwind CSS 4'));
    assert.ok(md.includes('Next.js 15 + Tailwind CSS 4'));  // recommended_approach
    assert.ok(md.includes('既存CSSとの競合リスク'));  // risks
    assert.ok(md.includes('2人日'));  // estimated_effort
    assert.ok(md.includes('Grok Bot QA 用'));  // 検証項目
    assert.ok(md.includes('https://react.dev'));  // ソース
    assert.ok(md.includes('https://authjs.dev'));  // medium confidence source also included

    // low confidence は除外されること
    assert.ok(!md.includes('価格情報'));

    // QA 検証項目が含まれていること
    const qaMatches = md.match(/\[ \] \d+\./g);
    assert.ok(qaMatches && qaMatches.length >= 2); // 2 high + 1 risk

  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
    if (fs.existsSync(tmpMd)) fs.unlinkSync(tmpMd);
  }
});

/**
 * stdin（Markdown コードブロック）からの入力
 */
it('Markdown コードブロック内のJSONも解析できる', () => {
  const tmpJson = path.join(__dirname, `_test_md_${Date.now()}.json`);
  const mdContent = `# Research Result
Some text before.

\`\`\`json
${JSON.stringify(VALID_RESEARCH, null, 2)}
\`\`\`

Some text after.`;
  try {
    fs.writeFileSync(tmpJson, mdContent, 'utf8');
    const result = spawnSync('node', [
      BRIDGE, '--research', tmpJson, '--title', 'MDテスト'
    ], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('React 19'));
    assert.ok(result.stdout.includes('MDテスト'));
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});

/**
 * バリデーションエラー（findings が空）
 */
it('空の findings でエラーになる', () => {
  const tmpJson = path.join(__dirname, `_test_bad_${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpJson, JSON.stringify({ findings: [] }), 'utf8');
    const result = spawnSync('node', [BRIDGE, '--research', tmpJson], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('findings は空でない配列'));
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});

/**
 * --research 未指定のエラー
 */
it('--research 未指定でエラーになる', () => {
  const result = spawnSync('node', [BRIDGE], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.ok(result.stderr.includes('--research'));
});

/**
 * 存在しないファイルを指定したエラー
 */
it('存在しないファイルでエラーになる', () => {
  const result = spawnSync('node', [
    BRIDGE, '--research', '/nonexistent/path.json'
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.ok(result.stderr.includes('ファイルが見つかりません'));
});

/**
 * confidence が不正
 */
it('不正な confidence 値でエラーになる', () => {
  const tmpJson = path.join(__dirname, `_test_conf_${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpJson, JSON.stringify({
      findings: [{ item: 'test', summary: 'test', confidence: 'invalid' }]
    }), 'utf8');
    const result = spawnSync('node', [BRIDGE, '--research', tmpJson], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('confidence'));
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});