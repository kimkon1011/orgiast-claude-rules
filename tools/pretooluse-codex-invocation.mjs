#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  const input = JSON.parse(raw);
  const tool = String(input.tool_name || '');
  if (!/^(Bash|PowerShell)$/.test(tool)) process.exit(0);

  const command = String(input.tool_input?.command || '');
  if (!/(?:\bcodex\s+exec\b|\bcodex-do\.mjs\b)/i.test(command)) process.exit(0);

  const findings = [];
  const usesPromptFile = /(?:^|\s)--prompt-file(?:\s|=)/i.test(command);
  const usesStdin = /(?:^|\s)-(?:\s|$)/.test(command) || /<\s*[^<]/.test(command);
  const codexExec = command.match(/\bcodex\s+exec\b([\s\S]*)/i);

  if (/\b(?:bash|sh)\s+-(?:[^\s]*c|c[^\s]*)\b/i.test(command)) {
    findings.push('shell-wrapped: bash -lc / bash -c / sh -c 経由です。シェル層が増えると指示内のバッククォートや $() が展開されます。');
  }
  if (codexExec && !usesPromptFile && !/(?:^|\s)-(?:\s|$)/.test(codexExec[1]) && !/<\s*[^<]/.test(codexExec[1])) {
    findings.push('argv-prompt: codex exec に指示文を引数で渡しています。指示は --prompt-file または stdin で渡してください。');
  }
  if ((command.includes('`') || command.includes('$(')) && !usesPromptFile && !usesStdin) {
    findings.push('backtick-in-argv: 指示が argv のままバッククォートまたは $() を含み、シェルに実行される危険があります。');
  }
  if (/\|\s*(?:tail|head)(?:\s|$)/i.test(command)) {
    findings.push('piped-output: codex の出力を tail/head に流すとバッファされ、hang と実行中の区別がつかなくなります。');
  }
  // codex-do.mjs は既定1800秒の上限を内蔵しているので警告しない。
  // 正しい使い方を罰する gate は読まれなくなる。
  const usesWrapper = /\bcodex-do\.mjs\b/i.test(command);
  if (!usesWrapper && !/(?:^|\s)--timeout(?:\s|=)/i.test(command) && !/\btimeout\s+\d+(?:\.\d+)?(?:[smhd])?\b/i.test(command)) {
    findings.push('no-timeout: 実行時間の上限がなく、stdin 待ちなどで無限に残る可能性があります。');
  }

  if (!findings.length) process.exit(0);

  const repo = process.env.ORGIAST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const recommended = `node "${path.join(repo, 'tools', 'codex-do.mjs')}" --prompt-file <指示を書いたファイル> --cwd <対象パス> --timeout 1800`;
  const context = [
    '⚠️ Codex 呼び出し方に再発リスクがあります（ブロックはしていません）:',
    ...findings.map((finding) => `- ${finding}`),
    `推奨: ${recommended}`,
    '直に叩く場合: wsl -d Ubuntu --cd "<path>" -- timeout 1800 codex exec -s workspace-write - < prompt.md',
    '返ってこない時: wsl -d Ubuntu -- bash -lc "ps -eo pid,etime,stat,args | grep \'[c]odex\'" で stat の + と etime を確認してください。',
  ].join('\n');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
} catch {}
