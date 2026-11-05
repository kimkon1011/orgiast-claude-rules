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
const deliverable = /PDF|書面|ファイル|資料|チラシ|フライヤー|画像|写真|初稿|第\d+稿|原稿|Doc|ドキュメント|スプレッドシート|シート|Excel|xlsx|見積|企画書|提案書|計画書|報告書|台本|デザイン|スライド|デッキ|リスト|一覧表|動画|告知|確認用|LP|ページ|印刷|FAX|送付|提出|添付/i;
const reviewAction = /見て|見せ|確認|チェック|レビュー|開いて|目を通|直し|修正|OK|よいですか|いいですか|返信|承認|送って|印刷|提出|添付|してください|お願いします|していただ|してくださいませんか/i;
const explicitNoUrl = /URLなし\s*[（(]\s*理由\s*[:：]\s*[^）)]+[）)]/i;
const reason = '成果物を Drive にアップし、最終メッセージの③の依頼と同じ箇所に URL（authuser=開く人のメール付き）を書いてください。② と ③ で見てもらう成果物は、その行に Drive の URL を書く（例: - チラシ初稿 PDF https://drive.google.com/file/d/…/view）。例: node tools/drive-upload.mjs --file <path> --folder <folderId> --authuser <開く人のメール>。鍵が無い PC は rclone copyto <file> <remote>:<name> --drive-root-folder-id <folderId>（drive リモート）、または Drive MCP。全部失敗したら [DRIVE-UPLOAD-FAILED: <エラー本文>] を書いてください。';

function summaryUnits(text) {
  const start = text.indexOf('【最終まとめ】');
  if (start < 0) return [];
  const units = [];
  let section = 0;
  let current = null;
  for (const line of text.slice(start).split(/\r?\n/)) {
    const heading = line.match(/^[ \t#*_]*([①②③])[^\n]*/);
    if (heading) {
      section = '①②③'.indexOf(heading[1]) + 1;
      current = null;
      continue;
    }
    if (section !== 2 && section !== 3) continue;
    if (/^\s*$/.test(line)) { current = null; continue; }
    if (/^\s*[-*+]\s+/.test(line) || !/^\s+/.test(line) || !current) {
      current = { section, text: line };
      units.push(current);
    } else {
      current.text += `\n${line}`;
    }
  }
  return units;
}

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
  const missingUnitLink = summaryUnits(scannable).some(unit => deliverable.test(unit.text) && reviewAction.test(unit.text) && !urls(unit.text).length && !explicitNoUrl.test(unit.text));
  if (missingUnitLink) return { ...result, decision: 'block', reason };
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
