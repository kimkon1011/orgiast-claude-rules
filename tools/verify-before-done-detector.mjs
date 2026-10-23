#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "verify-before-done-detector", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "verify-before-done-detector"}]};
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { readLastLines } from './transcript-tail.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { appendStopLedger, registerStopViolation, stopGateOutput } from './lib/stop-recheck.mjs';

const normalize = value => String(value).replaceAll('\\', '/').replace(/^\.\//, '');
const excluded = file => /(?:^|\/)(?:memory|scratchpad|tests?)(?:\/|$)|(?:\.test|\.spec)\.|\.md$/i.test(normalize(file));
const external = /notify|discord|gmail|send|deploy|sheets|cron|webhook/i;
const paths = text => [...String(text).matchAll(/(?:[\w.@:+-]+[\\/])*[\w@+-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|ps1|sh|json|ya?ml|go|rs|gs|vue|svelte|rb|php|cs)\b/g)].map(m => normalize(m[0]));
const body = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const tokens = command => [...command.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s"']+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
function script(command) {
  // Only actual interpreter invocations, never echo/import/--test/--eval text.
  const t = tokens(command);
  if (!/^(?:node|python3?|pwsh|powershell)(?:\.exe)?$/i.test(path.posix.basename(normalize(t[0] || '')))) return '';
  let i = 1;
  while (/^-(?:NoProfile|NonInteractive|File)$/i.test(t[i] || '')) i++;
  return t[i] && !t[i].startsWith('-') ? normalize(t[i]) : '';
}
// Worktrees may already be deleted: compare repository identity without stat().
const repoPath = value => {
  const file = normalize(value).replace(/^[ab]\//, '');
  const tools = file.lastIndexOf('/tools/');
  return tools >= 0 ? file.slice(tools + 1) : file.split('/').slice(-2).join('/');
};
const sameFile = (a, b) => repoPath(a) === repoPath(b);
const resolveScript = (cwd, file) => path.resolve(cwd, file.replace(/^~(?=[/\\])/, process.env.HOME || '~'));
function childScripts(source) {
  // Count literal interpreter child-process calls (including literal const aliases).
  const literals = new Map([...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(['"`])([^'"`\n]+)\2/g)].map(m => [m[1], m[3]]));
  const literal = value => {
    const quoted = value.trim().match(/^(['"`])([^'"`]+)\1$/);
    return quoted ? quoted[2] : literals.get(value.trim());
  };
  return [...source.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*([^,]+),\s*\[\s*([^,\]]+)/g)].flatMap(m => {
    const interpreter = literal(m[1]);
    if (m[1].trim() !== 'process.execPath' && !/^(?:node|python3?|pwsh|powershell)(?:\.exe)?$/i.test(path.posix.basename(normalize(interpreter || '')))) return [];
    const target = literal(m[2]);
    return target && !target.startsWith('-') ? [normalize(target)] : [];
  });
}
function realUser(e) {
  if (e.isSidechain || e.isMeta || (e.type !== 'user' && e.message?.role !== 'user')) return false;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) return false;
  const text = typeof c === 'string' ? c : (c || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return !!text?.trim() && !/^(?:<local-command|<command-|<task-notification|<system-reminder|Stop hook feedback:)/.test(text.trim());
}

export function evaluateVerification(entries, assistantText, { cwd = process.cwd(), readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  if (!/(完了|できました|直しました|修正しました|実装しました|反映しました|デプロイ|deployed|completed|fixed|push(しました|済)|バグ.*修正|動くように)/i.test(assistantText)) return null;
  const exception = assistantText.match(/\[NO-TEST-OK:\s*([^\]]*)\]/)?.[1]?.trim();
  if (exception && !/時間がない|時間不足|後で|あとで|後ほど|後回し|次回|未実施|先送り|later|no time/i.test(exception)) return null;
  let start = 0;
  entries.forEach((e, i) => { if (realUser(e)) start = i + 1; });
  const turn = entries.slice(start).filter(e => !e.isSidechain);
  const results = new Map();
  for (const e of turn) for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
    if (b.type === 'tool_result') results.set(b.tool_use_id, { ...b, metadata: e.toolUseResult });
  }
  const files = new Map();
  let changed = false, sensitive = false;
  const calls = [];
  const addFiles = (text, index) => { for (const file of paths(text)) if (file.replace(/^[ab]\//, '').includes('/') && !excluded(file)) files.set(file.replace(/^[ab]\//, ''), index); };
  turn.forEach((e, index) => {
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b.type !== 'tool_use') continue;
      const result = results.get(b.id);
      const output = body(result?.content) + body(result?.metadata);
      const ok = !!result && !result.is_error && !/"exit_code"\s*:\s*[1-9]|"exitCode"\s*:\s*[1-9]|Exit code:?\s*[1-9]|Process exited with code [1-9]/i.test(output);
      const input = b.input || {}, command = String(input.command || '');
      calls.push({ name: b.name, input, command, index, ok, output });
      let edit = false;
      if (/^(Edit|Write|MultiEdit)$/.test(b.name) && !result?.is_error) {
        const file = normalize(input.file_path || '');
        if (file && !excluded(file)) { files.set(file, index); edit = true; }
      }
      if (b.name === 'Bash' && /codex-do\.mjs\b/.test(command) && !/--review\b/.test(command)) edit = true;
      if (b.name === 'Bash' && /pr-merge\.mjs\b|\bgh\s+pr\s+merge\b/.test(command) && ok) edit = true;
      if (/^(Agent|Task)$/.test(b.name) && /実装|修正|変更|implement|fix|edit|write|build/i.test(body(input)) && !/^(Explore|Plan)$/i.test(input.subagent_type || '')) edit = true;
      if (edit) {
        changed = true;
        const evidence = body(input) + output;
        if (!/^(Edit|Write|MultiEdit)$/.test(b.name)) addFiles(evidence.replace(/(?:[\w./\\:-]*\/)?(?:codex-do|pr-merge)\.mjs/g, ''), index);
        sensitive ||= external.test(evidence);
      }
      // PR metadata may have been read before the merge.
      if (b.name === 'Bash' && /\bgh\s+pr\s+(?:view|diff)\b/.test(command) && ok) addFiles(output, index);
    }
  });
  if (!changed) return null;
  const executed = new Map();
  for (const call of calls) {
    if (call.name !== 'Bash' || !call.ok || /--test\b|--dry[-_]?run\b/.test(call.command)) continue;
    const invoked = script(call.command);
    if (!invoked) continue;
    // Per file: a run counts only after that file's own last change (a later unrelated merge must not void it).
    const after = file => call.index > files.get(file) || (call.index === files.get(file) && /codex-do\.mjs$/.test(invoked));
    let imports = [];
    if (/scratchpad/.test(invoked)) {
      try {
        const source = readFile(resolveScript(cwd, invoked));
        // Dependency injection and test doubles cannot establish live execution.
        if (/fetchImpl|sendImpl|mock|stub|fake|(?:fetch|send\w*)\s*[:=]|vi\.|sinon\./i.test(source)) continue;
        imports = [...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)].map(m => normalize(path.resolve(path.dirname(resolveScript(cwd, invoked)), m[2])));
        imports.push(...childScripts(source));
      } catch { continue; }
    }
    for (const file of files.keys()) if (after(file) && ((!excluded(invoked) && sameFile(invoked, file)) || imports.some(p => sameFile(p, file)))) executed.set(file, call.index);
  }
  const missing = [...files.keys()].filter(f => !executed.has(f));
  const lastExecution = Math.max(...executed.values());
  const readback = executed.size > 0 && (/\[TESTED-LIVE:\s*[^\]\s][^\]]*\]/.test(assistantText) || calls.some(c => c.ok && c.index > lastExecution && (
    /(?:discord|gmail|sheets|webhook|deploy).*?(?:read|get|list|fetch|history)/i.test(c.name) ||
    (c.name === 'Bash' && /^(?:curl|gh|node)\b/.test(c.command) && /read[-_]?back|\bcurl\b.*https:\/\/[^\s]*(?:discord|gmail|googleapis)|\bgh\s+api\b/i.test(c.command) && !/--test|scratchpad|--dry-run|\s-X\s*(?:POST|PUT|DELETE|PATCH)/i.test(c.command))
  )));
  if (executed.size && !missing.length && (!sensitive || readback)) return null;
  return `[VERIFY-BEFORE-DONE] 完了報告の実行証拠が不足しています。\n未実行: ${missing.length ? missing.join(', ') : executed.size ? 'なし' : '変更対象不明（PR files / 委譲結果からパスを記録）'}\n実送信・外部反映の読み戻し: ${sensitive ? readback ? 'あり' : 'なし（本番送信後のAPI取得、または具体的な [TESTED-LIVE: 結果] が必要）' : '対象外'}\n変更対象を配置場所から実行し、結果を検証してから報告してください。単体テスト・mock・[TESTED]だけでは通りません。実行不要の場合のみ [NO-TEST-OK: 先送りでない具体的理由] を記載してください。`;
}

if (isEntry(import.meta.url)) {
  const stdin = await readStdinWithTimeout();
  try {
    if (stdin.trim()) {
      const data = JSON.parse(stdin);
      if (data.transcript_path && fs.existsSync(data.transcript_path)) {
        const entries = readLastLines(data.transcript_path, 4000, 8 * 1024 * 1024).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const assistantText = latestAssistantText(data.transcript_path);
        const reason = evaluateVerification(entries, assistantText, { cwd: data.cwd || process.cwd() });
        if (reason) {
          const recheck = registerStopViolation({ input: data, assistantText, blockedBy: ['verify-before-done-detector'], reasonCodes: ['VERIFY-BEFORE-DONE'] });
          appendStopLedger({ sessionId: recheck.sessionId, verdict: recheck.verdict, blockedBy: recheck.blockedBy, reasonCodes: recheck.reasonCodes, retryCap: recheck.retryCap, excerpt: assistantText.slice(0, 200) });
          console.log(JSON.stringify(stopGateOutput(recheck, reason)));
        }
      }
    }
  } catch (error) { console.error(`[VERIFY-BEFORE-DONE] ${error.message}`); }
}
