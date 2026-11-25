#!/usr/bin/env node
// 毎晩、安価なモデルで処理できる実データだけを重複なく batch-queue に積む。
// セッション要約の有効化は環境変数 ORGIAST_BATCH_SESSION_SUMMARY=1（セッション記録が Groq へ送られる点に注意）。
// 追加: executor-usage-digest, auto-session-digest, next-session-todo-triage
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueueJob } from './batch-enqueue.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function jsonl(file) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } }
function walk(dir) {
  const found = [];
  try { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) found.push(...walk(full)); else if (entry.name.endsWith('.jsonl')) found.push(full); } } catch {}
  return found;
}
function readTextSafe(file, limit = 12000) {
  try { const raw = fs.readFileSync(file, 'utf8'); return redactSecrets(raw.length <= limit ? raw : raw.slice(-limit)); } catch { return ''; }
}
export function localDate(now = new Date()) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
export function existingTypes(queueDir, date) {
  const rows = [...jsonl(path.join(queueDir, 'pending.jsonl'))];
  try { for (const name of fs.readdirSync(queueDir)) if (/^results-.*\.jsonl$/.test(name)) rows.push(...jsonl(path.join(queueDir, name))); } catch {}
  return new Set(rows.filter((row) => row.batchDate === date && row.jobType).map((row) => row.jobType));
}
export function produce({ home = os.homedir(), now = new Date(), enqueue = enqueueJob, sessionSummaryEnabled = process.env.ORGIAST_BATCH_SESSION_SUMMARY === '1' } = {}) {
  const claudeDir = path.join(home, '.claude');
  const queueDir = path.join(claudeDir, 'batch-queue');
  const date = localDate(now);
  const existing = existingTypes(queueDir, date);
  const made = [];
  const skipped = [];
  const closed = new Set(readJson(path.join(claudeDir, 'closed-sessions.json'), { ids: [] }).ids || []);
  for (const id of Object.keys(readJson(path.join(claudeDir, 'session-closed-ledger.json'), { sessions: {} }).sessions || {})) closed.add(id);
  const cutoff = now.getTime() - 7 * 86400000;
  const sessions = walk(path.join(claudeDir, 'projects')).filter((file) => fs.statSync(file).mtimeMs >= cutoff && !closed.has(path.basename(file, '.jsonl')));
  if (sessionSummaryEnabled && sessions.length && !existing.has('unclosed-session-summary')) {
    const source = sessions.slice(0, 20).map((file) => `\n--- ${path.basename(file)} ---\n${readTextSafe(file)}`).join('').slice(0, 120000);
    made.push(enqueue({ provider: 'groq', jobType: 'unclosed-session-summary', batchDate: date, max: 4000, prompt: `以下は直近7日で未クローズのClaudeセッション記録です。各セッションについて目的、完了事項、未完了事項、次の一手を日本語で簡潔に要約してください。秘密値らしき文字列は出力しないでください。\n${source}` }, { home, now }));
  } else if (sessionSummaryEnabled && !sessions.length) skipped.push('unclosed-session-summary(データ無し)');
  else if (!sessionSummaryEnabled) skipped.push('unclosed-session-summary(既定OFF)');
  else if (existing.has('unclosed-session-summary')) skipped.push('unclosed-session-summary(投入済み)');
  if (!existing.has('executor-usage-digest')) {
    const usageFile = path.join(claudeDir, 'executor-usage.jsonl');
    const since = now.getTime() - 86400000;
    const rows = jsonl(usageFile).filter((row) => new Date(row.t).getTime() >= since);
    if (rows.length) {
      const byKey = {};
      for (const row of rows) {
        const key = `${row.provider}|${row.model}`;
        if (!byKey[key]) byKey[key] = { calls: 0, in: 0, out: 0, failures: 0, secs: 0 };
        byKey[key].calls++;
        byKey[key].in += row.in || 0;
        byKey[key].out += row.out || 0;
        byKey[key].failures += row.status !== 'ok' ? 1 : 0;
        byKey[key].secs += row.secs || 0;
      }
      const summary = JSON.stringify(Object.entries(byKey).map(([key, stat]) => ({ key, ...stat })), null, 0);
      const recent = redactSecrets(rows.slice(-10).map((row) => JSON.stringify(row)).join('\n').slice(-4000));
      const source = `集計サマリ:\n${summary}\n\n直近10件の生ログ:\n${recent}`;
      made.push(enqueue({ provider: 'deepseek', jobType: 'executor-usage-digest', batchDate: date, max: 4000, prompt: `以下は直近24時間のAI委譲実績サマリです。①provider/model別の使われ方 ②失敗・リトライの傾向 ③コストを下げるために次に回すべき経路、を簡潔に日本語でまとめてください。秘密値らしき文字列は出力しないでください。\n${source}` }, { home, now }));
    } else skipped.push('executor-usage-digest(データ無し)');
  } else skipped.push('executor-usage-digest(投入済み)');
  if (!existing.has('auto-session-digest')) {
    const autoSessionDir = path.join(claudeDir, 'auto-session', 'runs');
    const since = now.getTime() - 86400000;
    let summaries = [];
    try { summaries = fs.readdirSync(autoSessionDir).filter((name) => name.endsWith('.summary.md')).map((name) => path.join(autoSessionDir, name)); } catch {}
    const recent = summaries.map((file) => { try { const stat = fs.statSync(file); return stat.size > 0 && stat.mtimeMs >= since ? { file, mtimeMs: stat.mtimeMs } : null; } catch { return null; } }).filter(Boolean).sort((x, y) => y.mtimeMs - x.mtimeMs);
    const contents = recent.slice(0, 5).map((row) => ({ file: row.file, text: readTextSafe(row.file) })).filter((row) => row.text.trim().length > 0);
    if (contents.length) {
      const source = contents.map((row) => `\n--- ${path.basename(row.file)} ---\n${row.text}`).join('').slice(0, 120000);
      made.push(enqueue({ provider: 'deepseek', jobType: 'auto-session-digest', batchDate: date, max: 4000, prompt: `以下は夜間自動セッションの作業記録です。①何を達成したか ②実物で検証できたこと／できていないこと ③残TODOと次の一手、を簡潔に日本語でまとめてください。秘密値らしき文字列は出力しないでください。\n${source}` }, { home, now }));
    } else skipped.push('auto-session-digest(データ無し)');
  } else skipped.push('auto-session-digest(投入済み)');
  // groq は無料枠 TPM 8,000。入力60行/6000字・出力3000tok に抑えて 429 を避ける。
  if (!existing.has('next-session-todo-triage')) {
    const todoFile = path.join(claudeDir, 'next-session.md');
    let lines = [];
    try { lines = fs.readFileSync(todoFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean); } catch {}
    const todoLines = lines.filter((line) => /^(?:\s*[-*]|\s*~~|\s*\d+\.|TODO)/i.test(line) || /TODO/i.test(line));
    if (todoLines.length) {
      const source = redactSecrets(todoLines.slice(0, 60).join('\n').slice(0, 6000));
      made.push(enqueue({ provider: 'groq', jobType: 'next-session-todo-triage', batchDate: date, max: 3000, prompt: `以下は残TODO一覧です。各項目に「優先度(高/中/低)」「種別(コスト/品質/運用/価格/その他)」「今すぐ着手可能か」を付けた一覧を日本語で出力してください。新しいTODOを創作せず、秘密値らしき文字列は出力しないでください。\n${source}` }, { home, now }));
    } else skipped.push('next-session-todo-triage(データ無し)');
  } else skipped.push('next-session-todo-triage(投入済み)');
  if (!existing.has('results-daily-digest')) {
    const resultFiles = (() => { try { return fs.readdirSync(queueDir).filter((name) => /^results-.*\.jsonl$/.test(name)).map((name) => path.join(queueDir, name)); } catch { return []; } })();
    const resultRows = resultFiles.flatMap(jsonl).filter((row) => row.jobType !== 'results-daily-digest' && row.text);
    if (resultRows.length) {
      const source = redactSecrets(resultRows.slice(-100).map((row) => `\n--- ${row.id || 'result'} (${row.completedAt || ''}) ---\n${String(row.text).slice(0, 8000)}`).join('').slice(-120000));
      made.push(enqueue({ provider: 'deepseek', jobType: 'results-daily-digest', batchDate: date, max: 4000, prompt: `以下の夜間バッチ結果を日次ダイジェストにまとめてください。重要な成果、要確認、失敗、次の一手を日本語で簡潔に整理してください。\n${source}` }, { home, now }));
    } else skipped.push('results-daily-digest(データ無し)');
  } else skipped.push('results-daily-digest(投入済み)');
  made.skipped = skipped;
  return made;
}

if (isEntry(import.meta.url)) {
  const made = produce();
  const types = made.map((job) => job.jobType).filter(Boolean);
  console.log(`batch-producer: ${made.length}件投入${types.length ? ` [${types.join(', ')}]` : ''}${made.skipped?.length ? ` / skipped: ${made.skipped.join(', ')}` : ''}`);
}