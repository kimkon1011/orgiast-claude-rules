export const GATE_CONTRACT = {"name": "awaiting-answer-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "awaiting-answer-gate"}]};

import os from 'node:os';
import path from 'node:path';
import { collectAwaiting } from './kim-awaiting.mjs';
import { listItems } from './kim-inbox.mjs';

// kim の発言に含まれる回答パターン。番号付きの答えや判断語を検出する。
// 番号付き: "1 可" "2. 不要" "3) OK" "1．良い" など
// 単独語: "送って" "不要" "保留" "完了" "OK" "可" "不可" "承認" "否認" "進めて" "良い" "大丈夫"
// 日本語は単語境界が無いので、部分一致で検出する。
const ANSWER_KEYWORDS = ['可', '不可', 'OK', 'ok', '承認', '否認', '不要', '保留', '完了', '送って', '進めて', '良い', '大丈夫', '全部OK', '全部良い', '全部大丈夫'];
const NUMBERED_PREFIX = /(?:^|\s)\d+\s*(?:[.．)）]\s*)?/;

// 引用行・コードブロックは回答本文ではないので除外する。
function proseLines(text) {
  let fence;
  return String(text || '').split(/\r?\n/).map(line => {
    if (/^\s*>/.test(line)) return '';
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n');
}

// 発言に回答パターンが含まれているか検出する。
export function detectAnswerPattern(text) {
  const prose = proseLines(text);
  // 番号付きパターン: "1 可" "2. 不要" など
  if (NUMBERED_PREFIX.test(prose)) {
    const afterNumber = prose.replace(NUMBERED_PREFIX, '');
    if (ANSWER_KEYWORDS.some(kw => afterNumber.startsWith(kw) || afterNumber.includes(kw))) return true;
  }
  // 単独キーワード: 行頭または区切りの後にあるキーワード
  const lines = prose.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 行全体がキーワードにマッチするか
    if (ANSWER_KEYWORDS.some(kw => trimmed === kw || trimmed.startsWith(kw + '。') || trimmed.startsWith(kw + '、') || trimmed.startsWith(kw + '!') || trimmed.startsWith(kw + '！') || trimmed.startsWith(kw + ' ') || trimmed.startsWith(kw + '　') || trimmed.startsWith(kw + 'です') || trimmed.startsWith(kw + 'だ') || trimmed.startsWith(kw + 'で') || trimmed.startsWith(kw + 'に') || trimmed.startsWith(kw + 'を'))) return true;
    // 行内の区切り後のキーワード（「1 可」「2 不要」など）
    const parts = trimmed.split(/[、,]\s*/);
    for (const part of parts) {
      const cleaned = part.replace(NUMBERED_PREFIX, '').trim();
      if (ANSWER_KEYWORDS.some(kw => cleaned === kw || cleaned.startsWith(kw + '。') || cleaned.startsWith(kw + '、') || cleaned.startsWith(kw + '!') || cleaned.startsWith(kw + '！') || cleaned.startsWith(kw + ' ') || cleaned.startsWith(kw + '　') || cleaned.startsWith(kw + 'です') || cleaned.startsWith(kw + 'だ') || cleaned.startsWith(kw + 'で') || cleaned.startsWith(kw + 'に') || cleaned.startsWith(kw + 'を'))) return true;
    }
  }
  return false;
}

// Stop gate から呼ぶ。kim の発言に回答パターンが含まれているのに、
// kim-inbox または kim-awaiting に未回答の項目がある場合、確認を促す。
export function judge(text, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  if (!text || !text.trim()) return { decision: 'pass' };
  if (!detectAnswerPattern(text)) return { decision: 'pass' };

  // kim-inbox の未回答 ask を確認
  const inboxItems = listItems(home).filter(i => i.kind === 'ask' && i.status === 'open');
  // kim-awaiting の未回答項目を確認
  const awaitingItems = collectAwaiting({ home, now: Date.now() });
  const pendingAwaiting = awaitingItems.filter(i => !i.answered);

  if (inboxItems.length === 0 && pendingAwaiting.length === 0) return { decision: 'pass' };

  const inboxCount = inboxItems.length;
  const awaitingCount = pendingAwaiting.length;
  const parts = [];
  if (inboxCount > 0) parts.push(`kim-inbox に ${inboxCount} 件`);
  if (awaitingCount > 0) parts.push(`kim-awaiting に ${awaitingCount} 件`);

  return {
    decision: 'block',
    code: 'AWAITING-ANSWER-UNRECORDED',
    reason: `kim の発言に回答（${ANSWER_KEYWORDS.join('・')} など）が含まれていますが、${parts.join('、')}の未回答の返事待ちがあります。\`node tools/kim-awaiting.mjs --list\` で一覧を確認し、\`node tools/kim-awaiting.mjs --answer <id> --body-file <file>\` で回答を記録しましたか？回答を記録していなければ、先に記録してから発言してください。`,
  };
}