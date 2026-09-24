#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { notifyKim } from './notify-kim.mjs';
import { fetchJson } from './booth-feedback-intake.mjs';

const DONE_STATES = new Set(['done', '完了', '対応済', '却下']);

function oneLine(value, limit = Infinity) {
  return String(value ?? '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function defaultIo() {
  return {
    read: (file) => fs.readFileSync(file, 'utf8'),
    write: (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); },
    exists: (file) => fs.existsSync(file),
    now: () => new Date(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
}

function readOptional(file, io) { try { return io.read(file); } catch { return ''; } }

export function buildEvalPrompt(items) {
  const rows = items.map((item) => [item.key, item.kind, item.title, item.body].map((value) => oneLine(value)).join('|')).join('\n');
  return `次の各アイテムがオージャストグループの100億円売上計画（ブース制作・購買部・学会協賛などの自社アプリの機能改善）にどの程度直結するかを、A(直結: 売上・受注・継続利用に大きく効く) / B(間接: 品質・信頼・効率改善) / C(ほぼ無関係) で判定せよ。1アイテム1行の key|kind|title|body 形式である。JSON {"<key>":{"rank":"A|B|C","reason":"30字以内"}} だけを返せ。他の文言は一切出すな。\n${rows}`;
}

export function parseEvalJson(text) {
  const source = String(text ?? '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function stableHealthKey(url) {
  let identity = String(url);
  try { const parsed = new URL(url); identity = `${parsed.host}${parsed.pathname}`; } catch {}
  return `health:${crypto.createHash('sha1').update(identity).digest('hex').slice(0, 8)}`;
}

export async function checkHealthUrls(urls, { fetchImpl = fetch, now = () => new Date(), disabled = false } = {}) {
  if (disabled) return { results: [], items: [] };
  const results = [];
  const items = [];
  for (const url of [...new Set(urls.filter(Boolean))]) {
    let status = 0;
    let error = '';
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      status = Number(response.status) || 0;
      if (!response.ok) error = `HTTP ${status}`;
    } catch (caught) { error = oneLine(caught?.message || caught, 200) || '接続失敗'; }
    const ok = !error;
    const result = { url, ok, status, error };
    results.push(result);
    if (!ok) items.push({
      key: stableHealthKey(url), kind: '不具合',
      title: `自動検知: ${url} が ${status ? `HTTP ${status}` : '接続失敗'}`,
      body: status ? `${url} のヘルスチェックが HTTP ${status} を返しました` : `${url} への接続に失敗しました: ${error}`,
      ts: now().toISOString(), source: 'auto-health', status: 'needsAction',
    });
  }
  return { results, items };
}

export function ranksOf(items, ledger = {}) {
  const evaluations = ledger?.items || {};
  const ranks = { A: [], B: [], C: [], unknown: [] };
  for (const item of items) {
    const rank = evaluations[item.key]?.rank;
    (ranks[rank] || ranks.unknown).push(item);
  }
  return ranks;
}

export function buildReport(items, ledger, healthResults, now = new Date()) {
  const evaluations = ledger?.items || {};
  const ranks = ranksOf(items, ledger);
  const failures = (healthResults || []).filter((result) => !result.ok);
  const pendingCount = items.filter((item) => item?.source !== 'auto-health').length;
  const lines = [`📊 フィードバック100億円評価（${now.toISOString().slice(0, 10)}）未対応 ${pendingCount} 件 / 自動検知 ${failures.length} 件`];
  lines.push('【A・100億円直結】');
  if (!ranks.A.length) lines.push('なし');
  for (const item of ranks.A.slice(0, 10)) lines.push(`[${oneLine(item.key, 50)}] ${oneLine(item.title, 60) || '(無題)'} — ${oneLine(evaluations[item.key]?.reason, 30)}`);
  lines.push(`B: ${ranks.B.length}件 / C: ${ranks.C.length}件 / 未評価: ${ranks.unknown.length}件`);
  if (failures.length) {
    lines.push('【自動検知の異常】');
    for (const result of failures.slice(0, 5)) lines.push(`・${oneLine(result.url, 120)} — ${result.status ? `HTTP ${result.status}` : oneLine(result.error, 80, '接続失敗')}`);
  }
  return lines.join('\n').slice(0, 1900);
}

function parseArgs(args) {
  const options = { healthUrls: [], dryRun: false, noHealth: false, noLlm: false, json: false, itemsFile: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-health') options.noHealth = true;
    else if (arg === '--no-llm') options.noLlm = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--items-file') options.itemsFile = args[++index] || '';
    else if (arg === '--health-url') options.healthUrls.push(args[++index] || '');
  }
  return options;
}

export function runLlm(prompt, { spawnImpl = spawn, toolDir = import.meta.dirname } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [path.join(toolDir, 'llm-ask.mjs'), '--provider', 'groq', '--category', 'classification', '--no-fallback', prompt], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`llm-ask exit ${code}: ${oneLine(stderr, 200)}`)));
  });
}

function validLedger(text) {
  try { const value = JSON.parse(text); if (value?.version === 1 && value.items && typeof value.items === 'object') return value; } catch {}
  return { version: 1, items: {} };
}

export async function evaluatePending(items, ledger, { spawnImpl = spawn, now = () => new Date(), toolDir = import.meta.dirname } = {}) {
  const pending = items.filter((item) => item?.key && !ledger.items[item.key]);
  if (!pending.length) return { attempted: 0, added: 0 };
  const parsed = parseEvalJson(await runLlm(buildEvalPrompt(pending), { spawnImpl, toolDir }));
  if (!parsed) return { attempted: pending.length, added: 0 };
  let added = 0;
  for (const item of pending) {
    const value = parsed[item.key];
    if (!['A', 'B', 'C'].includes(value?.rank)) continue;
    ledger.items[item.key] = { rank: value.rank, reason: oneLine(value.reason, 30), evaluatedAt: now().toISOString(), model: 'groq' };
    added += 1;
  }
  return { attempted: pending.length, added };
}

export async function collectItems({ itemsFile = '', env = {}, io = defaultIo(), fetchImpl = fetch } = {}) {
  if (itemsFile) {
    // 呼び出し元から絶対パスを受け取る。path.resolve は Windows でドライブ相対解決に化けるため使わない。
    const data = JSON.parse(io.read(itemsFile));
    return Array.isArray(data?.items) ? data.items : [];
  }
  if (!env.BOOTH_FEEDBACK_URL || !env.BOOTH_FEEDBACK_TOKEN) return [];
  const endpoint = new URL(env.BOOTH_FEEDBACK_URL);
  endpoint.searchParams.set('action', 'feedback');
  endpoint.searchParams.set('token', env.BOOTH_FEEDBACK_TOKEN);
  const data = await fetchJson(endpoint, {}, fetchImpl);
  if (!data?.ok) throw new Error(data?.error || 'API が ok:false を返しました');
  return Array.isArray(data.items) ? data.items : [];
}

function discordCredentialsAvailable(home, io) {
  const token = process.env.DISCORD_BOT_TOKEN?.trim() || readOptional(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), io).trim();
  const userId = process.env.ORGIAST_DISCORD_USER_ID?.trim() || readOptional(path.join(home, '.claude', 'orgiast-discord-user-id.txt'), io).trim();
  return Boolean(token && userId);
}

export async function runMain({ args = process.argv.slice(2), home = process.env.ORGIAST_HOME || os.homedir(), io = defaultIo(), fetchImpl = fetch, spawnImpl = spawn, notifyImpl = notifyKim } = {}) {
  const options = parseArgs(args);
  const envFile = path.join(home, '.claude', 'booth-feedback.env');
  const env = parseEnvText(readOptional(envFile, io));
  let items = [];
  if (!options.itemsFile && (!env.BOOTH_FEEDBACK_URL || !env.BOOTH_FEEDBACK_TOKEN)) {
    io.stderr('feedback-100oku: BOOTH_FEEDBACK_URL/TOKEN 未設定のためフィードバック取得をスキップします');
  }
  try { items = await collectItems({ itemsFile: options.itemsFile, env, io, fetchImpl }); }
  catch (error) { io.stderr(`feedback-100oku: アイテム取得失敗: ${oneLine(error?.message || error)}`); }
  items = items.filter((item) => item?.key && !DONE_STATES.has(String(item.status ?? '').trim().toLowerCase()));

  const configuredUrls = options.healthUrls.length ? options.healthUrls : String(env.FEEDBACK_HEALTH_URLS || env.HEALTH_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const health = await checkHealthUrls(configuredUrls, { fetchImpl, now: io.now, disabled: options.noHealth });
  const byKey = new Map(items.map((item) => [item.key, item]));
  for (const item of health.items) byKey.set(item.key, item);
  items = [...byKey.values()];

  const ledgerFile = path.join(home, '.claude', 'feedback-100oku-ledger.json');
  const ledger = validLedger(readOptional(ledgerFile, io));
  if (!options.noLlm && items.length) {
    try { await evaluatePending(items, ledger, { spawnImpl, now: io.now }); }
    catch (error) { io.stderr(`feedback-100oku: LLM評価失敗（次回再試行）: ${oneLine(error?.message || error)}`); }
    try { io.write(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`); }
    catch (error) { io.stderr(`feedback-100oku: 台帳保存失敗: ${oneLine(error?.message || error)}`); }
  }

  const report = buildReport(items, ledger, health.results, io.now());
  // A案件・自動検知異常が無い夜の DM は feedback-nag との二重報告で kim の注意を溶かすため送らない。
  const worthReporting = ranksOf(items, ledger).A.length > 0 || health.results.some((result) => !result.ok);
  let sent = false;
  if (options.dryRun || !worthReporting || !discordCredentialsAvailable(home, io)) io.stdout(options.json ? JSON.stringify({ ok: true, sent, report, health: health.results }) : report);
  else {
    try {
      const result = await notifyImpl(report, { home, fetchImpl });
      sent = result?.delivered === 'dm' || result?.delivered === 'webhook';
      if (!sent) io.stderr(`feedback-100oku: Discord 送信失敗: ${oneLine(result?.reason || '送信されませんでした')}`);
      if (options.json) io.stdout(JSON.stringify({ ok: true, sent, report, health: health.results }));
    } catch (error) { io.stderr(`feedback-100oku: Discord 送信失敗: ${oneLine(error?.message || error)}`); }
  }
  return health.items.length ? 3 : 0;
}

if (isEntry(import.meta.url)) process.exitCode = await runMain();
