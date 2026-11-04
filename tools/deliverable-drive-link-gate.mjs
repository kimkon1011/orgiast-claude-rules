#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "deliverable-drive-link-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "deliverable-drive-link-gate"}]};
import fs from 'node:fs';
import path from 'node:path';
import { stripQuoted } from './handoff-info-guard.mjs';

const EXT = '(?:pdf|docx|xlsx|pptx|csv|png|jpg|jpeg|zip|html)';
const fileExtension = new RegExp(`\\.${EXT}$`, 'i');
const localFiles = new RegExp(`(?:[a-z]:[\\\\/]|/c/Users/|/mnt/c/)[^\\r\\n<>"\x60|]*?\\.${EXT}(?=$|[\\s\\]\\)<>"\x60、。」「』『“”])`, 'gi');
const urls = text => text.match(/https:\/\/(?:drive|docs)\.google\.com\/[^\s<>"`\]）)]+/g) || [];
const canonicalFile = file => file.replaceAll('\\', '/').replace(/^\/mnt\/c\//i, 'c:/').replace(/^\/c\//i, 'c:/').toLowerCase();
const reason = '成果物を Drive にアップし、最終メッセージの③の依頼と同じ箇所に URL（authuser=開く人のメール付き）を書いてください。例: node tools/drive-upload.mjs --file <path> --folder <folderId> --authuser <開く人のメール>。鍵が無い PC は rclone copyto <file> <remote>:<name> --drive-root-folder-id <folderId>（drive リモート）、または Drive MCP。全部失敗したら [DRIVE-UPLOAD-FAILED: <エラー本文>] を書いてください。';

export function judgeDeliverableDriveLink({ text = '', toolUses = [] } = {}) {
  const files = new Set();
  for (const tool of toolUses) {
    if (tool?.name !== 'SendUserFile') continue;
    const entries = tool.input?.files;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const file = typeof entry === 'string' ? entry : entry?.path ?? entry?.file_path ?? entry?.file;
      if (typeof file === 'string' && fileExtension.test(file)) files.add(canonicalFile(file));
    }
  }
  for (const match of text.matchAll(localFiles)) files.add(canonicalFile(match[0]));
  const result = { decision: 'pass', code: 'DELIVERABLE-DRIVE-LINK', files: [...files] };
  if ([...text.matchAll(/\[DRIVE-UPLOAD-FAILED:([^\]]*)\]/g)].some(m => [...m[1].trim()].length >= 20)) return result;
  const scannable = stripQuoted(text);
  const attachment = /端末[にへ]送りました|添付しました|添付のPDF|SendUserFile|チャットに送りました/i.test(scannable);
  const summary = scannable.indexOf('【最終まとめ】');
  const sections = summary < 0 ? [] : [...scannable.slice(summary).matchAll(/③[^\n]*(?:\n(?![ \t#*]*[①②③])[^\n]*)*/g)].map(m => m[0]);
  const requests = sections.filter(s => /PDF|書面|ファイル|資料|印刷|FAX|送付|提出|添付/i.test(s) && /してください|送って|印刷して|提出して|お願いします|していただ|してくださいませんか/.test(s));
  if (!files.size && !attachment && !requests.length) return result;
  const needed = Math.max(1, files.size);
  if (urls(text).length >= needed && requests.every(s => urls(s).length >= needed)) return result;
  return { ...result, decision: 'block', reason };
}

// Separate from the general retry budget: a successful check resets the streak.
export function registerDeliverableCheck({ home, sessionId, blocked }) {
  const file = path.join(home, '.claude', 'deliverable-drive-link-state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  const key = sessionId || 'unknown';
  for (const [id, value] of Object.entries(state)) if (value.at < Date.now() - 7 * 864e5) delete state[id];
  const count = blocked ? (state[key]?.count || 0) + 1 : 0;
  state[key] = { count: count > 3 ? 0 : count, at: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state) + '\n');
  return { count, capped: count > 3 };
}
