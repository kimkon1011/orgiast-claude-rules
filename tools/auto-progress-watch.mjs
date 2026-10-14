#!/usr/bin/env node
// 自動進行の台帳(auto-progress-ledger.mjs が記録)を定期巡回し、約束が進んでいるかを判定する。
// done → 閉じる / in_progress → 様子見 / stalled → 自動再開(1回/件/日)＋共有 Sheet へ行追加。
// 判定は安いLLM(llm-ask --category classification)。全滅したら「証拠なし=stalled」の決定論判定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

export const GRACE_MS = 6 * 3600 * 1000;
export const EXPIRE_MS = 7 * 86400000;
export const MAX_RESUMES = 3; // 1件あたりの累計
export const MAX_RESUMES_PER_RUN = 2; // 1回の巡回あたり（定期タスクの60分枠に判定・送信の余裕を残す）
const WATCHED = new Set(['open', 'resumed']);
const rowKey = (row) => `${row.pc}|${row.user}|${row.sessionId}|${row.ts}`;
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

// ---- 証拠収集 -------------------------------------------------------------
// transcript の promise 記録時刻以降の assistant/tool メッセージを要約する。
export function transcriptEvidence(transcriptPath, sinceMs, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let text = '';
  try { text = readFile(transcriptPath); } catch { return { count: 0, lastAt: 0, snippets: [] }; }
  let count = 0, lastAt = 0; const snippets = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry?.timestamp);
    // 約束を書いたメッセージ自体（記録時刻の直前直後）は証拠に数えない。
    if (!Number.isFinite(at) || at <= sinceMs + 60000) continue;
    const content = entry?.message?.content;
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const body = parts.map((b) => b?.type === 'text' ? b.text : b?.type === 'tool_use' ? `[tool:${b.name}]` : '').filter(Boolean).join(' ').trim();
    if (entry.type !== 'assistant' && !(entry.type === 'user' && Array.isArray(content) && content.some((b) => b?.type === 'tool_result'))) continue;
    count += 1; lastAt = Math.max(lastAt, at);
    if (body) snippets.push(body.slice(0, 240));
  }
  return { count, lastAt, snippets: snippets.slice(-4) };
}

// 記録以降に同 cwd 配下で更新されたファイル（深さ4・走査上限2000件）。
export function recentFiles(cwd, sinceMs, { limit = 2000 } = {}) {
  let seen = 0, lastAt = 0; const names = [];
  const skip = new Set(['node_modules', '.git', '.next', 'dist', '.venv']);
  const walk = (dir, depth) => {
    if (depth > 4 || seen >= limit) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= limit) return;
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(path.join(dir, entry.name), depth + 1); continue; }
      seen += 1;
      let mtime; try { mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs; } catch { continue; }
      if (mtime > sinceMs) { lastAt = Math.max(lastAt, mtime); if (names.length < 5) names.push(entry.name); }
    }
  };
  if (cwd) walk(cwd, 0);
  return { lastAt, names };
}

// ~/.claude/auto-session/runs の該当ログ（sessionId か cwd を含み、記録以降に更新されたもの）。
export function autoSessionRuns(home, row, sinceMs) {
  const dir = path.join(home, '.claude', 'auto-session', 'runs');
  let names; try { names = fs.readdirSync(dir); } catch { return { lastAt: 0, names: [] }; }
  let lastAt = 0; const hit = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.mtimeMs <= sinceMs || stat.size > 2_000_000) continue;
      const body = fs.readFileSync(file, 'utf8');
      if ((row.sessionId && body.includes(row.sessionId)) || (row.cwd && body.includes(String(row.cwd).replace(/\\/g, '\\\\')))) { lastAt = Math.max(lastAt, stat.mtimeMs); hit.push(name); }
    } catch { /* 読めない行は無視 */ }
  }
  return { lastAt, names: hit.slice(0, 3) };
}

export function gatherEvidence(row, home, io = {}) {
  const since = Date.parse(row.ts);
  const transcript = (io.transcriptEvidence ?? transcriptEvidence)(row.transcriptPath, since);
  const files = (io.recentFiles ?? recentFiles)(row.cwd, since);
  const runs = (io.autoSessionRuns ?? autoSessionRuns)(home, row, since);
  const lastEvidenceAt = Math.max(transcript.lastAt, files.lastAt, runs.lastAt);
  return { transcript, files, runs, lastEvidenceAt, any: transcript.count > 0 || files.names.length > 0 || runs.names.length > 0 };
}

export function evidenceSummary(row, evidence, now) {
  const hours = (ms) => ms ? `${((now - ms) / 3600000).toFixed(1)}時間前` : 'なし';
  return [
    `約束: ${row.promise}`, `記録: ${row.ts}`,
    `記録後の会話/ツール動作: ${evidence.transcript.count}件（最後 ${hours(evidence.transcript.lastAt)}）`,
    ...evidence.transcript.snippets.map((s) => `  - ${s}`),
    `記録後に更新されたファイル: ${evidence.files.names.join(', ') || 'なし'}（最後 ${hours(evidence.files.lastAt)}）`,
    `auto-session ログ: ${evidence.runs.names.join(', ') || 'なし'}`,
  ].join('\n');
}

// ---- 判定 -----------------------------------------------------------------
export function parseVerdict(output) {
  const text = String(output ?? '');
  const match = text.match(/\b(done|in_progress|stalled)\b/i);
  if (!match) return null;
  const reason = text.replace(match[0], '').replace(/^[\s:：|｜,、\-–—]+/, '').split(/\r?\n/)[0].trim().slice(0, 120);
  return { verdict: match[1].toLowerCase(), reason: reason || '(理由なし)' };
}

export function deterministicVerdict(evidence, now) {
  if (!evidence.any) return { verdict: 'stalled', reason: '証拠なし（約束後の会話・ファイル更新・実行ログが無い）', source: 'deterministic' };
  if (now - evidence.lastEvidenceAt < GRACE_MS) return { verdict: 'in_progress', reason: '直近6時間以内に動きあり', source: 'deterministic' };
  return { verdict: 'stalled', reason: '最後の動きから6時間以上経過', source: 'deterministic' };
}

export function askLlm(prompt, { spawnImpl = spawnSync } = {}) {
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-ask.mjs');
  // llm-ask 内部の FALLBACK_CHAIN が groq → gemini → openrouter などへ自動で落とす。
  const result = spawnImpl(process.execPath, [tool, '--category', 'classification', '--provider', 'groq', '--max', '160', prompt], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

export function judge(row, evidence, now, io = {}) {
  if (!evidence.any) return deterministicVerdict(evidence, now); // 証拠ゼロは LLM に聞くまでもなく stalled
  const prompt = `次は AI セッションが「この後に自動で進める」と宣言した内容と、その後の証拠です。宣言が実行済みなら done、進行中なら in_progress、止まっているなら stalled と判定してください。\n出力は1行のみ: <done|in_progress|stalled> | <15字程度の理由>\n\n${evidenceSummary(row, evidence, now)}`;
  let parsed = null;
  try { parsed = parseVerdict((io.askLlm ?? askLlm)(prompt)); } catch { parsed = null; }
  return parsed ? { ...parsed, source: 'llm' } : deterministicVerdict(evidence, now);
}

// ---- 再開 ----------------------------------------------------------------
// stalled-session-resume.mjs と同じ方式: claude を --resume で呼び、成果 JSON を書かせる。
export async function resumeSession(row, { timeoutMs = 20 * 60000, home = os.homedir(), io = {} } = {}) {
  const { runChild, resolveClaudeExe } = await import('./auto-session.mjs');
  const resultFile = path.join(home, '.claude', `auto-progress-resume-${String(row.sessionId).slice(0, 8)}.json`);
  fs.rmSync(resultFile, { force: true }); // Never reuse a report from an earlier attempt.
  const prompt = `以前このセッションで宣言した「この後の自動進行」が止まっています。宣言: 「${row.promise}」。\n元の会話は ${row.transcriptPath} にあります。宣言を1歩進めてください。推測で目的を広げず、他セッションの変更を上書きせず、権限や確認待ちを迂回しないでください。期限は${timeoutMs / 60000}分です。\n結果を ${resultFile} に JSON で保存: {"progressed":true/false,"evidence":"変更した成果物と検証結果、または進めない理由"}`;
  const result = await (io.runChild ?? runChild)(io.executable ?? resolveClaudeExe(), prompt, row.cwd, row.cwd, timeoutMs, { resumeSessionId: row.sessionId });
  if (result.status !== 'success') return { outcome: 'error', reason: String(result.status) };
  let report = null; try { report = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* 成果記録なし */ }
  return { outcome: report?.progressed === true && String(report.evidence ?? '').trim() ? 'progressed' : 'no-progress', reason: String(report?.evidence ?? '成果記録なし').slice(0, 200) };
}

// ---- Sheet ---------------------------------------------------------------
export function sheetConfig(home) {
  try { const env = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8')); return env.FLEET_SHEET_URL && env.FLEET_SHEET_TOKEN ? { url: env.FLEET_SHEET_URL, token: env.FLEET_SHEET_TOKEN } : null; }
  catch { return null; }
}

export async function postSheet(config, kind, body, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(config.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: config.token, kind, ...body }), signal: AbortSignal.timeout(60000), redirect: 'follow' });
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* 非JSON */ }
  if (!response.ok || parsed?.ok !== true || (kind === 'auto-progress' && typeof parsed.updated !== 'boolean') || (kind === 'auto-progress-list' && !Array.isArray(parsed.rows))) throw new Error(parsed?.error || `HTTP ${response.status}`);
  return parsed;
}

export function sheetRow(row, verdict, evidence, now = Date.now()) {
  return {
    key: rowKey(row), pc: row.pc, user: row.user, sessionId: row.sessionId, promise: row.promise, recordedAt: row.ts,
    lastEvidenceAt: evidence.lastEvidenceAt ? new Date(evidence.lastEvidenceAt).toISOString() : '',
    verdict: verdict.verdict, reason: verdict.reason, resumeAttempted: Boolean(row.resumedAt), resumeOutcome: row.resumeOutcome || '',
    reportedAt: new Date(now).toISOString(),
  };
}

// ---- 本体 ----------------------------------------------------------------
export async function run({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, io = {} } = {}) {
  const file = ledgerFile(home);
  const patch = (key, changes) => { // ledger hook と競合しないよう、書く直前に読み直して該当行だけ更新する。
    if (dryRun) return;
    const rows = readLedger(file);
    writeLedger(file, rows.map((r) => rowKey(r) === key ? { ...r, ...changes, status: WATCHED.has(r.status) ? (changes.status ?? r.status) : r.status } : r));
  };
  const summary = { checked: 0, done: 0, inProgress: 0, stalled: 0, resumed: 0, reported: 0, expired: 0, graced: 0, errors: [] };
  const config = (io.sheetConfig ?? sheetConfig)(home);
  for (const row of readLedger(file).filter((r) => WATCHED.has(r.status))) {
    const recorded = Date.parse(row.ts);
    if (!Number.isFinite(recorded)) continue;
    if (now - recorded < GRACE_MS) { summary.graced += 1; continue; }
    if (now - recorded >= EXPIRE_MS) { patch(rowKey(row), { status: 'expired' }); summary.expired += 1; continue; }
    summary.checked += 1;
    const evidence = gatherEvidence(row, home, io);
    const verdict = judge(row, evidence, now, io);
    if (verdict.verdict === 'done') { patch(rowKey(row), { status: 'done', doneAt: new Date(now).toISOString(), reason: verdict.reason }); summary.done += 1; continue; }
    if (verdict.verdict === 'in_progress') { patch(rowKey(row), { lastCheckedAt: new Date(now).toISOString(), reason: verdict.reason }); summary.inProgress += 1; continue; }
    summary.stalled += 1;
    let current = { ...row };
    const canResume = !dryRun && summary.resumed < MAX_RESUMES_PER_RUN &&(row.resumeCount ?? 0) < MAX_RESUMES && localDay(Date.parse(row.resumedAt || 0)) !== localDay(now)
      && row.cwd && (io.cwdExists ?? fs.existsSync)(row.cwd);
    if (canResume) {
      // Persist the attempt before launching: crashes must not allow another same-day resume.
      current = { ...row, status: 'resumed', resumedAt: new Date(now).toISOString(), resumeCount: (row.resumeCount ?? 0) + 1, resumeOutcome: 'attempting' };
      patch(rowKey(row), { status: current.status, resumedAt: current.resumedAt, resumeCount: current.resumeCount, resumeOutcome: current.resumeOutcome });
      let outcome;
      try { outcome = await (io.resume ?? resumeSession)(row, { home }); } catch (error) { outcome = { outcome: 'error', reason: String(error?.message ?? error).slice(0, 200) }; }
      current = { ...row, status: 'resumed', resumedAt: new Date(now).toISOString(), resumeCount: (row.resumeCount ?? 0) + 1, resumeOutcome: `${outcome.outcome}: ${outcome.reason}` };
      patch(rowKey(row), { status: 'resumed', resumedAt: current.resumedAt, resumeCount: current.resumeCount, resumeOutcome: current.resumeOutcome, lastCheckedAt: new Date(now).toISOString(), reason: verdict.reason });
      summary.resumed += 1;
    }
    const reportKey = `${verdict.verdict}:${Boolean(current.resumedAt)}:${current.resumeCount ?? 0}`;
    if (config && current.reportedKey !== reportKey && !dryRun) {
      try { await (io.postSheet ?? postSheet)(config, 'auto-progress', { row: sheetRow(current, verdict, evidence, now) }); patch(rowKey(row), { reportedKey: reportKey }); summary.reported += 1; }
      catch (error) { summary.errors.push(`sheet: ${String(error?.message ?? error).slice(0, 120)}`); } // 次回巡回で再送する
    }
  }
  if (!dryRun) {
    const log = path.join(home, '.claude', 'logs', 'auto-progress-watch.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, `${new Date(now).toISOString()} ${JSON.stringify(summary)}\n`);
  }
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const label = resolveFleetLabel(process.env.ORGIAST_HOME || os.homedir());
  const summary = await run({ dryRun });
  console.log(JSON.stringify({ label, dryRun, ...summary }));
  return 0;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 0; }
}
