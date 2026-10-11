// setup --converge の「mobile standby」ステップ。スマホ(Remote Control)用の空き Claude Code タブを
// 全PCで常時 3 本待機させるための収束処理。冪等。タブの起動自体は拡張（orgiast.next-session）が行う。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveVscodeCli, pickBundledVsix, vsixVersion, compareVersions, shouldInstallBundledVsix,
} from './next-session-launch.mjs';

export const MOBILE_STANDBY_COUNT = 3;
const EXTENSION_ID = 'orgiast.next-session';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));

// ~/.claude/mobile-sessions.json: 無ければ作成、count が 3 未満なら count だけ引き上げ（他キーは保持）。
export function convergeMobileConfig(home, count = MOBILE_STANDBY_COUNT) {
  const file = path.join(home, '.claude', 'mobile-sessions.json');
  let config = {};
  let exists = false;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') return { changed: false, note: `mobile-sessions.json を解釈できないため変更しません: ${error.message}` }; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { changed: false, note: 'mobile-sessions.json がオブジェクトではないため変更しません' };
  const current = Number(config.count);
  if (exists && Number.isInteger(current) && current >= count) return { changed: false, note: `count=${current}（変更なし）` };
  const next = { ...config, count };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { changed: true, note: exists ? `count ${config.count ?? '未設定'} -> ${count}` : `作成 count=${count}` };
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
export function convergeMobileExtension({ home, repoRoot, env = process.env, exists = fs.existsSync, readdir = fs.readdirSync, runCodeCli }) {
  const codeCli = resolveVscodeCli({ env, exists, homedir: home });
  if (!codeCli) return { status: 'skip', note: 'VSCode(code.cmd) が無いためスキップ' };
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

export function convergeMobileStandby({ home, repoRoot = path.dirname(toolsDir), env = process.env, runCodeCli, exists, readdir, settingsPath } = {}) {
  const lines = [];
  const result = { ok: true, lines };
  const note = (label, outcome) => lines.push(`[mobile-standby] ${label}: ${outcome.note}`);
  try { const r = convergeMobileConfig(home); note('mobile-sessions.json', r); result.config = r; }
  catch (error) { result.ok = false; lines.push(`[mobile-standby] mobile-sessions.json: 失敗 ${error.message}`); }
  try {
    const target = settingsPath ?? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
    const r = removeMobileTabsZero(target); note('VSCode settings', r); result.settings = r;
  } catch (error) { result.ok = false; lines.push(`[mobile-standby] VSCode settings: 失敗 ${error.message}`); }
  try {
    const r = convergeMobileExtension({ home, repoRoot, env, runCodeCli, exists, readdir }); note('拡張', r); result.extension = r;
    if (r.status === 'ng') result.ok = false;
  } catch (error) { result.ok = false; lines.push(`[mobile-standby] 拡張: 失敗 ${error.message}`); }
  return result;
}
