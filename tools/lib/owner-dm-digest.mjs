import { isKimHumanProgress } from './human-progress-row.mjs';
import { checkProgressSummary } from './check-progress-summary.mjs';
import { decisionOwnerOf } from '../auto-progress-decision-owner.mjs';
import { notificationKind } from './owner-dm-policy.mjs';
const day = 86400000;
// まとめの1行を作る。2026-11-04 nishi: 届いたまとめが「【kimko-PC（）・… の Claude Code】（このDMに返信してください）」
// 「新しいセッションが で引き継ぎ」「10 に成約率」と穴だらけで、結局「進捗どう？」と聞くしかなかった。
// - 出どころの見出し行（【…の Claude Code】プロジェクト: … ／ 作業ID: …）は改行を潰す前に行ごと外す。
//   以前は cleanText で改行を潰してから「プロジェクト:〜行末」を消していたため、後ろの質問文まで消えていた。
// - パスは「C:\…」「~/…」「/a/b…」だけを外し、`/session-start` のような1段の語や 10/28 の日付は残す。
// - 社内用語は消さずに言い換える（消すと文に穴が開く）。
const JARGON = { autopilot: '自動ループ', headless: '無人実行', 'quota-sweep': '定期処理', 'nightly-repo': '共通ツール', unattended: '無人' };
const plain = value => cleanText(String(value || '').split(/\r?\n/).filter(line => !/^\s*【[^】]*Claude Code】/.test(line) && !/^\s*(?:作業ID|セッションの目的|プロジェクト)[:：]/.test(line)).join('\n'))
  .replace(/(?<![\w/])(?:[A-Za-z]:\\|~\/|\/[\w.-]+\/)[^\s、。]+/g, '')
  .replace(/\b(autopilot|headless|quota-sweep|nightly-repo|unattended)\b/gi, word => JARGON[word.toLowerCase()])
  .replace(/\s+/g, ' ').trim();
export function compactDigest(rows, deferred, now, { home, owner = '' } = {}) {
  const actions = deferred.filter(r => r.kind === 'action');
  for (const row of rows) if (isHumanActionRequired(row)) {
    const kimWaiting = decisionOwnerOf(row) === 'kim' && owner.toLowerCase() !== 'kim@orgiast.jp';
    const action = kimAction(row);
    if (kimWaiting) {
      actions.push({ text: `kim の判断待ち: ${plain(row.label || row.promise).slice(0, 60)}`, reply: false, at: row.changedAt || row.ts });
      continue;
    }
    // 判断待ちだけは「何に答えるのか」を隠さない。約束は60字に縮め、判断内容（nextKim）は
    // 改行して最大400字まで全文を出す。従来は約束側の60字で切れてOKの対象が分からなかった。
    const shortPromise = plain(row.label || row.promise).slice(0, 60);
    const wanted = plain(String(row.nextKim || '').trim() || String(row.reason || '').trim() || (action === 'なし' ? '' : action)).slice(0, 400);
    actions.push({ text: shortPromise, detail: wanted, reply: true, at: row.changedAt || row.ts });
  }
  const byText = new Map();
  for (const action of actions) {
    const previous = byText.get(action.text);
    if (!previous || Date.parse(action.at) < Date.parse(previous.at)) byText.set(action.text, { ...action });
    if (action.reason === 'daily-limit') byText.get(action.text).reason = 'daily-limit';
  }
  const unique = [...byText.values()];
  const old = unique.filter(a => a.reason !== 'daily-limit' && now - Date.parse(a.changedAt || a.at) >= 7 * day);
  const recent = unique.filter(a => !old.includes(a)).sort((a, b) => Number(b.reason === 'daily-limit') - Number(a.reason === 'daily-limit'));
  const lines = ['あなたの返事待ち'];
  // Never truncate a question: oversized questions remain in the queue for a later digest.
  const included = [];
  let chars = 0;
  for (const a of recent) {
    const text = plain(a.text);
    const detail = a.detail ? plain(a.detail) : '';
    const lineLen = text.length + (detail ? detail.length + 20 : 0);
    if (included.length >= 2 || chars + lineLen > 1350) continue;
    included.push(a); chars += lineLen;
    if (a.reply === false) {
      lines.push(`・${text}（あなたの操作は不要）`);
      continue;
    }
    // 「何に答えるのか」が分かるよう、判断内容は改行して独立の行に出す（1通1800字の分割は行単位）。
    lines.push(`・${text}（このDMに返信してください）`);
    if (detail) lines.push(`  → 判断してほしいこと: ${detail}`);
  }
  const extra = [];
  if (old.length) extra.push(`古い待ち ${old.length}件（7日以上動きなし）`);
  if (!unique.length) lines.push('なし');
  else if (recent.length > included.length) extra.push(`ほか返事待ち ${recent.length - included.length}件（次のまとめでお知らせします）`);
  if (extra.length) lines.push(extra.join(' ／ '));
  const humanRows = rows.filter(r => isKimHumanProgress(r) || notificationKind('', { kind: 'done-requested', session: r, home }) === 'done-requested');
  const human = [...humanRows, ...deferred.filter(r => r.kind === 'done-requested' && !humanRows.some(h => h.sessionId && h.sessionId === r.session?.sessionId)).map(r => ({ ...r.session, status: 'done', label: r.session?.label || r.session?.requestText || r.text }))];
  const done = human.filter(r => r.status === 'done');
  const ongoing = human.filter(r => r.status !== 'done');
  lines.push('あなたが頼んだこと', `完了 ${done.length}件 / 進行中 ${ongoing.length}件（止まっている ${ongoing.filter(r => ['stalled', 'waiting_user'].includes(r.status)).length}件）`);
  for (const row of [...ongoing, ...done].slice(0, 10)) {
    const summary = checkProgressSummary(row.checkText).split(/\r?\n/)[0];
    lines.push(`・${plain(row.label || row.requestText || row.promise).slice(0, 60)} ／ ${summary} ／ nextKim: ${plain(row.nextKim) || 'なし'}`);
  }
  if (human.length > 10) lines.push(`ほか ${human.length - 10}件`);
  const automatic = rows.filter(r => !humanRows.includes(r));
  lines.push('自動作業', `完了 ${automatic.filter(r => r.status === 'done').length + deferred.filter(r => r.kind === 'automatic' && r.status === 'done').length}件・止まっている ${automatic.filter(r => ['stalled', 'waiting_user'].includes(r.status)).length + deferred.filter(r => r.kind === 'automatic' && r.status === 'stalled').length}件`);
  const shown = new Set([...included, ...old].map(a => a.text));
  return { text: lines.join('\n'), includedIds: actions.filter(a => shown.has(a.text)).map(a => a.id).filter(Boolean) };
}

// Shared by the compact digest and the legacy formatter without importing the CLI.
export const kimAction = row => {
  const value = String(row.nextKim || '').trim();
  // 「なし / 0件」「なし（…」のように補足付き・途中で切れた「なし」も人の操作は不要として扱う。
  if (/^(?:特に)?(?:なし|無し|ナシ)/.test(value)) return 'なし';
  const action = /^(?:(?:特に)?なし|無し|ナシ|(?:対応(?:は)?)?不要(?:です)?|(?:特に)?ありません|none|n\/a|[-—–－ー―])(?:[（(].*[）)])?[。．]?$/i.test(value) || !value ? 'なし' : value;
  // 相手・別処理からの到着を待つ条件は kim の操作ではない。
  return /(?:待機|待つ|返事待ち|返信待ち|確認待ち|判断待ち|(?:が|から).*来たら|(?:が|を).*したら)/.test(action) ? 'なし' : action;
};

export const isHumanActionRequired = (row) => {
  if (row.status === 'done') return false;
  // main: 依頼本文がない明示的な判断待ちも取りこぼさない。
  if (row.status === 'waiting_user' && !String(row.nextKim || '').trim()) return true;
  if (kimAction(row) !== 'なし') return true;
  // promise は Claude 自身が進める約束なので語句では判定しない（「判断」等を含むだけで誤って判断待ちになる）。
  // 人の操作が要るのは「次に kim がすること」か、自動再開の結果が needs_user を返した時だけ。
  return /^needs_user\b/.test(String(row.resumeOutcome || '').trim());
};


export function cleanText(text, row = {}) {
  let s = String(text || '');
  // 先頭の定型句
  // 「:」か空白が続く見出しだけを外す。「自動進行が判断待ちです」の主語まで消すと「・が判断待ちです」になる。
  s = s.replace(/^[-*•\s]*(?:\*\*|__)?(?:この後の自動進行|自動進行|約束)(?:\*\*|__)?(?:[:：]\s*|\s+)/i, '');
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
