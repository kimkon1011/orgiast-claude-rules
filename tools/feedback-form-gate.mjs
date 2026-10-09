#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';

export const SHELL_TOOLS = 'Bash|PowerShell';
export const SHELL_TOOL = new RegExp(`^(?:${SHELL_TOOLS})$`);
export const HOOK_MATCHER = SHELL_TOOLS;

const DEPLOY_PATTERNS = [
  /vercel\s+deploy\b/i,
  /vercel\s+--prod\b/i,
  /vercel\s+redeploy\b/i,
  /vc\.js\s+deploy\b/i,
  /vc\.js\s+redeploy\b/i,
  /clasp\s+push\b/i,
  /clasp\s+deploy\b/i,
  /gas[\\/]deploy\.mjs\b/i,
  /npm\s+run\s+deploy\b/i,
  /netlify\s+deploy\b/i,
  /wrangler\s+deploy\b/i,
  /wrangler\s+pages\s+deploy\b/i,
  /firebase\s+deploy\b/i,
];

export function isDeployCommand(command) {
  const text = String(command ?? '');
  return DEPLOY_PATTERNS.some((pattern) => pattern.test(text));
}

function stripQuotes(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) return text.slice(1, -1);
  return text;
}

export function resolveTargetDir(command, cwd) {
  const text = String(command ?? '');
  const base = cwd || process.cwd();
  const patterns = [
    /(?:^|[\s;&|(])cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i,
    /(?:^|[\s;&|(])Set-Location\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i,
    /--cwd(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i,
    /(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let dir = stripQuotes(match[1] || match[2] || match[3]);
      if (!dir) continue;
      // Git Bash の /d/Claude/x 形式は Windows では D:/Claude/x に読み替える
      if (process.platform === 'win32') dir = dir.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
      return path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(base, dir);
    }
  }
  return base;
}

const ROOT_MARKERS = ['package.json', 'appsscript.json', '.clasp.json'];

export function findProjectRoot(dir) {
  let current = path.resolve(dir || process.cwd());
  for (let depth = 0; depth < 8; depth += 1) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function detectKind(root) {
  if (!root) return null;
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps && Object.prototype.hasOwnProperty.call(deps, 'next')) return 'next';
    } catch {
      // 読めない package.json は無視して他の判定へ進む
    }
  }
  if (fs.existsSync(path.join(root, 'appsscript.json')) || fs.existsSync(path.join(root, '.clasp.json'))) return 'gas';
  return null;
}

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out']);
const MAX_FILES = 2000;

function walkFiles(dir, extensions, onFile) {
  const stack = [dir];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
      } else if (entry.isFile()) {
        if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
        count += 1;
        if (count > MAX_FILES) return { truncated: true };
        if (onFile(path.join(current, entry.name))) return { found: true };
      }
    }
  }
  return { found: false, truncated: false };
}

function readClaspRootDir(root) {
  const claspPath = path.join(root, '.clasp.json');
  if (!fs.existsSync(claspPath)) return root;
  try {
    const clasp = JSON.parse(fs.readFileSync(claspPath, 'utf8'));
    const rootDir = clasp && typeof clasp.rootDir === 'string' ? clasp.rootDir.trim() : '';
    if (!rootDir) return root;
    return path.isAbsolute(rootDir) ? path.normalize(rootDir) : path.resolve(root, rootDir);
  } catch {
    return root;
  }
}

export function hasFeedback(root, kind) {
  if (!root || !kind) return false;
  if (kind === 'next') {
    const exts = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];
    const searchDirs = ['app', 'src', 'components', 'pages']
      .map((name) => path.join(root, name))
      .filter((dir) => fs.existsSync(dir));
    for (const dir of searchDirs) {
      const result = walkFiles(dir, exts, (file) => {
        try {
          return fs.readFileSync(file, 'utf8').includes('FeedbackWidget');
        } catch {
          return false;
        }
      });
      if (result.found) return true;
      if (result.truncated) return true;
    }
    return false;
  }
  if (kind === 'gas') {
    const base = readClaspRootDir(root);
    const exts = ['.js', '.gs', '.html'];
    const result = walkFiles(base, exts, (file) => {
      try {
        const source = fs.readFileSync(file, 'utf8');
        return source.includes('FeedbackRelay') || hasSharedFormLink(source);
      } catch {
        return false;
      }
    });
    if (result.found) return true;
    if (result.truncated) return true;
    return false;
  }
  return false;
}

export function exemptReason(root) {
  if (!root) return null;
  const file = path.join(root, '.feedback-exempt');
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

// Match one URL, so an unrelated form parameter elsewhere cannot satisfy the gate.
export function hasSharedFormLink(source) {
  const urls = String(source).match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec\?[^\s"'`<>]+/g) || [];
  return urls.some((url) => {
    try { return new URL(url.replace(/&amp;/g, '&')).searchParams.get('form') === 'feedback'; }
    catch { return false; }
  });
}

function gasInstall(root, { env = process.env, home = env.ORGIAST_HOME || env.USERPROFILE || os.homedir() } = {}) {
  const raw = env.FEEDBACK_SHARED_FORM_URL || readEnvValue(path.join(home, '.claude', 'feedback-relay.env'), 'FEEDBACK_SHARED_FORM_URL');
  const appName = path.basename(root);
  let link = '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.hostname === 'script.google.com' && !url.port && !url.username && !url.password && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) {
      const href = `${url.origin}${url.pathname}?form=feedback&app=${encodeURIComponent(appName)}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      link = `<a href="${href}" target="_blank" rel="noopener">不具合・要望</a>`;
    }
  } catch {}
  const sync = fileURLToPath(new URL('./onboarding-sync.mjs', import.meta.url));
  return `方式B: 社員が開く HTML に共通フォームへのリンクを1本置きます。\n${link
    ? `アプリ名はフォルダ名「${appName}」から生成しています。正式名が異なる場合は app= を encodeURIComponent(正式名) で置き換えてください。\n${link}`
    : `共通フォームURLが未取得または不正です。keyserve から ~/.claude/feedback-relay.env を取得してください（既存の他キーは保持されます）。\nnode "${sync}" --keys-only --force\n取得後に元のコマンドを再実行すると、貼り付け用リンクを表示します。`}
方式A（FeedbackRelay）と方式Bの詳細: https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/packages/feedback-gas/INSTALL.md`;
}

function buildReason(kind, root, options) {
  const formName = kind === 'gas' ? 'FeedbackRelay または方式Bリンク' : 'FeedbackWidget';
  const install = kind === 'gas'
    ? gasInstall(root, options)
    : 'node -e "fetch(\'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/packages/feedback-widget/install.mjs?cb=\'+Date.now()).then(r=>r.text()).then(t=>require(\'fs\').writeFileSync(\'install-feedback.mjs\',t))" && node install-feedback.mjs --app-name "<アプリ名>"';
  return `[FEEDBACK-FORM] §2.11: 社員が使う社内アプリは「不具合・要望フォーム」と「対応完了時の投稿者への完了報告」の搭載が必須です。${root} にはフォーム（${formName}）が見当たらないため、本番反映を止めました。
導入（アプリのリポジトリ直下で実行）:
${install}
${kind === 'gas' ? '導入後は INSTALL.md の方式別検証手順でフォームを開き、アプリ名・実投稿・通知を確認してください。' : '導入後 node verify.mjs --url <本番URL> で実投稿と read-back まで確認してください。'}
社員が使わないアプリ（個人ツール・ライブラリ・社外向け LP 等）なら、user に確認を取ったうえで、理由を1行書いた .feedback-exempt をリポジトリ直下に置けば通ります。`;
}

// install.mjs が app/api/feedback/route.ts に焼き込む APP_NAME を読む。見つからなければ null。
export function readAppName(root) {
  for (const rel of ['app/api/feedback/route.ts', 'app/api/feedback/route.js', 'src/app/api/feedback/route.ts', 'src/app/api/feedback/route.js']) {
    try {
      const match = fs.readFileSync(path.join(root, rel), 'utf8').match(/const\s+APP_NAME\s*=\s*["'`]([^"'`]+)["'`]/);
      if (match) return match[1];
    } catch {}
  }
  return null;
}

// feedback-to-issues.mjs と同じ台帳 + env FEEDBACK_REPO_MAP。ここに無いアプリは投稿が Issue 化されず完了報告も飛ばない。
export function isRegistered(appName, registryFile = new URL('./feedback-apps.json', import.meta.url), env = process.env) {
  try {
    if (Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(registryFile, 'utf8')), appName)) return true;
  } catch {}
  return String(env.FEEDBACK_REPO_MAP || '').split(',').some((entry) => entry.split('=')[0].trim() === appName);
}

function buildRegistryReason(appName, root) {
  return `[FEEDBACK-FORM] §2.11: ${root} の不具合・要望フォーム（アプリ名「${appName}」）は、完了報告の台帳 tools/feedback-apps.json に未登録です。このままでは投稿が GitHub Issue にならず、対応完了時に投稿者へ完了報告が届きません。
正本 kimkon1011/orgiast-claude-rules の tools/feedback-apps.json に "${appName}": "<owner>/<repo>"（このアプリの git remote origin）を1行足す PR を、正本ブランチ + automerge ラベルで出してください。
マージ後の配布を待たずに反映したい場合は、この PC の環境変数 FEEDBACK_REPO_MAP に ${appName}=<owner>/<repo> を足すと通ります（feedback-to-issues.mjs も同じ値を使います）。`;
}

export function judge({ command, cwd }, { registryFile, env, home } = {}) {
  if (!isDeployCommand(command)) return { deny: false };
  const targetDir = resolveTargetDir(command, cwd);
  const root = findProjectRoot(targetDir);
  if (!root) return { deny: false };
  const kind = detectKind(root);
  if (!kind) return { deny: false };
  if (exemptReason(root)) return { deny: false };
  if (!hasFeedback(root, kind)) return { deny: true, reason: buildReason(kind, root, { env, home }) };
  if (kind === 'next') {
    const appName = readAppName(root);
    if (appName && !isRegistered(appName, registryFile, env)) return { deny: true, reason: buildRegistryReason(appName, root) };
  }
  return { deny: false };
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (!SHELL_TOOL.test(input?.tool_name || '')) return;
    const command = String(input?.tool_input?.command ?? '');
    const cwd = input?.cwd || process.cwd();
    const result = judge({ command, cwd });
    if (result.deny) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
        },
      }));
    }
  } catch {
    // fail-open: 例外・JSON パース失敗はすべて通す
  }
}

if (isEntry(import.meta.url)) await main();
