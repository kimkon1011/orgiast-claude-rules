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
const deliverable = /PDF|書面|ファイル|資料|チラシ|フライヤー|画像|写真|初稿|第\d+稿|原稿|\bDoc\b|ドキュメント|スプレッドシート|シート|Excel|xlsx|見積|企画書|提案書|計画書|報告書|台本|デザイン|スライド|デッキ|リスト|一覧表|動画|告知|LP|ページ|印刷|FAX|送付|提出|添付/i;
const reviewAction = /見て|見せ|確認|チェック|レビュー|開いて|目を通|直し|修正|\bOK\b|よいですか|いいですか|返信|承認|送って|印刷|提出|添付|してください|お願いします|していただ|してくださいませんか/i;
const explicitNoUrl = /URLなし\s*[（(]\s*理由\s*[:：]\s*[^）)]+[）)]/i;
const reason = '成果物を Drive にアップし、最終メッセージの③の依頼と同じ箇所に URL（authuser=開く人のメール付き）を書いてください。② と ③ で見てもらう成果物は、その行に Drive の URL を書く（例: - チラシ初稿 PDF https://drive.google.com/file/d/…/view）。例: node tools/drive-upload.mjs --file <path> --folder <folderId> --authuser <開く人のメール>。鍵が無い PC は rclone copyto <file> <remote>:<name> --drive-root-folder-id <folderId>（drive リモート）、または Drive MCP。全部失敗したら [DRIVE-UPLOAD-FAILED: <エラー本文>] を書いてください。';

const approvalWord = /承認|よいですか|いいですか|送ってよい|どれ|選ん[でだ]|確認してください|確認をお願い|判断|\bOK\b/i;
const planName = /[梅竹松]|案\s*(?:[0-9０-９]+|[A-ZＡ-Ｚ])|[A-ZＡ-Ｚ]\s*案/gi;
const deliverableApprovalItem = /[梅竹松]|案\s*(?:[0-9０-９]+|[A-ZＡ-Ｚ])|[A-ZＡ-Ｚ]\s*案|パース|提案書|見積|スライド|メール本文|草案|案文|\bPDF\b|画像|\bDocs?\b|ドキュメント|デザイン|プラン|図面|レイアウト|イメージ|チラシ|フライヤー|企画書|企画案/i;
const approvalNoUrl = /URLなし\s*[（(]\s*理由\s*[:：]\s*[^\s）)][^）)]*[）)]/i;
const approvalReason = '成果物ごとの実物URL（Drive）を承認項目の同じ行（または直後2行以内）に書いてください。見つからなければ Drive へアップし直す。URLには authuser=<開く人のメール> を付け、近傍に「<メール> で開いてください」と書いてください。例外は「URLなし（理由: …）」と明記します。';

function validApprovalUrls(text, guidance) {
  const accountGuidance = guidance.replace(/https?:\/\/[^\s<>"`\]）)]+/g, '');
  return urls(text).flatMap(raw => {
    try {
      const url = new URL(raw);
      if (!['drive.google.com', 'docs.google.com'].includes(url.hostname) || url.username || url.password) return [];
      const account = url.searchParams.get('authuser');
      if (!account || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) return [];
      const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?<![\\w.+@-])${escaped}\\s*で開いてください`, 'i').test(accountGuidance)) return [];
      // 同一ファイルのURLを繰り返して複数成果物の代わりにはできない。
      const id = url.pathname.match(/\/d\/([^/]+)/)?.[1]
        || (url.hostname === 'drive.google.com' && url.pathname === '/open' ? url.searchParams.get('id') : null);
      return id ? [id] : [];
    } catch { return []; }
  });
}

function requiredApprovalUrlCount(line) {
  // 複合名（提案書PDF・メール本文の草案Doc）は1成果物として扱う。
  return line.split(/[、,／/・＆&＋+]|および|及び|ならびに|と/).reduce((count, item) => {
    if (!deliverableApprovalItem.test(item)) return count;
    const plans = [...item.matchAll(planName)].map(match => match[0].normalize('NFKC').replace(/\s/g, '').toUpperCase());
    return count + Math.max(1, new Set(plans).size);
  }, 0);
}

function approvalText(text) {
  const blank = value => value.replace(/[^\r\n]/g, ' ');
  // 引用の行数を保持し、遠いURLが「直後2行」に繰り上がらないようにする。
  let fence = null;
  text = text.split(/\r?\n/).map(line => {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
      return blank(line);
    }
    const start = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (start) { fence = { char: start[1][0], length: start[1].length }; return blank(line); }
    return /^\s*>/.test(line) ? blank(line) : line;
  }).join('\n');
  return text.replace(/“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』|`[^`]*`/g,
    quoted => stripQuoted(quoted) === quoted ? quoted : blank(quoted));
}

function summaryUnits(text) {
  const start = text.indexOf('【最終まとめ】');
  if (start < 0) return [];
  const units = [];
  let section = 0;
  let current = null;
  let afterBlank = false;
  for (const line of text.slice(start).split(/\r?\n/)) {
    const heading = line.match(/^[ \t#*_]*([①②③])[^\n]*/);
    if (heading) {
      section = '①②③'.indexOf(heading[1]) + 1;
      current = null;
      afterBlank = false;
      continue;
    }
    if (section !== 2 && section !== 3) continue;
    if (/^\s*$/.test(line)) { current = null; afterBlank = true; continue; }
    if (section === 3 && afterBlank && /^(?:障害時アナログ運営:|\s*-\s*\*\*(?:この後の自動進行|このセッション|恒久策):\*\*)/.test(line)) {
      section = 0;
      current = null;
      continue;
    }
    if (/^\s*【[^】]+】\s*$/.test(line)) { current = null; continue; }
    if (/^\s*[-*+]\s+/.test(line) || !/^\s+/.test(line) || !current) {
      current = { section, text: line };
      units.push(current);
    } else {
      current.text += `\n${line}`;
    }
  }
  return units;
}

/**
 * 承認コンテキストのチェック:
 * 最終メッセージに承認語があれば成果物の各行を確認する。
 * 次の項目のURL・例外理由を流用せず、直後2行までの継続行だけを使う。
 */
function judgeApprovalContext(text) {
  const hasApprovalRequest = approvalWord.test(text);
  const approvalHeading = /^\s*(?:#+\s+)?\**【kim 確認用の全文】\**\s*$/i;
  if (!hasApprovalRequest && !text.split(/\r?\n/).some(line => approvalHeading.test(line))) return 'pass';
  let summarySection = '';
  let inApprovalBlock = false;
  const lines = text.split(/\r?\n/).map(line => {
    const section = line.match(/^[ \t#*_]*([①②③])/);
    if (section) summarySection = section[1];
    if (section || /^\s*(?:#+\s|\**【[^】]+】\**\s*$)/.test(line)) {
      inApprovalBlock = approvalHeading.test(line);
      return line;
    }
    if ((!hasApprovalRequest && !inApprovalBlock) || (summarySection === '①' && !inApprovalBlock) || /^(?:\s*[-*+]?\s*\**)(?:この後の自動進行|このセッション|恒久策)[:：]/.test(line)) return '';
    return line;
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/https?:\/\/[^\s<>"`\]）)]+/g, '');
    if (/^\s*(?:#+\s|【[^】]+】\s*$|[\t#*_]*[①②③])/.test(line) || !deliverableApprovalItem.test(line)) continue;
    let end = i + 1;
    while (end < Math.min(i + 3, lines.length)) {
      const next = lines[end].replace(/https?:\/\/[^\s<>"`\]）)]+/g, '');
      if (deliverableApprovalItem.test(next) || /^\s*(?:[-*+]\s|\d+[.)]\s|[#【①②③])/.test(next)) break;
      end++;
    }
    const context = lines.slice(i, end).join('\n');
    if (approvalNoUrl.test(context)) continue;
    const identities = new Set();
    for (let row = i; row < end; row++) {
      for (const id of validApprovalUrls(lines[row], lines.slice(Math.max(0, row - 1), row + 2).join('\n'))) identities.add(id);
    }
    if (identities.size < requiredApprovalUrlCount(line)) {
      return 'block';
    }
  }
  return 'pass';
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
  if (judgeApprovalContext(approvalText(text)) === 'block') return { ...result, decision: 'block', reason: approvalReason };
  if ([...text.matchAll(/\[DRIVE-UPLOAD-FAILED:([^\]]*)\]/g)].some(m => [...m[1].trim()].length >= 20)) return result;
  const scannable = stripQuoted(text.replace(/^\s*>[^\r\n]*/gm, ''));
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
