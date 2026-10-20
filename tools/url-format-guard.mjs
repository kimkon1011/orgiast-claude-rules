#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "url-format-guard", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "url-format-guard"}]};
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { appendStopLedger, registerStopViolation, stopGateOutput } from './lib/stop-recheck.mjs';


const RAW_URL = /(?<!\]\()https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%\-]+/g;
// 全角文字・全角括弧・句読点に加え、半角の ) ] もリンク範囲に巻き込まれる（2026-10-18 実害: …/pull/864（ が 404）。
const BAD_NEXT = /^[　-〿぀-ヿ一-鿿＀-￯)\]]/;

export function findBrokenRawUrl(text) {
  const value = String(text || '');
  if (/\[RAW-URL-OK\]/.test(value)) return { decision: 'pass' };
  // コードはリンク化されないので対象外。
  const prose = value.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const hit = [...prose.matchAll(RAW_URL)].find(m => {
    const rest = prose.slice(m.index + m[0].length, m.index + m[0].length + 2);
    return BAD_NEXT.test(rest) && !rest.startsWith('](');
  });
  if (!hit) return { decision: 'pass' };
  const sample = prose.slice(hit.index, hit.index + hit[0].length + 1).slice(-60);
  const reason = `[URL-FORMAT VIOLATION] 生URLが日本語/全角文字に直接隣接しています(リンク破損): "${sample}"

URLは必ず Markdown リンク形式にすること(絶対ルール):
  NG:  （https://example.com）。   /  https://example.com を確認
  OK:  [example.com](https://example.com)  /  URL を単独行に置き、説明・アカウントは直前の行に書く

生URLの直後に句読点・全角カッコ・日本語・半角の ) ] を隙間なく続けるとクリック時に巻き込まれ
ERR_NAME_NOT_RESOLVED / 404 になります。該当箇所を [text](url) に直して再送してください。
(本当に生URLが必要な稀な場合のみ [RAW-URL-OK] タグを付ける)`;
  return { decision: 'block', reason };
}

export const REMEDY_EXAMPLES = [
  '[example.com](https://example.com)',
  '[サイトはこちら](https://example.com)',
];

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (!input?.transcript_path || !fs.existsSync(input.transcript_path)) return;
    const text = input.last_assistant_message ?? input.assistant_text ?? latestAssistantText(input.transcript_path); if (!text) return;
    const result = findBrokenRawUrl(text);
    if (result.decision === 'block') {
      const recheck = registerStopViolation({ input, assistantText: text, blockedBy: ['url-format-guard'], reasonCodes: ['URL-FORMAT'] });
      appendStopLedger({ sessionId: recheck.sessionId, verdict: recheck.verdict, blockedBy: recheck.blockedBy, reasonCodes: recheck.reasonCodes, retryCap: recheck.retryCap, excerpt: text.slice(0, 200) });
      console.log(JSON.stringify(stopGateOutput(recheck, result.reason)));
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main();
