#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { extractInlineProgram, isExcludedInlineProgramCommand } from './inline-program.mjs';
export { extractInlineProgram } from './inline-program.mjs';

const DAY = 864e5;
// Japanese prose is close to one token per character, while code/JSON is much
// less dense (roughly 3.4 characters per token). Thinking/text use a blended
// 1.8 divisor; tool inputs use the code/JSON divisor.
const PROSE_CHARS_PER_TOKEN = 1.8;
const JSON_CHARS_PER_TOKEN = 3.4;
export function modelTier(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('fable')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return 'default';
}
export function walkJsonl(dir, out = []) {
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) { const p = path.join(dir, e.name); if (e.isDirectory()) walkJsonl(p, out); else if (e.name.endsWith('.jsonl')) out.push(p); }
  return out;
}
const CACHE_VERSION = 1;
const cacheStates = new Map();
function cachePath(home) { return path.join(home, '.claude', 'cost-loop-parse-cache.json'); }
function cacheState(home) {
  const file = cachePath(home);
  if (cacheStates.has(file)) return cacheStates.get(file);
  let files = {}, dirs = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version === CACHE_VERSION && parsed.files && !Array.isArray(parsed.files) && typeof parsed.files === 'object') { files = parsed.files; if (parsed.dirs && !Array.isArray(parsed.dirs) && typeof parsed.dirs === 'object') dirs = parsed.dirs; }
  } catch {}
  const state = { file, files, dirs, walks: new Map(), claudeScan: null, hits: 0, misses: 0, dirty: false };
  cacheStates.set(file, state);
  return state;
}
function cachedFile(home, file, kind, st, parse) {
  const state = cacheState(home), old = state.files[file];
  if (old?.size === st.size && old?.mtimeMs === st.mtimeMs && old?.kind === kind && old.result && typeof old.result === 'object') { state.hits++; return old.result; }
  const result = parse();
  if (result === null) return null;
  state.files[file] = { size: st.size, mtimeMs: st.mtimeMs, kind, result };
  state.misses++; state.dirty = true;
  return result;
}
function saveCache(home) {
  const state = cacheState(home); if (!state.dirty) return;
  const retentionCutoff = Date.now() - 30 * DAY;
  for (const file of Object.keys(state.files)) { try { if (state.files[file]?.mtimeMs < retentionCutoff || !fs.existsSync(file)) delete state.files[file]; } catch { delete state.files[file]; } }
  try { fs.mkdirSync(path.dirname(state.file), { recursive: true }); fs.writeFileSync(state.file, JSON.stringify({ version: CACHE_VERSION, files: state.files, dirs: state.dirs })); state.dirty = false; } catch {}
}
export function parseCacheStats(home = process.env.ORGIAST_HOME || os.homedir()) { const s = cacheState(home); return { hits: s.hits, misses: s.misses }; }
export function resetParseCacheForTests() { cacheStates.clear(); }
function cachedWalk(home, root) {
  const state = cacheState(home), out = [];
  if (state.walks.has(root)) return state.walks.get(root);
  const visit = (dir) => {
    let st; try { st = fs.statSync(dir); } catch { return; }
    let entry = state.dirs[dir];
    if (!entry || entry.mtimeMs !== st.mtimeMs || !Array.isArray(entry.children)) {
      let children; try { children = fs.readdirSync(dir, { withFileTypes: true }).map((item) => ({ name: item.name, dir: item.isDirectory() })); } catch { return; }
      entry = state.dirs[dir] = { mtimeMs: st.mtimeMs, children }; state.dirty = true;
    }
    for (const child of entry.children) { const target = path.join(dir, child.name); if (child.dir) visit(target); else if (child.name.endsWith('.jsonl')) out.push(target); }
  };
  visit(root); state.walks.set(root, out); return out;
}
function bulkStat(files) {
  if (files.length < 64) return files.map((file) => { try { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } });
  const program = "import fs from 'node:fs/promises';let s='';for await(const c of process.stdin)s+=c;const f=JSON.parse(s);const r=await Promise.all(f.map(async p=>{try{const x=await fs.stat(p);return [x.size,x.mtimeMs]}catch{return null}}));process.stdout.write(JSON.stringify(r));";
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', program], { input: JSON.stringify(files), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (run.status === 0) return JSON.parse(run.stdout).map((x) => x && ({ size: x[0], mtimeMs: x[1] }));
  } catch {}
  return files.map((file) => { try { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } });
}
function parseClaudeFile(file) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const records = [], commands = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue; let row; try { row = JSON.parse(line); } catch { continue; }
    const parsedTs = Date.parse(row.timestamp || ''), ts = Number.isFinite(parsedTs) ? parsedTs : 0;
    const content = Array.isArray(row?.message?.content) ? row.message.content : [];
    const assistant = (!row?.type || row.type === 'assistant') && (!row?.message?.role || row.message.role === 'assistant');
    let authoredLines = 0;
    if (assistant) for (const block of content) {
      authoredLines += authoredLinesFromToolUse(block);
      if (block?.type === 'tool_use' && ['Bash', 'PowerShell'].includes(block?.name)) {
        const command = typeof block?.input?.command === 'string' ? block.input.command : '';
        commands.push({ ts, chars: command.length, category: classifyBashCommand(command), preview: command.replace(/\s*\r?\n\s*/g, ' ').slice(0, 160) });
      }
    }
    const usage = row?.message?.usage;
    if (!usage) { if (authoredLines) records.push({ ts, authoredLines }); continue; }
    const out = Number(usage.output_tokens) || 0, model = String(row?.message?.model || ''), tier = modelTier(model);
    const blockTotals = { thinking: 0, text: 0, tool_use: 0, unattributed: 0, tools: {} };
    const weighted = content.map((b) => { const type = b?.type === 'tool_use' ? 'tool_use' : b?.type === 'thinking' ? 'thinking' : 'text'; const chars = type === 'tool_use' ? JSON.stringify(b?.input ?? '').length : String(b?.text ?? b?.thinking ?? (typeof b === 'string' ? b : '')).length; return { b, type, n: chars / (type === 'tool_use' ? JSON_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN) }; });
    const totalEstimate = weighted.reduce((s, x) => s + x.n, 0);
    if (!totalEstimate) { if (content.some((b) => b?.type === 'thinking')) blockTotals.thinking += out; else blockTotals.unattributed += out; }
    else for (const { b, type, n } of weighted) { const amount = out * n / totalEstimate; blockTotals[type] += amount; if (type === 'tool_use') { const name = String(b?.name || 'unknown'); blockTotals.tools[name] = (blockTotals.tools[name] || 0) + amount; } }
    records.push({ ts, authoredLines, out, tier, side: Boolean(row.isSidechain), blocks: blockTotals,
      input: Number(usage.input_tokens) || 0, cacheRead: Number(usage.cache_read_input_tokens) || 0, cacheWrite: Number(usage.cache_creation_input_tokens) || 0 });
  }
  return { records, commands };
}
function claudeFiles(home, cutoff = 0) {
  const state = cacheState(home); if (state.claudeScan) return state.claudeScan;
  const result = [], files = cachedWalk(home, path.join(home, '.claude', 'projects')), stats = bulkStat(files);
  for (let i = 0; i < files.length; i++) { const file = files[i], st = stats[i]; if (!st || st.mtimeMs < cutoff) continue; const parsed = cachedFile(home, file, 'claude', st, () => parseClaudeFile(file)); if (parsed) result.push({ file, st, parsed }); }
  state.claudeScan = result; return result;
}
export function collectClaudeActivityDays({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * DAY, active = new Set();
  for (const { st } of claudeFiles(home, cutoff)) if (st.mtimeMs >= cutoff) active.add(new Date(st.mtimeMs).toDateString());
  saveCache(home); return active.size;
}
export function collectClaudeStats({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * DAY, sessions = [], byModel = {}, blocks = { thinking: 0, text: 0, tool_use: 0, unattributed: 0, tools: {} }; let authoredLines = 0;
  for (const { file, st, parsed } of claudeFiles(home, cutoff)) {
    if (st.mtimeMs < cutoff) continue;
    let outputTokens = 0, sideOutput = 0, mainOutput = 0;
    for (const row of parsed.records) {
      if (row.ts < cutoff) continue; authoredLines += row.authoredLines || 0;
      const out = row.out || 0; if (!out) continue;
      outputTokens += out; byModel[row.tier] = (byModel[row.tier] || 0) + out;
      if (row.side) sideOutput += out; else mainOutput += out;
      for (const name of ['thinking', 'text', 'tool_use', 'unattributed']) blocks[name] += row.blocks?.[name] || 0;
      for (const [name, amount] of Object.entries(row.blocks?.tools || {})) blocks.tools[name] = (blocks.tools[name] || 0) + amount;
    }
    if (outputTokens) sessions.push({ session: path.basename(file, '.jsonl'), file, outputTokens, mainOutput, subOutput: sideOutput });
  }
  sessions.sort((a, b) => b.outputTokens - a.outputTokens);
  const total = sessions.reduce((s, x) => s + x.outputTokens, 0), main = sessions.reduce((s, x) => s + x.mainOutput, 0), sub = sessions.reduce((s, x) => s + x.subOutput, 0);
  saveCache(home); return { sessions, totals: { outputTokens: total, main, sub }, byModel, blocks, authoredLines };
}
export function classifyBashCommand(command) {
  command = String(command || '');
  if (isExcludedInlineProgramCommand(command)) return 'delegated';
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
  if (extractInlineProgram(command)) return 'inline-program';
  if (heredoc.test(command) || /(?:^|\s)(?:>|>>)(?![>&])\s*[^\s;&|]+/.test(command)) return 'spec-authoring';
  if (/^\s*git(?:\s|$)/i.test(command)) return 'git';
  if (/^\s*(?:cat|head|tail|sed\s+-n|grep|ls|wc|find)(?:\s|$)/i.test(command) && !/(?:^|[^<])>{1,2}/.test(command)) return 'read-only';
  return 'other';
}
export function collectBashProfile({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * DAY;
  const categoryNames = ['inline-program', 'spec-authoring', 'delegated', 'git', 'read-only', 'other'];
  const byCategory = Object.fromEntries(categoryNames.map((category) => [category, { calls: 0, chars: 0, pct: 0 }]));
  const commands = [];
  for (const { parsed } of claudeFiles(home, cutoff)) {
    for (const command of parsed.commands) {
      if (command.ts < cutoff) continue;
      byCategory[command.category].calls++; byCategory[command.category].chars += command.chars; commands.push({ chars: command.chars, category: command.category, preview: command.preview });
    }
  }
  const totalCalls = commands.length, totalChars = commands.reduce((sum, command) => sum + command.chars, 0);
  for (const stats of Object.values(byCategory)) stats.pct = totalChars ? stats.chars / totalChars * 100 : 0;
  commands.sort((a, b) => b.chars - a.chars);
  saveCache(home); return { days, totalCalls, totalChars, byCategory, top: commands.slice(0, 15) };
}
export function collectClaudeCostStats({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * DAY, byModel = {}, usageByModel = {}; let outputTokens = 0, cacheBase = 0, cacheRead = 0, cacheWrite = 0, topFableSource = null;
  for (const { file, st, parsed } of claudeFiles(home, cutoff)) {
    if (st.mtimeMs < cutoff) continue;
    let fileFableOut = 0, fileFableLatest = 0;
    for (const row of parsed.records) {
      if ((row.ts && row.ts < cutoff) || row.out === undefined) continue;
      cacheBase += row.input || 0; cacheRead += row.cacheRead || 0; cacheWrite += row.cacheWrite || 0; outputTokens += row.out || 0;
      byModel[row.tier] = (byModel[row.tier] || 0) + (row.out || 0);
      const usage = usageByModel[row.tier] ||= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      usage.input += row.input || 0; usage.cacheRead += row.cacheRead || 0; usage.cacheWrite += row.cacheWrite || 0; usage.output += row.out || 0;
      if (row.tier === 'fable') { fileFableOut += row.out || 0; fileFableLatest = Math.max(fileFableLatest, row.ts || st.mtimeMs); }
    }
    if (fileFableOut > (topFableSource?.outputTokens || 0)) topFableSource = { sessionId: path.basename(file, '.jsonl'), outputTokens: fileFableOut, latest: fileFableLatest };
  }
  saveCache(home); return { outputTokens, byModel, usageByModel, cacheBase, cacheRead, cacheWrite, topFableSource };
}
export function collectLedger({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * DAY, providers = {}; let outputTokens = 0, success = 0, failure = 0;
  let raw = ''; try { raw = fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8'); } catch {}
  for (const line of raw.split(/\r?\n/)) { let r; try { r = JSON.parse(line); } catch { continue; } if (Date.parse(r.t || '') < cutoff) continue; const p = String(r.provider || 'unknown'); const x = providers[p] ||= { calls: 0, success: 0, failure: 0, inputTokens: 0, outputTokens: 0 }; x.calls++; x.inputTokens += Number(r.in) || 0; x.outputTokens += Number(r.out) || 0; outputTokens += Number(r.out) || 0; if (r.status === 'ok') { x.success++; success++; } else { x.failure++; failure++; } }
  return { providers, totals: { calls: success + failure, success, failure, outputTokens } };
}
export function codexSessionDirs(home = process.env.ORGIAST_HOME || os.homedir()) {
  if (process.env.CODEX_SESSIONS_DIRS !== undefined) return process.env.CODEX_SESSIONS_DIRS.split(path.delimiter).filter(Boolean);
  const dirs = [path.join(home, '.codex', 'sessions')];
  const addUsers = (root) => {
    let users = []; try { users = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const user of users) if (user.isDirectory()) dirs.push(path.join(root, user.name, '.codex', 'sessions'));
  };
  // `//wsl.localhost/` itself cannot be enumerated, so ask wsl.exe for distro names.
  if (process.platform === 'win32') {
    let distros = [];
    try { distros = execSync('wsl.exe -l -q', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString('utf16le').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch {}
    for (const distro of distros) { addUsers(`//wsl.localhost/${distro}/home`); addUsers(`//wsl$/${distro}/home`); }
  }
  if (process.platform === 'linux') addUsers('/home');
  return [...new Set(dirs)];
}
export function collectCodexUsage({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now(), includePatchLines = false } = {}) {
  const cutoff = now - days * DAY; let outputTokens = 0, sessions = 0, added = 0, deleted = 0, patchFiles = 0;
  const files = [];
  for (const dir of codexSessionDirs(home)) files.push(...cachedWalk(home, dir));
  const uniqueFiles = [...new Set(files)], stats = bulkStat(uniqueFiles);
  for (let i = 0; i < uniqueFiles.length; i++) {
    const file = uniqueFiles[i], st = stats[i]; if (!st || st.mtimeMs < cutoff) continue;
    const parsed = cachedFile(home, file, 'codex', st, () => { let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; } const lines = countPatchLines(raw); const re = /"total_token_usage"\s*:\s*\{[^{}]*?"output_tokens"\s*:\s*(\d+)/g; let match, last = null; while ((match = re.exec(raw)) !== null) last = Number(match[1]); return { last, added: lines.added, deleted: lines.deleted }; });
    if (!parsed) continue;
    if (includePatchLines) { added += parsed.added; deleted += parsed.deleted; patchFiles++; }
    const last = parsed.last;
    if (last !== null) { outputTokens += last; sessions++; }
  }
  saveCache(home); return includePatchLines ? { outputTokens, sessions, added, deleted, patchFiles } : { outputTokens, sessions };
}
export const collectCodexOutput = collectCodexUsage;
export function countPatchLines(text) {
  const total = { added: 0, deleted: 0 };
  const count = (patch) => {
    let inPatch = !patch.includes('*** Begin Patch');
    for (const line of patch.split(/\r?\n/)) {
      if (line.includes('*** Begin Patch')) { inPatch = true; continue; }
      if (line.includes('*** End Patch')) { inPatch = false; continue; }
      if (!inPatch || line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
      if (line.startsWith('+')) total.added++;
      else if (line.startsWith('-')) total.deleted++;
    }
  };
  const visit = (value, patchContext = false) => {
    if (typeof value === 'string') {
      const decoded = value.replace(/\\r\\n|\\n/g, '\n');
      if (patchContext || (/apply_patch/.test(decoded) && decoded.includes('*** Begin Patch'))) count(decoded);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const isPatch = value.name === 'apply_patch';
    if (isPatch) {
      visit(value.input, true);
      visit(value.arguments, true);
      return;
    }
    for (const child of Object.values(value)) visit(child, patchContext);
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/"name"\s*:\s*"apply_patch"|tools\.apply_patch\(/.test(line)) continue;
    try { visit(JSON.parse(line)); } catch { }
  }
  return total;
}
export function collectCodexPatchLines({ dirs = codexSessionDirs(), since = 0 } = {}) {
  const cutoff = since instanceof Date ? since.getTime() : Number(since) || 0;
  const result = { added: 0, deleted: 0, files: 0 }, files = [];
  for (const dir of dirs) walkJsonl(dir, files);
  for (const file of new Set(files)) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = countPatchLines(raw);
    result.added += lines.added; result.deleted += lines.deleted; result.files++;
  }
  return result;
}
export function collectGitActivity({ repos = [process.cwd()], days = 7 } = {}) {
  const result = { added: 0, deleted: 0, repos: 0, commits: 0 };
  for (const repo of repos) {
    const run = spawnSync('git', ['-C', repo, 'log', `--since=${days} days ago`, '--numstat', '--pretty=tformat:commit %H'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (run.error || run.status !== 0) continue;
    result.repos++;
    for (const line of run.stdout.split(/\r?\n/)) {
      if (line.startsWith('commit ')) { result.commits++; continue; }
      const [added, deleted] = line.split(/\s+/, 2);
      if (/^\d+$/.test(added)) result.added += Number(added);
      if (/^\d+$/.test(deleted)) result.deleted += Number(deleted);
    }
  }
  return result;
}
export function collectLandedLines(options = {}) {
  const { added, deleted, repos } = collectGitActivity(options);
  return { added, deleted, repos };
}
export function countAuthoredLines(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAuthoredLines(item), 0);
  const text = typeof value === 'string' ? value : '';
  return text.length ? text.split(/\r?\n/).length : 0;
}
function authoredLinesFromToolUse(block) {
  if (block?.type !== 'tool_use') return 0;
  const input = block.input || {};
  if (block.name === 'Edit') return countAuthoredLines(input.new_string);
  if (block.name === 'MultiEdit') return (Array.isArray(input.edits) ? input.edits : []).reduce((sum, edit) => sum + countAuthoredLines(edit?.new_string), 0);
  if (block.name === 'Write') return countAuthoredLines(input.content);
  if (block.name === 'NotebookEdit') return countAuthoredLines(input.new_source);
  if (block.name === 'Bash' || block.name === 'PowerShell') return extractInlineProgram(input.command)?.lines || 0;
  return 0;
}
export function collectClaudeLines({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now() } = {}) {
  return collectClaudeStats({ home, days, now }).authoredLines;
}
export function calculateLinesDelegation({ codexLines = 0, claudeLines = 0 } = {}) {
  const total = codexLines + claudeLines;
  return total > 0 ? codexLines / total : null;
}
export function calculateDelegation({ codexOut = 0, execOut = 0, byModel = {}, specAuthoringOut = 0 } = {}) {
  const sonnetHaikuOut = (byModel.sonnet || 0) + (byModel.haiku || 0), supervisorOut = (byModel.opus || 0) + (byModel.fable || 0) + (byModel.default || 0);
  const delegated = codexOut + execOut + sonnetHaikuOut, total = delegated + supervisorOut;
  const delegRatio = total ? delegated / total : 0;
  return { codexOut, execOut, sonnetHaikuOut, supervisorOut, delegated, total, delegRatio, delegRatioWithPrep: total ? (delegated + specAuthoringOut) / total : 0, specAuthoringOut };
}
/**
 * Estimate spec-authoring output tokens by apportioning Bash/PowerShell tool-use
 * tokens according to their share of Bash/PowerShell command characters. This
 * is a character-ratio estimate, not an exact token measurement.
 */
export function estimateSpecAuthoringTokens({ blocks = {}, profile = {} } = {}) {
  const totalBashChars = Number(profile.totalChars) || 0;
  if (!totalBashChars) return 0;
  const bashOutputTokens = (Number(blocks?.tools?.Bash) || 0) + (Number(blocks?.tools?.PowerShell) || 0);
  const specAuthoringChars = Number(profile?.byCategory?.['spec-authoring']?.chars) || 0;
  return bashOutputTokens * (specAuthoringChars / totalBashChars);
}
export function formatBlockSource(blocks) {
  const entries = [['tool_use', blocks.tool_use || 0], ['text', blocks.text || 0], ['thinking', blocks.thinking || 0], ['unattributed', blocks.unattributed || 0]].filter(([, value]) => value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const shares = entries.map(([name, value]) => ({ name, value, exact: total ? value / total * 100 : 0 }));
  let remaining = 100 - shares.reduce((sum, share) => sum + Math.floor(share.exact), 0);
  for (const share of [...shares].sort((a, b) => (b.exact % 1) - (a.exact % 1))) share.pct = Math.floor(share.exact) + (remaining-- > 0 ? 1 : 0);
  const pct = (n, base) => Math.round(n / (base || 1) * 100);
  const top = Object.entries(blocks.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${pct(v, blocks.tool_use)}%`).join(' / ');
  return shares.map(({ name, pct: percentage }) => `${name} ${percentage}%${name === 'tool_use' && top ? ` (${top})` : ''}`).join(' / ');
}
export function formatBashProfile(profile) {
  const inline = profile.byCategory['inline-program'], spec = profile.byCategory['spec-authoring'];
  const lines = [
    `Bash/PowerShell profile (${profile.days} days): ${profile.totalCalls} calls, ${profile.totalChars} chars (~${Math.round(profile.totalChars / 4)} output tokens)`,
    `waste (inline-program): ${inline.chars} chars (${inline.pct.toFixed(1)}%)`,
    `delegation preparation (spec-authoring): ${spec.chars} chars (${spec.pct.toFixed(1)}%)`,
    '',
    'category         calls      chars      pct',
  ];
  for (const [category, stats] of Object.entries(profile.byCategory)) lines.push(`${category.padEnd(16)} ${String(stats.calls).padStart(5)} ${String(stats.chars).padStart(10)} ${stats.pct.toFixed(1).padStart(7)}%`);
  if (profile.top.length) {
    lines.push('', 'top commands');
    for (const item of profile.top) lines.push(`${String(item.chars).padStart(7)}  ${item.category.padEnd(14)}  ${item.preview}`);
  }
  return lines.join('\n');
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2), sub = args.find((x) => !x.startsWith('--')) || 'sessions', daysArg = args.find((x) => x.startsWith('--days='));
  const daysIndex = args.indexOf('--days'), days = Number(daysArg?.split('=')[1] || (daysIndex >= 0 ? args[daysIndex + 1] : 7)) || 7, json = args.includes('--json');
  const home = process.env.ORGIAST_HOME || os.homedir(), claude = collectClaudeStats({ home, days }); let result;
  if (sub === 'sessions') result = { sessions: claude.sessions, totals: claude.totals, byModel: claude.byModel };
  else if (sub === 'blocks') result = claude.blocks;
  else if (sub === 'bash') result = collectBashProfile({ home, days });
  else if (sub === 'ledger') result = collectLedger({ home, days });
  else if (sub === 'deleg') { const ledger = collectLedger({ home, days }), codex = collectCodexUsage({ home, days }); result = calculateDelegation({ codexOut: codex.outputTokens, execOut: ledger.totals.outputTokens, byModel: claude.byModel }); }
  else { console.error('usage: node tools/usage-stats.mjs <sessions|blocks|bash|ledger|deleg> [--days 7] [--json]'); process.exitCode = 2; }
  if (result) console.log(json ? JSON.stringify(result, null, 2) : sub === 'blocks' ? formatBlockSource(result) : sub === 'bash' ? formatBashProfile(result) : JSON.stringify(result, null, 2));
}
