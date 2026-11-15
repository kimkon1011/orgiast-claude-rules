#!/usr/bin/env node
// codex の ChatGPT ログインを AI が消さないためのガード（PreToolUse: Bash / PowerShell）。
// 2026-11-15 診断: codex login は開始時に既存ログインを logout（トークン失効）してから同意待ちになる。
// AI が「直そう」として codex login / logout を実行 → 同意されないまま放置 → 004・04U31RG で codex が未ログインのまま止まった。
// また auth.json を別の場所へコピーすると refresh token が2つの codex に配られ、先に更新した側がもう片方を失効させる。
// ログイン切れは lane-watch（codex-keeper）が status の「金さんの操作が必要」に出す。AI は作業を安いレーンへ回して報告するだけ。
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
export const GATE_CONTRACT = {"name": "codex-auth-guard", "remedies": [{"kind": "repo-file", "ref": "tools/codex-auth-guard.mjs", "reason": "codex login/logout と auth.json のコピー・削除は AI では行わず、lane-watch の status に従って金さんへ依頼する"}]};

const REASON = 'codex login / logout と ~/.codex/auth.json のコピー・移動・削除は AI からは実行しないこと（既存ログインが失効し codex が止まる）。'
  + 'ログイン切れは lane-watch の status（金さんの操作が必要）に出るので、作業は deepseek 等の安いレーンへ回し、金さんにはそのPCのデスクトップ「Codexログイン」を案内して報告するだけにする。';

export function evaluateCodexAuthCommand(command) {
  const s = String(command ?? '');
  for (const m of s.matchAll(/\bcodex(?:\.cmd|\.exe|\.ps1|\.js)?["']?\s+(login|logout)\b([^\n;&|]*)/gi)) {
    const verb = m[1].toLowerCase(), rest = m[2] || '';
    if (verb === 'login' && /^\s*(status\b|--help\b|-h\b)/i.test(rest)) continue;
    if (/^\s*(--help\b|-h\b)/i.test(rest)) continue;
    return { decision: 'block', reason: REASON };
  }
  if (/\.codex["']?[\\/]+auth\.json(?!\.)/i.test(s)
    && (/\b(rm|del|erase|mv|move|cp|copy|ln|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Content|Out-File|tee)\b/i.test(s) || /(^|[^>])>{1,2}\s*["']?[^\s"']*auth\.json/i.test(s))) {
    return { decision: 'block', reason: REASON };
  }
  return { decision: 'pass' };
}

export function run(input) {
  if (!/^(Bash|PowerShell)$/.test(String(input?.tool_name || ''))) return { decision: 'pass' };
  return evaluateCodexAuthCommand(input?.tool_input?.command);
}

if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdinWithTimeout();
    if (raw.trim()) {
      const r = run(JSON.parse(raw.replace(/^\uFEFF/, '')));
      if (r.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } }));
    }
  } catch {}
}
