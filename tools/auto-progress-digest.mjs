#!/usr/bin/env node
import { readDigest as readDeadlineDigest } from './deadline-watch.mjs';
import { addItem as addDeadlineDigest, listItems as listKimInboxItems, markSeen as markKimInboxSeen } from './kim-inbox.mjs';
// kim 宛の朝のまとめは kim-inbox、他メンバー宛の配送は従来どおり。
// 各PCのローカル台帳から、完了・進行中・停滞/再開・判断待ちを 持ち主の DM へ定期報告する。
import fs from 'node:fs';
import { readDeferred } from './lib/owner-dm-policy.mjs';
import { compactDigest, kimAction, isHumanActionRequired, cleanText } from './lib/owner-dm-digest.mjs';
export { compactDigest, kimAction, isHumanActionRequired, cleanText } from './lib/owner-dm-digest.mjs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from './lib/progress-file-lock.mjs';
import { isEntry } from './is-entry.mjs';
import { notifyOwner, resolveOwner } from './notify-owner.mjs';
import { ledgerFile, readLedger, latestOpenPromises, rowKey, isUnattendedRow, isNoopPromise, MAX_RESUMES } from './auto-progress-ledger.mjs';
export { isUnattendedRow } from './auto-progress-ledger.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { collectCaseProgress } from './case-progress-digest.mjs';
import { checkProgressSummary } from './auto-progress-check.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { decisionOwnerOf, isChoiceFormat } from './auto-progress-decision-owner.mjs';

export const WINDOW_MS = 24 * 3600 * 1000;
const stateFile = (home) => path.join(home, '.claude', 'state', 'auto-progress-digest.json');
const logFile = (home) => path.join(home, '.claude', 'logs', 'auto-progress-digest.summary.log');
const sentLogFile = (home) => path.join(home, '.claude', 'logs', 'auto-progress-digest.sent.jsonl');

function readState(home) { try { const v = JSON.parse(fs.readFileSync(stateFile(home), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function writeState(home, value) { const file = stateFile(home); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value)}\n`); }
function appendLog(home, value, io = {}) {
  try { const file = logFile(home); (io.mkdirSync ?? fs.mkdirSync)(path.dirname(file), { recursive: true }); (io.appendFileSync ?? fs.appendFileSync)(file, `${new Date(value.at).toISOString()} ${JSON.stringify(value)}\n`); }
  catch (error) { (io.stderr ?? console.error)(`auto-progress-digest: summary log failed: ${error?.message ?? error}`); }
}
function appendSentLog(home, value, io = {}) {
  try {
    const file = sentLogFile(home);
    // at はエポックmsでも ISO 文字列でも受け、記録は ISO に揃える（届いた内容を後から検証するため）。
    const at = Number.isFinite(value?.at) ? new Date(value.at).toISOString() : value?.at;
    (io.mkdirSync ?? fs.mkdirSync)(path.dirname(file), { recursive: true });
    (io.appendFileSync ?? fs.appendFileSync)(file, `${JSON.stringify({ ...value, at })}\n`);
  }
  catch (error) { (io.stderr ?? console.error)(`auto-progress-digest: sent log failed: ${error?.message ?? error}`); }
}

const rowTime = (row) => Date.parse(row.doneAt || row.lastCheckedAt || row.resumedAt || row.ts);
function deadlinePassed(row, now) {
  const explicit = Date.parse(row.deadlineAt || row.dueAt || '');
  if (Number.isFinite(explicit)) return explicit <= now;
  const match = String(row.promise || '').match(/20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?/);
  if (!match) return false;
  const parsed = Date.parse(match[0].replaceAll('/', '-'));
  return Number.isFinite(parsed) && parsed <= now;
}

export function selectRows(rows, now = Date.now(), since = now - WINDOW_MS) {
  const ledger = Array.isArray(rows) ? rows : [];
  const active = new Set(latestOpenPromises(ledger));
  return ledger.filter((row) => {
    if (row.kimAnswer || isNoopPromise(row.promise)) return false;
    if (row.status === 'done') return !row.doneNotifiedAt && Number.isFinite(Date.parse(row.doneAt)) && Date.parse(row.doneAt) > since;
    return active.has(row);
  }).sort((a, b) => rowTime(a) - rowTime(b));
}

export const verdictOf = (row, now = Date.now()) => row.status === 'done' ? 'done' : row.status === 'waiting_user' ? 'waiting_user' : row.status === 'resumed' ? 'resumed' : row.verdict || (row.status === 'stalled' ? 'stalled' : deadlinePassed(row, now) ? 'open/期限超過' : row.lastCheckedAt ? 'in_progress' : 'open');
export const MAX_ITEMS = 10;

export function needsDm(row, now = Date.now()) {
  if (row.kimAnswer || isNoopPromise(row.promise)) return false;
  const verdict = verdictOf(row, now);
  return isHumanActionRequired(row) || ['done', 'open/期限超過'].includes(verdict) ||
    (verdict === 'stalled' && (Number(row.resumeCount) >= MAX_RESUMES ||
      (/^(?:error|timeout|blocked)\b/i.test(String(row.resumeOutcome || '')) && Number(row.resumeFailureCount ?? row.resumeCount) >= 2)));
}


const projectOf = row => { const name = String(row.cwd || '').split(/[\\/]+/).filter(Boolean).pop(); return name ? `［${name}］` : ''; };
// 1行が長すぎると1通1800字に収まらないので、項目の本文だけを切る（見出し・件数は残す）。
const brief = (text, max) => { const s = String(text || ''); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export const MAX_ITEM_CHARS = 80;
// 旧formatDigest/chunkMessage互換APIの上限。実配達run()はcompactDigestでownerごとに1通へ要約する。
export const MESSAGE_MAX = 1800;
// 分割DMの続きマーカー（（進捗DM 続き 12/12）等）が付いても上限を超えないように、分割は余裕を見て行う。
export const PART_MARKER_MAX = 24;
export const PART_CHUNK_MAX = MESSAGE_MAX - PART_MARKER_MAX;

// 改行境界で分割し、各断片を max 字以内に収める。行自体が max を超える時だけ強制分割する。
export function chunkMessage(text, max = PART_CHUNK_MAX) {
  const parts = [];
  let current = '';
  for (let line of String(text || '').split('\n')) {
    while (line.length > max) {
      if (current) { parts.push(current); current = ''; }
      parts.push(line.slice(0, max));
      line = line.slice(max);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > max) { parts.push(current); current = line; }
    else current = candidate;
  }
  if (current) parts.push(current);
  return parts.filter(Boolean);
}
// 80字を超える行は、末尾の「きみがすること」を残して説明側を縮める（行動が切れて伝わらないのを防ぐ）。
const itemLine = (head, what, tail = '') => {
  const full = `${head}${what}${tail}`;
  if (full.length <= MAX_ITEM_CHARS) return full;
  const room = MAX_ITEM_CHARS - head.length - tail.length - 1;
  if (tail && room >= 8) return `${head}${brief(what, room)}${tail}`;
  return brief(full, MAX_ITEM_CHARS);
};

const rowTsOf = (row) => { const t = Date.parse(row?.ts || ''); return Number.isFinite(t) ? t : null; };
export const isClosedRow = row => row?.status === 'done' || row?.status === 'superseded';

export function actionOf(row) {
  const kim = kimAction(row);
  if (kim !== 'なし') return cleanText(kim, row);
  const text = `${row.resumeOutcome || ''} ${row.promise || ''}`.replace(/(?:判断|返信|確認|承認)待ち/g, '');
  const match = text.match(/([^、。\n]*(?:判断|承認|確認して|返信して)[^、。\n]*)/);
  if (match) return cleanText(match[1], row);
  return cleanText(row.resumeOutcome || row.reason || '対応をお願いします', row);
}

// 同じ作業場所と許可事項だけをまとめ、識別子や言い回しの違いを吸収する。
export function digestGroupKey(row, kind) {
  const cwd = String(row.cwd || '').replaceAll('\\', '/').replace(/^\/mnt\/([a-z])\//i, '$1:/').replace(/\/+$/, '').toLowerCase();
  if (!cwd) return rowKey(row);
  const text = String(kind === 'waiting' ? actionOf(row) : row.promise || '').toLowerCase()
    .replace(/`[^`]*`/g, '').replace(/\b[0-9a-f]{7,}\b/g, '')
    .replace(/\b(?!push\/pr\b)[a-z0-9_.-]+\/[a-z0-9_./-]+/g, '');
  const tags = [
    ['push', /push/], ['pr', /\bpr\b|pull request|プルリク/], ['merge', /merge|マージ/],
    ['curl', /curl/], ['token', /token|トークン/], ['write', /書き込み/],
    ['delete', /削除/], ['exec', /実行/],
  ].filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag).sort();
  return `${cwd}|${tags.length ? tags.join(',') : text.replace(/[\p{N}\p{P}\p{S}\s]/gu, '')}`;
}

function digestGroups(rows, kind) {
  const groups = new Map();
  for (const row of rows) {
    // 作業場所がない行は、同一キーでも独立した項目として残す。
    const key = row.cwd ? digestGroupKey(row, kind) : Symbol();
    const group = groups.get(key);
    if (!group) groups.set(key, { row, count: 1 });
    else {
      group.count++;
      if ((rowTsOf(row) ?? -Infinity) > (rowTsOf(group.row) ?? -Infinity)) group.row = row;
    }
  }
  return [...groups.values()];
}
const groupTail = count => count > 1 ? `（同じ内容 ×${count}）` : '';

export function formatDigest(rows, now = Date.now(), label = '', {
  allRows = rows,
  waitingRows,
  doneRows,
  stalledRows,
  inProgressRows,
  inProgressCount,
  unattended = 0,
  owner = '',
  nightWaitingKeys = new Set(),
} = {}) {
  const filtered = (allRows || rows || []).filter(row => !row.kimAnswer && !isNoopPromise(row.promise));
  if (!filtered.length && !(waitingRows?.length || doneRows?.length || stalledRows?.length || inProgressRows?.length)) return '';

  const scheduled = filtered.filter(row => ['scheduled', 'start_overdue'].includes(row.status));
  const waitingAll = waitingRows ? [...waitingRows] : [];
  const done = doneRows ? [...doneRows] : [];
  let stalled = stalledRows ? [...stalledRows] : [];
  let inProgressList = inProgressRows ? [...inProgressRows] : [];
  let inProgress = typeof inProgressCount === 'number' ? inProgressCount : inProgressList.length;

  if (!waitingRows && !doneRows && !stalledRows && !inProgressRows) {
    for (const row of filtered) {
      if (scheduled.includes(row)) continue;
      if (row.status === 'done' || verdictOf(row, now) === 'done') {
        done.push(row);
      } else if (isHumanActionRequired(row)) {
        waitingAll.push(row);
      } else if (row.status === 'stalled' || verdictOf(row, now) === 'stalled' || (row.status === 'resumed' && Number(row.resumeCount) >= MAX_RESUMES)) {
        stalled.push(row);
      } else if (row.status === 'resumed' || Boolean(row.resumedAt)) {
        stalled.push(row);
      } else {
        inProgressList.push(row);
      }
    }
    inProgress = inProgressList.length;
  }

  // 判断待ちは既に閉じた行だけ外し、古い行も含めて全件を名前つきで出す（件数だけにしない）。
  const activeWaiting = waitingAll.filter(row => !isClosedRow(row));
  const waiting = digestGroups(activeWaiting.filter(row => decisionOwnerOf(row) === 'owner'), 'waiting');
  const kimWaiting = digestGroups(activeWaiting.filter(row => decisionOwnerOf(row) === 'kim'), 'waiting');
  stalled = digestGroups(stalled, 'stalled');

  // 進行中は最終判定が新しい順
  const checkedTime = (r) => {
    const t = Date.parse(r.lastCheckedAt || r.resumedAt || r.ts || 0);
    return Number.isFinite(t) ? t : 0;
  };
  const inProgressSorted = inProgressList.filter(row => !scheduled.includes(row)).sort((a, b) => checkedTime(b) - checkedTime(a));

  const pcLabel = label || 'このPC';
  const header = `【${pcLabel} の自動進行】 完了 ${done.length}件・止まっている ${stalled.length}件・あなたの判断待ち ${waiting.length}件・kim の判断待ち ${kimWaiting.length}件`;
  const footerParts = [];
  if (unattended > 0) footerParts.push(`無人処理: ${unattended}件`);
  const footer = footerParts.join(' ／ ');

  // 旧フォーマッタの互換出力。実配達run()ではこの本文を使わずcompactDigestで要約する。
  const render = () => {
    const lines = [header];
    for (const row of scheduled) {
      lines.push(itemLine(`・開始予約${row.status === 'start_overdue' ? '（期限超過）' : ''}: `,
        cleanText(row.label || row.promise, row), `（開始条件の最終確認 ${row.lastCheckedAt || '未確認'}）`));
    }
    // 判断内容を先に出す。従来の80字制限では依頼本文が切れるため別枠で表示する。
    for (const [groups, heading] of [[waiting, 'あなたの判断待ち'], [kimWaiting, 'kim の判断待ち（あなたの操作は不要）']]) {
      for (const { row, count } of groups) {
        const action = String(row.nextKim || '').trim();
        const warning = isChoiceFormat(action) ? '⚠ 選択肢形式（Claude が推奨案で決めるべき内容） ' : '';
        const night = nightWaitingKeys.has(waitingNotificationKey(row)) ? '夜間に出た判断待ち: ' : '';
        if (heading === 'あなたの判断待ち') {
          // 判断の中身（nextKim）を必ず全文に近い形で出す。約束は短くして、改行の次行に判断内容を置く。
          const shortPromise = cleanText(String(row.label || row.promise || '約束した作業').slice(0, 60), row);
          const wanted = cleanText(String(action || row.reason || row.promise || '対応をお願いします').slice(0, 400), row);
          lines.push(`・${heading}: ${night}${projectOf(row)}${warning}${shortPromise}${groupTail(count)}`);
          lines.push(`  → 判断してほしいこと: ${wanted}`);
          continue;
        }
        const what = action ? cleanText(action.slice(0, 120), row) : cleanText(row.promise || '約束した作業', row);
        const promise = action ? `（約束: ${cleanText(String(row.promise || '').slice(0, 40), row)}）` : '';
        lines.push(`・${heading}: ${night}${projectOf(row)}${warning}${what}${promise}${groupTail(count)}`);
      }
    }
    // 2. 完了（各1行・80字以内）
    for (const row of done) {
      const what = cleanText(row.label || row.promise || '約束した作業', row);
      lines.push(itemLine(`・完了: ${projectOf(row)}`, what));
    }
    // 3. 止まっている（再開したかどうか）
    for (const { row, count } of stalled) {
      const what = cleanText(row.label || row.promise || '約束した作業', row);
      const resumed = row.status === 'resumed' || Boolean(row.resumedAt);
      const resumeText = resumed ? '自動再開しました' : '自動再開していません';
      lines.push(itemLine(`・止まっている: ${projectOf(row)}`, what, ` — ${resumeText}${groupTail(count)}`));
    }
    // 4. 進行中（並びは最終判定が新しい順）
    for (const row of inProgressSorted) {
      const what = cleanText(row.label || row.promise || '約束した作業', row);
      const state = cleanText(String(row.checkText || '').trim().split(/\r?\n/).at(-1) || row.reason || '状態未確認', row);
      lines.push(itemLine(`・進行中: ${projectOf(row)}`, what, ` — ${brief(state, 40)}`));
    }
    const totalProg = Math.max(inProgress, inProgressSorted.length);
    if (inProgressSorted.length === 0 && inProgress > 0) {
      lines.push(`・進行中: ${inProgress}件`);
    }

    if (footer) lines.push(footer);
    return lines.join('\n');
  };

  return render();
}

// 枠と日付キーは日本時間で決める。PCやCIのタイムゾーンに左右させると、
// 同じ朝でも実行環境によって「枠外」判定や日付キーがずれる（CI は UTC で動く）。
const JST_OFFSET_MS = 9 * 3600 * 1000;
const jstDate = (now) => new Date(now + JST_OFFSET_MS);

export const waitingNotificationKey = row => JSON.stringify([
  String(row?.sessionId || '').trim(),
  String(row?.promise || '').trim().replace(/\s+/g, ' '),
]);

export function isQuietHours(now = Date.now()) {
  const h = jstDate(now).getUTCHours();
  return h >= 21 || h < 8;
}

export function slotOf(now = Date.now()) {
  const h = jstDate(now).getUTCHours();
  // 朝枠: 08:00〜11:59 (8, 9, 10, 11)
  if (h >= 8 && h < 12) return '朝';
  // 夕枠: 17:00〜20:59 (17, 18, 19, 20)
  if (h >= 17 && h < 21) return '夕';
  return null;
}

export async function run({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, slot, io = {} } = {}) {
  const currentSlot = slot === undefined ? slotOf(now) : slot;
  if (!currentSlot) return { sent: false, count: 0, skipped: 'outside-slot' };
  const release = dryRun ? () => {} : acquireLock(path.join(home, '.claude/state/owner-compact-digest.lock'));
  if (!release) return { sent: false, count: 0, skipped: 'locked' };
  try {
    let state = (io.readState ?? readState)(home);
    const key = `${jstDate(now).toISOString().slice(0, 10)}|${currentSlot}`;
    if ((state.sentKeys || []).includes(key)) return { sent: false, count: 0, skipped: 'already-sent' };
    const localOwner = io.localOwner ?? resolveOwner({ home });
    const label = io.label ?? resolveFleetLabel(home);
    const consumed = new Set(state.deferredConsumed || []);
    const pending = readDeferred(home).filter(r => !consumed.has(r.id));
    const rows = selectRows((io.readLedger ?? readLedger)(ledgerFile(home)), now, state.lastSuccessAt ? Date.parse(state.lastSuccessAt) - 1 : now - WINDOW_MS)
      .filter(row => row.status !== 'done' || state.lastVerdicts?.[rowKey(row)] !== 'done');
    const cases = label === 'kim-PC' ? await collectCaseProgress({ home, now, previous: state.caseProgress, fetchResume: io.fetchCaseResume, dryRun }) : { text: '', checkpoints: {} };
    let deadlineText = '';
    if (currentSlot === '朝' && localOwner === 'kim@orgiast.jp') {
      try { deadlineText = await (io.readDeadlineDigest || readDeadlineDigest)({ home, today: new Date(now + 9 * 3600000).toISOString().slice(0, 10) }); }
      catch (e) { deadlineText = '今週の期限\n期限台帳を取得できません。再試行が必要です。'; (io.stderr || console.error)(`deadline digest: ${e.message}`); }
    }
        const inboxSince = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : now - WINDOW_MS;
    const doneInbox = (io.listKimInboxItems ?? listKimInboxItems)(home, { status: 'open' }).filter(item =>
      item.source === 'auto-progress-done' && (Date.parse(item.createdAt || item.lastAt) || 0) > inboxSince);
    // kim の通常台帳も許可済み progress-digest 経路へ push する。会話開始待ちに戻さない。
    if (label === 'kim-PC' && localOwner === 'kim@orgiast.jp' && !cases.text && !pending.length && !doneInbox.length && !deadlineText && !rows.some(row => row.check && Date.parse(row.deadlineAt) - now >= 12 * 3600000)) return { sent: false, count: 0, skipped: 'session-context-only' };
    const groups = new Map();
    const group = owner => { const key = String(owner || localOwner).trim().toLowerCase(); if (!groups.has(key)) groups.set(key, { rows: [], pending: [], inbox: [] }); return groups.get(key); };
    for (const row of rows) group(row.owner).rows.push(row);
    for (const row of pending) group(row.owner).pending.push(row);
    for (const item of doneInbox) group(localOwner).inbox.push(item);
    if (cases.text || deadlineText) group(localOwner);
    const changed = rows.some(row => state.lastVerdicts?.[rowKey(row)] !== verdictOf(row, now) || state.lastKim?.[rowKey(row)] !== kimAction(row) || state.lastWaiting?.[rowKey(row)] !== isHumanActionRequired(row));
    if (currentSlot === '夕' && !changed && !pending.length && !doneInbox.length && !cases.text) return { sent: false, count: 0 };
    const count = rows.length + pending.length + doneInbox.length + Object.keys(cases.checkpoints).length;
    if (!groups.size) return { sent: false, count: 0 };
    const deliveredOwners = new Set(state.slotOwners?.[key] || []);
    const receipts = [], messages = [];
    let error;
    for (const [owner, items] of groups) {
      if (deliveredOwners.has(owner)) continue;
      const ownerCases = owner === String(localOwner).toLowerCase() ? cases : { text: '', checkpoints: {} };
      const digest = compactDigest(items.rows, items.pending, now, { home, owner });
      // 案件ID・更新席・生のハブ本文は外に出さず件数だけをまとめる。
      const caseCount = Object.keys(ownerCases.checkpoints).length;
      const caseUnchanged = caseCount && Object.entries(ownerCases.checkpoints).every(([id, cp]) => state.caseProgress?.[id]?.fingerprint === cp.fingerprint);
      const deadlinePrefix = owner === 'kim@orgiast.jp' && deadlineText ? deadlineText + '\n\n' : '';
      const longChecks = items.rows.filter(row => row.check && Date.parse(row.deadlineAt) - now >= 12 * 3600000 && !['done', 'overdue_reported'].includes(row.status));
      const dailyChecks = currentSlot === '朝' && state.checkSummaryDays?.[owner] !== key.split('|')[0] ? longChecks : [];
      // 見出し「【進捗まとめ】\n」は Discord 許可リストの照合対象なので形を変えない。
      const progressText = dailyChecks.length ? '日次進捗\n' + dailyChecks.map(row => `${row.label || row.promise}\n${checkProgressSummary(row.checkText || 'まだ確認結果がありません')}`).join('\n') + '\n' : '';
      const text = redactSecrets(deadlinePrefix + `【進捗まとめ】\n${progressText}${digest.text}${ownerCases.text ? `（案件 ${caseCount}件${caseUnchanged ? '・変化なし' : ''}）` : ''}`);
      messages.push(text);
      if (dryRun) continue;
      const options = { home, now, owner, kind: 'digest', source: 'auto-progress-digest', webhookFallback: false };
      let result;
      try {
        if (io.notify) result = await io.notify(text, options);
        else result = await (io.notifyOwner ?? notifyOwner)(owner, text, options);
      }
      catch (e) { result = { delivered: 'none', reason: String(e?.message || e) }; }
      const ok = ['dm', 'session-inbox', 'spooled', 'toast', 'inbox'].includes(result?.delivered);
      receipts.push({ owner, ...result, channel: result?.channel || result?.delivered, recipientId: result?.recipientId ?? result?.userId ?? null, messageId: result?.messageId ?? null, httpStatus: result?.httpStatus ?? result?.status ?? null });
      if (!ok) { error ||= result?.reason || 'DM not delivered'; continue; }
      deliveredOwners.add(owner);
      for (const row of items.pending) if (row.kind !== 'action' || digest.includedIds.includes(row.id)) consumed.add(row.id);
      const lastVerdicts = { ...state.lastVerdicts }, lastKim = { ...state.lastKim }, lastWaiting = { ...state.lastWaiting };
      for (const row of items.rows) { lastVerdicts[rowKey(row)] = verdictOf(row, now); lastKim[rowKey(row)] = kimAction(row); lastWaiting[rowKey(row)] = isHumanActionRequired(row); }
      state = { ...state, ...(dailyChecks.length ? { checkSummaryDays: { ...state.checkSummaryDays, [owner]: key.split('|')[0] } } : {}), lastVerdicts, lastKim, lastWaiting, slotOwners: { ...state.slotOwners, [key]: [...deliveredOwners] }, deferredConsumed: [...consumed], ...(ownerCases.text ? { caseProgress: { ...state.caseProgress, ...ownerCases.checkpoints } } : {}) };
      (io.writeState ?? writeState)(home, state);
    }
    if (dryRun) return { sent: false, count, text: messages.join('\n'), messages };
    const sent = !error;
    const entry = { at: now, slot: key, sent, count, parts: messages.length, text: messages.join('\n'), receipts, ...(error ? { error } : {}) };
    appendSentLog(home, entry, io);
    appendLog(home, entry, io);
    if (!sent) return { sent: false, count, error };
    (io.writeState ?? writeState)(home, { ...state, sentKeys: [...(state.sentKeys || []), key].slice(-60), lastSuccessAt: new Date(now).toISOString() });
    return { sent: true, count, parts: messages.length };
  } finally { release(); }
}

// kim-PC のセッション文脈専用。既存の定時通知とは状態を分離する。
export function sessionDigest({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, io = {} } = {}) {
  if ((io.label ?? resolveFleetLabel(home)) !== 'kim-PC') return '';
  const file = path.join(home, '.claude/state/auto-progress-session-digest.json');
  const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const release = dryRun ? () => {} : acquireLock(file + '.lock');
  if (!release) return '';
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!dryRun && state.day === day) return '';
    const rows = (io.readLedger ?? readLedger)(ledgerFile(home));
    const latest = new Map();
    for (const row of rows) {
      const key = row.sessionId || rowKey(row);
      const previous = latest.get(key);
      if (!previous || (Date.parse(row.ts) || 0) >= (Date.parse(previous.ts) || 0)) latest.set(key, row);
    }
    const previous = state.signatures || {};
    const selected = [];
    for (const [key, row] of latest) {
      if (row.owner && row.owner.toLowerCase() !== 'kim@orgiast.jp') continue;
      if (!['open', 'stalled', 'resumed', 'waiting_user'].includes(row.status) || isNoopPromise(row.promise)) continue;
      const due = Date.parse(row.deadlineAt || row.dueAt || '');
      const signature = JSON.stringify([row.status, row.verdict, row.nextKim, row.nextClaude, row.resumeOutcome]);
      const changed = previous[key] ? previous[key] !== signature : now - rowTime(row) <= WINDOW_MS;
      if (!(due <= now + WINDOW_MS) && !changed) continue;
      const stage = due <= now ? '期限超過' : due <= now + WINDOW_MS ? '期限間近' : row.status === 'waiting_user' ? '判断待ち' : row.status === 'stalled' ? '停止中' : row.status === 'resumed' ? '再開済み' : '進行中';
      const rawNext = String(row.nextClaude || '達成状況を確認する');
      const nextClaude = /--prompt-file/.test(rawNext) ? '指示書に沿って実装・テストを進め、PR の結果を報告する' : rawNext.replace(/(?:DM|Discord)(?:で|に)/gi, 'このセッションで');
      const who = kimAction(row) !== 'なし' ? `kim が ${kimAction(row)}` : `Claude が ${nextClaude}`;
      const oneLine = value => { const text = redactSecrets(String(value || '')).replace(/\s+/g, ' '); return text.length > 130 ? text.slice(0, 129) + '…' : text; };
      const verdict = ({check_error:'確認処理エラー',unmet:'未達',in_progress:'進行中',needs_user:'判断待ち'})[row.verdict] || row.verdict;
      selected.push({ key, signature, priority: due <= now ? 0 : due <= now + WINDOW_MS ? 1 : 2, due: Number.isFinite(due) ? due : Infinity,
        text: `・${oneLine(row.label || row.promise || '作業')}：${stage}${row.verdict && !['open','stalled'].includes(row.verdict) ? `（${oneLine(verdict)}）` : ''}。次: ${oneLine(who)}` });
    }
    const top = selected.sort((a, b) => a.priority - b.priority || a.due - b.due || a.key.localeCompare(b.key)).slice(0, 5);
    if (!top.length) return '';
    if (!dryRun) {
      const next = { day, signatures: { ...previous, ...Object.fromEntries(top.map(x => [x.key, x.signature])) } };
      const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(next) + '\n'); fs.renameSync(temp, file);
    }
    return top.map(x => x.text).join('\n');
  } finally { release(); }
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await run({ dryRun: process.argv.includes('--dry-run') }))); }
  catch (error) { console.error(String(error?.message ?? error)); }
  process.exitCode = 0;
}
