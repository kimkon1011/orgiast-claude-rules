#!/usr/bin/env node
// 夜間digestでも使うAIニュースのローカル整形。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isEntry } from './is-entry.mjs';

const START = '<!-- AI-NEWS-START -->';
const END = '<!-- AI-NEWS-END -->';
const MAX_CHARS = 4000;
const STALE_DAYS = 7;
const DAY_MS = 86400000;

export function readAiNews({ home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const file = path.join(home, '.claude', 'ai-news-digest.md');
  const lineOpenchatDir = path.join(home, '.claude', 'line-openchat');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
  } catch {
    return ''; // 未生成なら黙って何も出さない
  }

  // マーカーは行完全一致で探す(部分一致は自己言及文書に誤爆する / 実機で2回破損した)
  const lines = raw.split(/\r?\n/);
  const s = lines.findIndex((l) => l.trim() === START);
  const e = lines.findIndex((l) => l.trim() === END);
  if (s < 0 || e < 0 || e <= s) return '';

  const body = lines.slice(s + 1, e).join('\n').trim();
  if (!body) return '';

  // LINE の実データが古い場合は、14日間の取り込み期限が来る前に知らせる。
  // 新しい月のファイル・新しい行から探し、全レコードの JSON.parse は避ける。
  let dataFreshnessNote = '';
  try {
    const jsonlFiles = (fs.existsSync(lineOpenchatDir) ? fs.readdirSync(lineOpenchatDir) : [])
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse();

    let latestTs = null;
    for (const name of jsonlFiles) {
      const content = fs.readFileSync(path.join(lineOpenchatDir, name), 'utf-8');
      const rows = content.split(/\r?\n/);
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        // ts は epoch ms の数値で入る(receivedAt だけが ISO 文字列)。念のため文字列形式も受ける。
        const match = rows[i].match(/"ts"\s*:\s*(?:(\d+)|"([^"]+)")/);
        if (!match) continue;
        const ts = match[1] ? Number(match[1]) : Date.parse(match[2]);
        if (Number.isFinite(ts) && (latestTs === null || ts > latestTs)) latestTs = ts;
      }
      // YYYY-MM の新しいファイルで有効な日時が見つかれば、古い月は読む必要がない。
      if (latestTs !== null) break;
    }

    if (latestTs === null) {
      dataFreshnessNote = '\n(まだ1件も取り込まれていません。手順: https://claude-pc.tailc5d751.ts.net/line-setup )';
    } else {
      const dataAgeDays = Math.max(0, Math.floor((Date.now() - latestTs) / DAY_MS));
      if (dataAgeDays >= 14) {
        dataFreshnessNote = `\n(🔴 最後の取り込みから ${dataAgeDays} 日。14日より前の投稿は取り込んでも捨てられます。エクスポート手順: https://claude-pc.tailc5d751.ts.net/line-setup )`;
      } else if (dataAgeDays >= 7) {
        dataFreshnessNote = `\n(⚠ 最後の取り込みから ${dataAgeDays} 日。14日を過ぎた分は「期間外」で捨てられるので、近いうちにエクスポートを)`;
      } else if (dataAgeDays >= 3) {
        dataFreshnessNote = `\n(最後の取り込みから ${dataAgeDays} 日。そろそろ LINE のエクスポートを)`;
      }
    }
  } catch {
    // SessionStart hook を止めない。読み取り失敗時は従来どおり digest だけ表示する。
  }

  // データが新しいのに作り置きだけ古い場合は、夜間バッチ停止として知らせる。
  let staleNote = '';
  try {
    const ageDays = (Date.now() - fs.statSync(file).mtimeMs) / 86400000;
    if (!dataFreshnessNote && ageDays > STALE_DAYS) {
      staleNote = `\n(注意: この作り置きは ${Math.floor(ageDays)} 日前のもの。取り込みが止まっている可能性があるので \`node tools/line-digest.mjs\` の実行状況を確認すること)`;
    }
  } catch {}

  const out = body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) + '\n…(以下省略)' : body;
  return `${out}${dataFreshnessNote || staleNote}\n`;
}
if (isEntry(import.meta.url)) process.stdout.write(readAiNews());
