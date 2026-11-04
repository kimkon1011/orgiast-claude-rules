#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
export function inquiryContext({ prompt = '' } = {}) {
  const text = String(prompt).normalize('NFKC');
  if (!/問い合わせ|問合せ|打合せ|打ち合わせ|ミーティング|案件|見積/.test(text)) return '';
  const named = /株式会社|有限会社|合同会社|様|\b(?:Inc|Ltd|Corp|LLC)\b/i.test(text);
  const timed = /(?:今日|明日)[^\n。]{0,40}(?:\d{1,2}\s*時|\d{1,2}:\d{2})/.test(text);
  if (!named && !timed) return '';
  return '先に `node tools/inquiry-lookup.mjs <会社名・氏名・メール等の検索語>` を1回実行し、その結果だけで判断せよ。未確認の情報源は「未確認」と明示する。\nsatou@・eigyou@ などはGoogleグループなので seisaku-team@ の to: 検索を見る。';
}
if (isEntry(import.meta.url)) {
  try { const context = inquiryContext(JSON.parse(await readStdinWithTimeout())); if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })); } catch { /* fail-open */ }
}
