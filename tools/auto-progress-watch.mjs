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
import { ledgerFile, readLedger, writeLedger, cleanupOldLedgerTemps, OPEN_STATUSES, latestOpenPromises, rowKey, isUnattendedRow, isNoopPromise, MAX_RESUMES, originLine } from './auto-progress-ledger.mjs';
export { MAX_RESUMES } from './auto-progress-ledger.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { notifyOwner, resolveOwner, sendOwnerToast } from './notify-owner.mjs';
import { escalateKimDecisions } from './auto-progress-escalate.mjs';
import { isQuietHours, kimAction } from './auto-progress-digest.mjs';
import { completionActions } from './lib/auto-progress-artifact.mjs';
import { reportCheckProgress } from './lib/auto-progress-heartbeat.mjs';
import { checkPromise, checkProgressSummary, executeCheck, isTimeOnlyCheck, queueCheckFollowup, pendingAction } from './auto-progress-check.mjs';
import { addItem } from './kim-inbox.mjs';
import { pushDailyProgress } from './lib/auto-progress-daily.mjs';
import { appendInbox, inboxFile } from './auto-progress-inbox-hook.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { BLOCKER, readJson as readFleetJson, saveJson as saveFleetJson } from './lib/fleet-chase-ledger.mjs';
import { errorKind, findUnansweredRequest } from './lib/unanswered-request.mjs';
import { refreshDoneApprovals, deliverDoneInbox, hasDoneInboxReceipt, usesKimDoneInbox } from './lib/auto-progress-done-inbox.mjs';

export const GRACE_MS = 1 * 3600 * 1000;
export const RESUME_INTERVAL_MS = 2 * 3600 * 1000;
export const EXPIRE_MS = 7 * 86400000;
export const MAX_RESUMES_PER_RUN = 4; // 1回の巡回あたり（4件 × 最大20分）
const WATCHED = OPEN_STATUSES;
export const EXPIRE_UNATTENDED_MS = 48 * 3600 * 1000;
export const FALLBACK_STALL_MS = 24 * 3600 * 1000;
export const TIME_ONLY_REASON = '時刻だけの check は完了判定にできないため開始予約へ変換';
export const LEGACY_ADD_CHECK_REASON = 'nextClaude 付き add-check の誤完了を開始予約へ変換';

// 完了が本人に配達・検証済み（done inbox レシートまたは done 通知済み）の行は誤完了ではない。
// レシートがあるのに移行で復活させると、完了済みの約束が偽の開始予約として何度も再開される（2026-11-05 17件実害）。
export function doneConcludedWithReceipt(row) {
  return Boolean((row.doneInboxId && row.doneInboxVerifiedAt) || row.doneNotifiedAt);
}

// rowKey のセッション部分を使い、別 PC / user の同名セッションを混同しない。
const migrationSessionKey = row => rowKey(row).slice(0, rowKey(row).lastIndexOf('|'));
const rowTime = row => Date.parse(row.ts) || 0;
function latestMigrationSessionRows(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = migrationSessionKey(row), previous = latest.get(key);
    if (!previous || rowTime(row) >= rowTime(previous)) latest.set(key, row);
  }
  return new Set(latest.values());
}

export function legacyAddCheckMigrationRows(rows) {
  const latest = latestMigrationSessionRows(rows);
  const migrated = new Set(rows.map(row => row.migratedFromLegacyAddCheck).filter(Boolean));
  return rows.filter(row => latest.has(row) && row.status === 'done' && String(row.check || '').trim() &&
    String(row.nextClaude || '').trim() && !isTimeOnlyCheck(row.check) && !row.resumedAt &&
    !doneConcludedWithReceipt(row) && !migrated.has(rowKey(row)));
}

export function legacyAddCheckReservation(row, now = Date.now()) {
  const reset = { ...row };
  for (const key of ['check', 'checkRegisteredAt', 'checkResult', 'checkText', 'doneAt', 'doneNotifiedAt', 'doneInboxId',
    'doneInboxVerifiedAt', 'checkNotifiedResult', 'lastCheckedAt', 'startedAt', 'startOverdueNotifiedAt']) delete reset[key];
  return { ...reset, ts: new Date(now).toISOString(), status: 'scheduled', startWhen: row.check,
    deadlineAt: new Date(now + 24 * 3600000).toISOString(), reason: LEGACY_ADD_CHECK_REASON,
    migratedLegacyAddCheckAt: new Date(now).toISOString(), migratedFromLegacyAddCheck: rowKey(row) };
}

export async function migrateLegacyAddChecks({ home, now = Date.now(), dryRun = false, io = {} }) {
  const file = ledgerFile(home), rows = readLedger(file), targets = legacyAddCheckMigrationRows(rows);
  if (dryRun || !targets.length) return { targets, appended: 0 };
  const additions = targets.map(row => legacyAddCheckReservation(row, now));
  (io.writeLedger ?? writeLedger)(file, [...rows, ...additions], io.ledgerIo ?? {});
  for (const row of additions) {
    const text = `nextClaude 付き check を再開対象に戻しました: ${row.label || row.promise}`;
    (io.stdout ?? console.log)(text);
    await (io.addKimInboxItem ?? addItem)(home, { kind: 'info', source: 'auto-progress-legacy-add-check-migration', text,
      dedupeKey: `auto-progress-legacy-add-check-migration:${row.sessionId || rowKey(row)}` });
  }
  return { targets, appended: additions.length };
}

export function timeOnlyMigrationRows(rows) {
  const latest = latestMigrationSessionRows(rows);
  const migrated = new Set(rows.map(row => row.migratedFromTimeOnlyCheck).filter(Boolean));
  return rows.filter(row => latest.has(row) && row.status === 'done' && isTimeOnlyCheck(row.check) && !migrated.has(rowKey(row)));
}

export function timeOnlyReservation(row, now = Date.now()) {
  const reset = { ...row };
  for (const key of ['check', 'checkResult', 'checkText', 'doneAt', 'doneNotifiedAt', 'doneInboxId', 'doneInboxVerifiedAt', 'checkNotifiedResult', 'lastCheckedAt', 'startedAt', 'startOverdueNotifiedAt']) delete reset[key];
  return { ...reset, ts: new Date(now).toISOString(), status: 'scheduled', startWhen: row.check,
    deadlineAt: new Date(now + 24 * 3600000).toISOString(), reason: TIME_ONLY_REASON,
    nextClaude: String(row.nextClaude || '').trim() || `「${row.label || row.promise}」の作業を再開し、成果物を確認して完了まで進める`,
    migratedTimeOnlyCheckAt: new Date(now).toISOString(), migratedFromTimeOnlyCheck: rowKey(row) };
}

export async function migrateTimeOnlyChecks({ home, now = Date.now(), dryRun = false, io = {} }) {
  const file = ledgerFile(home), rows = readLedger(file), targets = timeOnlyMigrationRows(rows);
  if (dryRun || !targets.length) return { targets, appended: 0 };
  const additions = targets.map(row => timeOnlyReservation(row, now));
  (io.writeLedger ?? writeLedger)(file, [...rows, ...additions], io.ledgerIo ?? {});
  for (const row of additions) {
    const text = `誤って達成扱いだった約束を再開しました: ${row.label || row.promise}`;
    (io.stdout ?? console.log)(text);
    await (io.addKimInboxItem ?? addItem)(home, { kind: 'info', source: 'auto-progress-time-only-migration', text,
      dedupeKey: `auto-progress-time-only-migration:${row.sessionId || rowKey(row)}` });
  }
  return { targets, appended: additions.length };
}

const migrationSourceKey = row => row.migratedFromLegacyAddCheck || row.migratedFromTimeOnlyCheck;
const isMigrationRow = row => Boolean(migrationSourceKey(row) || row.repairedFromLegacyReopen);

export function migrationClobberRestorationRows(rows) {
  const groups = new Map(), byKey = new Map(rows.map(row => [rowKey(row), row]));
  const restored = new Set(rows.map(row => row.restoredFromMigrationClobber).filter(Boolean));
  for (const row of rows) {
    const key = migrationSessionKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const targets = [];
  for (const group of groups.values()) {
    group.sort((a, b) => rowTime(a) - rowTime(b)); // stable: 同時刻は後の行が最新
    // 正当な後続更新・復元済みの行があれば、その意思決定を巻き戻さない。
    let end = group.length - 1;
    while (end >= 0 && isMigrationRow(group[end]) && !group[end].restoredFromMigrationClobberAt) end--;
    const candidate = group[end];
    if (!candidate || end === group.length - 1 || restored.has(rowKey(candidate))) continue;
    const clobber = group[end + 1];
    let source = byKey.get(migrationSourceKey(clobber) || clobber.repairedFromLegacyReopen);
    // 旧修復は参照キーではなく true だけを保存した。同一セッションの一意な
    // 元 done 行を照合できる場合だけ救済し、曖昧な修復元は推測しない。
    if (!source && clobber.repairedFromLegacyReopen === true) {
      const originals = group.filter(row => !isMigrationRow(row) && row.status === 'done' &&
        rowTime(row) < rowTime(candidate) && row.label === clobber.label &&
        row.check === clobber.check && row.nextClaude === clobber.nextClaude);
      if (originals.length === 1) source = originals[0];
    }
    if (!source || migrationSessionKey(source) !== migrationSessionKey(candidate) || rowTime(source) >= rowTime(candidate)) continue;
    if (!OPEN_STATUSES.has(candidate.status) && candidate.status !== 'superseded') continue;
    if (candidate.status === 'superseded' && candidate.supersededFromStatus && !OPEN_STATUSES.has(candidate.supersededFromStatus)) continue;
    // 古い台帳は superseded 前の status を保存していない。記録済みの状態を優先し、
    // 判別不能な旧行は open に戻す。今後は supersededFromStatus で正確に保存する。
    const status = OPEN_STATUSES.has(candidate.status) ? candidate.status :
      OPEN_STATUSES.has(candidate.supersededFromStatus) ? candidate.supersededFromStatus : 'open';
    targets.push({ ...candidate, status });
  }
  return targets;
}

export async function restoreMigrationClobbers({ home, now = Date.now(), dryRun = false, io = {} }) {
  const file = ledgerFile(home), rows = readLedger(file), targets = migrationClobberRestorationRows(rows);
  if (dryRun || !targets.length) return { targets, appended: 0 };
  const additions = targets.map(row => ({ ...row, ts: new Date(now).toISOString(),
    ...(Date.parse(row.deadlineAt) < now ? { deadlineAt: new Date(now + 24 * 3600000).toISOString() } : {}),
    restoredFromMigrationClobber: rowKey(row), restoredFromMigrationClobberAt: new Date(now).toISOString() }));
  (io.writeLedger ?? writeLedger)(file, [...rows, ...additions], io.ledgerIo ?? {});
  for (const row of additions) {
    const text = `移行で上書きされた約束を復元しました: ${String(row.sessionId).slice(0, 8)} ${row.label || row.promise}`;
    await (io.addKimInboxItem ?? addItem)(home, { kind: 'info', source: 'auto-progress-migration-clobber-restore', text,
      dedupeKey: `auto-progress-migration-clobber-restore:${row.restoredFromMigrationClobber}` });
  }
  return { targets, appended: additions.length };
}

// ---- 証拠収集 -------------------------------------------------------------
// transcript の promise 記録時刻以降の assistant/tool メッセージを要約する。
export function transcriptEvidence(transcriptPath, sinceMs, { readFile = (p) => fs.readFileSync(p, 'utf8'), graceMs = 60000, includeUser = false } = {}) {
  let text = '';
  try { text = readFile(transcriptPath); } catch { return { count: 0, lastAt: 0, snippets: [] }; }
  let count = 0, lastAt = 0; const snippets = [], touchedPaths = [];
  let scheduledTurn = false, ignoredScheduledCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    const toolResult = Array.isArray(content) && content.some(b => b?.type === 'tool_result');
    // 時刻で絞る前に起点を追う。tool_result や meta 行は本人の次の発言ではない。
    if (entry.type === 'user') {
      // promptSource:'system' はバックグラウンド完了通知（turnOrigin:'task_notification'）にも付き、本物の進捗なので見ない。
      if (entry.turnOrigin === 'scheduled' || entry.wakeupSource) scheduledTurn = true;
      else if (!entry.isMeta && !toolResult) scheduledTurn = false;
    }
    const at = Date.parse(entry?.timestamp);
    // 約束を書いたメッセージ自体（記録時刻の直前直後）は証拠に数えない。
    if (!Number.isFinite(at) || at <= sinceMs + graceMs) continue;
    if (scheduledTurn && (entry.type === 'user' || entry.type === 'assistant')) {
      ignoredScheduledCount += 1;
      continue;
    }
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const body = parts.map((b) => b?.type === 'text' ? b.text : b?.type === 'tool_use' ? `[tool:${b.name}]` : '').filter(Boolean).join(' ').trim();
    if (entry.type !== 'assistant' && !(entry.type === 'user' && ((includeUser && !entry.isMeta) || (Array.isArray(content) && content.some((b) => b?.type === 'tool_result'))))) continue;
    count += 1; lastAt = Math.max(lastAt, at);
    if (body) snippets.push(body.slice(0, 240));
    for (const block of parts.filter(b => b?.type === 'tool_use')) {
      const input = block.input || {};
      for (const candidate of [input.file_path, input.path, input.command]) {
        if (!candidate) continue;
        const values = block.name === 'Bash' ? String(candidate).match(/(?:[A-Za-z]:\\[^\s"']+|\/(?:[^\s"']+))/g) || [] : [candidate];
        for (const value of values) if (!touchedPaths.includes(String(value))) touchedPaths.push(String(value));
      }
    }
  }
  return { count, lastAt, snippets: snippets.slice(-4), touchedPaths: touchedPaths.slice(-50), ignoredScheduledCount };
}

// この session の tool_use が明示したファイルだけを見る。他 session の cwd 更新は証拠にしない。
export function recentFiles(cwd, sinceMs, { paths = [] } = {}) {
  let lastAt = 0; const names = [];
  for (const value of paths) {
    const file = path.isAbsolute(value) ? value : path.resolve(cwd || '.', value);
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.isFile() && stat.mtimeMs > sinceMs) { lastAt = Math.max(lastAt, stat.mtimeMs); names.push(file); }
  }
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

// Legacy rows have no streak counter; retain their recorded failed attempts.
export const failedResume = row => /^(?:error|timeout|blocked)\b/i.test(String(row.resumeOutcome ?? '').trim());
export const failedResumeCount = row => failedResume(row) ? (row.resumeFailureCount ?? row.resumeCount ?? 0) : 0;
export function failedResumeEnd(row) {
  if (!failedResume(row)) return 0;
  return Math.max(Date.parse(row.resumeFinishedAt || row.lastCheckedAt) || 0, Date.parse(row.resumedAt) || 0);
}

export function gatherEvidence(row, home, io = {}) {
  const cutoff = failedResumeEnd(row);
  const since = Math.max(Date.parse(row.ts), cutoff);
  let transcript = (io.transcriptEvidence ?? transcriptEvidence)(row.transcriptPath, since, { graceMs: cutoff ? 0 : 60000, includeUser: Boolean(cutoff) });
  if (cutoff && transcript.lastAt <= cutoff) transcript = { ...transcript, count: 0, lastAt: 0, snippets: [], touchedPaths: [] };
  const files = (io.recentFiles ?? recentFiles)(row.cwd, since, { paths: transcript.touchedPaths || [] });
  let runs = (io.autoSessionRuns ?? autoSessionRuns)(home, row, since);
  if (cutoff && runs.lastAt <= cutoff) runs = { lastAt: 0, names: [] };
  // ファイルは共有されるため、更新時刻をこの約束の進捗時刻には使わない。
  const lastEvidenceAt = Math.max(transcript.lastAt, runs.lastAt);
  return { transcript, files, runs, lastEvidenceAt, any: transcript.count > 0 || files.names.length > 0 || runs.names.length > 0 };
}

export function evidenceSummary(row, evidence, now) {
  const hours = (ms) => ms ? `${((now - ms) / 3600000).toFixed(1)}時間前` : 'なし';
  return [
    `約束: ${row.promise}`, `記録: ${row.ts}`,
    `記録後の会話/ツール動作: ${evidence.transcript.count}件（最後 ${hours(evidence.transcript.lastAt)}）`,
    ...(evidence.transcript.ignoredScheduledCount ? ['定期確認のプロンプト・応答は進捗から除外'] : []),
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
  const lastSessionActivityAt = Math.max(evidence.transcript?.lastAt || 0, evidence.runs?.lastAt || 0);
  if (now - lastSessionActivityAt < FALLBACK_STALL_MS) return { verdict: 'in_progress', reason: '判定AIが使えず様子見', source: 'deterministic' };
  return { verdict: 'stalled', reason: '最後の動きから24時間以上経過', source: 'deterministic' };
}

export function askLlm(prompt, { spawnImpl = spawnSync } = {}) {
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-ask.mjs');
  // llm-ask 内部の FALLBACK_CHAIN が groq → gemini → openrouter などへ自動で落とす。
  const result = spawnImpl(process.execPath, [tool, '--category', 'classification', '--provider', 'groq', '--max', '160', prompt], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

export function exhaustedResumeVerdict(row) {
  const outcome = String(row.resumeOutcome ?? '').trim();
  if (!(row.resumeCount >= MAX_RESUMES) || !/^(?:error|timeout|blocked)\b/i.test(outcome)) return null;
  const summary = redactSecrets(outcome).replace(/\s+/g, ' ').slice(0, 160);
  return { verdict: 'stalled', reason: `自動再開が${row.resumeCount}回失敗（${summary}）`, source: 'resume-exhausted' };
}

export function judge(row, evidence, now, io = {}) {
  const result = judgeEvidence(row, evidence, now, io);
  // source は維持し、既存の reportKey による重複通知抑止を変えない。
  if (result.verdict === 'stalled' && evidence.transcript?.ignoredScheduledCount) {
    result.reason = `定期確認のみで進捗なし（${result.reason}）`;
  }
  return result;
}

function judgeEvidence(row, evidence, now, io) {
  // A failed resume writes transcript activity too; it must not reset the stall clock forever.
  const cutoff = failedResumeEnd(row);
  const freshActivity = cutoff && evidence.lastEvidenceAt > cutoff;
  if (failedResumeCount(row) >= 2 && !freshActivity && cutoff) {
    const summary = redactSecrets(String(row.resumeOutcome)).replace(/\s+/g, ' ').slice(0, 160);
    return { verdict: 'stalled', reason: `自動再開が連続${failedResumeCount(row)}回失敗（${summary}）`, source: 'resume-failed' };
  }
  const exhausted = freshActivity ? null : exhaustedResumeVerdict(row);
  if (exhausted) return exhausted;
  if (!evidence.any) return deterministicVerdict(evidence, now); // 証拠ゼロは LLM に聞くまでもなく stalled
  const prompt = `次は AI セッションが「この後に自動で進める」と宣言した内容と、その後の証拠です。宣言が実行済みなら done、進行中なら in_progress、止まっているなら stalled と判定してください。\n出力は1行のみ: <done|in_progress|stalled> | <15字程度の理由>\n\n${evidenceSummary(row, evidence, now)}`;
  let parsed = null;
  try { parsed = parseVerdict((io.askLlm ?? askLlm)(prompt)); } catch { parsed = null; }
  if (parsed?.verdict === 'done' && !evidence.transcript.snippets.some(s => /(?:完了|完成|done|finished|公開済|提出済)/i.test(s))) parsed.verdict = 'in_progress';
  return parsed ? { ...parsed, source: 'llm' } : deterministicVerdict(evidence, now);
}

// ---- 再開 ----------------------------------------------------------------
// stalled-session-resume.mjs と同じ方式: claude を --resume で呼び、成果 JSON を書かせる。
export async function resumeSession(row, { timeoutMs = 20 * 60000, home = os.homedir(), io = {}, reason } = {}) {
  const { runChild, resolveClaudeExe } = await import('./auto-session.mjs');
  const resultFile = path.join(home, '.claude', `auto-progress-resume-${String(row.sessionId).slice(0, 8)}.json`);
  fs.rmSync(resultFile, { force: true }); // Never reuse a report from an earlier attempt.
  const apiErrorResume = row.source === 'api-error-unanswered';
  const promptLead = reason === 'scheduled-start'
    ? `予約していた作業の開始条件を満たしました。予約: 「${row.label || row.promise}」。`
    : apiErrorResume
    ? `API エラーで返答できなかった user の依頼に、最初から通常どおり応えてください。依頼: ${row.requestText || row.promise.replace(/^API エラー（.*?）で返答できなかった依頼:\s*/, '')}`
    : `以前このセッションで宣言した「この後の自動進行」が止まっています。宣言: 「${row.promise}」。`;
  const prompt = `${promptLead}${row.kimAnswer ? `\nkim の返事: 「${row.kimAnswer}」。これを前提に続きを進めてください。` : ''}${reason === 'check-overdue' ? `\n期限超過の最終確認です。確認出力全文:\n${row.checkText || ''}\n確認エラー:\n${row.checkStderr || ''}` : ''}${row.nextClaude ? `\nやること: ${row.nextClaude}` : ''}\n元の会話は ${row.transcriptPath} にあります。${apiErrorResume ? '依頼を完了まで進めてください。' : '宣言の最終成果まで進めてください。'}止まる前に、取り消せる作業（調査・資料作成・下書き作成・比較表・社内向け準備）は全部先に済ませてください。needs_user で止まってよいのは、支払い・社外への送信・削除・本人の同意・本人にしかできない物理操作が残ったときだけです。evidence には先に済ませた作業と成果物を書いてください。推測で目的を広げず、他セッションの変更を上書きせず、権限や確認待ちを迂回しないでください。期限は${timeoutMs / 60000}分です。\n結果を ${resultFile} に JSON で保存: {"state":"progressed|done|needs_user|blocked","evidence":"先に済ませた作業と成果物パス・検証結果、残った操作と進めない理由","artifact":"成果物パス（任意）","nextKim":"本人だけができる具体的な判断・操作。返信待ちや自動調査なら空文字"}`;
  const rateLimited = apiErrorResume && /rate.?limit|usage.?credits?|429/i.test([row.error, row.apiError, row.apiErrorStatus].join(' '));
  const runOptions = { resumeSessionId: row.sessionId, ...(rateLimited ? { model: process.env.AUTO_PROGRESS_RESUME_MODEL || 'opus' } : {}) };
  const result = await (io.runChild ?? runChild)(io.executable ?? resolveClaudeExe(), prompt, row.cwd, row.cwd, timeoutMs, runOptions);
  if (result.status !== 'success') {
    const tail = String(result.stderr ?? '').split(/\r?\n/).filter(line => line.trim()).at(-1) || '';
    const detail = `${result.executorUsed} exit ${result.exitCode}`;
    const clean = value => value.replace(/\s+/g, ' ').trim();
    if (result.skippedNoExecutor || result.launchFailed || result.deferred) {
      return { outcome: 'deferred', deferred: true, reason: clean(`実行者なし: ${detail}${tail ? ` / ${tail}` : ''}`).slice(0, 240) };
    }
    return { outcome: 'error', reason: clean(`${result.status} (${detail}): ${tail}`).slice(0, 300) };
  }
  let report = null; try { report = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* 成果記録なし */ }
  const state = ['progressed', 'done', 'needs_user', 'blocked'].includes(report?.state) ? report.state : 'blocked';
  return { outcome: state, state, reason: String(report?.evidence ?? '成果記録なし').slice(0, 500), artifact: String(report?.artifact ?? ''), nextKim: String(report?.nextKim ?? '') };
}

// ---- 完了通知 -----------------------------------------------------------
export function readableReason(value, row, limit = 1200) {
  let text = String(value ?? '');
  for (const [key, replacement] of [['pc', 'このパソコン'], ['sessionId', 'この作業']]) {
    if (row && row[key]) text = text.split(String(row[key])).join(replacement);
  }
  text = text.replace(/\r\n/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
  return text.slice(0, limit);
}

// 判断に不要な作業ログを落として、準備できた内容だけを短く伝える。
export function summarizeEvidence(value) {
  const text = String(value ?? '')
    .replace(/\[CLAIM-EVIDENCE:[\s\S]*?\]/gi, '')
    .replace(/^\s*[a-z][a-z_ -]*[:：]\s*/i, '')
    .replace(/https?:\/\/[^\s<>「」]+/gi, '')
    .replace(/(?:[A-Za-z]:)?[\w./\\-]+\.[a-z][a-z0-9]*(?:\b)/gi, '')
    .replace(/\bidx\d+\b/gi, '')
    .replace(/\baria-[a-z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s。]+))?/gi, '')
    .replace(/\s+/g, ' ').trim();
  return (text.match(/[^。！？.!?]+[。！？.!?]?/g) || []).slice(0, 2).join('').slice(0, 160).trim();
}

export function formatDoneMessage(row, { reason = '', artifact = '', home = process.env.ORGIAST_HOME || os.homedir(), io = {}, ownerOf } = {}) {
  const origin = originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: ownerOf ? ownerOf(row) : row.owner, home });
  const lines = [
    origin,
    '✅ 自動進行が完了しました',
    formatDoneLine(row, { reason, artifact, home }),
    completionActions({ ...row, artifact: artifact || row.artifact }, { home }).text,
  ];
  return lines.join('\n').slice(0, 4000);
}

export function logDoneDm(home, row, delivery, message, now = Date.now(), io = {}, toastResult = null) {
  const file = path.join(home, '.claude', 'logs', 'auto-progress-done-dm.sent.jsonl');
  try {
    (io.mkdirSync ?? fs.mkdirSync)(path.dirname(file), { recursive: true });
    const payload = JSON.stringify({
      at: new Date(now).toISOString(),
      sessionId: row.sessionId,
      delivered: delivery?.delivered ?? null,
      channel: delivery?.channel ?? null, ok: delivery?.ok, attempts: delivery?.attempts, toastExitCode: delivery?.toastExitCode,
      reason: delivery?.reason,
      httpStatus: delivery?.httpStatus, messageId: delivery?.messageId, recipientId: delivery?.recipientId,
      text: message.slice(0, 8000),
      ...(toastResult ? { toast: { ok: toastResult.ok, exitCode: toastResult.exitCode } } : {}),
    });
    (io.appendFileSync ?? fs.appendFileSync)(file, `${payload}\n`);
  } catch (error) {
    (io.stderr ?? console.error)(`auto-progress-watch: done-dm log failed: ${error?.message ?? error}`);
  }
}

export const DONE_NOTICE_RECENT_MS = 72 * 3600 * 1000;
export const DONE_BACKLOG_MESSAGE_LIMIT = 1800;
export const DONE_BACKLOG_MAX_MESSAGES = 3;

function doneTime(row) {
  for (const value of [row.doneAt, row.lastCheckedAt, row.ts]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function doneWasAlreadyReportedByCheck(row) {
  // checkResult=done は checkPromise 自身が未達を再送する。掃除側でも送ると、
  // 同じ巡回で check の結果通知と汎用完了DMが二重になる。
  return row.check && row.checkResult === 'done';
}

export function doneNoticeSweepRows(rows, home, now = Date.now()) {
  const migrated = new Set(rows.flatMap(row => [row.migratedFromTimeOnlyCheck, row.migratedFromLegacyAddCheck]).filter(Boolean));
  const eligible = rows.filter(row => row.status === 'done' && !(usesKimDoneInbox(row, home) ? hasDoneInboxReceipt(row) : row.doneNotifiedAt) && !row.doneNotifySkipped &&
    !isUnattendedRow(row, home) && !doneWasAlreadyReportedByCheck(row) && !migrated.has(rowKey(row)));
  return {
    recent: eligible.filter(row => now - doneTime(row) <= DONE_NOTICE_RECENT_MS),
    backlog: eligible.filter(row => now - doneTime(row) > DONE_NOTICE_RECENT_MS),
  };
}

const jstDay = value => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));

export function formatDoneLine(row, { home = process.env.ORGIAST_HOME || os.homedir(), reason = '', artifact = '' } = {}) {
  const reports = [];
  if (row.sessionId && !/[\\/]/.test(row.sessionId)) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(home, '.claude', `auto-progress-resume-${String(row.sessionId).slice(0, 8)}.json`), 'utf8'));
      if (report?.state === 'done') reports.push(report);
    } catch { /* inboxへフォールバック */ }
    try {
      const lines = fs.readFileSync(path.join(home, '.claude', 'auto-progress-inbox', `${row.sessionId}.jsonl`), 'utf8').split(/\r?\n/).reverse();
      for (const line of lines) {
        try { const report = JSON.parse(line); if (report?.state === 'done') reports.push(report); } catch { /* 壊れた行は無視 */ }
      }
    } catch { /* 記録なし */ }
  }
  const clean = value => readableReason(value, row).replace(/\s+/g, ' ').trim();
  const report = reports.find(item => typeof item.evidence === 'string' && item.evidence.trim());
  const evidence = clean(report?.evidence || reason || row.evidence || row.reason);
  const summary = evidence ? evidence.slice(0, 120) : `（結果記録なし・宣言文）${clean(row.promise).slice(0, 120) || '(宣言なし)'}`;
  const project = clean(row.projectName || row.project || String(row.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '作業').slice(0, 80);
  const output = clean(report?.artifact || reports.find(item => item.artifact)?.artifact || artifact || row.artifact || row.doneNotifyArtifact || 'なし').slice(0, 300);
  return `✅ 完了: ${project} — ${summary}（成果物: ${output}）（${jstDay(doneTime(row))} JST）`;
}

export function formatDoneBacklogMessages(rows, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const header = '📋 未通知だった自動進行の完了一覧\n過去に完了していたものをまとめてお知らせします。';
  const entries = rows.map(row => ({ row, line: formatDoneLine(row, { home }) }));
  const messages = [];
  let current = { text: header, rows: [] };
  for (const entry of entries) {
    const next = `${current.text}\n${entry.line}`;
    if (next.length > DONE_BACKLOG_MESSAGE_LIMIT && current.rows.length) {
      messages.push(current);
      if (messages.length >= DONE_BACKLOG_MAX_MESSAGES) break;
      current = { text: header, rows: [] };
    }
    if (`${current.text}\n${entry.line}`.length > DONE_BACKLOG_MESSAGE_LIMIT) continue;
    current.text += `\n${entry.line}`;
    current.rows.push(entry.row);
  }
  if (messages.length < DONE_BACKLOG_MAX_MESSAGES && current.rows.length) messages.push(current);
  return messages;
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

function recentTranscripts(home, now, io = {}) {
  if (io.transcriptFiles) return io.transcriptFiles;
  const root = path.join(home, '.claude', 'projects');
  const found = [];
  const visit = dir => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['subagents', 'memory'].includes(entry.name)) visit(file);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { if (now - fs.statSync(file).mtimeMs <= EXPIRE_MS) found.push(file); } catch {}
      }
    }
  };
  visit(root);
  return found;
}

async function registerUnanswered(home, now, rows, dryRun, summary, ownerOf, io, persist) {
  for (const transcriptPath of recentTranscripts(home, now, io)) {
    const found = (io.findUnansweredRequest ?? findUnansweredRequest)(transcriptPath);
    if (!found) continue;
    const duplicate = rows.some(row =>
      (row.sessionId === found.sessionId && OPEN_STATUSES.has(row.status)) ||
      (row.source === 'api-error-unanswered' && row.ts === found.errorAt));
    if (duplicate) continue;
    if (dryRun) { summary.discovered += 1; continue; } // dry-run は件数だけ数え、台帳も DM も触らない。
    const requestText = redactSecrets(found.requestText).slice(0, 200);
    const kind = redactSecrets(errorKind(found));
    const row = {
      ts: found.errorAt, pc: io.hostname ?? os.hostname(), user: io.user ?? (() => { try { return os.userInfo().username; } catch { return ''; } })(),
      owner: '', sessionId: found.sessionId, cwd: found.cwd, transcriptPath: found.transcriptPath,
      promise: `API エラー（${kind}）で返答できなかった依頼: ${requestText}`, requestText,
      error: found.error, apiError: found.apiError, apiErrorStatus: found.apiErrorStatus,
      nextKim: 'なし', status: 'open', source: 'api-error-unanswered',
    };
    row.owner = ownerOf(row);
    rows.push(row);
    if (!persist(rows)) { rows.pop(); break; }
    summary.discovered += 1;
    if (isUnattendedRow(row, home)) continue;
    try {
      const message = `${originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: row.owner, home })}\nエラーで止まっていた依頼を見つけ、自動で再開します。\n依頼: ${requestText}`;
      const delivery = await (io.notifyOwner ?? notifyOwner)(row.owner, message, { home, now, kind: 'automatic', session: row });
      if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
    } catch (error) { summary.errors.push(`api-error-notify: ${String(error?.message ?? error).slice(0, 120)}`); }
  }
}

export async function watchFleetMail({ home, now, dryRun = false, io = {} }) {
  const dir = path.join(home, '.claude');
  const sent = readFleetJson(path.join(dir, 'fleet-mail-sent-status.json'), {});
  const file = path.join(dir, 'auto-progress-fleet-notified.json');
  const notified = readFleetJson(file, {});
  const summary = { fleetExpired: 0, fleetBlocked: 0 };
  const label = io.label ?? resolveFleetLabel(home);
  const WINDOW = 7 * 24 * 3600000;
  // Collect fleet-chase tracked mail IDs.
  const chasedIds = new Set();
  if (io.fleetChaseMailIds) {
    for (const id of io.fleetChaseMailIds) chasedIds.add(id);
  } else {
    try {
      const ledger = readFleetJson(path.join(home, '.claude', 'fleet-chase', 'ledger.json'), {});
      for (const item of Object.values(ledger.items || {})) {
        for (const id of [item?.mailId, ...(item?.chaseMailIds || [])]) if (id) chasedIds.add(id);
      }
    } catch { /* fleet-chase not available */ }
  }
  const due = [];
  for (const [key, mail] of Object.entries(sent)) {
    const id = mail?.id || key;
    if (!mail || (mail.from && mail.from !== label) || id.startsWith('mail-reply-') || mail.replyTo) continue;
    if (!(now - Date.parse(mail.expiresAt || mail.createdAt) < WINDOW)) continue;
    // Notes never need chasing: no result body expected, and fleet-chase ignores them.
    if (mail.kind !== 'prompt') continue;
    // Self-addressed: no cross-PC tracking needed.
    if (mail.to === mail.from || mail.to === label) continue;
    // fleet-chase own tracking IDs and already-chased mails.
    if (id.startsWith('mail-chase-') || chasedIds.has(id)) continue;
    const expired = mail.status === 'expired';
    const empty = !String(mail.resultBody || '').trim();
    const blocked = mail.status === 'failed' || mail.status === 'done' && (empty || BLOCKER.test(mail.resultBody || ''));
    if (!expired && !blocked) continue;
    summary[expired ? 'fleetExpired' : 'fleetBlocked']++;
    if (dryRun) continue;
    const prev = notified[id];
    const prevNotifiedAt = typeof prev === 'number' ? prev : (prev?.notifiedAt ?? NaN);
    if (Number.isFinite(prevNotifiedAt) && now - prevNotifiedAt < 24 * 3600000) continue;
    due.push({ id, mail });
  }
  if (!due.length) return summary;
  const isKimPc = label === 'kim-PC';
  if (isKimPc) {
    // kim-PC: no DM, fleet-chase ingest already tracks these outbound mails.
    for (const { id } of due) {
      const prev = notified[id];
      notified[id] = typeof prev === 'number'
        ? { notifiedAt: prev, handledAt: new Date(now).toISOString() }
        : { ...(prev ?? {}), handledAt: new Date(now).toISOString() };
    }
    saveFleetJson(file, notified);
    return summary;
  }
  // Non-kim-PC: auto-retry once per stuck mail, then log remaining.
  for (const { id, mail } of due) {
    const prev = notified[id];
    const retryCount = typeof prev === 'object' ? (prev?.retryCount ?? 0) : 0;
    if (retryCount > 0) {
      // Already retried once; log but do not DM.
      const log = path.join(home, '.claude', 'logs', 'auto-progress-watch.log');
      try { fs.appendFileSync(log, `${new Date(now).toISOString()} fleet-retry-exhausted: ${id} (${mail.status})\n`); } catch {}
      continue;
    }
    if (!dryRun) {
      try { await autoRetryFleetMail(home, label, mail, id, now, io); }
      catch (error) {
        const log = path.join(home, '.claude', 'logs', 'auto-progress-watch.log');
        try { fs.appendFileSync(log, `${new Date(now).toISOString()} fleet-retry-failed: ${id} (${String(error?.message ?? error).slice(0, 200)})\n`); } catch {}
      }
    }
    notified[id] = typeof prev === 'number'
      ? { notifiedAt: prev, retryCount: 1, retriedAt: new Date(now).toISOString() }
      : { ...(prev ?? {}), retryCount: 1, retriedAt: new Date(now).toISOString() };
  }
  saveFleetJson(file, notified);
  return summary;
}

async function autoRetryFleetMail(home, fromLabel, mail, id, now, io = {}) {
  let body = mail.body || '';
  // Fall back to the sent log if body not in status cache.
  if (!body) {
    try {
      const raw = io.readFile ? io.readFile(path.join(home, '.claude', 'fleet-mail-sent.jsonl'))
        : String(fs.readFileSync(path.join(home, '.claude', 'fleet-mail-sent.jsonl'), 'utf8'));
      for (const line of raw.split(/\r?\n/)) {
        try { const e = JSON.parse(line); if (e.id === id && e.action === 'sent' && e.body) { body = e.body; break; } } catch {}
      }
    } catch {}
  }
  if (!body) throw new Error('body not found for auto-retry');
  // 本文先頭は exec マーカーの解析位置なので触らず、再送の印は why に付ける（docs/fleet-chase.md）。
  const retryBody = String(body).slice(0, 19500);
  const retryWhy = `[自動再送] ${mail.why || ''}`.trim();
  if (io.sendMail) { return io.sendMail({ id: `${id}-retry-1`, to: mail.to, body: retryBody, why: retryWhy }); }
  const { parseEnvText } = await import('./env-kv.mjs');
  const env = parseEnvText(
    io.readFile ? io.readFile(path.join(home, '.claude', 'fleet-sheet.env'))
      : String(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8')));
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) throw new Error('fleet-sheet.env not configured');
  const { createClient } = await import('./fleet-mail.mjs');
  const request = createClient({ url: env.FLEET_SHEET_URL, token: env.FLEET_SHEET_TOKEN });
  const newId = `${id}-retry-1`;
  await request('mail-send', {
    id: newId, from: fromLabel, to: mail.to, messageKind: 'prompt',
    body: retryBody,
    why: retryWhy, auto: true, hop: 1, priority: 'normal',
    expiresAt: new Date(now + 24 * 3600000).toISOString(),
  });
}

// ---- 本体 ----------------------------------------------------------------
export async function run({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, io = {} } = {}) {
  const file = ledgerFile(home);
  const clock = io.clock ?? Date.now;
  const stopAt = clock() + 45 * 60000;
  const summary = { checked: 0, done: 0, overdueReported: 0, noop: 0, inProgress: 0, stalled: 0, resumed: 0, resumeDeferred: 0, reported: 0, expired: 0, graced: 0, superseded: 0, discovered: 0, errors: [] };
  let notificationsStopped = false;
  const ledgerFailure = (error) => {
    notificationsStopped = true;
    const detail = `ledger-write-failed: ${String(error?.code ? `${error.code}: ` : '')}${String(error?.message ?? error).slice(0, 240)}`;
    summary.errors.push(detail);
    const log = path.join(home, '.claude', 'logs', 'auto-progress-watch.log');
    try {
      (io.mkdirSync ?? fs.mkdirSync)(path.dirname(log), { recursive: true });
      (io.appendFileSync ?? fs.appendFileSync)(log, `${new Date(now).toISOString()} ${detail}\n`);
    } catch (logError) { (io.stderr ?? console.error)(`auto-progress-watch: ledger failure log failed: ${logError?.message ?? logError}`); }
  };
  const persist = (rows) => {
    if (dryRun) return true;
    if (notificationsStopped) return false;
    try { (io.writeLedger ?? writeLedger)(file, rows, io.ledgerIo ?? {}); return true; }
    catch (error) { ledgerFailure(error); return false; }
  };
  const patch = (key, changes) => { // ledger hook と競合しないよう、書く直前に読み直して該当行だけ更新する。
    if (dryRun) return true;
    const rows = readLedger(file);
    return persist(rows.map((r) => rowKey(r) === key ? { ...r, ...changes, status: WATCHED.has(r.status) ? (changes.status ?? r.status) : r.status } : r));
  };
  if (!dryRun) {
    try { (io.cleanupOldLedgerTemps ?? cleanupOldLedgerTemps)(file, { now, io: io.cleanupIo ?? {} }); }
    catch (error) { summary.errors.push(`ledger-temp-cleanup-failed: ${String(error?.message ?? error).slice(0, 120)}`); }
  }
  try {
    const restoration = await restoreMigrationClobbers({ home, now, dryRun, io });
    summary.migrationClobberRestore = { count: restoration.targets.length, labels: restoration.targets.map(row => row.label || row.promise), appended: restoration.appended };
  } catch (error) {
    summary.errors.push(`migration-clobber-restore: ${String(error?.message ?? error).slice(0, 120)}`);
  }
  try {
    const migration = await migrateTimeOnlyChecks({ home, now, dryRun, io });
    summary.timeOnlyMigration = { count: migration.targets.length, labels: migration.targets.map(row => row.label || row.promise), appended: migration.appended };
  } catch (error) {
    summary.errors.push(`time-only-migration: ${String(error?.message ?? error).slice(0, 120)}`);
  }
  try {
    const migration = await migrateLegacyAddChecks({ home, now, dryRun, io });
    summary.legacyAddCheckMigration = { count: migration.targets.length, labels: migration.targets.map(row => row.label || row.promise), appended: migration.appended };
  } catch (error) {
    summary.errors.push(`legacy-add-check-migration: ${String(error?.message ?? error).slice(0, 120)}`);
  }
  try { Object.assign(summary, await watchFleetMail({ home, now, dryRun, io })); }
  catch { summary.fleetExpired ??= 0; summary.fleetBlocked ??= 0; summary.errors.push('fleet-mail monitoring failed'); }
  const config = (io.sheetConfig ?? sheetConfig)(home);
  // owner 未記録の行は自PCの持ち主へ。空のまま渡すと「宛先: 不明（DM 未解決）」だけになり出どころが分からない（2026-10-23 実測）。
  let localOwner;
  const ownerOf = row => row.owner || (localOwner ??= io.localOwner ?? (() => { try { return resolveOwner({ home }); } catch { return ''; } })());
  const deferredNotices = new Map();
  const queueDeferredNotice = (row, reason) => {
    if (dryRun || notificationsStopped || isQuietHours(now) || isUnattendedRow(row, home)) return;
    const previousAt = Date.parse(row.resumeDeferredNotifiedAt || 0) || 0;
    if (row.resumeDeferredNotifiedReason === reason && now - previousAt < 24 * 3600000) return;
    const owner = ownerOf(row);
    const group = deferredNotices.get(owner) ?? [];
    group.push({ row, reason });
    deferredNotices.set(owner, group);
  };
  const sendDeferredNotices = async () => {
    for (const [owner, items] of deferredNotices) {
      if (notificationsStopped) break;
      const reasons = [...new Set(items.map(item => item.reason))].join(' / ');
      const targets = items.map(({ row }) => {
        const purpose = row.label || row.promise || '目的未記録';
        const next = row.nextClaude || pendingAction(row);
        return `・対象: ${purpose}\n  次の手: ${next}`;
      }).join('\n');
      const message = `自動再開を見送りました。理由: ${reasons}。次回の枠回復後に自動で再試行します。\n${targets}`;
      try {
        const delivery = await (io.notifyOwner ?? notifyOwner)(owner, message, { home, now, kind: 'automatic', session: items[0].row });
        if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
        for (const { row, reason } of items) patch(rowKey(row), {
          resumeDeferredNotifiedAt: new Date(now).toISOString(), resumeDeferredNotifiedReason: reason,
        });
      } catch (error) { summary.errors.push(`deferred-notify: ${String(error?.message ?? error).slice(0, 120)}`); }
    }
  };
  const askKim = (row, reason, artifact = '') => {
    const action = kimAction(row) !== 'なし' ? kimAction(row) : pendingAction(row).replace(/^[^:：\n]+[:：]\s*/, '');
    const url = String(artifact || row.artifact || '').match(/https?:\/\/[^\s<>]+/)?.[0]
      || String(reason || '').match(/https?:\/\/[^\s<>「」]+/)?.[0];
    const lines = [
      originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: ownerOf(row), home }),
      `自動進行が判断待ちです: ${row.label || row.promise}`,
      `あなたの返事待ち: ${action.replace(/\s+/g, ' ').trim()}`,
      `準備済み: ${summarizeEvidence(reason) || '準備内容の記録なし'}`,
    ];
    if (url) lines.push(`成果物: ${url}`);
    return (io.notifyOwner ?? notifyOwner)(ownerOf(row), lines.join('\n'), { home, now, kind: 'action', session: row });
  };
  const notifyDone = async (row, reason, artifact) => {
    if (notificationsStopped) return false;
    if (usesKimDoneInbox(row, home)) {
      if (hasDoneInboxReceipt(row)) return false;
      const message = formatDoneMessage(row, { reason, artifact, home, io, ownerOf });
      let delivery = null;
      try {
        delivery = await deliverDoneInbox(home, [{ ...row, artifact: artifact || row.artifact }], message, { now, io });
        return patch(rowKey(row), delivery.receipt);
      } catch (error) {
        patch(rowKey(row), { doneNotifyPending: true, doneNotifyArtifact: artifact || row.artifact || '' });
        summary.errors.push(`notify-done: ${String(error?.message ?? error).slice(0, 120)}`);
        return false;
      } finally { logDoneDm(home, row, delivery, message, now, io); }
    }
    if (row.doneNotifiedAt) return false;
    if (isQuietHours(now)) return false;
    const message = formatDoneMessage(row, { reason, artifact, home, io, ownerOf });
    let delivery = null;
    try {
      delivery = await (io.notifyOwner ?? notifyOwner)(ownerOf(row), message, { home, now, kind: row.status === 'done' && !isUnattendedRow(row, home) ? 'done-requested' : 'automatic', session: row });
      if (!['dm', 'session-inbox', 'toast', 'inbox'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
      patch(rowKey(row), { doneNotifiedAt: new Date(now).toISOString(), doneNotifyPending: false });
    } catch (error) {
      // done は open の集合から外れるので、印を残さないと次回の巡回で拾えず結果が消える。
      patch(rowKey(row), { doneNotifyPending: true, doneNotifyArtifact: artifact ? String(artifact) : '' });
      summary.errors.push(`notify-done: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    // 完了通知は DM の成否に関係なく、owner ��この PC のローカル user ならトーストも毎回出す
    let toastResult = null;
    try {
      const rowOwner = ownerOf(row);
      const pcOwner = io.localOwner ?? (() => { try { return resolveOwner({ home }); } catch { return ''; } })();
      if (delivery?.delivered !== 'toast' && rowOwner && pcOwner && rowOwner.toLowerCase() === pcOwner.toLowerCase()) {
        const toastText = `✅ 自動進行が完了: ${String(row.promise ?? '').slice(0, 120)}`;
        (io.sendOwnerToast ?? sendOwnerToast)(toastText, { home, onToastResult: value => { toastResult = value; } });
      }
    } catch { /* トースト失敗は DM の成否判定に影響しない */ }
    logDoneDm(home, row, delivery, message, now, io, toastResult);
    return ['dm', 'session-inbox', 'toast', 'inbox'].includes(delivery?.delivered);
  };
  const rows = readLedger(file);
  if (!dryRun) {
    try { await refreshDoneApprovals(home, rows, { now, io, patch }); }
    catch (error) { summary.errors.push(`done-approvals: ${String(error.message).slice(0, 200)}`); }
  }
  await registerUnanswered(home, now, rows, dryRun, summary, ownerOf, io, persist);
  let candidates = latestOpenPromises(rows);
  // check 付き行は sessionId + label ごとに1件選ばれるため、別 label の自動チェックはすべて残る。
  const selected = new Set(candidates);
  const migratedSourceKeys = new Set(rows.flatMap(row => [row.migratedFromTimeOnlyCheck, row.migratedFromLegacyAddCheck]).filter(Boolean));
  const pendingChecks = rows.filter(row => row.check && row.status === 'done' && row.checkResult === 'done' &&
    !hasDoneInboxReceipt(row) && !migratedSourceKeys.has(rowKey(row)));
  // 完了した経路に依存せず未通知を拾う。古い完了は個別DMを大量送信せず一覧にまとめる。
  const doneSweep = doneNoticeSweepRows(rows, home, now);
  summary.doneNotifications = { recent: doneSweep.recent.length, backlog: doneSweep.backlog.length };
  const normalized = rows.map((row) => {
    if (!WATCHED.has(row.status) || selected.has(row)) return row;
    summary.superseded += 1;
    return { ...row, supersededFromStatus: row.status, status: 'superseded' };
  });
  // Update by row identity: equal timestamps share rowKey, so patch(key) would
  // also supersede the selected latest row. No await occurs between read/write.
  if (!dryRun && summary.superseded) persist(normalized);
  // Expiration is cheap maintenance: never let checks/resumes exhaust its time budget.
  const reservation = row => row.startWhen && ['scheduled', 'starting', 'start_overdue'].includes(row.status);
  const expired = new Set(candidates.filter(row => !reservation(row) && !row.check && isUnattendedRow(row, home) &&
    Number.isFinite(Date.parse(row.ts)) && now - Date.parse(row.ts) >= EXPIRE_UNATTENDED_MS));
  for (const row of expired) patch(rowKey(row), { status: 'expired' });
  summary.expired += expired.size;
  candidates = candidates.filter(row => !expired.has(row));
  if (dryRun) summary.notifications = {
    unattendedExcluded: rows.filter(row => isUnattendedRow(row, home)).length,
    responseProbes: rows.filter(row => /^(?:OK|了解)\s*とだけ/.test(row.requestText || '')).map(row => ({
      sessionId: row.sessionId, status: row.status, dmEligible: !isUnattendedRow(row, home),
    })),
  };
  const needsKim = row => !['', 'なし'].includes(String(row.nextKim ?? '').trim());
  candidates.sort((a, b) => Number(needsKim(a)) - Number(needsKim(b)) || Date.parse(a.ts) - Date.parse(b.ts));
  let executorUnavailable = false;
  const reportOverdue = async row => {
    const text = row.overdueReportText;
    const delivery = await (io.notifyOwner ?? notifyOwner)(ownerOf(row), text,
      { home, now, kind: 'automatic', session: row });
    if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'final report not delivered');
    patch(rowKey(row), { overdueReportedAt: new Date(now).toISOString() });
  };
  // Retry delivery only, never the check or resume, after a transport failure.
  for (const row of rows.filter(r => r.status === 'overdue_reported' && !r.overdueReportedAt)) {
    if (dryRun || notificationsStopped) break;
    try { await reportOverdue(row); } catch (error) { summary.errors.push(`overdue-report: ${error.message}`); }
  }
  // Checks run first, before the potentially lengthy legacy resume lane.
  const executable = [...candidates.filter(row => row.check && !reservation(row)), ...pendingChecks];
  executable.sort((a, b) => (Date.parse(a.lastCheckedAt) || 0) - (Date.parse(b.lastCheckedAt) || 0));
  for (const row of executable) {
    if (notificationsStopped || clock() + 60000 >= stopAt) break;
    if (dryRun) continue; // --dry-run must never execute arbitrary commands.
    summary.checked++;
    try {
      const overdue = now >= Date.parse(row.deadlineAt);
      let state = await checkPromise(row, { home, now, patch, io, suppressNotices: overdue });
      if (overdue && ['unmet', 'error'].includes(state)) {
        const at = new Date(now).toISOString();
        let outcome = { reason: '再開上限・実行時間・作業場所の条件により再開できません' };
        const eligible = !executorUnavailable && summary.resumed < MAX_RESUMES_PER_RUN &&
          (row.resumeCount ?? 0) < MAX_RESUMES && now - (Date.parse(row.resumedAt || '') || 0) >= RESUME_INTERVAL_MS &&
          clock() + 22 * 60000 < stopAt && row.cwd && (io.cwdExists ?? fs.existsSync)(row.cwd) && !isUnattendedRow(row, home);
        if (eligible) {
          if (!patch(rowKey(row), { status: 'resumed', resumedAt: at, resumeCount: (row.resumeCount ?? 0) + 1, resumeOutcome: 'attempting' })) continue;
          try { outcome = await (io.resume ?? resumeSession)(row, { home, reason: 'check-overdue' }); }
          catch (error) { outcome = { outcome: 'error', reason: String(error.message || error) }; }
          if (outcome.deferred || outcome.outcome === 'deferred') {
            executorUnavailable = true;
            summary.resumeDeferred++;
            if (!patch(rowKey(row), { resumedAt: row.resumedAt || '', resumeCount: row.resumeCount ?? 0, resumeDeferredAt: at, resumeOutcome: `deferred: ${outcome.reason}` })) continue;
          } else {
            summary.resumed++;
            if (!patch(rowKey(row), { resumeOutcome: `${outcome.state || outcome.outcome}: ${outcome.reason}`, resumeFinishedAt: new Date(clock()).toISOString(), nextKim: outcome.nextKim ?? row.nextKim })) continue;
            row.nextKim = outcome.nextKim ?? row.nextKim;
            // A resume report alone cannot establish that an explicit check has passed.
            state = await checkPromise(row, { home, now, patch, io, suppressNotices: true });
          }
        }
        if (state !== 'done' && state !== 'ledger_error') {
          const report = `${originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: ownerOf(row), home })}\n最終報告（期限超過・未完了）: ${row.label || row.promise}\n期限切れ（${row.deadlineAt}）\n約束: ${row.promise}\n${checkProgressSummary(row.checkText)}\n再開結果: ${outcome.reason}\n次の一手: ${kimAction(row) !== 'なし' ? `${ownerOf(row)} が ${kimAction(row)}` : pendingAction(row)}`;
          if (!patch(rowKey(row), { status: 'overdue_reported', verdict: 'unmet', overdueClosedAt: at, overdueReportText: redactSecrets(report) })) continue;
          summary.overdueReported++;
          state = 'overdue_reported';
          (io.queueCheckFollowup ?? queueCheckFollowup)(home, row, { text: row.checkText });
          await reportOverdue({ ...row, overdueReportText: redactSecrets(report) });
        }
      }
      if (state === 'time_only') {
        const reservationRow = timeOnlyReservation(row, now);
        if (!dryRun && persist([...readLedger(file), reservationRow])) {
          const text = `誤って達成扱いだった約束を再開しました: ${row.label || row.promise}`;
          (io.stdout ?? console.log)(text);
          await (io.addKimInboxItem ?? addItem)(home, { kind: 'info', source: 'auto-progress-time-only-migration', text,
            dedupeKey: `auto-progress-time-only-migration:${row.sessionId || rowKey(row)}` });
        }
        continue;
      }
      if (state === 'done') summary.done++;
      else if (state === 'unmet') summary.inProgress++;
    } catch (error) { summary.errors.push(`check: ${String(error?.message ?? error).slice(0, 120)}`); }
  }
  for (const row of doneSweep.recent) {
    if (dryRun || notificationsStopped || clock() + 60000 >= stopAt) break;
    await notifyDone(row, row.reason || '', row.doneNotifyArtifact || '');
  }
  if (!dryRun && !notificationsStopped && clock() + 60000 < stopAt) {
    // Never put a kim notice into a staff DM group on a non-kim PC.
    const inboxBacklog = doneSweep.backlog.filter(row => usesKimDoneInbox(row, home));
    const ownerBacklog = doneSweep.backlog.filter(row => !usesKimDoneInbox(row, home));
    const groups = [...formatDoneBacklogMessages(inboxBacklog, { home }), ...formatDoneBacklogMessages(ownerBacklog, { home })];
    for (const group of groups) {
      // Inbox persistence must not depend on DM quiet hours or daily quotas.
      if (usesKimDoneInbox(group.rows[0], home)) {
        let delivery = null;
        try {
          delivery = await deliverDoneInbox(home, group.rows, group.text, { now, io });
          for (const row of group.rows) {
            if (!patch(rowKey(row), { ...delivery.receipt, doneNotifyMode: 'backlog' })) break;
          }
        } catch (error) { summary.errors.push(`notify-done-backlog: ${String(error?.message ?? error).slice(0, 120)}`); }
        logDoneDm(home, group.rows[0], delivery, group.text, now, io);
        if (notificationsStopped) break;
        continue;
      }
      if (isQuietHours(now)) continue;
      let delivery = null;
      try {
        delivery = await (io.notifyOwner ?? notifyOwner)(ownerOf(group.rows[0]), group.text, { home, now, kind: 'automatic' });
        if (!['dm', 'session-inbox', 'toast', 'inbox'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
        for (const row of group.rows) patch(rowKey(row), { doneNotifiedAt: new Date(now).toISOString(), doneNotifyMode: 'backlog', doneNotifyPending: false });
      } catch (error) {
        summary.errors.push(`notify-done-backlog: ${String(error?.message ?? error).slice(0, 120)}`);
      }
      // バックログ完了通知もローカル user にはトーストを出す
      let toastResult = null;
      try {
        const rowOwner = ownerOf(group.rows[0]);
        const pcOwner = io.localOwner ?? (() => { try { return resolveOwner({ home }); } catch { return ''; } })();
        if (delivery?.delivered !== 'toast' && rowOwner && pcOwner && rowOwner.toLowerCase() === pcOwner.toLowerCase()) {
          const toastText = `✅ 自動進行が完了 (ほか ${group.rows.length - 1}件): ${String(group.rows[0].promise ?? '').slice(0, 80)}`;
          (io.sendOwnerToast ?? sendOwnerToast)(toastText, { home, onToastResult: value => { toastResult = value; } });
        }
      } catch { /* トースト失敗は無視 */ }
      logDoneDm(home, group.rows[0], delivery, group.text, now, io, toastResult);
    }
  }
  for (const row of candidates.filter(reservation)) {
    if (dryRun || notificationsStopped || clock() + 22 * 60000 >= stopAt) continue;
    if (row.startedAt || row.status === 'starting') continue; // 起動済みの予約は二重起動しない。
    const key = rowKey(row), at = new Date(now).toISOString();
    try {
      if (now >= Date.parse(row.deadlineAt)) {
        // 期限超過かつ nextKim が空/なし の予約行は再開を試みる
        const nextKimClean = String(row.nextKim ?? '').replace(/^[\s　]+|[\s　]+$/g, '');
        const resumeEligible = (nextKimClean === '' || nextKimClean === 'なし') &&
          !executorUnavailable && summary.resumed < MAX_RESUMES_PER_RUN &&
          (row.resumeCount ?? 0) < MAX_RESUMES &&
          now - (Date.parse(row.resumedAt || '') || 0) >= RESUME_INTERVAL_MS &&
          clock() + 22 * 60000 < stopAt && row.cwd &&
          (io.cwdExists ?? fs.existsSync)(row.cwd) && !isUnattendedRow(row, home);
        if (resumeEligible) {
          const attempt = { status: 'resumed', resumedAt: at, resumeCount: (row.resumeCount ?? 0) + 1, resumeOutcome: 'attempting' };
          if (patch(key, attempt)) {
            let outcome;
            try { outcome = await (io.resume ?? resumeSession)(row, { home, reason: 'start-overdue' }); }
            catch (error) { outcome = { outcome: 'error', reason: String(error.message || error) }; }
            if (outcome.deferred || outcome.outcome === 'deferred') {
              executorUnavailable = true;
              summary.resumeDeferred++;
              patch(key, { resumedAt: row.resumedAt || '', resumeCount: row.resumeCount ?? 0, resumeDeferredAt: at, resumeOutcome: `deferred: ${outcome.reason}` });
            } else {
              summary.resumed++;
              const state = outcome.state || outcome.outcome;
              if (patch(key, { resumeOutcome: `${state}: ${outcome.reason}`, resumeFinishedAt: new Date(clock()).toISOString(), nextKim: outcome.nextKim ?? row.nextKim })) {
                try {
                  await (io.notifyOwner ?? notifyOwner)(ownerOf(row), `期限を過ぎた自動進行を再開しました: ${row.label || row.promise}\n結果: ${outcome.reason}`, { home, now, kind: 'automatic', session: row });
                } catch (error) { summary.errors.push(`start-overdue-notify: ${String(error?.message ?? error).slice(0, 120)}`); }
                continue;
              }
            }
          }
        }
        const result = { text: `開始予約の期限を過ぎても未起動です: ${row.label || row.promise}` };
        if (!patch(key, { status: 'start_overdue', reason: result.text })) continue;
        (io.queueCheckFollowup ?? queueCheckFollowup)(home, row, result);
        if (!row.startOverdueNotifiedAt && !isQuietHours(now) && !isUnattendedRow(row, home)) {
          const delivery = await (io.notifyOwner ?? notifyOwner)(ownerOf(row), `${result.text}\nClaude の次の手: ${row.nextClaude}（next-session.md に起票）`, { home, now, kind: 'automatic', session: row });
          if (['dm', 'toast', 'inbox'].includes(delivery?.delivered)) patch(key, { startOverdueNotifiedAt: at });
        }
        continue;
      }
      // 静穏時間は通知だけを止める。夜間着手の予約が主用途なので、開始は止めない。
      if (row.status !== 'scheduled' || isUnattendedRow(row, home)) continue;
      const result = await (io.executeCheck ?? executeCheck)({ ...row, check: row.startWhen }, { home });
      summary.checked++;
      if (!patch(key, { lastCheckedAt: at, checkResult: result.code === 1 ? 'unmet' : result.code === 0 ? 'ready' : 'error', checkText: result.text })) continue;
      if (result.code !== 0) await reportCheckProgress(home, { ...row, lastCheckedAt: at }, result, { now, patch, io });
      if (result.code !== 0) {
        if (result.code !== 1) summary.errors.push(`start-when: ${result.text}`);
        continue;
      }
      if (summary.resumed >= MAX_RESUMES_PER_RUN || (row.resumeCount ?? 0) >= MAX_RESUMES ||
          now - (Date.parse(row.resumedAt || 0) || 0) < RESUME_INTERVAL_MS ||
          !row.cwd || !(io.cwdExists ?? fs.existsSync)(row.cwd)) continue;
      if (executorUnavailable) {
        summary.resumeDeferred++;
        queueDeferredNotice(row, summary.resumeDeferredReason || '実行者が利用できません');
        continue;
      }
      const attempt = { status: 'starting', startedAt: at, resumedAt: at, resumeCount: (row.resumeCount ?? 0) + 1 };
      if (!patch(key, attempt)) continue;
      let outcome;
      try { outcome = await (io.resume ?? resumeSession)(row, { home, reason: 'scheduled-start' }); }
      catch (error) { outcome = { outcome: 'error', reason: String(error?.message ?? error) }; }
      if (outcome.deferred || outcome.outcome === 'deferred') {
        patch(key, { status: 'scheduled', startedAt: '', resumedAt: row.resumedAt || '', resumeCount: row.resumeCount ?? 0,
          resumeDeferredAt: at, resumeOutcome: `deferred: ${outcome.reason}` });
        executorUnavailable = true;
        summary.resumeDeferred++;
        summary.resumeDeferredReason ??= outcome.reason;
        queueDeferredNotice(row, outcome.reason);
        continue;
      }
      summary.resumed++;
      const state = outcome.state || outcome.outcome;
      const status = state === 'needs_user' ? 'waiting_user' : state === 'done' && !row.check ? 'done' : 'open';
      const current = { ...row, ...attempt, status, reason: outcome.reason, nextKim: outcome.nextKim ?? row.nextKim,
        resumeOutcome: `${state}: ${outcome.reason}`, ...(status === 'done' ? { doneAt: at } : {}) };
      if (!patch(key, current)) continue;
      (io.appendInbox ?? appendInbox)(home, row.sessionId, { at, state: row.check && state === 'done' ? 'progressed' : state, evidence: outcome.reason, artifact: outcome.artifact || '' });
      if (state === 'done' && row.check) {
        if (await checkPromise(current, { home, now, patch, io }) === 'done') summary.done++;
      } else if (status === 'done') {
        summary.done++;
        await notifyDone(current, outcome.reason, outcome.artifact || '');
      } else if (status === 'waiting_user' && kimAction(current) !== 'なし') {
        const delivery = await askKim(current, outcome.reason, outcome.artifact);
        if (['dm', 'toast', 'inbox'].includes(delivery?.delivered)) patch(key, { ownerNotifiedAt: at });
      }
    } catch (error) { summary.errors.push(`scheduled-start: ${String(error?.message ?? error).slice(0, 200)}`); }
  }
  for (const row of candidates.filter(row => !row.check && !reservation(row))) {
    // Reserve time for a 20-minute resume plus classification and reporting.
    if (clock() + 22 * 60000 >= stopAt) break;
    if (isNoopPromise(row.promise)) {
      patch(rowKey(row), { status: 'done', verdict: 'done', doneAt: new Date(now).toISOString(), reason: '自動進行の宣言なし' });
      summary.noop += 1;
      continue;
    }
    const answered = Boolean(row.kimAnswer && !row.resumedAt);
    const recorded = Date.parse(row.ts);
    if (!Number.isFinite(recorded)) continue;
    const unattended = isUnattendedRow(row, home);
    if (row.status === 'waiting_user') {
      if (kimAction(row) !== 'なし' && !unattended && !dryRun && !notificationsStopped && now - (Date.parse(row.ownerNotifiedAt || 0) || 0) >= 24 * 3600 * 1000) {
        try {
          const delivery = await askKim(row, row.reason);
          if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
          patch(rowKey(row), { ownerNotifiedAt: new Date(now).toISOString() });
        } catch (error) { summary.errors.push(`notify-owner: ${String(error?.message ?? error).slice(0, 120)}`); }
      } else if (kimAction(row) === 'なし' && !unattended && !dryRun && !notificationsStopped && now - (Date.parse(row.ownerNotifiedAt || 0) || 0) >= 24 * 3600 * 1000) {
        try {
          const message = `⏳ 待ち状況（自動確認）\n約束: ${String(row.promise || '').slice(0, 160)}\n待っている理由: ${String(row.reason || '').slice(0, 240)}\n最終確認: ${row.lastCheckedAt || '不明'}\nuser の操作は不要です。進展があれば自動で再開します。`;
          const delivery = await (io.notifyOwner ?? notifyOwner)(ownerOf(row), message, { home, now, kind: row.status === 'done' && !isUnattendedRow(row, home) ? 'done-requested' : 'automatic', session: row });
          if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
          patch(rowKey(row), { ownerNotifiedAt: new Date(now).toISOString() });
        } catch (error) { summary.errors.push(`notify-owner: ${String(error?.message ?? error).slice(0, 120)}`); }
      }
      summary.inProgress += 1;
      continue;
    }
    if (!answered && now - recorded < GRACE_MS) { summary.graced += 1; continue; }
    if (!answered && now - recorded >= EXPIRE_MS) { patch(rowKey(row), { status: 'expired' }); summary.expired += 1; continue; }
    summary.checked += 1;
    // Freeze the legacy boundary before lastCheckedAt advances on subsequent polls.
    if (failedResumeEnd(row) && !row.resumeFinishedAt) {
      row.resumeFinishedAt = new Date(failedResumeEnd(row)).toISOString();
      patch(rowKey(row), { resumeFinishedAt: row.resumeFinishedAt });
    }
    const evidence = gatherEvidence(row, home, io);
    let verdict = answered ? { verdict: 'stalled', reason: 'kim の返事を受領' } : judge(row, evidence, now, io);
    if (verdict.verdict === 'done') {
      patch(rowKey(row), { status: 'done', verdict: 'done', doneAt: new Date(now).toISOString(), reason: verdict.reason });
      summary.done += 1;
      if (!unattended && !dryRun && !row.doneNotifiedAt) {
        await notifyDone(row, verdict.reason, '');
      }
      continue;
    }
    if (verdict.verdict === 'in_progress') {
      const changes = { ...(row.status === 'stalled' ? { status: 'open' } : {}), verdict: 'in_progress', lastCheckedAt: new Date(now).toISOString(), reason: verdict.reason };
      if (patch(rowKey(row), changes) !== false && !dryRun && !notificationsStopped) {
        Object.assign(row, changes);
        try { await pushDailyProgress(home, row, { now, patch, io }); }
        catch (error) { summary.errors.push(`daily-progress: ${error.message}`); }
      }
      summary.inProgress += 1; continue;
    }
    summary.stalled += 1;
    patch(rowKey(row), { ...((row.resumeCount ?? 0) >= MAX_RESUMES || verdict.source === 'resume-failed' ? { status: 'stalled' } : {}), verdict: 'stalled', lastCheckedAt: new Date(now).toISOString(), reason: verdict.reason });
    let current = { ...row, ...((row.resumeCount ?? 0) >= MAX_RESUMES || verdict.source === 'resume-failed' ? { status: 'stalled' } : {}), verdict: verdict.verdict, reason: verdict.reason };
    const resumeEligible = !unattended && !dryRun && summary.resumed < MAX_RESUMES_PER_RUN && (answered || (row.resumeCount ?? 0) < MAX_RESUMES) && now - (Date.parse(row.resumedAt || 0) || 0) >= RESUME_INTERVAL_MS
      && row.cwd && (io.cwdExists ?? fs.existsSync)(row.cwd);
    const canResume = resumeEligible && !executorUnavailable;
    if (resumeEligible && executorUnavailable) {
      summary.resumeDeferred += 1;
      queueDeferredNotice(row, summary.resumeDeferredReason || '実行者が利用できません');
    }
    if (canResume) {
      // Persist the attempt before launching: crashes must not allow another same-day resume.
      current = { ...row, status: 'resumed', resumedAt: new Date(now).toISOString(), resumeCount: (row.resumeCount ?? 0) + 1, resumeOutcome: 'attempting' };
      patch(rowKey(row), { status: current.status, resumedAt: current.resumedAt, resumeCount: current.resumeCount, resumeOutcome: current.resumeOutcome });
      let outcome;
      try { outcome = await (io.resume ?? resumeSession)(row, { home }); } catch (error) { outcome = { outcome: 'error', reason: String(error?.message ?? error).slice(0, 200) }; }
      if (outcome.deferred) {
        patch(rowKey(row), { status: row.status, resumedAt: row.resumedAt ?? '', resumeCount: row.resumeCount ?? 0,
          resumeOutcome: failedResume(row) ? row.resumeOutcome : 'deferred: ' + outcome.reason, resumeDeferredAt: new Date(now).toISOString(),
          lastCheckedAt: new Date(now).toISOString(), reason: outcome.reason });
        current = { ...row };
        executorUnavailable = true;
        summary.resumeDeferred += 1;
        summary.resumeDeferredReason ??= outcome.reason;
        queueDeferredNotice(row, outcome.reason);
      } else {
        const state = outcome.state || outcome.outcome;
        const nextKim = outcome.nextKim ?? row.nextKim;
        const status = state === 'done' ? 'done' : state === 'needs_user' ? 'waiting_user' : 'resumed';
        current = { ...row, status, nextKim, resumedAt: new Date(now).toISOString(), resumeCount: (row.resumeCount ?? 0) + 1, resumeOutcome: `${state}: ${outcome.reason}` };
        current.resumeFinishedAt = new Date(clock()).toISOString();
        current.resumeFailureCount = failedResume(current) ? failedResumeCount(row) + 1 : 0;
        const failureVerdict = failedResume(current) ? judge(current, { any: false, lastEvidenceAt: 0 }, now, io) : null;
        if (!failedResume(current)) {
          if (verdict.source === 'resume-failed') verdict = { verdict: state === 'progressed' ? 'in_progress' : state, reason: outcome.reason, source: 'resume' };
          current.reportedKey = '';
        }
        if (failedResume(current) && failureVerdict.source === 'resume-failed') {
          verdict = failureVerdict;
          current.status = 'stalled';
        }
        patch(rowKey(row), { status: current.status, nextKim,
          resumeFinishedAt: current.resumeFinishedAt, resumeFailureCount: current.resumeFailureCount,
          ...(!failedResume(current) ? { reportedKey: '' } : {}),
          verdict: current.status === 'stalled' ? 'stalled' : state, ...(state === 'done' ? { doneAt: new Date(now).toISOString() } : {}), resumedAt: current.resumedAt, resumeCount: current.resumeCount, resumeOutcome: current.resumeOutcome, lastCheckedAt: current.resumeFinishedAt, reason: current.status === 'stalled' ? verdict.reason : outcome.reason });
        (io.appendInbox ?? appendInbox)(home, row.sessionId, { at: new Date(now).toISOString(), state, evidence: outcome.reason, artifact: outcome.artifact || '' });
        if (state === 'done' && !unattended && !dryRun && !row.doneNotifiedAt) {
          await notifyDone(row, outcome.reason, outcome.artifact || '');
        }
        if (state === 'needs_user' && !notificationsStopped && kimAction(current) !== 'なし' && now - (Date.parse(row.ownerNotifiedAt || 0) || 0) >= 24 * 3600 * 1000) {
          try {
            const delivery = await askKim({ ...current, nextKim }, outcome.reason, outcome.artifact);
            if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
            patch(rowKey(row), { ownerNotifiedAt: new Date(now).toISOString() });
          } catch (error) { summary.errors.push(`notify-owner: ${String(error?.message ?? error).slice(0, 120)}`); }
        }
        summary.resumed += 1;
      }
    }
    const reportKey = verdict.source === 'resume-failed' ? 'stalled:resume-failed' : `${verdict.verdict}:${Boolean(current.resumedAt)}:${current.resumeCount ?? 0}${verdict.source === 'resume-exhausted' ? ':resume-exhausted' : ''}`;
    if (config && current.reportedKey !== reportKey && !dryRun) {
      try { await (io.postSheet ?? postSheet)(config, 'auto-progress', { row: sheetRow(current, verdict, evidence, now) }); patch(rowKey(row), { reportedKey: reportKey }); summary.reported += 1; }
      catch (error) { summary.errors.push(`sheet: ${String(error?.message ?? error).slice(0, 120)}`); } // 次回巡回で再送する
    }
  }
  await sendDeferredNotices();
  if (!dryRun) {
    const log = path.join(home, '.claude', 'logs', 'auto-progress-watch.summary.log');
    try {
      (io.mkdirSync ?? fs.mkdirSync)(path.dirname(log), { recursive: true });
      (io.appendFileSync ?? fs.appendFileSync)(log, `${new Date(now).toISOString()} ${JSON.stringify(summary)}\n`);
    } catch (error) { (io.stderr ?? console.error)(`auto-progress-watch: summary log failed: ${error?.message ?? error}`); }
    try {
      if (notificationsStopped) return summary;
      const digest = io.digest ?? (await import('./auto-progress-digest.mjs')).run;
      summary.digest = await digest({ home, now, io: io.digestIo ?? {} });
    } catch (error) { summary.errors.push(`digest: ${String(error?.message ?? error).slice(0, 120)}`); }
  }
  if (!notificationsStopped) {
    try {
      summary.escalation = await (io.escalateKimDecisions ?? escalateKimDecisions)({ home, now, dryRun, io: io.escalationIo ?? {} });
    } catch (error) { summary.errors.push(`escalate: ${String(error?.message ?? error).slice(0, 120)}`); }
  }
  return summary;
}

export function forgiveNoExecutorResumes({ home, now = Date.now(), dryRun = false }) {
  const file = ledgerFile(home);
  const rows = readLedger(file);
  const summary = { rows: 0, restored: 0 };
  for (const row of rows) {
    if (!OPEN_STATUSES.has(row.status) || !(row.resumeCount > 0)) continue;
    const count = readLedger(inboxFile(home, row.sessionId))
      .filter(item => item.state === 'error' && item.evidence === 'failure').length;
    const n = Math.min(count - (row.forgivenNoExecutor ?? 0), row.resumeCount);
    if (n <= 0) continue;
    row.resumeCount -= n;
    row.forgivenNoExecutor = count;
    row.resumeOutcome = 'forgiven: 実行者なしの空振り ' + n + ' 回を取り消し';
    summary.rows += 1;
    summary.restored += n;
  }
  if (!dryRun && summary.rows) writeLedger(file, rows);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  if (argv.includes('--repair-reopened-done')) {
    const result = repairReopenedDoneLedger({ home: process.env.ORGIAST_HOME || os.homedir(), dryRun });
    console.log(JSON.stringify({ repaired: result.repaired.length, sessions: result.repaired.map(row => row.sessionId) }));
    return 0;
  }
  if (argv.includes('--forgive-no-executor')) {
    console.log(JSON.stringify(forgiveNoExecutorResumes({ home: process.env.ORGIAST_HOME || os.homedir(), dryRun })));
    return 0;
  }
  const label = resolveFleetLabel(process.env.ORGIAST_HOME || os.homedir());
  const summary = await run({ dryRun });
  console.log(JSON.stringify({ label, dryRun, ...summary }));
  return 0;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 0; }
}
