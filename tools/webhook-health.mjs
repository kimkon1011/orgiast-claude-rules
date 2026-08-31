#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { resolveReporterLabel } from './reporter-label.mjs';

export const WEBHOOK_RE = /https:\/\/discord\.com\/api\/webhooks\/(\d{15,})\/([A-Za-z0-9_-]{40,})/g;
const USER_AGENT = 'DiscordBot (https://orgiast.jp, 1.0) orgiast-webhook-health';

export function extractWebhooks(text) {
  return [...String(text).matchAll(new RegExp(WEBHOOK_RE.source, 'g'))].map((match) => ({
    url: match[0],
    webhookId: match[1],
  }));
}

export function redactSecrets(value) {
  return String(value).replace(new RegExp(WEBHOOK_RE.source, 'g'), 'https://discord.com/api/webhooks/$1/[REDACTED]');
}

export function mergeLedger(ledger, alive, seenFiles, now = new Date().toISOString()) {
  const next = structuredClone(ledger ?? {});
  for (const item of alive) {
    const previous = next[item.webhookId] ?? {};
    next[item.webhookId] = {
      ...previous,
      name: item.name ?? previous.name ?? null,
      channelId: item.channelId,
      // 旧版は body.name(=webhook名)を channelName として保存していた。
      // 引き継ぐと台帳の「対象チャンネル名」に webhook 名が入るので、分からない時は null に倒す。
      channelName: item.channelName ?? null,
      files: [...new Set([...(previous.files ?? []), ...(seenFiles[item.webhookId] ?? [])])].sort(),
      lastSeenAliveAt: now,
    };
  }
  for (const [webhookId, files] of Object.entries(seenFiles)) {
    if (!next[webhookId]) continue;
    next[webhookId].files = [...new Set([...(next[webhookId].files ?? []), ...files])].sort();
  }
  return next;
}

export function findReplacement(deadWebhookId, ledger, alive) {
  const channelId = ledger?.[deadWebhookId]?.channelId;
  if (!channelId) return null;
  const candidates = alive.filter((item) => item.webhookId !== deadWebhookId && item.channelId === channelId);
  candidates.sort((a, b) => String(ledger?.[b.webhookId]?.lastSeenAliveAt ?? '').localeCompare(String(ledger?.[a.webhookId]?.lastSeenAliveAt ?? '')));
  return candidates[0] ?? null;
}

function globToRegExp(glob) {
  const normalized = path.resolve(glob).replaceAll('\\', '/');
  let source = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*' && normalized[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function globRoot(pattern) {
  const absolute = path.resolve(pattern);
  const firstMagic = absolute.search(/[?*]/);
  if (firstMagic < 0) return path.dirname(absolute);
  const prefix = absolute.slice(0, firstMagic);
  return prefix.endsWith(path.sep) ? prefix.slice(0, -1) || path.parse(absolute).root : path.dirname(prefix);
}

async function walk(root, output) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(full, output);
    else if (entry.isFile()) output.push(full);
  }
}

async function expandPattern(pattern) {
  if (!/[?*]/.test(pattern)) {
    try { return (await fs.stat(path.resolve(pattern))).isFile() ? [path.resolve(pattern)] : []; } catch { return []; }
  }
  const files = [];
  await walk(globRoot(pattern), files);
  const matcher = globToRegExp(pattern);
  return files.filter((file) => matcher.test(path.resolve(file).replaceAll('\\', '/')));
}

export async function scanFiles(patterns = []) {
  const home = os.homedir();
  const defaults = (await fs.readdir(path.join(home, '.claude'), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /\.(?:env|txt)$/.test(entry.name))
    .map((entry) => path.join(home, '.claude', entry.name));
  const additions = (await Promise.all(patterns.map(expandPattern))).flat();
  return [...new Set([...defaults, ...additions].map((file) => path.resolve(file)))].sort();
}

async function checkWebhook(item, fetchImpl) {
  try {
    const response = await fetchImpl(item.url, { headers: { 'User-Agent': USER_AGENT } });
    if (response.status === 200) {
      const body = await response.json();
      return { ...item, status: 'alive', channelId: String(body.channel_id), name: body.name ?? null };
    }
    return { ...item, status: response.status === 404 ? 'dead' : 'error', code: response.status };
  } catch (error) {
    return { ...item, status: 'error', reason: redactSecrets(error?.message ?? error) };
  }
}

async function replaceInFiles(dead, replacement, dryRun) {
  const changed = [];
  const date = new Date().toISOString().slice(0, 10);
  for (const file of dead.files) {
    const original = await fs.readFile(file, 'utf8');
    if (!original.includes(dead.url)) continue;
    changed.push(file);
    if (dryRun) continue;
    await fs.copyFile(file, `${file}.bak-${date}`);
    await fs.writeFile(file, original.split(dead.url).join(replacement.url), 'utf8');
  }
  return changed;
}

function parseArgs(argv) {
  const options = { dryRun: false, fix: false, json: false, postSheet: false, scans: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--fix') options.fix = true;
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--post-sheet') options.postSheet = true;
    else if (argv[i] === '--scan' && argv[i + 1]) options.scans.push(argv[++i]);
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  return options;
}

function basenameAny(file) { return String(file || '').replaceAll('\\', '/').split('/').pop(); }
export function buildWebhookSheetPayload(result, { label, checkedAt }) {
  const rows = [...(result?.alive ?? []), ...(result?.dead ?? []), ...(result?.errors ?? [])];
  return { label, checkedAt, webhooks: rows.map((item) => ({
    webhookId: item.webhookId, name: item.name ?? '', channelId: item.channelId ?? '',
    channelName: item.channelName ?? '', state: item.status,
    files: [...new Set((item.files ?? []).map(basenameAny).filter(Boolean))],
  })) };
}

async function postSheet(result, checkedAt, fetchImpl) {
  const envFile = path.join(os.homedir(), '.claude', 'fleet-sheet.env');
  let envText = ''; try { envText = await fs.readFile(envFile, 'utf8'); } catch {}
  const env = parseEnvText(envText);
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) return { skipped: true, reason: '設定なし' };
  const resolved = resolveReporterLabel({ envText, hostname: os.hostname() });
  if (resolved.nextEnvText !== envText) await fs.writeFile(envFile, resolved.nextEnvText, 'utf8');
  const payload = buildWebhookSheetPayload(result, { label: resolved.label, checkedAt: checkedAt.slice(0, 10) });
  const response = await fetchImpl(env.FLEET_SHEET_URL, { method:'POST', redirect:'follow', headers:{'content-type':'application/json'}, body:JSON.stringify({ token:env.FLEET_SHEET_TOKEN, kind:'webhooks', ...payload }) });
  const text = await response.text(); if (!response.ok) throw new Error(`fleet sheet HTTP ${response.status}`);
  let body; try { body=JSON.parse(text); } catch { throw new Error('fleet sheet returned invalid JSON'); }
  if (!body.ok) throw new Error(`fleet sheet rejected request: ${body.error || 'unknown error'}`); return body;
}

async function notify(target, deadResults, fetchImpl) {
  const lines = ['🚨 Discord webhook の死亡を検知しました。'];
  for (const dead of deadResults) {
    lines.push(`webhook ID: ${dead.webhookId}`);
    lines.push(`参照ファイル: ${dead.files.join(', ') || '(なし)'}`);
    lines.push(`自動修復: ${dead.fixed ? '済み' : '未実施（要手動）'}`);
  }
  const request = () => fetchImpl(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ username: 'orgiast webhook health', content: lines.join('\n') }),
  });
  let response = await request();
  let responseText = await response.text();
  if (response.status === 429 && !responseText.includes('1015')) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    response = await request();
    responseText = await response.text();
  }
  return { sent: response.ok, code: response.status, reason: redactSecrets(responseText).slice(0, 200) };
}

export async function run(argv = process.argv.slice(2), { fetchImpl = fetch } = {}) {
  const options = parseArgs(argv);
  const ledgerFile = path.join(os.homedir(), '.claude', 'discord-webhooks.json');
  let ledger = {};
  try { ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')); } catch {}

  const files = await scanFiles(options.scans);
  const occurrences = [];
  for (const file of files) {
    let content;
    try { content = await fs.readFile(file, 'utf8'); } catch { continue; }
    for (const webhook of extractWebhooks(content)) occurrences.push({ ...webhook, file });
  }
  const grouped = new Map();
  for (const item of occurrences) {
    const existing = grouped.get(item.url) ?? { url: item.url, webhookId: item.webhookId, files: [] };
    existing.files.push(item.file);
    grouped.set(item.url, existing);
  }
  const checks = await Promise.all([...grouped.values()].map((item) => checkWebhook(item, fetchImpl)));
  const alive = checks.filter((item) => item.status === 'alive');
  const seenFiles = {};
  for (const item of checks) seenFiles[item.webhookId] = [...new Set([...(seenFiles[item.webhookId] ?? []), ...item.files])];
  const checkedAt = new Date().toISOString();
  ledger = mergeLedger(ledger, alive, seenFiles, checkedAt);
  for (const item of checks) {
    item.name = item.name ?? ledger[item.webhookId]?.name ?? null;
    item.channelId = item.channelId ?? ledger[item.webhookId]?.channelId ?? null;
    item.channelName = ledger[item.webhookId]?.channelName ?? null;
  }
  if (!options.dryRun) {
    await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
    await fs.writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  }

  const dead = checks.filter((item) => item.status === 'dead');
  for (const item of dead) {
    const replacement = findReplacement(item.webhookId, ledger, alive);
    item.channelId = ledger[item.webhookId]?.channelId ?? null;
    item.channelName = ledger[item.webhookId]?.channelName ?? null;
    item.fixed = false;
    if (options.fix && replacement) {
      item.changedFiles = await replaceInFiles(item, replacement, options.dryRun);
      item.fixed = !options.dryRun && item.changedFiles.length > 0;
      item.replacementWebhookId = replacement.webhookId;
    }
  }

  let notification = { sent: false, reason: options.dryRun ? 'dry-run' : dead.length ? 'no alive webhook' : 'no dead webhook' };
  if (dead.length && !options.dryRun && alive.length) {
    const target = [...alive].sort((a, b) => String(ledger[b.webhookId]?.lastSeenAliveAt ?? '').localeCompare(String(ledger[a.webhookId]?.lastSeenAliveAt ?? '')))[0];
    notification = await notify(target, dead, fetchImpl);
  }
  const publicItem = (item) => ({
    webhookId: item.webhookId, status: item.status, code: item.code,
    name: item.name, channelId: item.channelId, channelName: item.channelName, files: item.files,
    fixed: item.fixed, replacementWebhookId: item.replacementWebhookId,
  });
  const result = { checkedAt, filesScanned: files.length, alive: alive.map(publicItem), dead: dead.map(publicItem), errors: checks.filter((item) => item.status === 'error').map(publicItem), notification };
  if (options.postSheet) {
    const posted = await postSheet(result, checkedAt, fetchImpl);
    if (posted.skipped) console.error(`Webhook台帳送信 skip:${posted.reason}`);
  }
  if (options.json) console.log(JSON.stringify(result));
  else {
    console.log(`Discord webhook health: alive=${alive.length} dead=${dead.length} error=${result.errors.length}`);
    for (const item of dead) console.log(`🚨 webhook ID ${item.webhookId}: ${item.fixed ? '自動修復済み' : '要手動'} (${item.files.join(', ')})`);
  }
  return { result, exitCode: dead.some((item) => !item.fixed) ? 1 : 0 };
}

const isMain = isEntry(import.meta.url);
if (isMain) {
  run().then(({ exitCode }) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(redactSecrets(error?.stack ?? error));
    process.exitCode = 1;
  });
}
