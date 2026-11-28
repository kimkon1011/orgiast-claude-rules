import { readFile } from 'node:fs/promises';
import { isEntry } from './is-entry.mjs';

// 探した場所の分類用パターン
const DRIVE_RE = /drive|ドライブ/i;
const GMAIL_RE = /gmail|メール/i;
const CONVERSATION_RE = /会話|チャット|gb-reports|案件フォルダ|サイト/;

// 探す作業を金さんに返している質問のパターン
const KIM_SEARCH_RE = /場所を教えて|あれば教えて|なければ.{0,6}(ない|なし).{0,6}返|置いていれば/;

// AIが確かめられる事柄のパターン
const AI_CHECKABLE_RE = /印刷(さ)?れ(た|ました)|届(い)?(た|きました)か|送(っ)?(た|信した|りました)か|誰が.{0,10}(取得|申請|発行)|いつ.{0,10}取得/;

export function judge(input) {
  const {
    question = '',
    targetType,
    searchedPlaces = [],
    itemOwner,
    itemHandledBy = null,
    askTarget,
    yesNoForm = false,
    found = false,
  } = input;

  // 0. 探して見つかった場合は質問自体を送らない
  if (found === true) {
    return { verdict: 'pass', reasons: ['探して見つかったので質問不要（送らない）'] };
  }

  const reasons = [];

  // 1. 金さん本人の物を社員に聞かない
  if (itemOwner === 'kim' && targetType === 'staff') {
    reasons.push('金さん本人の書類・カード・個人情報の写しは社員に聞かない');
  }

  // 2. 探した場所の一覧が必須
  if (searchedPlaces.length === 0) {
    reasons.push('探した場所の一覧が無い（Drive・Gmail・過去の会話・案件フォルダを先に探す）');
  }

  // 3. 金さんに聞く場合の追加チェック
  if (targetType === 'kim') {
    // 3a. 探す範囲の網羅性
    const hasDrive = searchedPlaces.some((p) => DRIVE_RE.test(p));
    const hasGmail = searchedPlaces.some((p) => GMAIL_RE.test(p));
    const hasConversation = searchedPlaces.some((p) => CONVERSATION_RE.test(p));
    if (!hasDrive || !hasGmail || !hasConversation) {
      reasons.push('探す範囲が足りない');
    }
    // 3b. はい／いいえで答えられる形か
    if (yesNoForm === false) {
      reasons.push('金さんが はい／いいえ で答えられる形でない');
    }
    // 3c. 探す作業を金さんに返していないか（yesNoFormでもblock）
    if (KIM_SEARCH_RE.test(question)) {
      reasons.push('探す作業を金さんに返している');
    }
    // 3d. AIが確かめられることを聞いていないか
    if (AI_CHECKABLE_RE.test(question)) {
      reasons.push('AIが確かめられること（プリンタ履歴・受信箱・記録）を聞いている');
    }
  }

  // 4. 社員に聞く場合は、その物を実際に扱った・持っている人に限る
  if (targetType === 'staff' && itemOwner !== 'kim') {
    if (askTarget !== itemHandledBy) {
      reasons.push('聞く相手がその物を実際に扱った・持っている人ではない');
    }
  }

  // 5. 全項目合格
  if (reasons.length === 0) {
    return { verdict: 'pass', reasons: ['全項目合格'] };
  }
  return { verdict: 'block', reasons };
}

// CLI: node tools/ask-self-search-check.mjs --file <input.json>
if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  if (fileIndex === -1 || !args[fileIndex + 1]) {
    console.error('使い方: node tools/ask-self-search-check.mjs --file <input.json>');
    process.exit(1);
  }
  try {
    const raw = await readFile(args[fileIndex + 1], 'utf8');
    const input = JSON.parse(raw);
    const result = judge(input);
    console.log(JSON.stringify(result, null, 2));
    if (result.verdict === 'block') {
      process.exit(2);
    }
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}
