export const GATE_CONTRACT = {"name": "urgent-blocker-wait-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "urgent-blocker-wait-gate"}]};

import os from 'node:os';
import { hasOpenForSession } from './urgent-blocker.mjs';

// 人にしかできない操作で止まっている報告。2026-11-09 nishi の実害（LINE ログイン画像認証待ちで
// 6日停止・社外クレーム）の再発防止。裸名詞（「返事待ち」）は拾うが、丁寧な結び（「ご返信を
// お待ちしています」）は拾わない。
const HUMAN_WAIT = /ログイン待ち|ログイン(?:を|の)?お待ち|画像認証|(?:2|二)段階認証|認証コード|SMS認証|認証(?:を|の)?お?待ち|人にしかできない|人(?:の|による)手作業|手作業待ち|操作待ち|操作(?:を|の)?お待ち|(?:あなた|kim|user|ユーザー|担当者|本人)の(?:操作|確認|承認|対応|ログイン|入力|作業)(?:を|の)?お?待ち|ご対応待ち|対応待ち|承認待ち|承認(?:を|の)?お?待ち|支払(?:い)?待ち|入金待ち|返事待ち|返信待ち|回答待ち|返答待ち/g;

// 否定（〜待ちではありません／〜待ちは不要／〜待ちは解消）の近くでは拾わない。
const NEGATION = /(?:では?|じゃ|では)?ありません|していません|解消|不要|必要なし|なしです|ありませんでした/;

// 引用行・コードブロック・監査引用は回答本文ではないので除外する（deferral-wait-gate と同じ）。
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
    return /\[handoff-audit:[0-9a-f]{16}\]/.test(line) ? '' : line;
  }).join('\n');
}

export function enabled() {
  return process.env.ORGIAST_URGENT_BLOCKER_WAIT_GATE !== '0';
}

// 明示的に「この人待ちは認識済み・追跡済み」と宣言したマーカーは、urgent-blocker の追加登録を求めない
// （reply-only の返信待ちなど会話に戻ってくる待ちは、割り込み表示の対象外でよい）。
const ACKNOWLEDGED_WAIT = /\[(?:AUTOPROGRESS-CHECK-OK|NO-AUTOCHECK-OK):[ \t]*[^\]]/;

// 人待ちを報告しているか。報告していればそのフレーズ、していなければ null。
export function detectHumanWait(text) {
  const prose = proseLines(text);
  for (const match of prose.matchAll(HUMAN_WAIT)) {
    const nearby = prose.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
    if (NEGATION.test(nearby)) continue;
    return match[0];
  }
  return null;
}

// Stop gate から呼ぶ。人待ちを報告しているのに urgent-blocker 未登録なら block する。
// sessionId が無い（通常あり得ない）ときは、登録有無を判定できないので pass に倒す（fail-open しないが誤判定しない）。
export function judge(text, { sessionId = '', home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  if (!enabled()) return { decision: 'pass' };
  if (!sessionId) return { decision: 'pass' };
  if (ACKNOWLEDGED_WAIT.test(String(text || ''))) return { decision: 'pass' };
  const phrase = detectHumanWait(text);
  if (!phrase) return { decision: 'pass' };
  if (hasOpenForSession(home, sessionId)) return { decision: 'pass' };
  return {
    decision: 'block',
    code: 'URGENT-BLOCKER-MISSING',
    reason: `人にしかできない操作で止まって「${phrase}」と報告していますが、urgent-blocker が未登録です。node tools/urgent-blocker.mjs --add --session <このセッションID> --title "<何が止まっているか>" --ask "<人にしてほしい1操作・所要時間>" [--link <URL>] で登録し、待つ前に待っている経路が本当に成立するか（受け手に届くか）を検証し、代替経路（別の送り方・別アカウント・メール等）と自動再試行を試した結果を書いてください。登録すると user が使っている別セッションの冒頭に割り込み表示されます。`,
  };
}
