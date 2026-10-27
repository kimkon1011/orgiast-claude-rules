#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notifyKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

function ownerPcMap(home) {
  const map = readJson(path.join(repo, 'fleet-pc-map.json'));
  for (const [label, row] of Object.entries(readJson(path.join(home, '.claude', 'fleet-pc-map.json')))) {
    map[label] = row && typeof row === 'object' ? { ...map[label], ...row } : row;
  }
  return map;
}

export function resolveOwner({ home = os.homedir(), label = resolveFleetLabel(home), pcMap, gitEmail } = {}) {
  const map = pcMap ?? ownerPcMap(home);
  const aliases = Object.entries(map).find(([, value]) => value && typeof value === 'object' && [value.hostname, value.sheetName, value.remoteName, ...(value.aliases || [])].includes(label));
  const configured = map[label] || aliases?.[1];
  if (configured?.account) return configured.account;
  try { return String(gitEmail ?? execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true })).trim(); } catch { return ''; }
}

export function resolveOwnerDiscordId(owner, { home = os.homedir(), directory, ...options } = {}) {
  const wanted = String(owner || '').trim().toLowerCase();
  const data = directory ?? readJson(path.join(home, '.claude', 'orgiast-discord-members.json'));
  const rows = Array.isArray(data) ? data : Object.values(data?.queries || data || {}).flatMap(v => Array.isArray(v?.members) ? v.members : []);
  const matches = [...new Set(rows.filter(row => wanted && (row.emails || []).some(email => String(email).toLowerCase() === wanted)).map(row => row.id).filter(Boolean).map(String))];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return '';
  const maps = options.pcMap ? [options.pcMap] : [ownerPcMap(home)];
  for (const map of maps) {
    const ids = [...new Set(Object.values(map).filter(row => row && typeof row === 'object' && String(row.account || row.owner || '').toLowerCase() === wanted).map(row => row.discordId).filter(Boolean).map(String))];
    if (ids.length) return ids.length === 1 ? ids[0] : '';
  }
  const localOwner = resolveOwner({ home, ...options }).toLowerCase();
  const id = wanted && wanted === localOwner ? readText(path.join(home, '.claude', 'orgiast-discord-user-id.txt')) : '';
  return id === KIM_DISCORD_USER_ID && wanted !== 'kim@orgiast.jp' ? '' : id;
}

// Base64 keeps notification text out of executable script syntax.
export function sendOwnerToast(text, { platform = process.platform, exec = execFileSync } = {}) {
  if (platform !== 'win32') return false;
  const payload = Buffer.from(String(text), 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'
$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
$lines=$t -split '\\r?\\n',2
$title=$lines[0]
if ([String]::IsNullOrWhiteSpace($title)) { $title='依頼の進捗' }
if ($title.Length -gt 60) { $title=$title.Substring(0,60) }
$body=''
if ($lines.Count -gt 1) { $body=$lines[1] }
if ($body.Length -gt 300) { $body=$body.Substring(0,299)+'…' }
try {
  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null
  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>'+[Security.SecurityElement]::Escape($title)+'</text><text>'+[Security.SecurityElement]::Escape($body)+'</text></binding></visual><actions><action content="閉じる" arguments="dismiss" activationType="system"/></actions></toast>')
  $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Orgiast').Show($toast)
} catch {
  & msg.exe $env:USERNAME /TIME:60 $t
  if ($LASTEXITCODE -ne 0) { exit 1 }
}`;
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-toast-'));
    const scriptFile = path.join(tempDir, 'toast.ps1');
    // Windows PowerShell 5.1 needs a BOM to read Japanese as UTF-8.
    fs.writeFileSync(scriptFile, '\ufeff' + script, { encoding: 'utf8', mode: 0o600 });
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    return true;
  } catch { return false; } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup must not mask delivery status */ }
    }
  }
}

export async function notifyOwner(owner, text, options = {}) {
  const home = options.home ?? os.homedir();
  owner = String(owner || resolveOwner(options)).trim();
  const userId = options.userId ?? resolveOwnerDiscordId(owner, options);
  let reason = 'owner Discord recipient unresolved or mismatched';
  if (owner && userId && !(String(userId) === KIM_DISCORD_USER_ID && owner.toLowerCase() !== 'kim@orgiast.jp')) {
    try {
      const result = await (options.notify ?? notifyKim)(text, { ...options, userId, webhookFallback: false });
      if (result?.delivered === 'dm') return { ...result, channel: 'discord' };
      reason = 'Discord DM delivery failed';
    } catch { reason = 'Discord DM delivery failed'; }
  }
  // Local desktop fallback is only appropriate for this PC's owner.
  let sent = false;
  let deduped = false;
  const localOwner = resolveOwner({ ...options, home });
  if (owner && owner.toLowerCase() === localOwner.toLowerCase()) {
    const toastText = redactSecrets(text);
    const hash = createHash('sha256').update(String(toastText)).digest('hex');
    const lastFile = path.join(home, '.claude', 'logs', 'owner-toast-last.json');
    const last = readJson(lastFile);
    const now = Date.now();
    if (last.hash === hash && now >= last.at && now - last.at < 6 * 60 * 60 * 1000) {
      sent = true;
      deduped = true;
    } else {
      try { sent = Boolean(await (options.toast ?? sendOwnerToast)(toastText, options)); } catch { /* logged below */ }
      if (sent) {
        try {
          fs.mkdirSync(path.dirname(lastFile), { recursive: true });
          fs.writeFileSync(lastFile, JSON.stringify({ hash, at: now }), { mode: 0o600 });
        } catch { /* unwritable home must not break the caller */ }
      }
    }
  }
  const channel = sent ? 'toast' : 'none';
  const file = path.join(home, '.claude', 'logs', 'owner-notify-fallback.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), owner: redactSecrets(owner), channel, reason, text: redactSecrets(text) }) + '\n', { mode: 0o600 });
  } catch { /* unwritable home must not break the caller */ }
  return { delivered: sent ? 'toast' : 'none', channel, reason, ...(deduped ? { deduped: true } : {}) };
}
