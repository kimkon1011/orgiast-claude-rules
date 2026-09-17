#!/usr/bin/env node

const TOOL_NAMES = new Set(['Edit', 'Write', 'Bash', 'PowerShell']);
const FAILURE = /(?:permission[^\n]*denied|denied|拒否|self-modification|\berror\b|失敗)/i;

function blocks(entry, type) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content.filter(block => block?.type === type) : [];
}

function textOf(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
}

function handoffBlock(text) {
  const marker = text.search(/\[手渡し判定\]/);
  return marker < 0 ? '' : text.slice(marker);
}

export function absolutePaths(text) {
  const value = String(text);
  const matches = [];
  for (const match of value.matchAll(/[`"']((?:~\/\.claude\/|[A-Za-z]:\\|\/)[^`"'\r\n]+)[`"']/g)) matches.push(match[1]);
  matches.push(...(value.match(/(?:~\/\.claude\/[^\s`"'<>）】]+|[A-Za-z]:\\[^\s`"'<>）】]+|\/(?!\/)[^\s`"'<>）】]+)/g) || []));
  return [...new Set(matches.map(path => path.replace(/[.,;:、。]+$/, '')))];
}

function successful(result) {
  if (result?.is_error === true) return false;
  const content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? '');
  return !FAILURE.test(content);
}

function inputContainsTarget(input, target) {
  if (typeof input === 'string') return input.includes(target);
  if (Array.isArray(input)) return input.some(value => inputContainsTarget(value, target));
  if (input && typeof input === 'object') return Object.values(input).some(value => inputContainsTarget(value, target));
  return false;
}

export function evaluateHandoffRegret(transcriptRaw, finalText = '') {
  const entries = String(transcriptRaw).split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const handedOff = new Map();
  const uses = new Map();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const block = handoffBlock(textOf(entry));
    if (block) for (const target of absolutePaths(block)) if (!handedOff.has(target)) handedOff.set(target, index);
    for (const use of blocks(entry, 'tool_use')) {
      if (!TOOL_NAMES.has(use.name) || !use.id) continue;
      const targets = [...handedOff].filter(([target, handoffIndex]) => handoffIndex < index && inputContainsTarget(use.input, target)).map(([target]) => target);
      if (targets.length) uses.set(use.id, { targets, index });
    }
    for (const result of blocks(entry, 'tool_result')) {
      const use = uses.get(result.tool_use_id);
      if (!use || use.index >= index || !successful(result)) continue;
      const target = use.targets[0];
      const hasPrevention = /\[再発防止\][\s\S]*^原因:[^\n]+[\s\S]*^対策:[^\n]+[\s\S]*^機械化:[^\n]+/m.test(finalText);
      if (!hasPrevention) return { decision: 'block', target, reason: `[HANDOFF-REGRET] user に手渡した作業（${target}）を、その後 Claude 自身が実行できています。なぜ最初に手渡したかを調べ、\`[再発防止]\` ブロックに 原因: / 対策: / 機械化:（hook・memory・ルールのどれに入れたか）を書いてから止まってください（kim 2026-09-17 厳命: 毎回、言われなくても実施）` };
    }
  }
  return { decision: 'pass' };
}
