// Stop 時に kim の発言が未回答の返事待ちへの返答を含んでいそうなら確認する。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { collectAwaiting } from './kim-awaiting.mjs';
import { listItems } from './kim-inbox.mjs';

const homeDir = () => process.env.ORGIAST_HOME || os.homedir();

// kim の発言が「番号付き回答」「送って」「不要」「保留」「完了」等を含むか
const ANSWER_PATTERN = /(?:^|\s)(?:可|不可|承認|否認|はい|いいえ|不要|完了|保留|OK|送って|進めて|良い|大丈夫|お願い|全部OK)(?:[。、.!！\s]|$)/i;
const NUMBERED_REPLY = /(?:^|\s)[1-9]\d*\s*[.．、)）]\s*(?:可|不可|承認|否認|はい|いいえ|不要|完了|保留|OK|進めて|良い)(?:[。、.!！\s]|$)/im;

export function evaluateAnswerRecording(text, { home = homeDir(), now = Date.now() } = {}) {
  if (!text || !text.trim()) return { decision: 'pass' };

  // Check if human text contains answer-like patterns
  const hasAnswerPattern = ANSWER_PATTERN.test(text) || NUMBERED_REPLY.test(text);
  if (!hasAnswerPattern) return { decision: 'pass' };

  // Check if there are pending items that could be answered
  try {
    const awaiting = collectAwaiting({ home, now });
    const inboxItems = listItems(home).filter(i => (i.status === 'open' || (i.kind === 'info' && i.status === 'seen')) && (i.kind === 'ask' || i.deliveredToKim));
    if (!awaiting.length && !inboxItems.length) return { decision: 'pass' };
  } catch {
    return { decision: 'pass' };
  }

  return {
    decision: 'warn',
    reason: 'kim が返答したように見えますが、回答が kim-awaiting または kim-inbox に記録されたか確認してください。kim の発言から回答を拾い、`--answer` または `--answer-all` で記録してください。',
    code: 'KIM-ANSWER-RECORDING'
  };
}