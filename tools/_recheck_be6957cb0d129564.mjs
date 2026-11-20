#!/usr/bin/env node
// handoff-audit 指摘 be6957cb0d129564（恒久修正の先送り文）の再発検証
// 読み取りのみ。送信・権限変更・本番デプロイはしない。
import fs from 'node:fs';
import path from 'node:path';
import { detect } from './permanent-fix-deferral-scan.mjs';

const SINCE = '2026-11-19T14:09:00.000Z';
const PROJECTS_DIR = path.resolve(process.env.ORGIAST_HOME || process.env.USERPROFILE || 'C:\\Users\\user', '.claude', 'projects');
const SINCE_TS = Date.parse(SINCE);

function* walkJsonl(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(full);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= SINCE_TS) yield full;
    }
  }
}

function extractTextFromEntry(obj) {
  const message = obj?.message;
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b?.type === 'text')
      .map(b => b?.text ?? '')
      .join('\n');
  }
  return '';
}

// 末尾の3行フッター（「次に kim がすること」「この後の自動進行」「このセッション」）
// だけのメッセージは handoff ではなく定型行なので、P3 の検出時に除外するためコンテキストも含める
function isFooterOnly(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 3) return false;
  const last3 = lines.slice(-3);
  return last3.every(l => /^次に kim がすること|^この後の自動進行|^このセッション/.test(l.trim()));
}

const results = [];
const allFiles = [];
const allHits = [];

for (const file of walkJsonl(PROJECTS_DIR)) {
  allFiles.push(file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  let fileHits = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = obj.timestamp || '';
    if (ts < SINCE) continue;

    const text = extractTextFromEntry(obj);
    if (!text) continue;

    const found = detect(text);
    if (found.length) {
      for (const f of found) {
        // P3 で「次に kim がすること: なし」は除外（permanent-fix-deferral-scan.mjs の P3.find が除外するはずだが安全策）
        if (f.pattern === 'P3') {
          const match = f.match;
          const afterHandoff = text.slice(match.index + match[0].length, match.index + match[0].length + 80).split('\n')[0].trim();
          if (/^なし/.test(afterHandoff)) continue;
        }
        fileHits.push({
          pattern: f.pattern,
          sessionId: obj.sessionId || '',
          timestamp: ts,
          match: f.match[0].slice(0, 120),
          excerpt: text.slice(Math.max(0, f.match.index - 40), f.match.index + f.match[0].length + 40).replace(/\n/g, '↵'),
        });
      }
    }
  }

  if (fileHits.length) {
    allHits.push(...fileHits);
    results.push({ file, hits: fileHits.length, details: fileHits });
  }
}

// 集計
const byPattern = {};
for (const h of allHits) {
  byPattern[h.pattern] = (byPattern[h.pattern] || 0) + 1;
}

console.log(JSON.stringify({
  since: SINCE,
  filesScanned: allFiles.length,
  filesWithHits: results.length,
  totalHits: allHits.length,
  byPattern,
  hits: allHits.map(h => ({
    file: path.relative(PROJECTS_DIR, h.file || ''),
    pattern: h.pattern,
    sessionId: h.sessionId,
    timestamp: h.timestamp,
    match: h.match,
    excerpt: h.excerpt,
  })),
}, null, 2));