#!/usr/bin/env node
export const GATE_CONTRACT = { "name": "japanese-response-gate", "remedies": [{ "kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "japanese-response-gate" }] };
// 2026-10-18: 当日アプリの修正セッションで、Claude の応答が途中から英語に切り替わり、
// user（cr）が「なんで途中から英語なの？」と指摘した。全PC・全アカウントで応答は日本語に固定する。
// settings.json の language=japanese（register-hooks が全PCへ配布）に加え、応答末尾でも機械的に検査する。
import { isEntry } from './is-entry.mjs';

const MIN_LATIN_LETTERS = 80;
const MIN_JAPANESE_RATIO = 0.3;

// コード・URL・パス・ID は英字でも本文の言語とは無関係なので数えない。
export function proseOf(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s)]*/g, ' ')
    .replace(/(?:^|\s)[~.]?\/[\w./-]+/g, ' ')
    .replace(/\[[A-Z][A-Z0-9-]+(?::[^\]]*)?\][^\n]*/g, ' ');
}

export function measure(text) {
  const prose = proseOf(text);
  const japanese = (prose.match(/[぀-ヿ㐀-鿿ｦ-ﾟ]/g) || []).length;
  const latin = (prose.match(/[A-Za-z]/g) || []).length;
  // 英字2文字を日本語1文字ぶんの情報量として比べる（日本語の役割名が数語混じる英文を通さないため）。
  return { japanese, latin, ratio: japanese / Math.max(1, japanese + latin / 2) };
}

// user が英語での返答を明示した場合だけ [EN-OK] で例外にできる。
export function judge(text) {
  const raw = String(text || '');
  if (!raw.trim() || /\[EN-OK\]/.test(raw)) return { decision: 'pass' };
  const { japanese, latin, ratio } = measure(raw);
  if (latin < MIN_LATIN_LETTERS || ratio >= MIN_JAPANESE_RATIO) return { decision: 'pass', japanese, latin, ratio };
  return {
    decision: 'block',
    code: 'JAPANESE-ONLY',
    reason: `[JAPANESE-ONLY] 応答が日本語になっていません（日本語 ${japanese} 字・英字 ${latin} 字）。全PC・全アカウント共通ルール: user への応答は必ず日本語で書く（cr 2026-10-18）。同じ内容を日本語で書き直すこと。コード・コマンド・固有名詞は英字のままでよい。user が英語を明示した場合だけ本文に [EN-OK] を書く。`,
  };
}

// hook 入力は JSON。tool_input.command などの英字を応答本文と誤認しないよう、
// 応答本文（assistant_text / text）だけを判定し、block のときだけ出力する。
if (isEntry(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const input = JSON.parse(raw);
    const text = input.assistant_text || input.text || '';
    const result = judge(text);
    if (result.decision === 'block') console.log(JSON.stringify(result));
  } catch {}
}
