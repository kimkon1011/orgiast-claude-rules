#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';


const BAD_RAW_URL = /(?<!\]\()https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%\-]+[　-〿぀-ヿ一-鿿＀-￯]/;

export function findBrokenRawUrl(text) {
  const value = String(text || '');
  if (/\[RAW-URL-OK\]/.test(value)) return { decision: 'pass' };
  const match = value.match(BAD_RAW_URL);
  if (!match) return { decision: 'pass' };
  const sample = match[0].slice(0, 60);
  const reason = `[URL-FORMAT VIOLATION] 生URLが日本語/全角文字に直接隣接しています(リンク破損): "${sample}"

URLは必ず Markdown リンク形式にすること(絶対ルール):
  NG:  （https://example.com）。   /  https://example.com を確認
  OK:  [example.com](https://example.com)  /  [サイトはこちら](https://example.com)

生URLの直後に句読点・全角カッコ・日本語を隙間なく続けるとクリック時に巻き込まれ
ERR_NAME_NOT_RESOLVED / 404 になります。該当箇所を [text](url) に直して再送してください。
(本当に生URLが必要な稀な場合のみ [RAW-URL-OK] タグを付ける)`;
  return { decision: 'block', reason };
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input?.stop_hook_active || !input?.transcript_path || !fs.existsSync(input.transcript_path)) return;
    const text = latestAssistantText(input.transcript_path); if (!text) return;
    const result = findBrokenRawUrl(text);
    if (result.decision === 'block') console.log(JSON.stringify(result));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
