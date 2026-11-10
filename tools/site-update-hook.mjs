// site-update-hook.mjs — サイト更新用 Git hook スクリプト
//
// .claude/settings.json の hook から呼ばれることを想定。
// サイトファイル（.html, .css, .js, .md）の変更を検出し、
// change_type を推論して site-test-runner でテストを実行する。
//
// スキップ条件:
//   コミットメッセージに [skip-site-test] を含む
//   変更ファイルに .md のみ（ドキュメントのみ）
//
// 使い方（CLI直実行）:
//   node tools/site-update-hook.mjs [--skip]
//
// 設定例 (.claude/settings.json):
//   "hooks": { "PreCommit": [{ "hooks": [{ "type": "command",
//     "command": "node \"${CLAUDE_PROJECT_DIR}/tools/site-update-hook.mjs\"",
//     "async": false, "timeout": 300 }] }] }

import { execSync } from 'node:child_process';

const SITE_EXTS = ['.html', '.css', '.js', '.json', '.svg'];
const SITE_DIRS = ['docs/', 'site/', 'public/', 'src/'];
const SKIP_TOKEN = '[skip-site-test]';

/**
 * 変更ファイルから変更種別を検出
 * @param {string[]} files - 変更ファイルパス一覧
 * @returns {string} change_type
 */
function detectChangeType(files) {
  const htmlFiles = files.filter(f => f.endsWith('.html'));
  const cssFiles = files.filter(f => f.endsWith('.css'));
  const jsFiles = files.filter(f => f.endsWith('.js'));
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  if (htmlFiles.length > 0 && cssFiles.length === 0 && jsFiles.length === 0 && jsonFiles.length === 0) {
    // HTMLのみ → 内容変更
    return 'text';
  }
  if (cssFiles.length > 0 && htmlFiles.length <= 1) {
    return 'layout';
  }
  if (jsFiles.length > 0 && htmlFiles.length === 0) {
    // JSのみ → 機能変更
    return 'layout';
  }
  if (htmlFiles.length > 0 || cssFiles.length > 0) {
    return 'full';
  }
  return 'text';
}

/**
 * 変更ファイル一覧を取得
 */
function getChangedFiles() {
  try {
    const stdout = execSync('git diff --cached --name-only', { encoding: 'utf-8', timeout: 10000 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * サイト関連ファイルのみ抽出
 */
function filterSiteFiles(files) {
  return files.filter(f => {
    const ext = SITE_EXTS.some(e => f.endsWith(e));
    const dir = SITE_DIRS.some(d => f.startsWith(d) || f.includes('/' + d));
    return ext || dir;
  });
}

/**
 * コミットメッセージにスキップトークンがあるか
 */
function hasSkipToken() {
  try {
    const msg = execSync('git log --format=%B -n 1 HEAD', { encoding: 'utf-8', timeout: 5000 }).trim();
    return msg.includes(SKIP_TOKEN);
  } catch {
    // 初回コミット等で失敗
    return false;
  }
}

/**
 * メイン
 */
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--skip') || args.includes('-s')) {
    process.exit(0);
  }

  // スキップチェック
  if (hasSkipToken()) {
    console.log('[site-update-hook] スキップトークン検出: テストをスキップします');
    process.exit(0);
  }

  const files = getChangedFiles();
  const siteFiles = filterSiteFiles(files);

  if (siteFiles.length === 0) {
    // サイト関連ファイル無し → スキップ
    process.exit(0);
  }

  // .md のみならスキップ
  const nonMdFiles = siteFiles.filter(f => !f.endsWith('.md'));
  if (nonMdFiles.length === 0) {
    process.exit(0);
  }

  const changeType = detectChangeType(nonMdFiles);
  console.log(`[site-update-hook] 検出: ${nonMdFiles.length}ファイル変更 (${changeType})`);
  console.log(`  変更ファイル: ${nonMdFiles.slice(0, 5).join(', ')}${nonMdFiles.length > 5 ? `...他${nonMdFiles.length - 5}件` : ''}`);
  console.log(`  テストを実行します...`);

  // 実際のテスト実行（CLI呼び出し）
  // ここではテストを実行せず、具体的な URL が設定されていない場合は
  // 「テストが利用可能」と表示するだけ
  // 実際の利用時は SITE_URL 環境変数か設定ファイルから URL を取得
  const siteUrl = process.env.SITE_URL || '';
  if (siteUrl) {
    console.log(`  対象: ${siteUrl}`);
    try {
      const { execSync } = require ? require('node:child_process') : await import('node:child_process');
      execSync(
        `node tools/site-test-runner.mjs --url "${siteUrl}" --change-type ${changeType}`,
        { stdio: 'inherit', cwd: process.cwd(), timeout: 60000 }
      );
      console.log('[site-update-hook] ✅ 全テスト合格');
    } catch {
      console.error('[site-update-hook] ❌ テスト不合格。コミットをブロックします。');
      console.error('   修正するか、緊急時はコミットメッセージに [skip-site-test] を含めてスキップしてください。');
      process.exit(1);
    }
  } else {
    console.log(`  テストスイート利用可能: ${changeType}`);
    console.log(`  SITE_URL 環境変数を設定すると自動テストが有効になります。`);
    console.log(`  例: set SITE_URL=https://orgiast.jp && git commit`);
  }
}

main();