#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { lastAssistantText, readStdin } from './transcript-tail.mjs';

const PAST_REFERENCE = /前回と同じ|前と同じ|さっきの|先ほどの|同じコマンド|同じ手順|例の|上記の|前述の|いつもの|お伝えした/;
const HANDOFF_ACTION = /貼って|貼り付け|貼り直し|実行(?:して|を)|走らせて|開いて|クリック|押して|ログイン|サインイン|認証(?:して|を)|入力(?:して|を)|設定(?:して|を)|送って|共有(?:して|を)|インストール(?:して|を)|有効にして|オンにして|選んで|選択(?:して|を)|アップロード(?:して|を)|ダウンロード(?:して|を)/;
const REQUEST_ENDING = /(?:して|を)?(?:ください|下さい|くださいませ|お願いします|願います|もらえますか|いただけますか)(?:[。.!！?？]|$)/;
const DIRECT_REQUEST = /(?:ここ|次|以下|リンク|ボタン|URL|コマンド|ファイル|画面|PowerShell|Discord)[^。.!！?？\n]{0,50}(?:クリック|押して|ログイン|サインイン|選択)(?:[。.!！?？]|$)/i;
const COMPLETED = /しておきました|実行しました|設定しました|入力しました|共有しました|送信しました|アップロードしました|ダウンロードしました|インストールしました|有効にしました|オンにしました|選択しました|確認しました|設定済み|実行済み|完了(?:しました|です)/;
const SELF_ACTION = /(?:私|こちら|当方|Claude|AI)(?:が|で)[^。.!！?？\n]{0,50}(?:実行|設定|入力|共有|送信|アップロード|ダウンロード|インストール|確認)/i;

function hasRequiredInfo(text) {
  return /https:\/\/\S+/i.test(text)
    || /```[^]*?```/.test(text)
    || /`\s*(?:node|npm|npx|pnpm|yarn|git|irm|powershell|pwsh|curl)\s+[^`]+`/i.test(text)
    || /[A-Za-z]:\\[^\s<>"|?*]+/.test(text)
    || /\[[^\]\r\n]+\]\([^\r\n)]+\)/.test(text);
}

function handoffSentences(text) {
  return String(text || '').split(/(?<=[。.!！?？])|\r?\n/).map((part) => part.trim()).filter((part) => {
    if (!HANDOFF_ACTION.test(part)) return false;
    // 完了報告や Claude 自身の作業記述を依頼と数えると、正常な最終報告を毎回止めてしまう。
    if (COMPLETED.test(part) || SELF_ACTION.test(part)) return false;
    return REQUEST_ENDING.test(part) || DIRECT_REQUEST.test(part);
  });
}

export function findHandoffWithoutInfo(text) {
  const body = String(text || '');
  if (!body || body.includes('[HANDOFF-INFO-OK]')) return null;
  const requests = handoffSentences(body);
  if (requests.length === 0 || hasRequiredInfo(body)) return null;
  if (PAST_REFERENCE.test(body)) return { tier: 'A', reasons: ['「前回と同じ」等で過去を参照させている'] };
  return { tier: 'B', reasons: ['user に作業を頼んでいるが、その場で実行できる情報が本文に無い'] };
}

export function formatViolationMessage(result) {
  if (!result) return '';
  const past = result.tier === 'A' ? '\n特に「前回と同じ」等で過去を参照させています。' : '';
  return `[HANDOFF-INFO-GUARD] user に作業を頼んでいますが、その場で実行できる情報が本文にありません。${past}\n\n依頼と同じメッセージに URL / 実際に貼るコマンド全文 / 対象ファイルのパスを書いてください。Google Workspace の URL は /a/orgiast.jp/ を挟み、Drive の file/folder は ?authuser=kim@orgiast.jp を付けてください。\n\n例外的に追加情報が不要な依頼なら、本文に [HANDOFF-INFO-OK] を入れてください。`;
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
