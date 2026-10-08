#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { lastAssistantText, readStdin } from './transcript-tail.mjs';

const DOC_EXTENSIONS = new Set(['.md', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.txt']);
const BARE_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.png', '.jpg', '.jpeg', '.zip']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.ps1', '.py', '.gs', '.json', '.yml', '.yaml', '.sql', '.sh', '.cmd']);
const INTERNAL_DIRECTORY_SEGMENTS = new Set(['memory', 'projects', 'shell-snapshots', 'todos', 'skills', 'agents', 'commands', 'plugins']);
const INTERNAL_FILENAMES = new Set(['claude.md', 'next-session.md']);

function destinationPath(destination) {
  return destination.split(/[?#]/, 1)[0].replaceAll('\\', '/');
}

function destinationExtension(destination) {
  const match = destinationPath(destination).match(/(\.[a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

function isInternalClaudePath(destination) {
  const segments = destinationPath(destination).toLowerCase().split('/');
  const filename = segments.at(-1);
  return segments.slice(0, -1).some((segment) => INTERNAL_DIRECTORY_SEGMENTS.has(segment))
    || INTERNAL_FILENAMES.has(filename);
}

export function findLocalDocLinks(text) {
  const body = String(text || '');
  if (body.includes('[LOCAL-PATH-OK]')) return [];

  const hits = [];
  const markdownLink = /\[([^\]\r\n]+)\]\(\s*(<[^>\r\n]+>|[^\s)]+)(?:\s+["'][^\r\n]*?["'])?\s*\)/g;
  for (const match of body.matchAll(markdownLink)) {
    const label = match[1];
    const destination = match[2].replace(/^<|>$/g, '');
    const extension = destinationExtension(destination);
    if (/^(?:https?:\/\/|mailto:)/i.test(destination)) continue;
    if (isInternalClaudePath(destination)) continue;
    if (/#L\d+/i.test(destination)) continue;
    if (CODE_EXTENSIONS.has(extension)) continue;
    if (!DOC_EXTENSIONS.has(extension)) continue;
    hits.push({ label, destination });
  }
  return hits;
}

const FENCE = /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g;
const TEMP_PATH = /(?:^|[\\/])(?:scratchpad|temp|tmp)(?:[\\/]|$)|AppData[\\/]Local[\\/]Temp/i;

// バッククォートや裸の絶対パス（Desktop 等）で渡された成果物ファイルを検出する。
export function findBareLocalDocPaths(text) {
  const body = String(text || '');
  if (body.includes('[LOCAL-PATH-OK]')) return [];
  const prose = body.replace(FENCE, '');
  const found = new Set();
  const accept = (raw) => {
    const candidate = raw.trim().replace(/[。、，,.;:）)」』]+$/, '');
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|~[\\/])/.test(candidate)) return;
    if (/^https?:/i.test(candidate)) return;
    if (!BARE_EXTENSIONS.has(destinationExtension(candidate))) return;
    if (TEMP_PATH.test(candidate)) return;
    if (isInternalClaudePath(candidate)) return;
    found.add(candidate);
  };
  for (const match of prose.matchAll(/`([^`\r\n]+)`/g)) accept(match[1]);
  const bare = new RegExp(String.raw`(?:[A-Za-z]:[\\/]|\\\\)[^\s` + '`' + String.raw`"'<>|*?（）()「」]+?\.(?:pdf|docx|xlsx|pptx|csv|png|jpe?g|zip)(?![A-Za-z0-9])`, 'gi');
  for (const match of prose.matchAll(bare)) accept(match[0]);
  return [...found].map((destination) => ({ destination }));
}

export function formatBarePathMessage(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const detected = hits.slice(0, 3).map(({ destination }) => `  - ${destination}`).join('\n');
  return `[DOC-LINK-DRIVE-GUARD] 成果物ファイルのローカルパス（Desktop 等）を渡そうとしています。\n\n検出したパス（最大3件）:\n${detected}\n\nユーザー・他人に渡す成果物は Google Drive にアップして URL で渡してください（ローカルパス・SendUserFile・チャット添付だけは未完了）。\n  - 案件のデータはその案件の制作フォルダ、案件外は「作業ファイル」(1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si)\n  - アップロード: Drive MCP create_file、または node tools/drive-upload.mjs --file <path> --folder <folderId>\n  - 内部作業用でユーザーに渡さないパスなら本文に [LOCAL-PATH-OK] を入れてください。`;
}

export function formatViolationMessage(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const detected = hits.slice(0, 3).map(({ label, destination }) => `  - ${label} → ${destination}`).join('\n');
  return `[DOC-LINK-DRIVE-GUARD] kim が読む文書へのローカルパスリンクを検出しました。\n\n検出したリンク（最大3件）:\n${detected}\n\nkim が読む文書は Google Drive に上げて docs.google.com/a/orgiast.jp/document/d/{ID}/edit の URL で渡してください。\n\n作成方法:\n  - Drive MCP create_file の parentId: 1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si（標準フォルダ「作業ファイル」）\n  - contentMimeType: text/plain\n  - Markdown 記号（# - *）は Doc 変換でエスケープされて \\#\\# と表示されるため、本文はプレーン整形（■・など）で作る\n  - アップ後は read_file_content で read-back 検証する\n\n開発上の位置指定（ソース行を指す）なら path#L42 形式にするか、本文に [LOCAL-PATH-OK] を入れてください。`;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input.stop_hook_active || !input.transcript_path || !fs.existsSync(input.transcript_path)) return;
    const text = lastAssistantText(input.transcript_path);
    const message = formatViolationMessage(findLocalDocLinks(text)) || formatBarePathMessage(findBareLocalDocPaths(text));
    if (message) {
      console.error(message);
      process.exitCode = 2;
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main();
