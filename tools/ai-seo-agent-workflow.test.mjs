import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('ai-seo-agent-workflow.mjs', import.meta.url));

/**
 * Run the tool with given args, return { stdout, stderr }.
 * Exits with non-zero → throws; caught by test framework.
 */
function run(...args) {
  const stdout = execFileSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function runWithStderr(...args) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], {
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    return {
      stdout: e.stdout ? e.stdout.trim() : '',
      stderr: e.stderr ? e.stderr.trim() : '',
    };
  }
}

describe('ai-seo-agent-workflow', () => {

  // 1. --list が空でないシナリオ一覧を返す
  it('--list が空でないシナリオ一覧を返す', () => {
    const out = run('--list');
    assert.ok(out.length > 0, '出力が空');
    assert.ok(out.includes('plan'), 'plan を含む');
    assert.ok(out.includes('keywords'), 'keywords を含む');
    assert.ok(out.includes('minisite'), 'minisite を含む');
  });

  // 2. --scenario plan がパスA/B/Cのコスト情報を含む
  it('--scenario plan がパスA/B/Cのコスト情報を含む', () => {
    const out = run('--scenario', 'plan');
    assert.ok(out.includes('Claude Code + GAS'), 'パスA を含む');
    assert.ok(out.includes('Hermes/OpenClaw on VPS'), 'パスB を含む');
    assert.ok(out.includes('カスタムNode.js'), 'パスC を含む');
    assert.ok(out.includes('$'), '金額表記を含む');
  });

  // 3. --scenario keywords が6キーワード以上のスコア情報を含む
  it('--scenario keywords が6キーワード以上のスコア情報を含む', () => {
    const out = run('--scenario', 'keywords');
    // Count lines with "位" which appears in each keyword row
    const lines = out.split('\n').filter(l => l.includes('位') || l.includes('--'));
    assert.ok(lines.length >= 6, `6キーワード以上あること（実際: ${lines.length}）`);
    assert.ok(out.includes('スコア'), 'スコア列見出しを含む');
  });

  // 4. --scenario minisite が5テーマ以上の企画情報を含む
  it('--scenario minisite が5テーマ以上の企画情報を含む', () => {
    const out = run('--scenario', 'minisite');
    const themeMatches = out.match(/テーマ:/g);
    assert.ok(themeMatches && themeMatches.length >= 5, `5テーマ以上あること（実際: ${themeMatches?.length ?? 0}）`);
    assert.ok(out.includes('展示会ブース'), 'テーマ例を含む');
    assert.ok(out.includes('CTA'), 'CTA を含む');
  });

  // 5. --scenario plan --json がパース可能なJSONを返す
  it('--scenario plan --json がパース可能なJSONを返す', () => {
    const out = run('--scenario', 'plan', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.ok(Array.isArray(parsed), '配列である');
    assert.equal(parsed.length, 3, '3パス分のデータ');
    assert.ok(parsed[0].path, 'path フィールドを持つ');
    assert.ok(parsed[0].monthlyCost, 'monthlyCost フィールドを持つ');
  });

  // 6. --scenario keywords --json が数値スコアを含むJSONを返す
  it('--scenario keywords --json が数値スコアを含むJSONを返す', () => {
    const out = run('--scenario', 'keywords', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.ok(Array.isArray(parsed), '配列である');
    assert.ok(parsed.length >= 6, '6キーワード以上');
    parsed.forEach(d => {
      assert.ok(typeof d.keyword === 'string', 'keyword が文字列');
      assert.ok(typeof d.score === 'number', 'score が数値');
      assert.ok(d.score >= 0 && d.score <= 1, `スコアが0〜1の範囲内（${d.score}）`);
    });
  });

  // 7. 無効なシナリオ名でエラーメッセージを返す
  it('無効なシナリオ名でエラーメッセージを返す', () => {
    const { stdout, stderr } = runWithStderr('--scenario', 'nonexistent');
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('不明') || combined.includes('エラー') || combined.includes('nonexistent'),
      'エラーメッセージを含む'
    );
  });

  // 8. オプションなしで全シナリオの出力を含む
  it('オプションなしで全シナリオの出力を含む', () => {
    const out = run();
    assert.ok(out.includes('plan'), 'plan セクションを含む');
    assert.ok(out.includes('keywords'), 'keywords セクションを含む');
    assert.ok(out.includes('minisite'), 'minisite セクションを含む');
    assert.ok(out.includes('Claude Code + GAS'), 'コスト試算を含む');
    assert.ok(out.includes('展示会ブース'), 'ミニサイト企画を含む');
  });

});
