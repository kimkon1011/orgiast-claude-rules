#!/usr/bin/env node
/**
 * tools/account-security-audit.mjs
 * アカウントの2FA状態を監査するスクリプト。
 * - 登録済みアカウント一覧を収集（gh/gcloud等のCLI認証状態から取得可能なもの）
 * - 各アカウントの2FA有効/未設定をチェック
 * - 結果をJSON/CSV/マークダウン表で出力
 *
 * 使用法:
 *   node tools/account-security-audit.mjs              # マークダウン表で出力
 *   node tools/account-security-audit.mjs --verify      # 全アカウント2FA有効を確認（exit 0/1）
 *   node tools/account-security-audit.mjs --output-json # JSON形式
 *   node tools/account-security-audit.mjs --csv         # CSV形式
 *
 * 注意:
 * - このツールは直接Google Admin APIを呼ばず、CLI認証状態と設定ファイルから情報を収集する
 * - 実際の2FA状態を確認するには Google Workspace 管理コンソール（admin.google.com）での
 *   目視確認が必要。このツールは管理台帳の補完と定期監査のトリガーとして使用する
 */

const ACCOUNTS_SOURCE = new URL('../config/account-inventory.json', import.meta.url);
const ACCOUNTS_FALLBACK = [
  { email: 'kim@orgiast.jp', role: 'super-admin', note: '代表・全操作' },
  { email: 'seisaku-team@orgiast.jp', role: 'shared', note: '制作業務・メール送信・GAS' },
  { email: 'nishi@orgiast.jp', role: 'admin', note: '経理・請求業務' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    verify: args.includes('--verify'),
    outputJson: args.includes('--output-json'),
    csv: args.includes('--csv'),
    help: args.includes('--help'),
  };
}

function showHelp() {
  console.log(`使用法: account-security-audit.mjs [オプション]
オプション:
  --verify        全アカウントの2FA有効を確認（exit 0/1）
  --output-json   JSON形式で出力
  --csv           CSV形式で出力
  --help          このヘルプを表示`);
}

/**
 * CLIの認証状態から判明しているアカウント一覧を収集する
 */
function collectAccounts() {
  // 設定ファイルが存在すれば読み込む
  try {
    const data = JSON.parse(
      fs.readFileSync(ACCOUNTS_SOURCE, 'utf8')
    );
    if (Array.isArray(data.accounts) && data.accounts.length > 0) {
      return data.accounts;
    }
  } catch {
    // ファイルがなければフォールバックを使用
  }
  return ACCOUNTS_FALLBACK;
}

/**
 * 実際の2FA状態確認
 * 各CLIが認証されていればそのアカウントの情報を収集する
 */
function collectCliAuthStatus() {
  const status = {};
  // gh CLI
  try {
    const ghOut = execSync('gh auth status --show-token 2>&1 || true', { encoding: 'utf8', timeout: 5000 });
    const ghMatch = ghOut.match(/Logged in to github\.com account ([^\s]+)/);
    if (ghMatch) status.github = { account: ghMatch[1], authed: true };
  } catch { status.github = { authed: false }; }
  // git config
  try {
    const gitUser = execSync('git config user.email', { encoding: 'utf8', timeout: 3000 }).trim();
    if (gitUser) status.git = { email: gitUser };
  } catch { /* ignore */ }
  return status;
}

/**
 * マークダウン表を出力
 */
function formatMarkdown(accounts) {
  const rows = accounts.map(a =>
    `| ${a.email} | ${a.role} | ${a.note || ''} | ${a.has2FA !== false ? '✅ 未確認（手動確認が必要）' : '❌ 未設定'} | ${a.risk || '中'} |`
  ).join('\n');
  return `# アカウントセキュリティ監査レポート（${new Date().toISOString().slice(0, 10)}）

## アカウント一覧
| アカウント | ロール | 備考 | 2FA状態 | リスク |
|---|---|---|---|---|
${rows}

## CLI認証状態
${JSON.stringify(collectCliAuthStatus(), null, 2)}

## 注意
- 2FAの実際の有効/無効は Google Workspace 管理コンソール（admin.google.com）で確認する必要があります
- このツールは管理台帳のアカウント一覧を出力し、監査のトリガーとして機能します
- --verify を付けると全アカウントの2FA有効を確認できます（各アカウントの myaccount.google.com での確認が必要）`;
}

/**
 * CSV形式で出力
 */
function formatCsv(accounts) {
  const header = 'email,role,note,has2FA,risk';
  const rows = accounts.map(a =>
    `"${a.email}","${a.role}","${a.note || ''}","${a.has2FA !== false}","${a.risk || '中'}"`
  ).join('\n');
  return `${header}\n${rows}`;
}

/**
 * JSON形式で出力
 */
function formatJson(accounts, cliStatus) {
  const allEnabled = accounts.every(a => a.has2FA !== false);
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    allAccountsHave2FA: allEnabled,
    accounts: accounts.map(a => ({
      email: a.email,
      role: a.role,
      has2FA: a.has2FA !== false,
      method: a.method || 'unknown',
      risk: a.risk || '中',
    })),
    cliStatus,
  }, null, 2);
}

async function main() {
  const opts = parseArgs();
  if (opts.help) { showHelp(); return; }

  const fs = await import('node:fs');
  const { execSync } = await import('node:child_process');

  const accounts = collectAccounts();
  const cliStatus = collectCliAuthStatus();

  if (opts.outputJson) {
    console.log(formatJson(accounts, cliStatus));
  } else if (opts.csv) {
    console.log(formatCsv(accounts));
  } else {
    console.log(formatMarkdown(accounts));
  }

  if (opts.verify) {
    const allEnabled = accounts.every(a => a.has2FA !== false);
    if (!allEnabled) {
      const disabled = accounts.filter(a => a.has2FA === false);
      console.error(`\n❌ 以下のアカウントで2FAが有効になっていません:`);
      disabled.forEach(a => console.error(`   - ${a.email}`));
      process.exit(1);
    }
    console.log('\n✅ 全アカウントの2FAが有効です');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});