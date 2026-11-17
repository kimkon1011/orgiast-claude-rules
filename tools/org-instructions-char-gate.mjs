#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"org-instructions-char-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"org-instructions-char-gate"}]};
// 2026-11-17: claude.ai の「組織の指示」は3,000字上限。2回目の実害（memory
// feedback_org_instructions_3000_char_cap）を防ぐため、組織指示への追記案を
// 含む応答に [ORG-CHARS: n/3000] の字数明記と全文差し替え判断を強制する。
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

// 組織指示に関する言及パターン
const ORG_INSTRUCTION = /組織(?:の)?指示/u;

// 追記・貼付に関する言及パターン（組織指示に追加/貼り付ける意図）
const APPEND_INTENT = /追記|貼(?:っ|る|り)|書き足[しす]/u;

// [ORG-CHARS: <n>/3000] マーカー
const ORG_CHARS_MARKER = /\[ORG-CHARS:\s*(\d+)\/3000\]/;

// 全文差し替えの明示を要求する（Ctrl+A だけでは代用しない）。
const FULL_REPLACE = /全文差し替え/u;

const REASON_BLOCK = '[ORG-CHARS] claude.ai の「組織の指示」は3,000字上限です。追記案を作る前に現行全文＋追記の字数を node tools/org-instructions-chars.mjs --file <全文テキスト> で数え、2,800字を超えるなら全文の短縮版（Ctrl+A→貼り替え）を Google ドキュメントで渡してください。字数を本文に [ORG-CHARS: n/3000] の形で明記してください。';
const REASON_FULL = '[ORG-CHARS] 現行全文＋追記の字数を node で数え、2,800字超なら全文の短縮版（Ctrl+A→貼り替え）を Google ドキュメントで渡し、本文に「全文差し替え」と [ORG-CHARS: n/3000] を書いてください。';

export function proseOf(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');
}

export function judge(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { decision: 'pass' };

  const prose = proseOf(raw);

  // 組織指示に関する言及がない → pass
  if (!ORG_INSTRUCTION.test(prose)) return { decision: 'pass' };

  // 追記・貼付に関する言及がない → pass
  if (!APPEND_INTENT.test(prose)) return { decision: 'pass' };

  // [ORG-CHARS: n/3000] マーカーを探す
  const markerMatch = raw.match(ORG_CHARS_MARKER);
  if (!markerMatch) {
    return { decision: 'block', code: 'ORG-CHARS', reason: REASON_BLOCK };
  }

  const charCount = parseInt(markerMatch[1], 10);
  const hasFullReplace = FULL_REPLACE.test(prose);

  // 2,800字超で全文差し替えがない → block
  if (charCount > 2800 && !hasFullReplace) {
    return { decision: 'block', code: 'ORG-CHARS-FULL', reason: REASON_FULL };
  }

  return { decision: 'pass' };
}

// CLI エントリポイント（テスト用 / 単体実行用）
if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdinWithTimeout();
    const input = JSON.parse(raw);
    const text = input.last_assistant_message ?? input.assistant_text ?? input.text ?? latestAssistantText(input.transcript_path);
    const result = judge(text);
    if (result.decision === 'block') console.log(JSON.stringify(result));
  } catch {}
}
