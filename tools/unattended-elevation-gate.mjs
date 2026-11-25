#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"unattended-elevation-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"unattended-elevation-gate"}]};
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

// UAC 必須インストールのパターン（--scope user 付きは除外）
const UAC_PATTERNS = [
  { re: /\bwinget\s+(?:install|upgrade)\b/i, exclude: /--scope\s+user/i, label: 'winget install/upgrade' },
  { re: /\bmsiexec(?:\.exe)?\s+\/i\b/i, label: 'msiexec /i' },
  { re: /-Verb\s+RunAs/i, label: 'Start-Process -Verb RunAs' },
  { re: /\bchoco\s+install\b/i, label: 'choco install' },
  { re: /(?:^|[/\\])(?:[^/\\]*[Ss]etup[^/\\]*\.exe|[^/\\]*[Ii]nstaller[^/\\]*\.exe)\b/, label: 'Setup/Installer .exe' },
];

export function hasUacPattern(command) {
  if (!command || typeof command !== 'string') return null;
  for (const { re, exclude, label } of UAC_PATTERNS) {
    if (re.test(command)) {
      if (exclude && exclude.test(command)) continue;
      return label;
    }
  }
  return null;
}

export function isUnattended(env = process.env) {
  // CLAUDE_HEADLESS は headless claude -p / cheap-code-worker 等
  if (env.CLAUDE_HEADLESS === '1') return true;
  // ORGIAST_HEADLESS_JOB は auto-session / quota-sweep 等
  if (String(env.ORGIAST_HEADLESS_JOB || '').trim()) return true;
  // SDK 経由の無人セッション
  if (env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return true;
  return false;
}

export async function hookMain(raw) {
  try {
    const input = JSON.parse(raw);
    const tool = String(input.tool_name || '');
    if (!/^(Bash|PowerShell)$/.test(tool)) return;
    const command = input.tool_input?.command || input.tool_input?.script || '';
    const pattern = hasUacPattern(command);
    if (!pattern) return;

    if (isUnattended()) {
      const reason = `無人セッションでは UAC 必須インストールを起動しません（検出: ${pattern}）。必要なら kim-inbox に ask を積んでください。`;
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        }
      }));
    } else {
      console.error(`[WARN] 対話セッションでの UAC 必須インストール検出（${pattern}）。管理者権限のシェルで実行してください。`);
    }
  } catch {}
}

if (isEntry(import.meta.url)) await hookMain(await readStdinWithTimeout());