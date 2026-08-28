#!/usr/bin/env node
// user に作業を頼むのに、その場で実行できる情報（URL・貼るコマンド全文・パス）を
// 同じメッセージに書いていない応答を止める。ONBOARDING §1.5.3。
//
// なぜ必要か: 2026-08-28、配布インストーラの修正後に kim へ「前回と同じコマンドを
// もう一度貼ってください」とだけ伝え、貼るコマンドも対象 Doc の URL も書かなかった。
// kim が過去ログを掘る必要が生じた。同じ指摘は 3 回目(2026-06-11 / 07-05 / 08-28)で、
// 文書ルールとしては既にあったのに守れなかったため hook で機械強制する。
//
// 判定を「本文のどこかに URL があるか」でやってはいけない(初版がこれで機能しなかった)。
// 実際の応答には別件の PR リンク等がほぼ必ず含まれるので、事実上いつも素通しになる。
// 必要情報は「その依頼の近く」= 依頼が入っているブロック内にあることを要求する。
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { lastAssistantText, readStdin } from './transcript-tail.mjs';

const PAST_REFERENCE = /前回と同じ|前と同じ|さっきの|先ほどの|同じコマンド|同じ手順|例の|上記の|前述の|いつもの|お伝えした/;
// 動詞は語幹で持つ。「貼って」だけ見ていると「貼れば通ります」型の言い切り依頼を取り逃す。
const HANDOFF_ACTION = /貼(?:って|り付け|り直|れば|ったら)|実行(?:して|を|すれば|したら)|走らせ|開(?:いて|けば|いたら)|クリック|押(?:して|せば)|ログイン|サインイン|認証(?:して|を)|入力(?:して|を|すれば)|設定(?:して|を|すれば)|送(?:って|れば)|共有(?:して|を)|インストール(?:して|を|すれば)|有効にして|オンにして|選(?:んで|べば)|選択(?:して|を)|アップロード(?:して|を)|ダウンロード(?:して|を)/;
const REQUEST_ENDING = /(?:して|を)?(?:ください|下さい|くださいませ|お願いします|願います|もらえますか|いただけますか)(?:[。.!！?？]|$)/;
const DIRECT_REQUEST = /(?:ここ|次|以下|リンク|ボタン|URL|コマンド|ファイル|画面|PowerShell|Discord)[^。.!！?？\n]{0,50}(?:クリック|押して|ログイン|サインイン|選択)(?:[。.!！?？]|$)/i;
// 「貼れば通ります」「実行するだけで直ります」のような言い切りも依頼。条件形+結果表現で拾う。
const STATEMENT_REQUEST = /(?:えば|れば|たら|だけで|してもらえれば)[^。.!！?？\n]{0,30}(?:通りま|入りま|直りま|完了|OK|終わりま|反映|済みま|できま|使えま)/i;
const COMPLETED = /しておきました|実行しました|設定しました|入力しました|共有しました|送信しました|アップロードしました|ダウンロードしました|インストールしました|有効にしました|オンにしました|選択しました|確認しました|設定済み|実行済み|完了(?:しました|です)/;
const SELF_ACTION = /(?:私|こちら|当方|Claude|AI)(?:が|で)[^。.!！?？\n]{0,50}(?:実行|設定|入力|共有|送信|アップロード|ダウンロード|インストール|確認)/i;

function hasRequiredInfo(text) {
  return /https:\/\/\S+/i.test(text)
    || /```[^]*?```/.test(text)
    || /`\s*(?:node|npm|npx|pnpm|yarn|git|irm|powershell|pwsh|curl)\s+[^`]+`/i.test(text)
    || /[A-Za-z]:\\[^\s<>"|?*]+/.test(text)
    || /\[[^\]\r\n]+\]\([^\r\n)]+\)/.test(text);
}

// 空行区切りでブロックに割る。ただしフェンス付きコードブロックは中に空行があっても割らない。
// コードブロックは直前のブロック(依頼文)に属するものとして連結する — 「下のコマンドを貼って」
// の直後に置かれるのが普通の書き方で、そこを別ブロック扱いにすると正しい依頼まで違反になる。
export function splitBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  let current = [];
  let inFence = false;
  const flush = () => { if (current.join('').trim()) blocks.push(current.join('\n')); current = []; };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      // フェンス開始時は直前の依頼文ブロックに続ける(flush しない)
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') { flush(); continue; }
    current.push(line);
  }
  flush();
  return blocks;
}

function isHandoffSentence(part) {
  if (!HANDOFF_ACTION.test(part)) return false;
  // 完了報告や Claude 自身の作業記述を依頼と数えると、正常な最終報告を毎回止めてしまう。
  if (COMPLETED.test(part) || SELF_ACTION.test(part)) return false;
  return REQUEST_ENDING.test(part) || DIRECT_REQUEST.test(part) || STATEMENT_REQUEST.test(part);
}

export function findHandoffWithoutInfo(text) {
  const body = String(text || '');
  if (!body || body.includes('[HANDOFF-INFO-OK]')) return null;

  const offending = [];
  for (const block of splitBlocks(body)) {
    const sentences = block.split(/(?<=[。.!！?？])|\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!sentences.some(isHandoffSentence)) continue;
    // 依頼が入っているブロック自身に実行可能な情報があるかを見る。
    // 本文の別の場所にあるリンクは、この依頼を実行可能にしないので数えない。
    if (hasRequiredInfo(block)) continue;
    offending.push(block);
  }
  if (offending.length === 0) return null;

  if (PAST_REFERENCE.test(body)) {
    return { tier: 'A', reasons: ['「前回と同じ」等で過去を参照させている'], blocks: offending };
  }
  return { tier: 'B', reasons: ['user に作業を頼んでいるが、その場で実行できる情報が本文に無い'], blocks: offending };
}

export function formatViolationMessage(result) {
  if (!result) return '';
  const past = result.tier === 'A'
    ? '\n特に「前回と同じ」「さっきの」等で過去を参照させています。user に過去ログを掘らせないでください。'
    : '';
  const sample = Array.isArray(result.blocks) && result.blocks.length
    ? `\n\n該当箇所:\n  ${result.blocks[0].split(/\r?\n/)[0].slice(0, 80)}`
    : '';
  return `[HANDOFF-INFO-GUARD] user に作業を頼んでいますが、その場で実行できる情報が同じ場所にありません。${past}${sample}\n\n依頼と同じブロックに次を書いてください(ONBOARDING §1.5.3):\n  - URL(開く先・対象の Doc/PR/画面)\n  - 実際に貼るコマンドの全文(「同じコマンド」で参照しない)\n  - 対象ファイルのパスと人が読める名前\nGoogle Workspace の URL は /a/orgiast.jp/ を挟み、Drive の file/folder は ?authuser=kim@orgiast.jp を付けてください。\n\n例外的に追加情報が不要な依頼なら、本文に [HANDOFF-INFO-OK] を入れてください。`;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input.stop_hook_active || !input.transcript_path || !fs.existsSync(input.transcript_path)) return;
    const result = findHandoffWithoutInfo(lastAssistantText(input.transcript_path));
    const message = formatViolationMessage(result);
    if (message) {
      console.error(message);
      process.exitCode = 2;
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main();
