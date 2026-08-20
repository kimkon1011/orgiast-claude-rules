#!/usr/bin/env node
// ai-news-inject.mjs — SessionStart hook。
// line-digest.mjs が夜間に作り置きした「生成AI最新情報」ブロックを、
// セッション冒頭にそのまま流し込むだけ(組み立て・API呼び出しは一切しない / §2.8.1)。
// context を注入する hook なので settings.json で async:true を付けないこと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const START = '<!-- AI-NEWS-START -->';
const END = '<!-- AI-NEWS-END -->';
const MAX_CHARS = 4000;
const STALE_DAYS = 7;

const file = path.join(os.homedir(), '.claude', 'ai-news-digest.md');

let raw;
try {
  raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
} catch {
  process.exit(0); // 未生成なら黙って何も出さない
}

// マーカーは行完全一致で探す(部分一致は自己言及文書に誤爆する / 実機で2回破損した)
const lines = raw.split(/\r?\n/);
const s = lines.findIndex((l) => l.trim() === START);
const e = lines.findIndex((l) => l.trim() === END);
if (s < 0 || e < 0 || e <= s) process.exit(0);

const body = lines.slice(s + 1, e).join('\n').trim();
if (!body) process.exit(0);

// 古い作り置きを最新情報として出さない
let staleNote = '';
try {
  const ageDays = (Date.now() - fs.statSync(file).mtimeMs) / 86400000;
  if (ageDays > STALE_DAYS) {
    staleNote = `\n(注意: この作り置きは ${Math.floor(ageDays)} 日前のもの。取り込みが止まっている可能性があるので \`node tools/line-digest.mjs\` の実行状況を確認すること)`;
  }
} catch {}

const out = body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) + '\n…(以下省略)' : body;
process.stdout.write(`${out}${staleNote}\n`);
