#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const SENSITIVE_APIS = new Set(['cookies', 'userScripts', 'debugger', 'desktopCapture', 'tabCapture', 'nativeMessaging', 'proxy', 'webRequest', 'webRequestBlocking', 'history', 'management', 'privacy', 'clipboardRead']);
const BROAD_HOSTS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);
const RISK_ORDER = { high: 0, medium: 1, low: 2 };

function readJson(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')), failed: false }; }
  catch { return { value: null, failed: true }; }
}

export function browserRoots({ platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  if (process.env.ORGIAST_BROWSER_ROOTS) return process.env.ORGIAST_BROWSER_ROOTS.split(path.delimiter).filter(Boolean).map((root) => ({ browser: path.basename(root), root }));
  if (platform === 'win32' && localAppData) return [
    ['Chrome', 'Google/Chrome/User Data'], ['Edge', 'Microsoft/Edge/User Data'],
    ['Brave', 'BraveSoftware/Brave-Browser/User Data'], ['Vivaldi', 'Vivaldi/User Data'],
    ['Chrome Beta', 'Google/Chrome Beta/User Data'],
  ].map(([browser, rel]) => ({ browser, root: path.join(localAppData, ...rel.split('/')) }));
  if (platform === 'darwin') return [
    ['Chrome', 'Google/Chrome'], ['Edge', 'Microsoft Edge'], ['Brave', 'BraveSoftware/Brave-Browser'],
  ].map(([browser, rel]) => ({ browser, root: path.join(home, 'Library', 'Application Support', ...rel.split('/')) }));
  return [];
}

function permissionData(setting) {
  const source = setting.active_permissions || setting.granted_permissions || {};
  const api = Array.isArray(source.api) ? source.api : [];
  const explicit = Array.isArray(source.explicit_host) ? source.explicit_host : [];
  const scriptable = Array.isArray(source.scriptable_host) ? source.scriptable_host : [];
  const broadHost = [...explicit, ...scriptable].some((item) => BROAD_HOSTS.has(item));
  const keyPerms = [...new Set(api.filter((item) => SENSITIVE_APIS.has(item)))].sort();
  return { broadHost, keyPerms, api, explicitHost: explicit, scriptableHost: scriptable };
}

function resolveName(root, profile, id, manifest) {
  const raw = typeof manifest?.name === 'string' ? manifest.name : '';
  const match = /^__MSG_(.+)__$/.exec(raw);
  if (!match) return raw;
  const locales = ['ja', 'en', 'en_US', manifest?.default_locale].filter(Boolean);
  // 実際の Chrome は Extensions/<id>/<version>_0/ のようにサフィックス付きで置く。
  // manifest.version をそのままディレクトリ名にすると名前解決が必ず失敗して
  // 人が読めない `__MSG_appName__` の表になるため、実ディレクトリを列挙して当てる。
  const extensionDir = path.join(root, profile, 'Extensions', id);
  const version = String(manifest?.version || '');
  let candidates = [];
  try { candidates = fs.readdirSync(extensionDir).filter((name) => name === version || name.startsWith(`${version}_`)).sort().reverse(); } catch {}
  if (!candidates.length) { try { candidates = fs.readdirSync(extensionDir).sort().reverse(); } catch {} }
  if (!candidates.length && version) candidates = [version];
  for (const dir of candidates) {
    for (const locale of [...new Set(locales)]) {
      const file = path.join(extensionDir, dir, '_locales', locale, 'messages.json');
      const parsed = readJson(file).value;
      const message = parsed?.[match[1]]?.message;
      if (typeof message === 'string' && message) return message;
    }
  }
  return raw;
}

function enabledValue(setting) {
  if (!setting || typeof setting !== 'object') return '判定不能';
  if (setting.state === 0) return false;
  if (Array.isArray(setting.disable_reasons)) return setting.disable_reasons.length === 0;
  if (setting.disable_reasons === undefined && setting.state !== undefined) return true;
  if (setting.disable_reasons === undefined && setting.state === undefined) return '判定不能';
  return '判定不能';
}

export function scanBrowserExtensions({ roots = browserRoots() } = {}) {
  const rows = [];
  let unreadableProfiles = 0;
  let emptyProfiles = 0;
  for (const { browser, root } of roots) {
    if (!fs.existsSync(root)) continue;
    const localState = readJson(path.join(root, 'Local State')).value || {};
    let profiles = [];
    try { profiles = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name))).map((e) => e.name); }
    catch { continue; }
    for (const profile of profiles) {
      const secureFile = path.join(root, profile, 'Secure Preferences');
      const fallbackFile = path.join(root, profile, 'Preferences');
      let parsed = fs.existsSync(secureFile) ? readJson(secureFile) : { value: null, failed: false };
      if (!parsed.value && !parsed.failed) parsed = readJson(fallbackFile);
      if (parsed.failed || !parsed.value) { unreadableProfiles += 1; continue; }
      const settings = parsed.value?.extensions?.settings;
      // 拡張が0本のプロファイルは「読めなかった」ではない。混ぜると
      // 読み取り失敗の警告が常時点灯して意味を失うため別に数える。
      if (!settings || typeof settings !== 'object') { emptyProfiles += 1; continue; }
      for (const [id, setting] of Object.entries(settings)) {
        const manifest = setting?.manifest || {};
        const perms = permissionData(setting || {});
        const risk = perms.broadHost ? (perms.keyPerms.length ? 'high' : 'medium') : (perms.keyPerms.length ? 'medium' : 'low');
        const location = setting?.location;
        const locationText = String(location ?? '').toLowerCase();
        // Chromium ManifestLocation: 5=COMPONENT, 7/9=EXTERNAL_POLICY*, 10=EXTERNAL_COMPONENT.
        const builtin = setting?.was_installed_by_default === true || locationText.includes('component') || locationText.includes('external_policy') || [5, 7, 9, 10].includes(location);
        rows.push({ browser, profile, account: localState?.profile?.info_cache?.[profile]?.user_name || '', name: resolveName(root, profile, id, manifest), id, version: String(manifest.version || ''), enabled: enabledValue(setting), risk, builtin, broadHost: perms.broadHost, keyPerms: perms.keyPerms, fromWebstore: setting?.from_webstore, wasInstalledByDefault: setting?.was_installed_by_default, location, withholdingPermissions: setting?.withholding_permissions });
      }
    }
  }
  rows.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.name.localeCompare(b.name, 'ja') || a.browser.localeCompare(b.browser) || a.profile.localeCompare(b.profile) || a.id.localeCompare(b.id));
  const summary = { high: 0, medium: 0, low: 0, builtin: 0 };
  for (const row of rows) { summary[row.risk] += 1; if (row.builtin) summary.builtin += 1; }
  return { rows, summary, unreadableProfiles, emptyProfiles };
}

// enabled は true/false/'判定不能' の3値。人が読む表に true/false を出すと
// 「有効」と「判定できなかった」の区別が伝わらないので日本語に寄せる。
export function enabledLabel(value) {
  return value === true ? '有効' : value === false ? '無効' : '判定不能';
}

export function formatHuman(result) {
  const lines = ['リスク\t名前\tブラウザ\tプロファイル(アカウント)\tバージョン\t有効\t広域\t主要権限'];
  for (const r of result.rows) lines.push([r.risk, r.name, r.browser, `${r.profile}${r.account ? ` (${r.account})` : ''}`, r.version, enabledLabel(r.enabled), r.broadHost ? 'あり' : 'なし', r.keyPerms.join(',') || '-'].join('\t'));
  lines.push(`件数: high=${result.summary.high} medium=${result.summary.medium} low=${result.summary.low} builtin=${result.summary.builtin}`);
  lines.push(`読めなかったプロファイル: ${result.unreadableProfiles} / 拡張0本のプロファイル: ${result.emptyProfiles}`);
  return lines.join('\n');
}

async function main() {
  const result = scanBrowserExtensions();
  const json = process.argv.includes('--json');
  const outIndex = process.argv.indexOf('--out');
  const text = json ? JSON.stringify(result, null, 2) : formatHuman(result);
  if (outIndex >= 0 && process.argv[outIndex + 1]) fs.writeFileSync(process.argv[outIndex + 1], `${text}\n`, 'utf8');
  else console.log(text);
}

if (isEntry(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
