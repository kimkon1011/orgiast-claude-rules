#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"cmd-ascii-guard","remedies":[{"kind":"command","ref":"node tools/make-desktop-launcher.mjs --name <名前> --ps-file <絶対パス.ps1>（手書きの .cmd は英数字だけにし、日本語は .ps1/.mjs 側へ）。例外は内容に [CMD-NONASCII-OK: <理由>]"}]};
// cmd.exe はバッチを既定コードページ(CP932)とバイトオフセットで読むため、chcp 65001 を書いても
// 日本語行以降が壊れ「内部コマンドまたは外部コマンド…」で全行失敗する（2026-11-04 kim-PC 実害）。
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

const BATCH_FILE = /\.(?:cmd|bat)$/i;
const NON_ASCII = /[^\x00-\x7F]/;
const OVERRIDE = /\[CMD-NONASCII-OK:[ \t]*([^\]\r\n]*)\]/;

export const REASON = '.cmd/.bat に日本語などの非ASCII文字があります。cmd.exe はバッチを CP932 で読むため chcp 65001 を書いても文字化けし、全行が実行されません（2026-11-04 kim-PC 実害）。.cmd は英数字だけで書き、日本語の案内・処理は .ps1 か .mjs 側に置いてください。デスクトップに置く起動ファイルは手書きせず `node tools/make-desktop-launcher.mjs --name <名前> --ps-file <絶対パス.ps1>` で作る（CRLF・chcp 先頭・日本語パスを Windows 実行テスト済み）。例外は内容に `[CMD-NONASCII-OK: <理由>]` を含める。';

function insertedTexts(toolName, input = {}) {
  if (toolName === 'Write') return [input.content];
  if (toolName === 'Edit') return [input.new_string];
  if (toolName === 'MultiEdit') return (input.edits || []).map(edit => edit?.new_string);
  return [];
}

export function evaluate(payload = {}) {
  const input = payload.tool_input || {};
  if (!BATCH_FILE.test(String(input.file_path || ''))) return null;
  const texts = insertedTexts(payload.tool_name, input).filter(text => typeof text === 'string');
  if (!texts.some(text => NON_ASCII.test(text))) return null;
  if (texts.some(text => [...(text.match(OVERRIDE)?.[1]?.trim() || '')].length >= 5)) return null;
  return REASON;
}

if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdinWithTimeout();
    if (raw) {
      const reason = evaluate(JSON.parse(raw));
      if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    }
  } catch { /* Fail open on malformed input. */ }
}
