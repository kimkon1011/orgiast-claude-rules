#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"delete-approval-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"delete-approval-gate"}]};
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readEvidence, approvedAfter, shellSegments, roleOf, contentOf, human, outputDecision } from './lib/approval-evidence.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const HOOK_MATCHER = 'Bash|PowerShell|mcp__claude_ai_Google_Drive[^|]*__(trash_file|delete_file)|mcp__claude_ai_Gmail[^|]*__(trash_message|trash_thread|delete_draft|delete_label)|mcp__[^|]*(?:Canva|Docs)[^|]*__delete[^|]*';
const TARGET = new RegExp(`^(?:${HOOK_MATCHER})$`, 'i');
export const BLOCK_REASON = '削除対象を全件列挙して kim の許可を得てから実行してください（組織指示12）';
const block = () => ({ decision: 'block', reason: BLOCK_REASON });
function canonical(p, cwd) { const win = /^[a-z]:[\\/]/i.test(p) || /^[a-z]:[\\/]/i.test(cwd); return (win ? path.win32.resolve(cwd, p).toLowerCase() : path.resolve(cwd, p)).replaceAll('\\', '/'); }
export function exempt(p, cwd = process.cwd()) {
  const n = canonical(p, cwd);
  const tmp = canonical(os.tmpdir(), cwd);
  if (n === tmp || n.startsWith(tmp + '/') || /^\/var\/tmp(?:\/|$)/.test(n) || /^[a-z]:\/users\/[^/]+\/appdata\/local\/temp(?:\/|$)/i.test(n) || /^[a-z]:\/windows\/temp(?:\/|$)/i.test(n)) return true;
  return /(?:^|\/)(?:node_modules|dist|build|\.next|coverage|__pycache__)(?:\/|$)/.test(n);
}
export function deleteTargets(command, cwd = process.cwd()) {
  const targets = [];
  for (let args of shellSegments(command)) {
    if (/^(?:cd|Set-Location)$/i.test(args[0])) { cwd = canonical(args[1] ?? '.', cwd); continue; }
    while (/^(?:sudo|command|&|then|do|else|\(|\{)$/.test(args[0])) args = args.slice(1);
    if (!args.length) continue;
    const cmd = args[0]?.split(/[\\/]/).at(-1).replace(/\.exe$/i, '');
    if (cmd === 'git') {
      let i = 1;
      if (args[i] === '-C') { cwd = canonical(args[i + 1], cwd); i += 2; }
      if (args[i] === 'worktree') continue;
      if (!['rm', 'clean'].includes(args[i])) continue;
      if (args.slice(i + 1).some(a => a === '--dry-run' || /^-[a-z]*n[a-z]*$/.test(a))) continue;
      if (args[i] === 'clean') {
        const out = execFileSync('git', ['-c', 'core.quotePath=false', 'clean', ...args.slice(i + 1).filter(a => a !== '-f' && a !== '--force'), '--dry-run'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
        targets.push(...out.split(/\r?\n/).filter(l => l.startsWith('Would remove ')).map(l => ({ target: l.slice(13), cwd })));
        continue;
      }
      args = args.slice(i);
    } else if (!/^(?:rm|rmdir|del|erase|Remove-Item|ri)$/i.test(cmd ?? '')) continue;
    if (args.some(a => /^-WhatIf$/i.test(a))) continue;
    let literal = false;
    const operands = args.slice(1).filter(a => { if (a === '--') { literal = true; return false; } return literal || (!a.startsWith('-') && !/^\/[sqfp]$/i.test(a)); });
    if (!operands.length) throw new Error('unresolved deletion');
    for (let target of operands.flatMap(a => a.split(','))) {
      target = target.replace(/^(?:%TEMP%|%TMP%|\$env:TEMP|\$env:TMP|\$\{TMPDIR\}|\$TMPDIR)(?=[\\/]|$)/i, os.tmpdir());
      if (/[$`*?\[\]{}]/.test(target)) throw new Error('dynamic targets must be expanded and listed');
      targets.push({ target, cwd });
    }
  }
  return targets;
}
function newlyCreated(rows, target, cwd) {
  let start = 0;
  for (let i = 0; i < rows.length; i++) if (human(rows[i])) start = i + 1;
  const calls = new Set();
  for (const e of rows.slice(start)) {
    const c = contentOf(e);
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (roleOf(e) === 'assistant' && b.type === 'tool_use' && b.name === 'Write' && canonical(b.input?.file_path ?? '', cwd) === canonical(target, cwd)) calls.add(b.id);
      if (b.type === 'tool_result' && calls.has(b.tool_use_id) && !b.is_error && /(?:created successfully|new file|新規.*作成)/i.test(JSON.stringify(b.content))) return true;
    }
  }
  return false;
}
export function judge(input) {
  if (!TARGET.test(input?.tool_name ?? '')) return { decision: 'pass' };
  try {
    const shell = /^(Bash|PowerShell)$/.test(input.tool_name);
    let targets;
    if (shell) targets = deleteTargets(input.tool_input?.command ?? '', input.cwd ?? process.cwd()).filter(t => !exempt(t.target, t.cwd));
    else {
      const a = input.tool_input ?? {};
      targets = Object.entries(a).filter(([k]) => /^(?:file|message|thread|draft|label|design|document|page)?_?ids?$|^file_path$/i.test(k)).flatMap(([, v]) => (Array.isArray(v) ? v : [v]).map(target => ({ target: String(target) })));
      if (!targets.length) return block();
    }
    if (!targets.length) return { decision: 'pass' };
    const rows = readEvidence(input);
    targets = targets.filter(t => !shell || !newlyCreated(rows, t.target, t.cwd));
    if (!targets.length) return { decision: 'pass' };
    return approvedAfter(rows, text => targets.every(t => {
      // Boundaries prevent a.txt matching other-a.txt; basenames do not authorize other paths.
      const escaped = t.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[\\s\x60"'（(：:])${escaped}(?=$|[\\s\x60"'）)、。])`).test(text);
    }), 'delete') ? { decision: 'pass' } : block();
  } catch { return block(); }
}
if (isEntry(import.meta.url)) {
  try { const raw = await readStdinWithTimeout(4000); if (raw.trim()) outputDecision(judge(JSON.parse(raw))); }
  catch { outputDecision(block()); }
}
