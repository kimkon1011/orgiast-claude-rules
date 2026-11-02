export const GATE_CONTRACT = {"name":"response-language-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"response-language-gate"}]};

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const LATIN = /\p{Script=Latin}/gu;
const JAPANESE_INPUT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const REASON = '応答が日本語ではありません。user の言語設定は日本語です。説明文・報告・質問はすべて日本語で書き直してください（コード・識別子・コマンドは原文のままでよい）。Stop hook の差し戻しで書き直すときも日本語を保つこと。';

function homeDir(opts = {}) {
  return opts.home || process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir();
}

function readSettings(opts = {}) {
  if (opts.settings !== undefined) return opts.settings || {};
  try { return JSON.parse(fs.readFileSync(path.join(homeDir(opts), '.claude', 'settings.json'), 'utf8')); }
  catch { return {}; }
}

export function configuredMode(opts = {}) {
  const raw = String(opts.mode ?? process.env.ORGIAST_RESPONSE_LANGUAGE_GATE ?? 'block').toLowerCase();
  return ['off', 'warn', 'block'].includes(raw) ? raw : 'block';
}

// 2026-10-26 実害: 本文が英語でも、Stop gate が必須にする日本語の定型フッター
// （次に kim がすること / この後の自動進行 / このセッション / 恒久策）が日本語として数えられ、比率が上がって素通りした。
// 定型行と [NO-TEST-OK: …] 等のタグ行は本文の言語と無関係なので数えない。
const BOILERPLATE_LINE = /^[ \t>*-]*(?:次に\s*\S{0,20}\s*がすること|この後の自動進行|このセッション|恒久策|残\s*TODO)\s*[:：].*$|^[ \t]*\[[A-Z][A-Z0-9-]+(?::[^\]]*)?\][ \t]*$/gmu;

export function proseOf(text) {
  return String(text || '')
    .replace(BOILERPLATE_LINE, ' ')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gmu, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>)]+/giu, ' ')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s<>()"']+/g, ' ')
    .replace(/(?:^|\s)(?:~?\/|\.\.?\/)[^\s<>()"']+/g, ' ');
}

export function measureResponseLanguage(text) {
  const prose = proseOf(text);
  const japanese = (prose.match(JAPANESE) || []).length;
  const latin = (prose.match(LATIN) || []).length;
  return { japanese, latin, ratio: japanese / Math.max(1, japanese + latin) };
}

// ツール呼び出しの合間の途中経過も user に見えるため、最終メッセージだけでなくターン内の発言を1件ずつ判定する
// （2026-11-02 実測: 途中経過の英語が最終メッセージだけの検査を素通りしていた）。
export function judgeTurnLanguage(texts, humanText, opts = {}) {
  for (const text of texts) {
    const result = judgeResponseLanguage(text, humanText, opts);
    if (result.decision !== 'pass') return result;
  }
  return { decision: 'pass' };
}

export function judgeResponseLanguage(assistantText, humanText, opts = {}) {
  const mode = configuredMode(opts);
  if (mode === 'off') return { decision: 'pass' };
  const language = String(readSettings(opts).language || '').toLowerCase();
  const expectsJapanese = language === 'japanese' || language === '日本語' || JAPANESE_INPUT.test(String(humanText || ''));
  if (!expectsJapanese) return { decision: 'pass' };
  const { japanese, latin, ratio } = measureResponseLanguage(assistantText);
  if (latin < 60 || ratio >= 0.2) return { decision: 'pass' };
  return { decision: mode === 'warn' ? 'warn' : 'block', code: 'RESPONSE-LANGUAGE', reason: REASON };
}
