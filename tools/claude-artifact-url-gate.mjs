import { latestAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

export function judge(text) {
  const body = text.replace(/```[\s\S]*?```/g, block => block.replace(/[^\r\n]/g, ''));
  if (body.includes('[ARTIFACT-URL-OK]')) return { triggered: false, urls: [] };
  const urls = [...new Set([...body.matchAll(/https?:\/\/[^\s<>\x60"'\[\]{}()（）「」『』、。！？]+/gi)]
    .map(match => match[0].replace(/[.,;:!?]+$/, ''))
    .filter(url => /^https:\/\/claude\.ai\/(?:code\/)?artifact\//.test(url)))];
  return { triggered: urls.length > 0, urls };
}

export function formatReason(urls) {
  return '[CLAUDE-ARTIFACT-URL] claude.ai の artifact URL を成果物として渡しています。社内文書は Google ドキュメント（docs.google.com/a/orgiast.jp/...）で渡す（kim 2026-10-08 ルール）。user が artifact を明示的に求めた場合だけ [ARTIFACT-URL-OK] を書く。\n' + urls.join('\n');
}

async function main() {
  try {
    const input = JSON.parse(await readStdinWithTimeout());
    if (input.stop_hook_active) return;
    const text = latestAssistantText(input.transcript_path);
    if (!text) return;
    const result = judge(text);
    if (result.triggered) {
      console.error(formatReason(result.urls));
      process.exitCode = 2;
    }
  } catch { /* Unexpected input fails open, matching existing gates. */ }
}

if (isEntry(import.meta.url)) await main();
