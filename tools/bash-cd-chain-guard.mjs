#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"bash-cd-chain-guard","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"bash-cd-chain-guard"}]};

import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

function startsWithCdChain(command) {
  const start = /^[ \t]*cd[ \t]+/.exec(command);
  if (!start) return false;

  // Consume quoted and escaped characters before looking for shell operators.
  // Stop scanning at syntax that requires parsing a nested shell command.
  const token = /[ \t]+|\\\r?\n|#[^\r\n]*|&&|\|\||;|(?:'[^']*'|"(?:[^"\\$`]|\\[\s\S]|\$(?![({])|\$\{[^{}"\\`$]*\})*"|\\[^\r\n]|\$\{[^{}]*\}|[^\s'"`\\;&|()<>$]|\$(?![({]))+/y;
  token.lastIndex = start[0].length;
  let hasArgument = false;
  for (let match; (match = token.exec(command));) {
    const value = match[0];
    if (value.startsWith('#')) return false;
    if (value === '&&' || value === '||' || value === ';') {
      const next = command.slice(token.lastIndex).replace(/^(?:\s|\\\r?\n|#[^\r\n]*)+/, '');
      return hasArgument && /^[^;&|)]/.test(next);
    }
    if (!/^(?:[ \t]+|\\\r?\n)$/.test(value)) hasArgument = true;
  }
  return false;
}

export function hookMain(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const command = input?.tool_input?.command;
  if (input?.tool_name !== 'Bash' || typeof command !== 'string' || !startsWithCdChain(command)) return;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '`cd X && …` の連結は classifier 拒否の主因です。絶対パスを使うか `git -C <dir>` / `npm --prefix <dir>` / ツールの `--cwd` を使ってください（ONBOARDING §1.20）。',
    },
  }));
}

if (isEntry(import.meta.url)) hookMain(await readStdinWithTimeout());
