#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';

// 2026-10-02 実害: 社外宛メールの下書きに Google スプレッドシートの使い方を書いたが、
// 根拠は17日前に読んだソースコードで、その間に別セッションがシートを大改修していた
// (タブ新設・改名)。Drive コネクタは接続済みで get_file_permissions は3回叩いていたのに、
// 中身は一度も読んでいなかった。権限照会を「中身を見た」と錯覚するのが罠。
export const GMAIL_WRITE_ACTIONS = ['create_draft', 'update_draft', 'send_message', 'reply', 'forward'];
export const TARGET = new RegExp(`^mcp__claude_ai_Gmail(?:_\\d+)?__(${GMAIL_WRITE_ACTIONS.join('|')})$`);
export const SHELL_TOOLS = 'Bash|PowerShell';
export const SHELL_TOOL = new RegExp(`^(?:${SHELL_TOOLS})$`);
// register-hooks.mjs は add() がスクリプト名(basename)で重複判定し、syncMatcherFor が
// 同スクリプトを含む全 group の matcher をこの値へ上書きする。Gmail 用と Bash 用の2本登録は
// できないため、matcher は1本に合成する(internal-recipient-gmail-guard と同じ流儀)。
export const HOOK_MATCHER = `${TARGET.source.replace(/^\^/, '').replace(/\$$/, '')}|${SHELL_TOOLS}`;

// 中身を読んだ証拠として扱う Drive ツール。get_file_permissions / get_file_metadata /
// share_file / search_files は「権限・所在」しか見ておらず中身の確認にならないので除外する。
export const READ_TOOLS = new Set([
  'mcp__claude_ai_Google_Drive__read_file_content',
  'mcp__claude_ai_Google_Drive__download_file_content',
]);
// サブエージェントに読ませたケース(今回の正しい直し方)を証拠にする。
export const AGENT_TOOLS = new Set(['Agent', 'Task']);
// Bash/PowerShell 経由の読み出し。ID と読み出し動詞の両方が要る。
const SHELL_READ = /gdoc|sheets|read|export|download/i;
const WINDOW_MS = 6 * 60 * 60 * 1000;
const OVERRIDE_FILE = 'live-artifact-read-override';

// docs.google.com の各サービス URL と drive.google.com/file/d/<ID>。
// `/a/<domain>/` 付き(組織アカウント)も許容する。
const URL_PATTERN = /https:\/\/docs\.google\.com\/(?:a\/[^/\s"'<>]+\/)?(spreadsheets|document|presentation|forms)\/d\/([A-Za-z0-9_-]{20,})|https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/g;
const KIND_LABEL = { spreadsheets: 'Sheets', document: 'Docs', presentation: 'Slides', forms: 'Forms', file: 'Drive' };

export function extractArtifacts(text) {
  const found = new Map();
  for (const match of String(text ?? '').matchAll(new RegExp(URL_PATTERN.source, URL_PATTERN.flags))) {
    const kind = match[1] || 'file';
    const id = match[2] || match[3];
    if (!found.has(id)) found.set(id, { id, kind, label: KIND_LABEL[kind] || kind });
  }
  return [...found.values()];
}

// `--body "<...>"` の値、または `--body-file <path>` のファイル内容を本文とする。
// ファイルが読めなければ null を返し、呼び出し側で allow(誤爆より通す)に倒す。
export function extractShellBody(command, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const text = String(command ?? '');
  if (!/gmail-draft(?:\.mjs)?\b/.test(text)) return null;
  const body = text.match(/--body(?!-file)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (body) return body[1] ?? body[2] ?? body[3] ?? '';
  const file = text.match(/--body-file\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (!file) return null;
  const target = file[1] ?? file[2] ?? file[3];
  try { return readFile(target); } catch { return null; }
}

function toolUses(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content.filter((block) => block?.type === 'tool_use') : [];
}

function isReadEvidence(block, id) {
  const name = String(block?.name || '');
  const input = block?.input || {};
  if (READ_TOOLS.has(name)) return String(input.fileId || '') === id;
  if (AGENT_TOOLS.has(name)) return String(input.prompt || '').includes(id);
  if (SHELL_TOOL.test(name)) {
    const command = String(input.command || '');
    return command.includes(id) && SHELL_READ.test(command);
  }
  return false;
}

// transcript の JSONL を読み、各 ID について直近 WINDOW_MS 以内の「中身を読んだ」証拠を探す。
// 読めない/壊れている場合は null を返し、呼び出し側で allow に倒す。
export function findUnreadIds(transcriptPath, ids, now = Date.now()) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const read = new Set();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const timestamp = Date.parse(entry?.timestamp);
    if (!Number.isFinite(timestamp) || now - timestamp > WINDOW_MS) continue;
    for (const block of toolUses(entry)) {
      for (const id of ids) if (!read.has(id) && isReadEvidence(block, id)) read.add(id);
    }
  }
  return ids.filter((id) => !read.has(id));
}

export function overrideActive(home, now = Date.now()) {
  let raw;
  try { raw = fs.readFileSync(path.join(home, '.claude', OVERRIDE_FILE), 'utf8'); } catch { return false; }
  const first = raw.split(/\r?\n/)[0].trim();
  const expiry = Date.parse(first);
  return Number.isFinite(expiry) && now < expiry;
}

export function judge(hookInput, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), readFile } = {}) {
  const toolName = hookInput?.tool_name || '';
  const input = hookInput?.tool_input || {};
  let body = null;
  if (TARGET.test(toolName)) body = `${input.body ?? ''}\n${input.htmlBody ?? ''}`;
  else if (SHELL_TOOL.test(toolName)) body = extractShellBody(input.command, readFile);
  if (body === null) return { decision: 'pass', ids: [], unread: [] };
  const artifacts = extractArtifacts(body);
  if (!artifacts.length) return { decision: 'pass', ids: [], unread: [] };
  if (overrideActive(home, now)) return { decision: 'pass', ids: artifacts.map((a) => a.id), unread: [], override: true };
  const unread = findUnreadIds(hookInput?.transcript_path, artifacts.map((a) => a.id), now);
  if (unread === null) return { decision: 'pass', ids: artifacts.map((a) => a.id), unread: [], transcriptUnreadable: true };
  if (!unread.length) return { decision: 'pass', ids: artifacts.map((a) => a.id), unread: [] };
  const detail = unread.map((id) => `${id}（${artifacts.find((a) => a.id === id).label}）`).join(', ');
  const reason = `[LIVE-ARTIFACT-READ-GATE] メール本文で説明している Google ファイルを、直近6時間に一度も中身として読んでいません。\n未読の ID: ${detail}\n説明文はコード・過去の下書き・記憶ではなく、現物と突き合わせてから出してください。\nSheets ならタブ一覧＋各タブ1〜2行目＋凡例タブを読み（データ行は不要）、本文のタブ名・列記号・見出しを1つずつ照合する。\n権限照会（get_file_permissions / get_file_metadata）は中身の確認になりません。`;
  return { decision: 'block', ids: artifacts.map((a) => a.id), unread, reason };
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const result = judge(input);
    if (result.transcriptUnreadable) console.error('[LIVE-ARTIFACT-READ-GATE] transcript を読めないため判定をスキップしました。');
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch {
    console.error('[LIVE-ARTIFACT-READ-GATE] 入力または transcript を読めないため判定をスキップしました。');
  }
}

if (isEntry(import.meta.url)) await main();
