#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { lastAssistantText, readStdin } from './transcript-tail.mjs';

const DOC_EXTENSIONS = new Set(['.md', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.txt']);
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

// 中間生成物の置き場。ここは成果物ではないので警告しない
const SCRATCH_SEGMENTS = ['appdata/local/temp', '/tmp/', 'node_modules', '/.git/'];
// 人が開く場所。ここに置いた時点で「kim に渡すつもり」とみなす
const HUMAN_DIRS = ['/desktop/', '/documents/', '/downloads/', '/デスクトップ/', '/ドキュメント/'];

// markdown リンクになっていないローカルパス（バッククォート囲み・裸の絶対パス）を拾う。
// 2026-09-24: FAX送付状PDFをデスクトップに置き `C:\...\x.pdf` と書いたら素通りした実害への対応。
export function findBareLocalDocPaths(text) {
  const body = String(text || '');
  if (body.includes('[LOCAL-PATH-OK]')) return [];

  const hits = [];
  const seen = new Set();
  const patterns = [
    /`([^`\r\n]+)`/g,
    /(?:^|[\s（(「【、。])([A-Za-z]:[\\/][^\s`"'）)」】、。\r\n]+)/g,
  ];

  for (const re of patterns) {
    for (const match of body.matchAll(re)) {
      const raw = match[1].trim();
      if (!/^[A-Za-z]:[\\/]/.test(raw)) continue;
      const normalized = destinationPath(raw);
      const lower = normalized.toLowerCase();
      if (SCRATCH_SEGMENTS.some((segment) => lower.includes(segment))) continue;
      if (isInternalClaudePath(raw)) continue;

      const extension = destinationExtension(raw);
      if (CODE_EXTENSIONS.has(extension)) continue;

      const inHumanDir = HUMAN_DIRS.some((dir) => lower.includes(dir));
      // 文書ファイル、または人が開く場所のフォルダ（拡張子なし）を対象にする
      const isDoc = DOC_EXTENSIONS.has(extension);
      const isHumanFolder = inHumanDir && extension === '';
      if (!isDoc && !isHumanFolder) continue;

      if (seen.has(normalized)) continue;
      seen.add(normalized);
      hits.push({ label: raw, destination: raw });
    }
  }
  return hits;
}

export function formatBarePathMessage(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const detected = hits.slice(0, 3).map(({ destination }) => `  - ${destination}`).join('\n');
  return `[DOC-LINK-DRIVE-GUARD] kim に渡す成果物をローカルパスで案内しています（markdown リンクでなくても違反です）。\n\n検出（最大3件）:\n${detected}\n\nローカルのデスクトップに置いた成果物は kim のモバイル(Galaxy)から開けず、秘書チーム等の他人にも渡せません。Drive に上げて URL で渡してください（§2.9）。\n\n  - Drive MCP create_file の parentId: 1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si（標準フォルダ「作業ファイル」）\n  - kim へ渡す URL は drive.google.com/file/d/{ID}/view?authuser=kim@orgiast.jp\n  - アップ後は read-back で検証する\n\nローカルが中間生成物（scratchpad 等）で、kim が開く必要がないなら本文に [LOCAL-PATH-OK] を入れてください。`;
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
    const hits = findLocalDocLinks(lastAssistantText(input.transcript_path));
    const message = formatViolationMessage(hits);
    if (message) {
      console.error(message);
      process.exitCode = 2;
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main();
