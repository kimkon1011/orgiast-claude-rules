#!/usr/bin/env node
// 各PCのローカル台帳から、完了・進行中・停滞/再開・判断待ちを 持ち主の DM へ定期報告する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { notifyOwner, resolveOwner } from './notify-owner.mjs';
import { ledgerFile, readLedger, latestOpenPromises, rowKey, isUnattendedRow, isNoopPromise, MAX_RESUMES } from './auto-progress-ledger.mjs';
export { isUnattendedRow } from './auto-progress-ledger.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { redactSecrets } from './redact-secrets.mjs';

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
    if (isNoopPromise(row.promise)) return false;
    if (row.status === 'done') return Number.isFinite(Date.parse(row.doneAt)) && Date.parse(row.doneAt) > since;
    return active.has(row);
  }).sort((a, b) => rowTime(a) - rowTime(b));
}

export const verdictOf = (row, now = Date.now()) => row.status === 'done' ? 'done' : row.status === 'waiting_user' ? 'waiting_user' : row.status === 'resumed' ? 'resumed' : row.verdict || (row.status === 'stalled' ? 'stalled' : deadlinePassed(row, now) ? 'open/期限超過' : row.lastCheckedAt ? 'in_progress' : 'open');
export const MAX_ITEMS = 10;
export const kimAction = row => {
  const value = String(row.nextKim || '').trim();
  // 「なし / 0件」「なし（…」のように補足付き・途中で切れた「なし」も人の操作は不要として扱う。
  if (/^(?:特に)?(?:なし|無し|ナシ)/.test(value)) return 'なし';
  const action = /^(?:(?:特に)?なし|無し|ナシ|(?:対応(?:は)?)?不要(?:です)?|(?:特に)?ありません|none|n\/a|[-—–－ー―])(?:[（(].*[）)])?[。．]?$/i.test(value) || !value ? 'なし' : value;
  return /^(?:待機|待つ|返事待ち|返信待ち|確認待ち|判断待ち)/.test(action) ? 'なし' : action;
};

export const isHumanActionRequired = (row) => {
  if (row.status === 'done') return false;
  if (kimAction(row) !== 'なし') return true;
  // promise は Claude 自身が進める約束なので語句では判定しない（「判断」等を含むだけで誤って判断待ちになる）。
  // 人の操作が要るのは「次に kim がすること」か、自動再開の結果が needs_user を返した時だけ。
  return /^needs_user\b/.test(String(row.resumeOutcome || '').trim());
};

export function needsDm(row, now = Date.now()) {
  if (isNoopPromise(row.promise)) return false;
  const verdict = verdictOf(row, now);
  return isHumanActionRequired(row) || ['done', 'open/期限超過'].includes(verdict) ||
    (verdict === 'stalled' && Number(row.resumeCount) >= MAX_RESUMES);
}

export function cleanText(text, row = {}) {
  let s = String(text || '');
  // 先頭の定型句
  s = s.replace(/^[-*•\s]*(?:\*\*|__)?(?:この後の自動進行|自動進行|約束)(?:\*\*|__)?[:：\s]*/i, '');
  // バッククォートの中身（コマンド・パス・ファイル名）は消さずに残し、記号のバッククォートだけ外す。
  // 中身を消すと「マージ後に と で同期すれば」のように文へ穴が開く。平易化は送信時の notify-kim 側で行う。
  const kept = [];
  s = s.replace(/`([\s\S]*?)`/g, (_, inner) => { kept.push(inner); return `\u0000K${kept.length - 1}\u0000`; });
  // 英語ステータス名を日本語へ
  s = s.replace(/\bdone\b/gi, '完了');
  s = s.replace(/\bstalled\b/gi, '止まっている');
  s = s.replace(/\bin_progress\b/gi, '進行中');
  s = s.replace(/\bwaiting_user\b/gi, '判断待ち');
  s = s.replace(/\bneeds_user\b/gi, '判断待ち');
  s = s.replace(/\bresumed\b/gi, '再開済み');
  s = s.replace(/\bopen\/期限超過\b/gi, '期限超過');
  s = s.replace(/\bprogressed\b/gi, '進行');
  s = s.replace(/\bblocked\b/gi, '中断');
  s = s.replace(/\bsuperseded\b/gi, '更新');

  if (row.pc) s = s.split(row.pc).join('');
  if (row.sessionId) s = s.split(row.sessionId).join('');

  // ID、UUID、ハッシュ
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '');
  s = s.replace(/\b[0-9a-f]{16,64}\b/gi, '');
  s = s.replace(/\b[0-9a-f]{8,12}\b/gi, '');
  s = s.replace(/\bDESKTOP-[A-Z0-9]+\b/g, '');

  // ファイルパス・ディレクトリパス
  s = s.replace(/[a-zA-Z]:\\[^\s:：()（）「」\r\n]+/g, '');
  s = s.replace(/(?:^|[\s(（])(?:\/[a-zA-Z0-9_.-]+){2,}/g, '');
  s = s.replace(/~\/\.[a-zA-Z0-9_.-]+[^\s:：()（）「」\r\n]*/g, '');

  // コマンド名（node / git 等）は文脈ごと消すと穴が開くので、ここでは削らない。

  // 保護したバッククォートの中身を戻す
  s = s.replace(/\u0000K(\d+)\u0000/g, (_, index) => kept[Number(index)] ?? '');

  // 空白正規化
  s = s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[:：\-–—\s]+/, '').replace(/[:：\-–—\s]+$/, '');
  return s;
}

const projectOf = row => { const name = String(row.cwd || '').split(/[\\/]+/).filter(Boolean).pop(); return name ? `［${name}］` : ''; };
// 1行が長すぎると1通1800字に収まらないので、項目の本文だけを切る（見出し・件数は残す）。
const brief = (text, max) => { const s = String(text || ''); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

// 判断待ちのうち、記録から72時間を超えたものは個別に並べず、末尾に件数だけ出す。
export const WAITING_STALE_MS = 72 * 3600 * 1000;
// 各区分の上限（判断待ち・完了・止まっている・進行中）。1800字に収まる限り最大5件まで個別表示する。
export const CATEGORY_LIMITS = Object.freeze({ waiting: 5, done: 5, stalled: 5, inProgress: 5 });
export const MAX_ITEM_CHARS = 80;
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
export const isStaleWaiting = (row, now = Date.now()) => { const t = rowTsOf(row); return t !== null && now - t > WAITING_STALE_MS; };

export function actionOf(row) {
  const kim = kimAction(row);
  if (kim !== 'なし') return cleanText(kim, row);
  const text = `${row.resumeOutcome || ''} ${row.promise || ''}`.replace(/(?:判断|返信|確認|承認)待ち/g, '');
  const match = text.match(/([^、。\n]*(?:判断|承認|確認して|返信して)[^、。\n]*)/);
  if (match) return cleanText(match[1], row);
  return cleanText(row.resumeOutcome || row.reason || '対応をお願いします', row);
}

export function formatDigest(rows, now = Date.now(), label = '', {
  allRows = rows,
  waitingRows,
  doneRows,
  stalledRows,
  inProgressRows,
  inProgressCount,
  unattended = 0,
  owner = '',
} = {}) {
  const filtered = (allRows || rows || []).filter(row => !isNoopPromise(row.promise));
  if (!filtered.length && !(waitingRows?.length || doneRows?.length || stalledRows?.length || inProgressRows?.length)) return '';

  const waitingAll = waitingRows ? [...waitingRows] : [];
  const done = doneRows ? [...doneRows] : [];
  const stalled = stalledRows ? [...stalledRows] : [];
  let inProgressList = inProgressRows ? [...inProgressRows] : [];
  let inProgress = typeof inProgressCount === 'number' ? inProgressCount : inProgressList.length;

  if (!waitingRows && !doneRows && !stalledRows && !inProgressRows) {
    for (const row of filtered) {
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

  // 判断待ちは、既に閉じた行と72時間より古い行を個別表示から外す。古い分は末尾に件数だけ残す。
  const openWaiting = waitingAll.filter(row => !isClosedRow(row));
  const waiting = openWaiting.filter(row => !isStaleWaiting(row, now));
  const staleWaiting = openWaiting.filter(row => isStaleWaiting(row, now));

  // 進行中は最終判定が新しい順
  const checkedTime = (r) => {
    const t = Date.parse(r.lastCheckedAt || r.resumedAt || r.ts || 0);
    return Number.isFinite(t) ? t : 0;
  };
  const inProgressSorted = [...inProgressList].sort((a, b) => checkedTime(b) - checkedTime(a));

  const pcLabel = label || 'このPC';
  const header = `【${pcLabel} の自動進行】 完了 ${done.length}件・止まっている ${stalled.length}件・あなたの判断待ち ${waiting.length}件`;
  const footerParts = [];
  if (unattended > 0) footerParts.push(`無人処理: ${unattended}件`);
  const footer = footerParts.join(' ／ ');

  let wLimit = Math.min(waiting.length, CATEGORY_LIMITS.waiting);
  let dLimit = Math.min(done.length, CATEGORY_LIMITS.done);
  let sLimit = Math.min(stalled.length, CATEGORY_LIMITS.stalled);
  let pLimit = Math.min(inProgressSorted.length, CATEGORY_LIMITS.inProgress);

  const render = (wL, dL, sL, pL) => {
    const lines = [header];
    // 1. あなたの判断待ち
    for (const row of waiting.slice(0, wL)) {
      const what = cleanText(row.label || row.promise || '約束した作業', row);
      lines.push(itemLine(`・あなたの判断待ち: ${projectOf(row)}`, what, ` — ${actionOf(row)}`));
    }
    if (waiting.length > wL) {
      lines.push(`・あなたの判断待ち: ほか ${waiting.length - wL}件`);
    }
    // 2. 完了（各1行・80字以内）
    for (const row of done.slice(0, dL)) {
      const what = cleanText(row.label || row.promise || '約束した作業', row);
      lines.push(itemLine(`・完了: ${projectOf(row)}`, what));
    }
    if (done.length > dL) {
      lines.push(`・完了: ほか ${done.length - dL}件`);
    }
    // 3. 止まっている（再開したかどうか）
    for (const row of stalled.slice(0, sL)) {
      const what = cleanText(row.label || row.promise || '約束した作業', row);
      const resumed = row.status === 'resumed' || Boolean(row.resumedAt);
      const resumeText = resumed ? '自動再開しました' : '自動再開していません';
      lines.push(itemLine(`・止まっている: ${projectOf(row)}`, what, ` — ${resumeText}`));
    }
    if (stalled.length > sL) {
      lines.push(`・止まっている: ほか ${stalled.length - sL}件`);
    }
    // 4. 進行中（最大5件を名前で出す・並びは最終判定が新しい順）
    for (const row of inProgressSorted.slice(0, pL)) {
      const what = cleanText(row.label || row.promise || '約束した作業', row);
      lines.push(itemLine(`・進行中: ${projectOf(row)}`, what));
    }
    const totalProg = Math.max(inProgress, inProgressSorted.length);
    if (inProgressSorted.length > 0 && totalProg > pL) {
      lines.push(`・進行中: ほか ${totalProg - pL}件`);
    } else if (inProgressSorted.length === 0 && inProgress > 0) {
      lines.push(`・進行中: ${inProgress}件`);
    }

    if (footer) lines.push(footer);
    if (staleWaiting.length) {
      lines.push(`・3日以上前の判断待ち ${staleWaiting.length}件（必要なら次のセッションで整理します）`);
    }
    return lines.join('\n');
  };

  // 1通1800字に収める。字数が足りない時だけ一番多い区分から1件ずつ削り、均等に減らす。
  const tooLong = (text) => text.length > 1800;
  let guard = 200;
  while (tooLong(render(wLimit, dLimit, sLimit, pLimit)) && guard-- > 0) {
    const candidates = [
      { key: 'w', limit: wLimit },
      { key: 'd', limit: dLimit },
      { key: 's', limit: sLimit },
      { key: 'p', limit: pLimit },
    ].sort((a, b) => b.limit - a.limit);
    const target = candidates.find(c => c.limit > 1) || candidates.find(c => c.limit > 0);
    if (!target) break;
    if (target.key === 'w') wLimit--;
    else if (target.key === 'd') dLimit--;
    else if (target.key === 's') sLimit--;
    else pLimit--;
  }
  return render(wLimit, dLimit, sLimit, pLimit);
}

// 枠と日付キーは日本時間で決める。PCやCIのタイムゾーンに左右させると、
// 同じ朝でも実行環境によって「枠外」判定や日付キーがずれる（CI は UTC で動く）。
const JST_OFFSET_MS = 9 * 3600 * 1000;
const jstDate = (now) => new Date(now + JST_OFFSET_MS);

export function slotOf(now = Date.now()) {
  const h = jstDate(now).getUTCHours();
  // 朝枠: 08:00〜11:59 (8, 9, 10, 11)
  if (h >= 8 && h < 12) return '朝';
  // 夕枠: 17:00〜20:59 (17, 18, 19, 20)
  if (h >= 17 && h < 21) return '夕';
  return null;
}

export async function run({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, slot, io = {} } = {}) {
  const label = io.label ?? resolveFleetLabel(home);
  const state = (io.readState ?? readState)(home);

  const currentSlot = slot !== undefined ? slot : slotOf(now);
  const isOutside = !currentSlot;

  const rawLedger = (io.readLedger ?? readLedger)(ledgerFile(home));
  const ledger = Array.isArray(rawLedger) ? rawLedger : [];
  const localOwner = io.localOwner ?? (() => { try { return resolveOwner({ home }); } catch { return ''; } })();
  const ownerOf = row => row.owner || localOwner || '';

  // 前回送信の瞬間に完了した行も「前回以降の変化」に含める（境界は前回送信時刻を含む）。
  const since = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : now - WINDOW_MS;
  const activeRows = selectRows(ledger, now, since - 1).filter(row => !isNoopPromise(row.promise));

  const lastVerdicts = { ...(state.lastVerdicts || {}) };
  const lastKim = { ...(state.lastKim || {}) };
  const lastResumedAt = { ...(state.lastResumedAt || {}) };
  const lastWaiting = { ...(state.lastWaiting || {}) };
  const notifiedUrgentKeys = new Set(state.notifiedUrgentKeys || []);
  const lastSuccessAt = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;

  const waitingRows = [];
  const newlyWaitingRows = [];
  const newlyDoneRows = [];
  const newlyStalledRows = [];
  const newlyResumedRows = [];
  const inProgressRows = [];

  for (const row of activeRows) {
    if (isUnattendedRow(row, home)) continue;
    const key = rowKey(row);
    const v = verdictOf(row, now);
    const isWait = isHumanActionRequired(row);
    const prevVerdict = lastVerdicts[key];
    const prevKim = lastKim[key];
    const prevResumedAt = lastResumedAt[key];
    const prevWait = lastWaiting[key];

    if (row.status === 'done' || v === 'done') {
      const doneAtTime = Date.parse(row.doneAt || 0) || 0;
      if (prevVerdict !== 'done' || (doneAtTime && doneAtTime > lastSuccessAt)) {
        newlyDoneRows.push(row);
      }
    } else if (isWait) {
      waitingRows.push(row);
      // 枠内の「変化」は判断依頼の新規発生・内容変更と、まだ一度も知らせていない項目。
      // 一度配信した項目のキーは notifiedUrgentKeys に入るので、再送にはならない。
      if (!prevWait || prevKim !== kimAction(row) || !notifiedUrgentKeys.has(key)) {
        newlyWaitingRows.push(row);
      }
    } else if (row.status === 'stalled' || v === 'stalled' || (row.status === 'resumed' && Number(row.resumeCount) >= MAX_RESUMES)) {
      if (prevVerdict !== 'stalled') {
        newlyStalledRows.push(row);
      }
    } else if (row.status === 'resumed' || Boolean(row.resumedAt)) {
      if (!prevResumedAt || prevResumedAt !== row.resumedAt) {
        newlyResumedRows.push(row);
      }
    } else {
      inProgressRows.push(row);
    }
  }

  // 枠外の判定: 新たに人の判断・操作が要る項目がある時だけ即時1通
  if (isOutside) {
    const urgentItems = newlyWaitingRows.filter(r => !notifiedUrgentKeys.has(rowKey(r)));
    if (!urgentItems.length) {
      return { skipped: 'outside-slot', sent: false, count: 0 };
    }
  }

  // 重複判定キー
  const dateStr = jstDate(now).toISOString().slice(0, 10);
  const slotKey = currentSlot ? `${dateStr}|${currentSlot}` : null;
  if (slotKey && (state.sentKeys || []).includes(slotKey)) {
    return { skipped: 'already-sent', sent: false, count: 0 };
  }

  // 変化0件なら送らない
  const totalChanges = newlyDoneRows.length + newlyStalledRows.length + newlyResumedRows.length + newlyWaitingRows.length;
  if (!isOutside && totalChanges === 0) {
    return { sent: false, count: 0 };
  }

  // 送信の宛先は「変化のあった行」の持ち主だけ。既知の判断待ちは本文の一覧には載せるが、
  // 宛先の決定には使わない（成功済みの宛先へ再送しないため）。
  const changedRows = [...new Set([...newlyWaitingRows, ...newlyDoneRows, ...newlyStalledRows, ...newlyResumedRows])];
  const groups = new Map();
  for (const row of changedRows) {
    const owner = ownerOf(row);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(row);
  }

  const deliveries = [...groups].map(([owner, rows]) => {
    const owned = activeRows.filter(r => ownerOf(r) === owner);
    const ownedWaiting = waitingRows.filter(r => ownerOf(r) === owner);
    const ownedDone = newlyDoneRows.filter(r => ownerOf(r) === owner);
    const ownedStalled = [...new Set([...newlyStalledRows, ...newlyResumedRows])].filter(r => ownerOf(r) === owner);
    const ownedInProgress = inProgressRows.filter(r => ownerOf(r) === owner);
    const message = formatDigest(rows, now, label, {
      allRows: owned.filter(r => !isUnattendedRow(r, home)),
      waitingRows: ownedWaiting,
      doneRows: ownedDone,
      stalledRows: ownedStalled,
      inProgressRows: ownedInProgress,
      inProgressCount: ownedInProgress.length,
      unattended: owned.filter(r => isUnattendedRow(r, home)).length,
      owner,
    });
    return { owner, rows, message };
  }).filter(d => Boolean(d.message));

  const messages = deliveries.map(d => d.message);
  const text = messages.join('\n');
  const count = changedRows.length;

  if (dryRun) return { sent: false, count, text, messages };

  let error = '';
  for (const { owner, rows, message } of deliveries) {
    let result;
    try {
      result = io.notify ? await io.notify(message, { home, webhookFallback: false, owner }) : await (io.notifyOwner ?? notifyOwner)(owner, message, { home });
    } catch (cause) { result = { reason: cause?.message || String(cause) }; }
    if (result?.delivered !== 'dm') { error = result?.reason || 'DM not delivered'; break; }
    for (const row of rows) {
      const key = rowKey(row);
      lastVerdicts[key] = verdictOf(row, now);
      lastKim[key] = kimAction(row);
      lastWaiting[key] = isHumanActionRequired(row);
      if (row.resumedAt) lastResumedAt[key] = row.resumedAt;
    }
    // 判断待ちは枠内・枠外を問わず、一度知らせた項目を二度送らない（枠外の即時通知は新規のみ）。
    for (const row of waitingRows) {
      if (ownerOf(row) === owner) notifiedUrgentKeys.add(rowKey(row));
    }
    // 部分失敗後の再試行を防止するため各オーナー配信ごとに保存
    (io.writeState ?? writeState)(home, {
      ...state,
      lastVerdicts,
      lastKim,
      lastWaiting,
      lastResumedAt,
      notifiedUrgentKeys: [...notifiedUrgentKeys].slice(-200),
    });
  }

  if (error) {
    appendLog(home, { at: now, label, slot: slotKey || 'urgent', sent: false, count, error }, io);
    appendSentLog(home, { at: now, label, slot: slotKey || 'urgent', sent: false, count, parts: messages.length, text: redactSecrets(text) }, io);
    return { sent: false, count, error };
  }

  // 成功時の状態保存
  for (const row of activeRows) {
    const key = rowKey(row);
    lastVerdicts[key] = verdictOf(row, now);
    lastKim[key] = kimAction(row);
    lastWaiting[key] = isHumanActionRequired(row);
    if (row.resumedAt) lastResumedAt[key] = row.resumedAt;
  }

  const nextSentKeys = slotKey ? [...(state.sentKeys || []), slotKey].slice(-60) : (state.sentKeys || []);
  const next = {
    ...state,
    lastVerdicts,
    lastKim,
    lastWaiting,
    lastResumedAt,
    notifiedUrgentKeys: [...notifiedUrgentKeys].slice(-200),
    lastSuccessAt: new Date(now).toISOString(),
    sentKeys: nextSentKeys,
  };
  (io.writeState ?? writeState)(home, next);
  appendLog(home, { at: now, label, slot: slotKey || 'urgent', sent: true, count, parts: messages.length }, io);
  appendSentLog(home, { at: now, label, slot: slotKey || 'urgent', sent: true, count, parts: messages.length, text: redactSecrets(text) }, io);
  return { sent: true, count, parts: messages.length };
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await run({ dryRun: process.argv.includes('--dry-run') }))); }
  catch (error) { console.error(String(error?.message ?? error)); }
  process.exitCode = 0;
}
