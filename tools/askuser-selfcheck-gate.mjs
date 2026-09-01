#!/usr/bin/env node
// AskUserQuestion で「自分で調べれば分かること」を user に聞くのを *事前に* 止める。
//
// なぜ Stop hook だけでは足りないか: self-check-before-asking-guard.mjs は応答を書き終えた
// あとに走るので、user は既に不要な依頼文を目にしている。AskUserQuestion は
// PreToolUse で止められるため、ここだけは「user の目に触れる前」に防げる。
// 2026-09-01 user 厳命「何度も起きている。二度と起こらないように徹底して」への対応。
//
// 止めるのは *調査の外注* だけ。方針の選択(A案/B案どちらにしますか)は人にしか決められない
// ので通す。判定ロジックは Stop hook と同じモジュールを共有する(二重メンテを避ける)。
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';
import { findOutsourcedInvestigation, formatViolationMessage, scanToolUses } from './self-check-before-asking-guard.mjs';

// 質問文と選択肢を1本のテキストに畳む。段落判定に載せるため空行で区切る。
export function collectQuestionText(toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const chunks = [];
  for (const question of questions) {
    const parts = [String(question?.question || '')];
    for (const option of Array.isArray(question?.options) ? question.options : []) {
      parts.push(String(option?.label || ''), String(option?.description || ''));
    }
    chunks.push(parts.filter(Boolean).join(' '));
  }
  return chunks.join('\n\n');
}

export function judge(toolInput, evidence) {
  const text = collectQuestionText(toolInput);
  if (!text.trim()) return null;
  return findOutsourcedInvestigation(text, evidence);
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input.tool_name !== 'AskUserQuestion') return;
    const evidence = input.transcript_path && fs.existsSync(input.transcript_path)
      ? scanToolUses(input.transcript_path)
      : { names: new Set(), inputs: '' };
    const result = judge(input.tool_input, evidence);
    if (!result) return;
    console.error(`${formatViolationMessage(result)}\n\n(AskUserQuestion は user の目に触れる前に止めました。自分で調べてから、判断が要る点だけを聞いてください)`);
    process.exitCode = 2;
  } catch { /* ガードの失敗で作業を止めない */ }
}

if (isEntry(import.meta.url)) await main();
