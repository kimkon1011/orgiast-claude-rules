#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';

const DOC_EXTENSIONS = new Set(['.md', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.txt']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.ps1', '.py', '.gs', '.json', '.yml', '.yaml', '.sql', '.sh', '.cmd']);

function destinationExtension(destination) {
  const withoutFragmentOrQuery = destination.split(/[?#]/, 1)[0];
  const match = withoutFragmentOrQuery.match(/(\.[a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

export function findLocalDocLinks(text) {
  const body = String(text || '');
  if (body.includes('[LOCAL-PATH-OK]')) return [];

  const hits = [];
  const markdownLink = /\[([^\]\r\n]+)\]\(\s*(<[^>\r\n]+>|[^\s)]+)(?:\s+["'][^\r\n]*?["'])?\s*\)/g;
  for (const match of body.matchAll(markdownLink)) {
    const label = match[1];
    const destination = match[2].replace(/^<|>$/g, '');
    const normalized = destination.replaceAll('\\', '/').toLowerCase();
    const extension = destinationExtension(destination);
    if (/^(?:https?:\/\/|mailto:)/i.test(destination)) continue;
    if (normalized.includes('/memory/') || normalized.includes('.claude')) continue;
    if (/#L\d+/i.test(destination)) continue;
    if (CODE_EXTENSIONS.has(extension)) continue;
    if (!DOC_EXTENSIONS.has(extension)) continue;
    hits.push({ label, destination });
  }
  return hits;
}

export function formatViolationMessage(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const detected = hits.slice(0, 3).map(({ label, destination }) => `  - ${label} → ${destination}`).join('\n');
  return `[DOC-LINK-DRIVE-GUARD] kim が読む文書へのローカルパスリンクを検出しました。\n\n検出したリンク（最大3件）:\n${detected}\n\nkim が読む文書は Google Drive に上げて docs.google.com/a/orgiast.jp/document/d/{ID}/edit の URL で渡してください。\n\n作成方法:\n  - Drive MCP create_file の parentId: 1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si（標準フォルダ「作業ファイル」）\n  - contentMimeType: text/plain\n  - Markdown 記号（# - *）は Doc 変換でエスケープされて \\#\\# と表示されるため、本文はプレーン整形（■・など）で作る\n  - アップ後は read_file_content で read-back 検証する\n\n開発上の位置指定（ソース行を指す）なら path#L42 形式にするか、本文に [LOCAL-PATH-OK] を入れてください。`;
}

function readLastLines(file, count = 50, maxBytes = 256 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
  let raw = buffer.toString('utf8');
  if (stat.size > length) raw = raw.slice(raw.indexOf('\n') + 1);
  return raw.split(/\r?\n/).slice(-count);
}

function lastAssistantText(transcriptPath) {
  let latest = '';
  for (const line of readLastLines(transcriptPath)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    if (!message || (event.type !== 'assistant' && message.role !== 'assistant') || !Array.isArray(message.content)) continue;
    latest = message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
  }
  return latest;
}

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
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
