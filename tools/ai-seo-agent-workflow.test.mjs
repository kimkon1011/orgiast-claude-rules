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

  // ── Scenario tests (existing) ─────────────────────────────────────────

  it('--list が空でないシナリオ一覧を返す', () => {
    const out = run('--list');
    assert.ok(out.length > 0, '出力が空');
    assert.ok(out.includes('plan'), 'plan を含む');
    assert.ok(out.includes('keywords'), 'keywords を含む');
    assert.ok(out.includes('minisite'), 'minisite を含む');
  });

  it('--scenario plan がパスA/B/Cのコスト情報を含む', () => {
    const out = run('--scenario', 'plan');
    assert.ok(out.includes('Claude Code + GAS'), 'パスA を含む');
    assert.ok(out.includes('Hermes/OpenClaw on VPS'), 'パスB を含む');
    assert.ok(out.includes('カスタムNode.js'), 'パスC を含む');
    assert.ok(out.includes('$'), '金額表記を含む');
  });

  it('--scenario keywords が6キーワード以上のスコア情報を含む', () => {
    const out = run('--scenario', 'keywords');
    const lines = out.split('\n').filter(l => l.includes('位') || l.includes('--'));
    assert.ok(lines.length >= 6, `6キーワード以上あること（実際: ${lines.length}）`);
    assert.ok(out.includes('スコア'), 'スコア表記を含む');
  });

  it('--scenario minisite が5テーマ以上の企画情報を含む', () => {
    const out = run('--scenario', 'minisite');
    const themeMatches = out.match(/テーマ:/g);
    assert.ok(themeMatches && themeMatches.length >= 5, `5テーマ以上あること（実際: ${themeMatches?.length ?? 0}）`);
    assert.ok(out.includes('展示会ブース'), 'テーマ例を含む');
    assert.ok(out.includes('CTA'), 'CTA を含む');
  });

  it('--scenario plan --json がパース可能なJSONを返す', () => {
    const out = run('--scenario', 'plan', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.ok(Array.isArray(parsed), '配列である');
    assert.equal(parsed.length, 3, '3パス分のデータ');
    assert.ok(parsed[0].path, 'path フィールドを持つ');
    assert.ok(parsed[0].monthlyCost, 'monthlyCost フィールドを持つ');
  });

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

  it('無効なシナリオ名でエラーメッセージを返す', () => {
    const { stdout, stderr } = runWithStderr('--scenario', 'nonexistent');
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('不明') || combined.includes('エラー') || combined.includes('nonexistent'),
      'エラーメッセージを含む'
    );
  });

  it('オプションなしで全シナリオの出力を含む', () => {
    const out = run();
    assert.ok(out.includes('plan'), 'plan セクションを含む');
    assert.ok(out.includes('keywords'), 'keywords セクションを含む');
    assert.ok(out.includes('minisite'), 'minisite セクションを含む');
    assert.ok(out.includes('Claude Code + GAS'), 'コスト試算を含む');
    assert.ok(out.includes('展示会ブース'), 'ミニサイト企画を含む');
  });

  // ── Mode tests ────────────────────────────────────────────────────────

  it('--list がモード一覧も含む', () => {
    const out = run('--list');
    assert.ok(out.includes('daily'), 'daily モードを含む');
    assert.ok(out.includes('weekly'), 'weekly モードを含む');
    assert.ok(out.includes('cron-setup'), 'cron-setup モードを含む');
    assert.ok(out.includes('report'), 'report モードを含む');
  });

  it('--mode daily がパイプラインステップを含む', () => {
    const out = run('--mode', 'daily');
    assert.ok(out.includes('GSCキーワード'), 'GSC取得ステップを含む');
    assert.ok(out.includes('スコアリング'), 'スコアリングステップを含む');
    assert.ok(out.includes('レポート'), 'レポートステップを含む');
    assert.ok(out.includes('impressions'), 'impressions を含む');
    assert.ok(out.includes('clicks'), 'clicks を含む');
  });

  it('--mode weekly が競合分析・コンテンツギャップ・レポートを含む', () => {
    const out = run('--mode', 'weekly');
    assert.ok(out.includes('競合分析'), '競合分析ステップを含む');
    assert.ok(out.includes('コンテンツギャップ'), 'コンテンツギャップを含む');
    assert.ok(out.includes('週次レポート'), '週次レポートを含む');
    assert.ok(out.includes('株式会社'), '競合名を含む');
  });

  it('--mode cron-setup がsystemdとGitHub Actions設定を含む', () => {
    const out = run('--mode', 'cron-setup');
    assert.ok(out.includes('systemd'), 'systemd 設定を含む');
    assert.ok(out.includes('GitHub Actions'), 'GitHub Actions 設定を含む');
    assert.ok(out.includes('OnCalendar'), 'OnCalendar を含む');
    assert.ok(out.includes('cron:'), 'cron 式を含む');
  });

  it('--mode report が実行サマリを含む', () => {
    const out = run('--mode', 'report');
    assert.ok(out.includes('最終実行'), '最終実行を含む');
    assert.ok(out.includes('日次'), '日次セクションを含む');
    assert.ok(out.includes('週次'), '週次セクションを含む');
    assert.ok(out.includes('総実行回数'), '総実行回数を含む');
    assert.ok(out.includes('稼働率'), '稼働率を含む');
  });

  it('--mode daily --dry-run がSKIP表示を含む', () => {
    const out = run('--mode', 'daily', '--dry-run');
    assert.ok(out.includes('DRY-RUN') || out.includes('SKIP'), 'dry-run表示を含む');
    assert.ok(out.includes('GSCキーワード'), 'パイプライン表示はある');
  });

  it('--mode daily --json がパース可能なJSONを返す', () => {
    const out = run('--mode', 'daily', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.ok(typeof parsed === 'object', 'オブジェクトである');
    assert.equal(parsed.mode, 'daily', 'mode が daily');
    assert.ok(parsed.timestamp, 'timestamp を含む');
  });

  it('--mode report --json がパース可能なJSONを返す', () => {
    const out = run('--mode', 'report', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.ok(typeof parsed === 'object', 'オブジェクトである');
    assert.equal(parsed.mode, 'report', 'mode が report');
    assert.ok(parsed.lastRun, 'lastRun を含む');
    assert.ok(parsed.lastRun.totalRuns, 'totalRuns を含む');
  });

  it('--mode cron-setup --json が構造化された設定を返す', () => {
    const out = run('--mode', 'cron-setup', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.ok(typeof parsed === 'object', 'オブジェクトである');
    assert.equal(parsed.mode, 'cron-setup', 'mode が cron-setup');
    assert.ok(parsed.configs.systemd, 'systemd 設定を含む');
    assert.ok(parsed.configs.systemd.service, 'service ファイルを含む');
    assert.ok(parsed.configs.systemd.timer, 'timer ファイルを含む');
    assert.ok(parsed.configs.githubActions, 'GitHub Actions 設定を含む');
  });

  it('--mode weekly --dry-run がSKIP表示を含む', () => {
    const out = run('--mode', 'weekly', '--dry-run');
    assert.ok(out.includes('DRY-RUN') || out.includes('SKIP'), 'dry-run表示を含む');
    assert.ok(out.includes('競合分析'), 'パイプライン表示はある');
  });

  it('--mode weekly --json がパース可能なJSONを返す', () => {
    const out = run('--mode', 'weekly', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.ok(typeof parsed === 'object', 'オブジェクトである');
    assert.equal(parsed.mode, 'weekly', 'mode が weekly');
    assert.ok(Array.isArray(parsed.competitors), 'competitors が配列');
    assert.ok(Array.isArray(parsed.contentGaps), 'contentGaps が配列');
    assert.ok(parsed.report, 'report を含む');
  });

  it('--mode daily --dry-run --json が dryRun: true を含むJSONを返す', () => {
    const out = run('--mode', 'daily', '--dry-run', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.equal(parsed.mode, 'daily', 'mode が daily');
    assert.equal(parsed.dryRun, true, 'dryRun が true');
  });

  it('--mode weekly --dry-run --json が dryRun: true を含むJSONを返す', () => {
    const out = run('--mode', 'weekly', '--dry-run', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, 'JSONパースが成功');
    assert.equal(parsed.mode, 'weekly', 'mode が weekly');
    assert.equal(parsed.dryRun, true, 'dryRun が true');
  });

  it('--mode bogus --json がエラーJSONを返す', () => {
    const { stdout } = runWithStderr('--mode', 'bogus', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, 'JSONパースが成功');
    assert.equal(parsed.error, true, 'error フィールドが true');
    assert.ok(parsed.message.includes('不明なモード'), 'エラーメッセージを含む');
  });

  it('--scenario bogus --json がエラーJSONを返す', () => {
    const { stdout } = runWithStderr('--scenario', 'bogus', '--json');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, 'JSONパースが成功');
    assert.equal(parsed.error, true, 'error フィールドが true');
    assert.ok(parsed.message.includes('不明なシナリオ'), 'エラーメッセージを含む');
  });

  it('無効なモード名でエラーメッセージを返す', () => {
    const { stdout, stderr } = runWithStderr('--mode', 'bogus');
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('不明') || combined.includes('エラー'),
      'エラーメッセージを含む'
    );
  });

  it('--help がヘルプテキストを表示する', () => {
    const out = run('--help');
    assert.ok(out.includes('使い方'), '使い方を含む');
    assert.ok(out.includes('--mode'), '--mode オプションの説明を含む');
    assert.ok(out.includes('--scenario'), '--scenario オプションの説明を含む');
  });

  it('-h がヘルプテキストを表示する', () => {
    const out = run('-h');
    assert.ok(out.includes('使い方'), '使い方を含む');
  });

});