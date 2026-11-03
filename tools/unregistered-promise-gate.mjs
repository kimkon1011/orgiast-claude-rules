export const GATE_CONTRACT = {"name": "unregistered-promise-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "unregistered-promise-gate"}]};

import { extractPromise } from './auto-progress-ledger.mjs';

// Deliberately require an affirmative sentence ending: questions, negations and
// reported speech are not promises. Do not reject a future clause just because
// an earlier clause mentions completion (e.g. 確認しましたので、追記します).
const PROMISE = /(?:しておきます|(?:記録|反映|追記|対応|送信|共有|登録|更新|修正|確認|調査|作成|実装|進行)します|進めます|送ります)(?:[。！!]|$)/u;
const OTHER_ACTOR = /(?:user|ユーザー|kim|あなた|先方|相手|担当者|お客様|彼女?|[\p{L}\p{N}_]+(?:さん|様)|システム|アプリ|ツール|スクリプト|ジョブ|ワークフロー|bot)(?:側)?(?:が|は)/iu;
const CONDITIONAL = /(?:教えてもらえれば|いただければ|返事があれば)/u;
const SELF = /(?:私|こちら|Claude)(?:側)?(?:が|は)/iu;
const mask = text => text.replace(/[^\r\n]/g, ' ');

function stripExcluded(text) {
  let fence = null;
  let source = String(text || '').split(/(?<=\n)/u).map(line => {
    if (fence) {
      const close = line.trim().match(/^(`{3,}|~{3,})$/u)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      return mask(line);
    }
    if (/^\s*>/u.test(line)) return mask(line);
    const open = line.match(/^[ \t]*(`{3,}|~{3,})/u)?.[1];
    if (open) { fence = open; return mask(line); }
    return line;
  }).join('');

  // Keep offsets for quoting the original sentence in the remedy. A stack also
  // handles nested and unfinished Japanese quotations without joining words.
  const stack = [];
  source = source.replace(/[\s\S]/gu, char => {
    if (char === '「' || char === '『') { stack.push(char === '「' ? '」' : '』'); return mask(char); }
    if (!stack.length) return char;
    if (char === stack.at(-1)) stack.pop();
    return mask(char);
  });
  return source;
}

export function findUnregisteredPromise(text) {
  const original = String(text || '');
  const prose = stripExcluded(original);
  // Share decoration, last-declaration and no-op handling with the ledger.
  // Quoted/code examples must not masquerade as a registration.
  if (extractPromise(prose)) return null;
  const body = prose.replace(/(`+)[^\r\n]*?\1/gu, mask);
  for (const match of body.matchAll(/[^。！!？?\r\n]+[。！!？?]?/gu)) {
    const sentence = match[0].trim();
    if (!PROMISE.test(sentence)) continue;
    // With an explicit other actor, prefer passing ambiguous prose. Conditional
    // requests for user input can still promise our own subsequent action.
    if (OTHER_ACTOR.test(sentence) && !CONDITIONAL.test(sentence) && !SELF.test(sentence)) continue;
    return original.slice(match.index, match.index + match[0].length).trim();
  }
  return null;
}

export function evaluateUnregisteredPromise(text) {
  const promise = findUnregisteredPromise(text);
  if (!promise) return { decision: 'pass' };
  return {
    decision: 'block',
    code: 'UNREGISTERED-PROMISE',
    reason: `本文で約束した作業（${promise}）が、実行も『この後の自動進行:』への登録もされていません。今このターンで実行するか、自動進行に登録してください。user の返事待ちの条件付き約束は使わず、返事が無くても進む形にしてください。`,
  };
}

