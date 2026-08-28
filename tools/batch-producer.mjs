#!/usr/bin/env node
// 毎晩、安価なモデルで処理できる実データだけを重複なく batch-queue に積む。
// セッション要約の有効化は環境変数 ORGIAST_BATCH_SESSION_SUMMARY=1（セッション記録が Groq へ送られる点に注意）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueJob } from './batch-enqueue.mjs';
import { redactSecrets } from './redact-secrets.mjs';

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function jsonl(file) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } }
function walk(dir) {
  const found = [];
  try { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) found.push(...walk(full)); else if (entry.name.endsWith('.jsonl')) found.push(full); } } catch {}
  return found;
}
function excerpt(file, limit = 12000) {
  const raw = fs.readFileSync(file, 'utf8');
  return redactSecrets(raw.length <= limit ? raw : raw.slice(-limit));
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
  const closed = new Set(readJson(path.join(claudeDir, 'closed-sessions.json'), { ids: [] }).ids || []);
  for (const id of Object.keys(readJson(path.join(claudeDir, 'session-closed-ledger.json'), { sessions: {} }).sessions || {})) closed.add(id);
  const cutoff = now.getTime() - 7 * 86400000;
  const sessions = walk(path.join(claudeDir, 'projects')).filter((file) => fs.statSync(file).mtimeMs >= cutoff && !closed.has(path.basename(file, '.jsonl')));
  if (sessionSummaryEnabled && sessions.length && !existing.has('unclosed-session-summary')) {
    const source = sessions.slice(0, 20).map((file) => `\n--- ${path.basename(file)} ---\n${excerpt(file)}`).join('').slice(0, 120000);
    made.push(enqueue({ provider: 'groq', jobType: 'unclosed-session-summary', batchDate: date, max: 4000, prompt: `以下は直近7日で未クローズのClaudeセッション記録です。各セッションについて目的、完了事項、未完了事項、次の一手を日本語で簡潔に要約してください。秘密値らしき文字列は出力しないでください。\n${source}` }, { home, now }));
  }
  if (!sessionSummaryEnabled) made.skipped = ['session-summary(既定OFF)'];
  const resultFiles = (() => { try { return fs.readdirSync(queueDir).filter((name) => /^results-.*\.jsonl$/.test(name)).map((name) => path.join(queueDir, name)); } catch { return []; } })();
  const resultRows = resultFiles.flatMap(jsonl).filter((row) => row.jobType !== 'results-daily-digest' && row.text);
  if (resultRows.length && !existing.has('results-daily-digest')) {
    const source = redactSecrets(resultRows.slice(-100).map((row) => `\n--- ${row.id || 'result'} (${row.completedAt || ''}) ---\n${String(row.text).slice(0, 8000)}`).join('').slice(-120000));
    made.push(enqueue({ provider: 'deepseek', jobType: 'results-daily-digest', batchDate: date, max: 4000, prompt: `以下の夜間バッチ結果を日次ダイジェストにまとめてください。重要な成果、要確認、失敗、次の一手を日本語で簡潔に整理してください。\n${source}` }, { home, now }));
  }
  return made;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = produce();
  console.log(`batch-producer: ${made.length}件投入${made.skipped?.length ? ` / skipped: ${made.skipped.join(', ')}` : ''}`);
}
