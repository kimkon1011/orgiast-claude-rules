#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
export function playbookContext({ prompt = '', transcript_path } = {}, home = process.env.ORGIAST_HOME || os.homedir()) {
  const dir = path.resolve(home, '.claude', 'playbooks');
  const text = `${prompt}\n${readTranscriptContext(transcript_path).assistantText.slice(-4000)}`.toLowerCase();
  const contexts = [];
  let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch { return ''; }
  for (const file of files) {
    try {
      const full = path.join(dir, file), name = file.slice(0, -3), body = fs.readFileSync(full, 'utf8');
      const normalized = body.replace(/^\uFEFF/, '');
      const frontmatter = normalized.startsWith('---') ? normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '' : normalized.split(/\r?\n/)[0];
      const header = frontmatter.match(/^aliases:[ \t]*([^\n]*)/m);
      const aliases = header?.[1]?.replace(/^\s*\[|\]\s*$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) || [];
      const matches = [name, ...aliases].filter(Boolean).some(n => {
        const lower = n.toLowerCase();
        if (n.length > 3) return text.includes(lower);
        const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`).test(text);
      });
      if (!matches) continue;
      contexts.push(`[PLAYBOOK:${name}] 過去に成功した実測手順（正本: ${full}）。user に手順を渡すときはこれを優先し、一般知識で上書きしない。ここに無い部分は過去ログを検索してから書く。\n${body.slice(0, 6000)}${body.length > 6000 ? `\n…（続きは ${full} を Read）` : ''}`);
      if (contexts.length === 2) break;
    } catch { /* 読めないファイルだけを除外する。 */ }
  }
  return contexts.join('\n\n');
}
if (isEntry(import.meta.url)) {
  try {
    const context = playbookContext(JSON.parse(await readStdinWithTimeout()));
    if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  } catch { /* hook は fail-open。 */ }
}
