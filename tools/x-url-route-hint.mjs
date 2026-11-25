#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export function xUrlContext({ prompt = '' } = {}) {
  const url = String(prompt).match(/(?<![A-Za-z0-9_./@-])((?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+)(?=$|[^A-Za-z0-9_/])/i)?.[1];
  if (!url) return '';
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grok-x-fetch.mjs');
  const canonicalUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return `[X投稿の読み方] X の投稿は node "${tool}" --url ${canonicalUrl} で読む。WebFetch は 402、ミラー(fxtwitter等)は classifier 拒否になる。`;
}

if (isEntry(import.meta.url)) {
  try {
    const context = xUrlContext(JSON.parse(await readStdinWithTimeout()));
    if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  } catch { /* hook は fail-open。 */ }
}
