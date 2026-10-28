#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

export const ITEMS = ['SMBv1', 'RDP', 'WinRM', 'sshd', 'FW無効', 'Defender', 'BitLocker', 'Update', 'Tailscale Funnel', '平文鍵', '.env件数', '0.0.0.0待受', '無人ジョブ詰まり'];
const short = value => String(value).replace(/[\r\n]/g, ' ').slice(0, 120);
export function summarizeAudit(a) {
  const result = { host: a.host, red: [], yellow: [], green: [] };
  const add = (item, red, yellow, known, detail) => result[red ? 'red' : yellow || !known ? 'yellow' : 'green'].push({ item, detail: short(known || red || yellow ? detail : '未取得・要確認') });
  const age = value => (Date.parse(a.at) - Date.parse(value)) / 86400000;
  add('SMBv1', a.smb1Enabled === true, false, typeof a.smb1Enabled === 'boolean', `SMB1=${a.smb1Enabled}`);
  add('RDP', a.rdpEnabled === true && a.rdpNla !== 1, a.rdpEnabled === true, typeof a.rdpEnabled === 'boolean', `enabled=${a.rdpEnabled}, NLA=${a.rdpNla}`);
  add('WinRM', false, a.winrmListeners > 0, Number.isFinite(a.winrmListeners), `listeners=${a.winrmListeners}`);
  add('sshd', a.sshdStatus === 'Running', false, a.sshdStatus != null, a.sshdStatus);
  add('FW無効', a.firewall?.some(p => p.enabled === false), a.inboundAllowAnyPublic?.length > 25, Array.isArray(a.firewall) && a.firewall.length > 0 && Array.isArray(a.inboundAllowAnyPublic), `disabled=${a.firewall?.filter(p => p.enabled === false).length}, publicAllow=${a.inboundAllowAnyPublic?.length}`);
  add('Defender', a.defender?.realtime === false, age(a.defender?.sigDate) > 3, typeof a.defender?.realtime === 'boolean' && Number.isFinite(age(a.defender?.sigDate)), `realtime=${a.defender?.realtime}, sig=${a.defender?.sigDate}`);
  // システムドライブは C: 固定とすると別ドライブの暗号化を誤判定する。
  const system = a.bitlocker?.find(b => b.mount?.toUpperCase() === (a.systemDrive || 'C:').toUpperCase());
  add('BitLocker', system?.protection === 'Off', false, system?.protection != null, `system=${system?.mount}, protection=${system?.protection}`);
  add('Update', false, age(a.lastHotfixDate) > 45, Number.isFinite(age(a.lastHotfixDate)), a.lastHotfixDate);
  const funnelPorts = [...(a.tailscale?.funnelStatus || '').matchAll(/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d+)/g)].map(m => Number(m[1]));
  const funnel = /Funnel on/i.test(a.tailscale?.funnelStatus || '');
  const exposed = a.listenAllTcp?.filter(p => p.address === '0.0.0.0') || [];
  add('Tailscale Funnel', funnel && exposed.some(p => funnelPorts.includes(p.port)), false, a.tailscale?.installed === false || (typeof a.tailscale?.funnelStatus === 'string' && Array.isArray(a.listenAllTcp)), funnel ? `Funnel on; targets=${funnelPorts.join(',')}` : 'Funnel off');
  const secrets = a.secrets;
  add('平文鍵', secrets?.hardcodedCredFiles?.length > 0, secrets?.claudeKeyTxtCount > 0 || secrets?.scanTruncated === true || secrets?.scanIncomplete === true, Array.isArray(secrets?.hardcodedCredFiles) && Number.isFinite(secrets?.claudeKeyTxtCount), `hardcoded=${secrets?.hardcodedCredFiles?.length}, keyTxt=${secrets?.claudeKeyTxtCount}`);
  add('.env件数', false, secrets?.envFileCount > 20, Number.isFinite(secrets?.envFileCount), `count=${secrets?.envFileCount}`);
  const dev = exposed.filter(p => (p.port >= 3000 && p.port <= 3999) || (p.port >= 5000 && p.port <= 5999) || (p.port >= 8000 && p.port <= 8999));
  add('0.0.0.0待受', false, dev.length > 0, Array.isArray(a.listenAllTcp), `devPorts=${dev.map(p => p.port).join(',') || 'none'}`);
  add('無人ジョブ詰まり', false, a.stuckJobs?.oldestNodeHours > 24 || a.stuckJobs?.cpuLoadPercent >= 90, Number.isFinite(a.stuckJobs?.oldestNodeHours) && Number.isFinite(a.stuckJobs?.cpuLoadPercent), `oldestNodeHours=${a.stuckJobs?.oldestNodeHours}, CPU=${a.stuckJobs?.cpuLoadPercent}%`);
  return result;
}

export function buildMailBody(audit, label, date) {
  if (!/^[^\s<>]+$/.test(label) || !/^\d{8}$/.test(date)) throw new Error('invalid label/date');
  const copy = structuredClone(audit);
  const encode = () => `<!-- security-audit: v1 label=${label} date=${date} -->\n\`\`\`json\n${JSON.stringify(copy)}\n\`\`\`\n`;
  if (Buffer.byteLength(encode()) > 60 * 1024 || encode().length > 19500) {
    copy.truncated = true;
    copy.summary = summarizeAudit(audit);
    if (copy.secrets) for (const key of ['hardcodedCredFiles', 'envFileDirs']) if (Array.isArray(copy.secrets[key])) copy.secrets[key] = copy.secrets[key].slice(0, 30);
    if (Array.isArray(copy.inboundAllowAnyPublic)) copy.inboundAllowAnyPublic = copy.inboundAllowAnyPublic.slice(0, 30);
  }
  // fleet-mail が 20,000 文字で切るため、残りも縮約し件数判定は原本から保持する。
  if (Buffer.byteLength(encode()) > 60 * 1024 || encode().length > 19500) {
    copy.summary = summarizeAudit(audit);
    const shrink = obj => { for (const [key, value] of Object.entries(obj)) {
      if (key === 'summary') continue;
      if (Array.isArray(value)) obj[key] = value.slice(0, 5).map(v => typeof v === 'string' ? short(v) : v);
      else if (value && typeof value === 'object') shrink(value);
      else if (typeof value === 'string') obj[key] = short(value);
    } };
    shrink(copy);
  }
  if (Buffer.byteLength(encode()) > 60 * 1024 || encode().length > 19500) throw new Error('audit body exceeds transport limit');
  if (Buffer.byteLength(encode()) > 60 * 1024 || encode().length > 20000) throw new Error('audit summary exceeds transport limit');
  return encode();
}
export const auditDate = (date = new Date()) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
// 実行全体をロックし、前回異常終了のロックは24時間後に回復する。
export function claimAuditSend(sent, now = Date.now()) {
  if (fs.existsSync(sent)) return false;
  const pending = `${sent}.pending`;
  try {
    if (now - fs.statSync(pending).mtimeMs <= 86400000) return false;
    fs.unlinkSync(pending);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.writeFileSync(pending, new Date(now).toISOString(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  return true;
}
function winPath(p) {
  if (process.platform !== 'linux') return p;
  const r = spawnSync('wslpath', ['-w', p], { encoding: 'utf8', windowsHide: true, shell: false });
  if (r.status !== 0) throw new Error('Windows path conversion failed');
  return r.stdout.trim();
}
export function main(args = process.argv.slice(2)) {
  let out; const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = path.resolve(args[++i]);
    else if (['--send', '--dry-run', '--json'].includes(args[i])) flags.add(args[i]);
    else throw new Error('unknown option or missing value');
  }
  const home = process.env.USERPROFILE || os.homedir();
  const label = resolveFleetLabel(home);
  if (!/^[\p{L}\p{N}_.()-]+$/u.test(label) || label === '.' || label === '..') throw new Error('unsafe PC label');
  const date = auditDate();
  out ||= path.join(home, '.claude', 'security-audit', date);
  const sent = path.join(out, `${label}.sent-${date}`);
  if (flags.has('--send') && !flags.has('--dry-run') && fs.existsSync(sent)) return;
  fs.mkdirSync(out, { recursive: true });
  if (flags.has('--send') && !flags.has('--dry-run') && !claimAuditSend(sent)) return;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 });
  const exe = probe.status === 0 ? 'pwsh' : 'powershell.exe';
  const isWindowsPS = exe.endsWith('.exe') || process.platform === 'win32';
  const convert = p => isWindowsPS ? winPath(p) : p;
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', convert(path.join(dir, 'security-audit-readonly.ps1')), '-OutDir', convert(out), '-Label', label], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  // 例外の stderr には対象の値が混ざり得るため、そのまま転載しない。
  if (r.error || r.status !== 0) throw new Error(`PowerShell audit failed (${r.error?.code || r.status})`);
  const audit = JSON.parse(r.stdout.replace(/^\uFEFF/, '').trim());
  if (flags.has('--json') || flags.has('--dry-run')) console.log(JSON.stringify(audit, null, 2));
  if (flags.has('--send') && !flags.has('--dry-run')) {
    // 送信後のローカル失敗でも再送しない。結果不明は pending を残し調査可能にする。
    const pending = `${sent}.pending`;
    const body = buildMailBody(audit, label, date);
    const temp = path.join(out, `${label}.mail-${date}.md`);
    fs.writeFileSync(temp, body, { mode: 0o600 });
    const mail = spawnSync(process.execPath, [path.join(dir, 'fleet-mail.mjs'), '--send', '--to', 'kim-PC', '--kind', 'note', '--body-file', temp, '--why', `[報告・返信不要] security-audit ${date} ${label}`], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000 });
    if (mail.error || mail.status !== 0) throw new Error('fleet-mail send unresolved; pending marker retained');
    fs.renameSync(pending, sent);
    console.log(body);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
