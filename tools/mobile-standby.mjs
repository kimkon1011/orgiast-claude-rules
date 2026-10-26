// setup --converge の「mobile standby」ステップ。スマホ(Remote Control)用の空き Claude Code タブを
// 全PCで常時 3 本待機させるための収束処理。冪等。タブの起動自体は拡張（orgiast.next-session）が行う。
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveVscodeCli, vscodeCliCandidates, pickBundledVsix, vsixVersion, compareVersions, shouldInstallBundledVsix,
} from './next-session-launch.mjs';
import pool from './lib/mobile-state.cjs';

export const MOBILE_STANDBY_COUNT = 3;
// Remote Control のセッション名接頭辞。短くしてスマホの一覧で切れないようにする。
// 意味は「まだ発言していない＝未使用のセッション枠」。
export const RC_NAME_PREFIX = '待機';
const RC_PREFIX_ENV = 'CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX';
const EXTENSION_ID = 'orgiast.next-session';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));

// 全PC共通のリフレッシュ設定（リポジトリ同期で配られる）。値が未設定なら従来どおり変更しない。
export const MOBILE_REFRESH_FILE = 'mobile-refresh.json';
export function readMobileRefreshConfig(repoRoot) {
  const file = path.join(repoRoot, 'tools', MOBILE_REFRESH_FILE);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; return { error: `mobile-refresh.json を解釈できません: ${error.message}` }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'mobile-refresh.json がオブジェクトではありません' };
  const next = {};
  if (raw.minutes != null) {
    const minutes = Number(raw.minutes);
    if (!Number.isFinite(minutes) || minutes < 0) return { error: `mobile-refresh.json の minutes が不正: ${raw.minutes}` };
    next.minutes = minutes;
  }
  if (raw.hours != null) {
    const hours = String(raw.hours).trim();
    if (!pool.parseRefreshHours(hours)) return { error: `mobile-refresh.json の hours が不正: ${raw.hours}` };
    next.hours = hours;
  }
  return Object.keys(next).length ? next : null;
}

// ~/.claude/mobile-sessions.json: 無ければ作成、count が 3 未満なら count だけ引き上げ（他キーは保持）。
// refresh={minutes,hours} が渡されたときだけ refreshMinutes/refreshHours も書く（他キーは保持）。
export function convergeMobileConfig(home, count = MOBILE_STANDBY_COUNT, refresh = null) {
  const file = path.join(home, '.claude', 'mobile-sessions.json');
  let config = {};
  let exists = false;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') return { changed: false, note: `mobile-sessions.json を解釈できないため変更しません: ${error.message}` }; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { changed: false, note: 'mobile-sessions.json がオブジェクトではないため変更しません' };
  if (config.enabled === false) return { changed: false, note: '無効（enabled:false）' };
  const next = { ...config };
  const notes = [];
  const current = Number(config.count);
  if (!(exists && Number.isInteger(current) && current >= count)) {
    notes.push(exists ? `count ${config.count ?? '未設定'} -> ${count}` : `作成 count=${count}`);
    next.count = count;
  }
  if (refresh?.minutes != null && next.refreshMinutes !== refresh.minutes) {
    notes.push(`refreshMinutes ${config.refreshMinutes ?? '未設定'} -> ${refresh.minutes}`);
    next.refreshMinutes = refresh.minutes;
  }
  if (refresh?.hours != null && next.refreshHours !== refresh.hours) {
    notes.push(`refreshHours ${config.refreshHours ?? '未設定'} -> ${refresh.hours}`);
    next.refreshHours = refresh.hours;
  }
  if (notes.length === 0) return { changed: false, note: `count=${current}（変更なし）` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { changed: true, note: notes.join(' / ') };
}

// VS Code user settings の orgiast.nextSession.mobileTabs=0（補充無効化）を外す。
export function removeMobileTabsZero(settingsPath) {
  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { return { changed: false, note: 'settings.json なし' }; }
  const hasKey = /"orgiast\.nextSession\.mobileTabs"\s*:\s*0\s*(,|\}|\r?\n)/.test(raw);
  if (!hasKey) return { changed: false, note: 'mobileTabs=0 の指定なし' };
  let out;
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (parsed['orgiast.nextSession.mobileTabs'] !== 0) return { changed: false, note: 'mobileTabs=0 の指定なし' };
    delete parsed['orgiast.nextSession.mobileTabs'];
    out = `${JSON.stringify(parsed, null, 4)}\n`;
  } catch {
    // コメント付き(JSONC)は行単位で除去。最終プロパティだった場合は直前行の末尾カンマも外す。
    const lines = raw.split(/\r?\n/);
    const index = lines.findIndex((line) => /^\s*"orgiast\.nextSession\.mobileTabs"\s*:\s*0\s*,?\s*(\/\/.*)?$/.test(line));
    if (index < 0) return { changed: false, note: 'mobileTabs=0 を安全に除去できないため変更しません' };
    const hadComma = /,\s*(\/\/.*)?$/.test(lines[index]);
    lines.splice(index, 1);
    if (!hadComma) {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (!lines[i].trim()) continue;
        lines[i] = lines[i].replace(/,(\s*)$/, '$1');
        break;
      }
    }
    out = lines.join('\n');
  }
  fs.writeFileSync(settingsPath, out, 'utf8');
  return { changed: true, note: 'orgiast.nextSession.mobileTabs=0 を除去' };
}

// JSONC のコメント・既存書式を保持し、判定できない設定は変更しない。
export function ensureMobileRefreshDisabled(settingsPath) {
  return ensureZeroSetting(settingsPath, 'mobileRefreshMinutes', 'norefresh');
}
export function ensureMobileTabsDisabled(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{}\n', 'utf8');
  }
  return ensureZeroSetting(settingsPath, 'mobileTabs', 'nomobile');
}
function ensureZeroSetting(settingsPath, setting, backup) {
  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { changed: false, note: 'settings.json なし' };
    throw error;
  }
  const unsafe = () => ({ changed: false, note: `${setting} を安全に編集できないため変更しません` });
  // 文字列中の // や /* はコメントではない。文字位置と改行は維持する。
  const clean = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('"') ? token : token.replace(/[^\r\n]/g, ' '));
  let parsed;
  try {
    const json = clean.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g,
      (token) => token === ',' ? ' ' : token);
    parsed = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch { return unsafe(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unsafe();
  const key = `orgiast.nextSession.${setting}`;
  const keys = [...clean.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)]
    .filter((match) => JSON.parse(match[0].slice(0, match[0].lastIndexOf(':')).trim()) === key);
  let out;
  if (Object.hasOwn(parsed, key)) {
    if (keys.length !== 1) return unsafe();
    if (parsed[key] === 0) return { changed: false, note: `${setting}=0（変更なし）` };
    const start = keys[0].index;
    const lineStart = raw.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = raw.indexOf('\n', start);
    const end = lineEnd < 0 ? raw.length : lineEnd;
    const line = raw.slice(lineStart, end);
    const match = line.match(/^(\s*"orgiast\.nextSession\.(?:mobileRefreshMinutes|mobileTabs)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|"(?:\\.|[^"\\])*")(\s*,?\s*(?:\/\/[^\r\n]*)?\r?)$/);
    if (!match) return unsafe();
    out = raw.slice(0, lineStart) + match[1] + '0' + match[3] + raw.slice(end);
  } else {
    if (keys.length) return unsafe();
    const opening = clean.indexOf('{');
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const tail = raw.slice(opening + 1);
    out = raw.slice(0, opening + 1) + newline + `  "${key}": 0,` +
      (/^\r?\n/.test(tail) ? tail : newline + tail);
  }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  fs.copyFileSync(settingsPath, `${settingsPath}.bak-${backup}-${stamp}.json`, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(settingsPath, out, 'utf8');
  return { changed: true, note: `${key}=0 を設定` };
}

// powershell.exe を -EncodedCommand(UTF-16LE の Base64)で呼ぶ。日本語が化けないための必須手順。
function runPowershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// powershell.exe(5.1) の stdout はコンソールのコードページで出るため、日本語は Base64 経由で受け取る。
// （UTF-8 として読むと "待機" が "�ҋ@" になり、既に同じ値でも毎回書き込んでしまう。）
function defaultReadUserEnv(name) {
  const q = String(name).replace(/'/g, "''");
  const encoded = runPowershell(`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string][Environment]::GetEnvironmentVariable('${q}','User')))`);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function defaultWriteUserEnv(name, value) {
  // PowerShell の単一引用符リテラルは ' を '' に二重化してエスケープする。
  const q = (text) => String(text).replace(/'/g, "''");
  runPowershell(`[Environment]::SetEnvironmentVariable('${q(name)}','${q(value)}','User')`);
}

// Windows のユーザー環境変数に RC のセッション名接頭辞を配る。冪等。
// VS Code 拡張ホスト(Code.exe)の環境に入れておけば、拡張の spawn が process.env 経由で CLI に届ける。
export function convergeRcNamePrefix({ platform = process.platform, readUserEnv, writeUserEnv, prefix = RC_NAME_PREFIX } = {}) {
  if (platform !== 'win32') return { changed: false, ok: true, note: 'Windows 以外はスキップ' };
  const read = readUserEnv ?? defaultReadUserEnv;
  const write = writeUserEnv ?? defaultWriteUserEnv;
  try {
    const current = String(read(RC_PREFIX_ENV) ?? '').trim();
    if (current === prefix) return { changed: false, ok: true, note: `${RC_PREFIX_ENV} は既に "${prefix}"` };
    write(RC_PREFIX_ENV, prefix);
    return { changed: true, ok: true, note: `${RC_PREFIX_ENV}: "${current || '未設定'}" -> "${prefix}"` };
  } catch (error) {
    return { changed: false, ok: false, note: `${RC_PREFIX_ENV} の設定に失敗 ${error.message}` };
  }
}

function installedVersionFromDisk(home, readdir) {
  try {
    const versions = readdir(path.join(home, '.vscode', 'extensions'))
      .map((name) => String(name).match(/^orgiast\.next-session-([0-9]+(?:\.[0-9]+){2})/)?.[1])
      .filter(Boolean)
      .sort(compareVersions);
    return versions.at(-1) ?? '';
  } catch { return ''; }
}

function defaultRunCodeCli(codeCli, args) {
  try {
    const stdout = execFileSync('cmd.exe', ['/d', '/s', '/c', `""${codeCli}" ${args.map((a) => `"${a}"`).join(' ')}"`], {
      encoding: 'utf8', timeout: 50_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) { return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? '') }; }
}

// 同梱最新 VSIX を導入／更新（未導入 or 古い時だけ）。VSCode が無い PC はスキップ。
export function convergeMobileExtension({ home, repoRoot, env = process.env, exists = fs.existsSync, readdir = fs.readdirSync, runCodeCli, regQuery }) {
  const io = { env, exists, homedir: home, regQuery };
  const codeCli = resolveVscodeCli(io);
  if (!codeCli) {
    // VS Code の痕跡があるのに CLI が見つからない = 配ったのに効いていない。skip ではなく NG にして可視化する。
    const traces = [path.join(home, '.vscode', 'extensions'), path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User')];
    if (traces.some((p) => exists(p))) {
      const tried = vscodeCliCandidates(io);
      return { status: 'ng', note: `VSCode の痕跡あり but code.cmd 未検出(探索${tried.length}件)。探した候補: ${tried.join(' | ')}` };
    }
    return { status: 'skip', note: 'VSCode(code.cmd) が無いためスキップ' };
  }
  const packageDir = path.join(repoRoot, 'packages', 'vscode-next-session');
  let vsixName = '';
  try { vsixName = pickBundledVsix(readdir(packageDir)); } catch { /* 下で報告 */ }
  if (!vsixName) return { status: 'ng', note: `同梱 VSIX が見つかりません: ${packageDir}` };
  const bundled = vsixVersion(vsixName);
  const onDisk = installedVersionFromDisk(home, readdir);
  if (onDisk && compareVersions(onDisk, bundled) >= 0) return { status: 'ok', note: `${EXTENSION_ID}@${onDisk} 導入済み` };
  const run = runCodeCli ?? ((args) => defaultRunCodeCli(codeCli, args));
  const listed = run(['--list-extensions', '--show-versions']);
  if (listed.code !== 0) return { status: 'ng', note: `拡張一覧の取得に失敗: ${listed.stderr || `exit ${listed.code}`}`.slice(0, 200) };
  if (!shouldInstallBundledVsix({ listedExtensions: listed.stdout, vsixName })) return { status: 'ok', note: `${EXTENSION_ID} は最新` };
  const installed = run(['--install-extension', path.join(packageDir, vsixName), '--force']);
  if (installed.code !== 0) return { status: 'ng', note: `拡張の導入に失敗: ${installed.stderr || `exit ${installed.code}`}`.slice(0, 200) };
  return { status: 'installed', note: `${EXTENSION_ID}@${bundled} を導入（VSCode ウィンドウの再読み込みで有効化）` };
}

export function convergeMobileStandby({ home, repoRoot = path.dirname(toolsDir), env = process.env, runCodeCli, regQuery, exists, readdir, settingsPath, rcPrefix = {} } = {}) {
  const enabled = pool.isMobileEnabled(home);
  const lines = [];
  if (!enabled) lines.push('[mobile-standby] 無効（mobile-sessions.json enabled:false）');
  const result = { ok: true, lines };
  const note = (label, outcome) => lines.push(`[mobile-standby] ${label}: ${outcome.note}`);
  try {
    const desired = enabled ? readMobileRefreshConfig(repoRoot) : null;
    if (desired?.error) { result.ok = false; lines.push(`[mobile-standby] mobile-refresh.json: NG ${desired.error}`); }
    // mobile-refresh.json が無い PC でも refreshMinutes=0 を配る（拡張は VS Code 設定より json を優先する。作業中のスマホ会話タブを閉じる事故の再発防止）
    else { const r = convergeMobileConfig(home, MOBILE_STANDBY_COUNT, desired ?? { minutes: 0 }); note('mobile-sessions.json', r); result.config = r; }
  }
  catch (error) { result.ok = false; lines.push(`[mobile-standby] mobile-sessions.json: 失敗 ${error.message}`); }
  try {
    const target = settingsPath ?? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
    const r = enabled ? removeMobileTabsZero(target) : ensureMobileTabsDisabled(target); note('VSCode settings', r); result.settings = r;
  } catch (error) { result.ok = false; lines.push(`[mobile-standby] VSCode settings: 失敗 ${error.message}`); }
  try {
    const target = settingsPath ?? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
    const r = ensureMobileRefreshDisabled(target); note('VSCode refresh', r); result.refreshSetting = r;
  } catch (error) { result.ok = false; lines.push(`[mobile-standby] VSCode refresh: 失敗 ${error.message}`); }
  try {
    const r = convergeMobileExtension({ home, repoRoot, env, runCodeCli, exists, readdir, regQuery }); note('拡張', r.status === 'ng' ? { note: `NG ${r.note}` } : r); result.extension = r;
    if (r.status === 'ng') result.ok = false;
  } catch (error) { result.ok = false; lines.push(`[mobile-standby] 拡張: 失敗 ${error.message}`); }
  try {
    const r = convergeRcNamePrefix(rcPrefix); note('RC接頭辞', r); result.rcPrefix = r;
    if (r.ok === false) result.ok = false;
  } catch (error) { result.ok = false; lines.push(`[mobile-standby] RC接頭辞: 失敗 ${error.message}`); }
  return result;
}

export function setMobileEnabled(home, enabled, settingsPath = path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json')) {
  const file = path.join(home, '.claude', 'mobile-sessions.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('mobile-sessions.json がオブジェクトではありません');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...config, enabled }, null, 2)}\n`);
  return enabled ? removeMobileTabsZero(settingsPath) : ensureMobileTabsDisabled(settingsPath);
}
if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--disable', '--enable'].includes(args[0])) throw new Error('--disable または --enable を指定してください');
  const enabled = args[0] === '--enable';
  const result = setMobileEnabled(process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir(), enabled);
  console.log(result.note);
  if (!enabled) console.log('既に開いている待機タブは閉じません。ユーザーが手で閉じてください。');
}
