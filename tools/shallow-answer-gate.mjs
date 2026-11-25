#!/usr/bin/env node
export const GATE_CONTRACT = { "name": "shallow-answer-gate", "remedies": [{ "kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "shallow-answer-gate" }] };

import { currentTurnEntries, blocks } from './state-claim-evidence.mjs';
import { isEntry } from './is-entry.mjs';

const SHALLOW_CLAIM_PATTERN = /(?:ありませんでした|見つかりませんでした|存在しません|該当なし|0件|記載がありません)/;
const CODE_EXEMPT_PATTERN = /(?:エラー|バグ|ビルド|lint|構文|型エラー|テスト|失敗|差分|変更|コミット|未コミット|不具合|警告|warning)は(?:ありません|見つかり|存在し|0件)/i;

// 中身を開いて確認した「深い」ツール。ここに無い一覧系・検索系は浅い扱いになる。
const DEEP_TOOL_NAMES = new Set([
  'read_file_content', 'download_file_content', 'get_thread', 'get_message',
  'Read', 'read_file', 'WebFetch', 'web_fetch', 'pdftotext'
]);

// 件名・一覧・ファイル名しか見ない「浅い」ツール。証拠にならないので深い判定より先に落とす。
const SHALLOW_TOOL_NAMES = new Set([
  'search_files', 'search_threads', 'Glob', 'glob', 'get_file_metadata'
]);

function isDeepToolUse(block) {
  if (!block || typeof block !== 'object') return false;
  const name = String(block.name || '');
  if (!name) return false;

  // 浅いツールは最優先で false（search_files / search_threads / list_* / Glob / メタデータ取得）。
  if (SHALLOW_TOOL_NAMES.has(name) || /^list_/i.test(name) || /^search_/i.test(name)) return false;

  if (DEEP_TOOL_NAMES.has(name)) return true;

  if (/^mcp__/i.test(name)) {
    // 中身を返す MCP ツールだけを証拠とみなす（search_threads / list_* は該当しない）。
    if (/search_threads|list_/i.test(name)) return false;
    return /(?:read_file_content|download_file_content|get_thread|get_message|get_body|read_)/i.test(name);
  }

  // Grep は本文を出したときだけ深い。既定の files_with_matches と count は件名・一覧と同じ。
  if (/^(?:Grep|grep_search)$/i.test(name)) {
    return String(block.input?.output_mode || '').toLowerCase() === 'content';
  }

  // IMAP の FETCH ... BODY[TEXT] や本文を出すコマンドだけを証拠とみなす。
  // SEARCH と FETCH ... HEADER は件名・一覧しか見ていないので証拠にならない。
  if (/^(?:Bash|PowerShell|run_shell_command)$/i.test(name)) {
    const cmd = String(block.input?.command || block.input?.script || '');
    if (/BODY\[HEADER\]/i.test(cmd) || (/\bSEARCH\b/i.test(cmd) && !/BODY\[TEXT\]/i.test(cmd))) {
      return false;
    }
    return /\b(?:cat|head|tail|pdftotext)\b/i.test(cmd) || /BODY\[TEXT\]/i.test(cmd);
  }

  return false;
}

export function evaluateShallowAnswer(input = {}) {
  const { text, transcriptRaw, raw } = typeof input === 'string' ? { text: input } : (input || {});
  const source = String(text || '');
  if (!source.trim()) return { decision: 'pass', reason: 'empty-text' };

  // 脱出弁は他のどの条件よりも優先する。`[DEPTH-OK]` 単体でも `[DEPTH-OK: 理由]` でも効く
  if (/\[DEPTH-OK/i.test(source)) {
    return { decision: 'pass', reason: 'depth-ok-exempt' };
  }

  if (!SHALLOW_CLAIM_PATTERN.test(source)) {
    return { decision: 'pass', reason: 'no-shallow-claim' };
  }

  if (CODE_EXEMPT_PATTERN.test(source)) {
    return { decision: 'pass', reason: 'own-code-negative-exempt' };
  }

  const tr = transcriptRaw || raw;
  if (tr) {
    const entries = currentTurnEntries(tr);
    const toolUses = blocks(entries, 'tool_use');
    const hasDeepTool = toolUses.some(isDeepToolUse);

    if (hasDeepTool) {
      return { decision: 'pass', reason: 'deep-tool-used' };
    }
  }

  return {
    decision: 'block',
    code: 'SHALLOW-ANSWER',
    reason: `[SHALLOW-ANSWER] 表面的な検索（件名・一覧・ファイル名のみ）で「ありません」「これだけです」と結論づけています。\n\n中身を開いて確認した証拠（read_file_content / get_message / WebFetch / 本文の取得）がありません。\n件名・一覧に記載が無くても、本文中に目的の情報が含まれている場合があります（例: 件名が「見積もり」でなくても本文に100,000円の記載がある）。\n\nやること: 候補となるメッセージ・ファイルの中身を開いて確認し、本文を読んだ上で回答してください。\nどうしても確認不能な場合は、本文に [DEPTH-OK: 理由] を明記してください。`
  };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const input = JSON.parse(raw);
    const text = input.assistant_text || input.text || '';
    const transcriptRaw = input.transcript_raw || input.raw || '';
    const result = evaluateShallowAnswer({ text, transcriptRaw });
    if (result.decision === 'block') {
      console.log(JSON.stringify(result));
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main();
