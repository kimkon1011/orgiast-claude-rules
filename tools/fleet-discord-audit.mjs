#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchMessages } from './discord-digest.mjs';
import { isEntry } from './is-entry.mjs';

const DEFAULT_CHANNEL_ID = '1508437329247862794';
const DAY_MS = 86_400_000;

export function maskEmailAddress(value) {
  const email = String(value || '');
  const at = email.indexOf('@');
  if (at < 1) return email;
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}***@${email.slice(at + 1)}`;
}

export function extractIdentity(content, { maskEmail = false } = {}) {
  const text = String(content || '');
  const tokenLabel = /^\s*\*\*💻\s*Claude Code ローカル利用トークン\*\*\s*[—–-]\s*(.+?)\s*$/mi.exec(text)?.[1];
  const bracketLabel = /^[^\n]*?(?:▶|⚠(?:️)?)\s*\*\*\[([^\]\n]+)\]\*\*/mu.exec(text)?.[1];
  const machine = /🖥(?:️)?\s*hostname\s*=\s*([^/\r\n]*?)\s*\/\s*user\s*=\s*([^/\r\n]*?)\s*\/\s*git\s*=\s*([^\s/\r\n]+)/iu.exec(text);
  const gitEmail = machine?.[3]?.trim() || '';
  return {
    label: (tokenLabel || bracketLabel || '').trim(),
    hostname: machine?.[1]?.trim() || '',
    user: machine?.[2]?.trim() || '',
    gitEmail: maskEmail ? maskEmailAddress(gitEmail) : gitEmail,
  };
}

function statusFor(lastMs, nowMs) {
  const elapsedMs = Math.max(0, nowMs - lastMs);
  if (elapsedMs <= DAY_MS) return { status: 'fresh', elapsedMs };
  if (elapsedMs <= 3 * DAY_MS) return { status: 'stale', elapsedMs };
  return { status: 'silent', elapsedMs };
}

function addObservation(table, key, timestamp, nowMs) {
  if (!key) return;
  const time = Date.parse(timestamp || '');
  if (!Number.isFinite(time)) return;
  const current = table[key] || { first: timestamp, last: timestamp, count: 0 };
  if (time < Date.parse(current.first)) current.first = timestamp;
  if (time > Date.parse(current.last)) current.last = timestamp;
  current.count++;
  table[key] = current;
}

function finishTable(table, nowMs) {
  for (const value of Object.values(table)) {
    Object.assign(value, statusFor(Date.parse(value.last), nowMs));
  }
  return table;
}

function setsToArrays(table) {
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b, 'ja')).map(([key, values]) => [key, [...values].sort((a, b) => a.localeCompare(b, 'ja'))]));
}

export function auditFleet(messages, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now は有効な日時で指定してください');
  const labels = {};
  const hostnames = {};
  const labelToHostnames = {};
  const hostnameToLabels = {};

  for (const message of Array.isArray(messages) ? messages : []) {
    const identity = extractIdentity(message?.content);
    addObservation(labels, identity.label, message?.timestamp, nowMs);
    addObservation(hostnames, identity.hostname, message?.timestamp, nowMs);
    if (identity.label && identity.hostname) {
      (labelToHostnames[identity.label] ||= new Set()).add(identity.hostname);
      (hostnameToLabels[identity.hostname] ||= new Set()).add(identity.label);
    }
  }

  return {
    labels: finishTable(labels, nowMs),
    hostnames: finishTable(hostnames, nowMs),
    labelToHostnames: setsToArrays(labelToHostnames),
    hostnameToLabels: setsToArrays(hostnameToLabels),
  };
}

function parseArgs(argv) {
  const opts = { days: 7, json: false, maskEmail: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--mask-email') opts.maskEmail = true;
    else if (arg === '--days' || arg === '--channel') {
      if (argv[i + 1] == null) throw new Error(`${arg} に値が必要です`);
      opts[arg.slice(2)] = argv[++i];
    } else throw new Error(`不正な引数: ${arg}`);
  }
  opts.days = Number(opts.days);
  if (!Number.isFinite(opts.days) || opts.days <= 0) throw new Error('--days は正の数で指定してください');
  return opts;
}

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function elapsedText(ms) {
  const hours = Math.max(0, ms) / 3_600_000;
  if (hours < 1) return `${Math.floor(hours * 60)}分`;
  if (hours < 48) return `${hours.toFixed(1)}時間`;
  return `${(hours / 24).toFixed(1)}日`;
}

function displayRows(audit) {
  const keys = new Set([...Object.keys(audit.labels), ...Object.keys(audit.labelToHostnames)]);
  const rows = [];
  for (const label of [...keys].sort((a, b) => a.localeCompare(b, 'ja'))) {
    const hosts = audit.labelToHostnames[label] || [''];
    for (const hostname of hosts) {
      const stat = audit.labels[label];
      if (stat) rows.push({ label, hostname, ...stat });
    }
  }
  for (const [hostname, stat] of Object.entries(audit.hostnames)) {
    if (!(audit.hostnameToLabels[hostname]?.length)) rows.push({ label: '', hostname, ...stat });
  }
  return rows;
}

export function formatAudit(audit) {
  const rows = displayRows(audit);
  const lines = ['label | hostname | 分類 | 最終報告からの経過 | 回数', '--- | --- | --- | --- | ---'];
  for (const row of rows) lines.push(`${row.label || '-'} | ${row.hostname || '-'} | ${row.status} | ${elapsedText(row.elapsedMs)} | ${row.count}`);
  if (!rows.length) lines.push('- | - | silent | - | 0');
  lines.push('', 'label↔hostname の対応');
  const mappings = Object.entries(audit.labelToHostnames);
  lines.push(...(mappings.length ? mappings.map(([label, hosts]) => `${label} ↔ ${hosts.join(', ')}`) : ['（対応データなし）']));
  const conflicts = Object.entries(audit.hostnameToLabels).filter(([, labels]) => labels.length > 1);
  lines.push('', 'hostname が複数 label を名乗っている（env コピー混同の疑い）');
  lines.push(...(conflicts.length ? conflicts.map(([host, labels]) => `⚠ ${host}: ${labels.join(', ')}`) : ['なし']));
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), now = new Date()) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const home = os.homedir();
  const channelId = opts.channel || readTrimmed(path.join(home, '.claude', 'orgiast-discord-channel-id.txt')) || DEFAULT_CHANNEL_ID;
  const token = process.env.DISCORD_BOT_TOKEN?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'));
  if (!token) { console.error('Discord Bot トークンが見つかりません'); return 2; }
  try {
    const since = now.getTime() - opts.days * DAY_MS;
    const { messages } = await fetchMessages({ channelId, limit: 1000, since, token });
    const audit = auditFleet(messages.map((message) => opts.maskEmail ? { ...message, content: String(message.content || '').replace(/[\w.+-]+@[\w.-]+/g, maskEmailAddress) } : message), now);
    process.stdout.write(`${opts.json ? JSON.stringify(audit, null, 2) : formatAudit(audit)}\n`);
    return 0;
  } catch (error) {
    console.error(`fleet-discord-audit: ${error.message}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
