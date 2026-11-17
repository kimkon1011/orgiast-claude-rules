#!/usr/bin/env node
// claude.ai の組織指示の字数を数え、[ORG-CHARS: n/3000] を出力するユーティリティ。
// Unicode コードポイント（[...text].length）で数える。
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';

export function countChars(text) {
  return [...String(text || '')].length;
}

export function formatCharCount(text) {
  const n = countChars(text);
  return `[ORG-CHARS: ${n}/3000]`;
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  if (fileIndex >= 0 && args[fileIndex + 1]) {
    const text = fs.readFileSync(args[fileIndex + 1], 'utf8');
    console.log(formatCharCount(text));
  } else {
    console.error('Usage: node tools/org-instructions-chars.mjs --file <textfile>');
    process.exitCode = 1;
  }
}