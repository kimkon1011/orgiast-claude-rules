#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { loadFablePolicy, fableAllowedForSupervisor } from './fable-policy.mjs';

const TAIL_BYTES = 256 * 1024;

function allowed(home, sessionId) {
  try {
    const allow = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'fable-allow.json'), 'utf8').replace(/^﻿/, ''));
    return Boolean(sessionId) && allow.sessionId === sessionId && Date.parse(allow.until) > Date.now();
  } catch {
    return false;
  }
}

export function inspectTranscript(transcriptPath) {
  const size = fs.statSync(transcriptPath).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let lines = buffer.toString('utf8').split(/\r?\n/);
  if (start > 0) lines = lines.slice(1);
  let currentModel = '';
  let fableResponses = 0;
  let fableOutputTokens = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    const model = row?.message?.model;
    if (typeof model !== 'string' || !model || model.includes('<synthetic>')) continue;
    if (!currentModel) currentModel = model;
    if (/fable/i.test(model)) {
      fableResponses += 1;
      fableOutputTokens += Number(row?.message?.usage?.output_tokens) || 0;
    }
  }
  return { currentModel, fableResponses, fableOutputTokens };
}

export async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw) return;
  let input;
  try { input = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; }
  const policy = loadFablePolicy({ dir: process.env.ORGIAST_FABLE_POLICY_DIR || undefined });
  if (fableAllowedForSupervisor(policy)) return;
  const home = process.env.ORGIAST_HOME || os.homedir();
  if (allowed(home, input.session_id)) return;
  let detected;
  try { detected = inspectTranscript(input.transcript_path); } catch { return; }
  if (!/fable/i.test(detected.currentModel)) return;
  const context = [
    '🚨 このセッションは Claude Fable 5 で動いています（§1.16 全用途禁止・別課金枠）。',
    '直ちに `/model opus` でモデルを切り替えるか、`/session-close` して新しいセッションで続けてください。',
    `検出: 最新応答が ${detected.currentModel}（末尾読み取り範囲の fable 応答 ${detected.fableResponses}件 / 出力 ${(detected.fableOutputTokens / 1000).toFixed(0)}k tok）。user が明示指定した場合のみ例外です。`,
  ].join('\n');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'UserPromptSubmit', additionalContext: context } }));
}

if (isEntry(import.meta.url)) await main().catch(() => {});
