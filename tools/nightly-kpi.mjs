#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRICING } from './claude-cost-reporter.mjs';
import { notifyKim } from './notify-kim.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { isEntry } from './is-entry.mjs';

export const NO_OP_PATTERNS = [
  /コード変更(?:は)?不要/i,
  /差分ゼロ/i,
  /既に修正済み/i,
  /変更ゼロ/i,
  /実装は不要/i,
  /再実装は行わなかった/i,
  /already\s+(?:fixed|resolved|merged)/i,
  /no\s+(?:new\s+)?code/i,
];

const DAY_MS = 86_400_000;
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
const normalizeSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function normalizeTodo(text) {
  return normalizeSpace(String(text ?? '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/→\s*✅[\s\S]*$/, '')
    .replace(/~~|\*\*/g, ''));
}

export function parseTodos(markdown) {
  const lines = String(markdown ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const rawTodos = [];
  let inBlock = false;
  let current = null;
  const flush = () => { if (current) rawTodos.push(current.join('\n')); current = null; };
  for (const line of lines) {
    if (/^##\s+残TODO/.test(line)) { flush(); inBlock = true; continue; }
    if (inBlock && /^##\s+/.test(line)) { flush(); inBlock = false; continue; }
    if (!inBlock) continue;
    if (/^\s*\d+\.\s*/.test(line)) { flush(); current = [line]; }
    else if (current) current.push(line);
  }
  flush();
  const byKey = new Map();
  for (const raw of rawTodos) {
    const key = normalizeTodo(raw);
    if (!key) continue;
    const completed = raw.includes('✅');
    const completedDate = raw.match(/✅\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { key, text: normalizeSpace(raw.replace(/^\s*\d+\.\s*/, '')), completed, completedDate, dateUnknown: completed && !completedDate });
    else if (completed && !existing.completed) Object.assign(existing, { completed, completedDate, dateUnknown: !completedDate, text: normalizeSpace(raw.replace(/^\s*\d+\.\s*/, '')) });
  }
  return { todos: [...byKey.values()], duplicateTodoLines: rawTodos.length - byKey.size };
}

export function nightlyWindow(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  const end = new Date(year, month - 1, day, 9, 0, 59, 999);
  const start = new Date(year, month - 1, day - 1, 18, 0, 0, 0);
  return { start, end };
}

export function isInNightlyWindow(timestamp, date) {
  const time = new Date(timestamp).getTime();
  const { start, end } = nightlyWindow(date);
  return Number.isFinite(time) && time >= start.getTime() && time <= end.getTime();
}

export function parseRun(run) {
  let event = null;
  let costKnown = false;
  try { event = typeof run.stdout === 'string' ? JSON.parse(run.stdout) : run.stdout; } catch {}
  const totalCost = event?.total_cost_usd === null || event?.total_cost_usd === undefined ? NaN : Number(event.total_cost_usd);
  const modelUsage = event?.modelUsage && typeof event.modelUsage === 'object' ? event.modelUsage : {};
  let calculated = 0;
  let hasPricedUsage = false;
  const policyViolations = [];
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (/claude-fable-5/i.test(model)) policyViolations.push(`禁止モデルを検出: ${model}`);
    const price = PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, '')];
    if (!price) continue;
    hasPricedUsage = true;
    calculated += tokenCost(usage, price);
  }
  let nightCostUsd = null;
  if (Number.isFinite(totalCost)) { nightCostUsd = totalCost; costKnown = true; }
  else if (hasPricedUsage) { nightCostUsd = calculated; costKnown = true; }
  const combinedText = `${run.summary ?? ''}\n${event?.result ?? ''}`;
  return { ...run, event, modelUsage, nightCostUsd, costKnown, noOp: NO_OP_PATTERNS.some((pattern) => pattern.test(combinedText)), policyViolations };
}

function usageTokens(usage = {}) {
  return {
    in: Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0,
    out: Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0,
    cacheWrite: Number(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0) || 0,
    cacheRead: Number(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0) || 0,
  };
}

export function tokenCost(usage, price) {
  const t = usageTokens(usage);
  return (t.in * price.in + t.out * price.out + t.cacheWrite * price.cacheWrite + t.cacheRead * price.cacheRead) / 1e6;
}

export function parseBatchLog(content) {
  if (content === null || content === undefined) return { batchRan: false, batchCompleted: false, batchStepsOk: 0, batchStepsTotal: 0, failedSteps: [], lastStep: null };
  const steps = [];
  for (const line of String(content).split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(' / ');
    if (parts.length < 3) continue;
    const step = parts[1].trim();
    const detail = parts.slice(2).join(' / ').trim();
    steps.push({ step, detail });
  }
  return {
    batchRan: true,
    batchCompleted: steps.some(({ step, detail }) => step === 'サマリ' || /nightly-batch\s+完了/.test(detail)),
    batchStepsOk: steps.filter(({ detail }) => detail.startsWith('ok:')).length,
    batchStepsTotal: steps.length,
    failedSteps: [...new Set(steps.filter(({ detail }) => detail.startsWith('error:')).map(({ step }) => step))],
    lastStep: steps.at(-1)?.step ?? null,
  };
}

export function calculateKpi({ date, todoParse, runs, batch, taskInfo = null }) {
  const previousDate = localDate(new Date(nightlyWindow(date).start.getTime()));
  const completed = todoParse.todos.filter((todo) => todo.completed);
  const closedOvernight = completed.filter((todo) => todo.completedDate === date || todo.completedDate === previousDate).length;
  const backlogAtEnd = todoParse.todos.filter((todo) => !todo.completed).length;
  const selected = runs.filter((run) => isInNightlyWindow(run.startedAt, date)).map(parseRun);
  const sessions = selected.length;
  const succeeded = selected.filter((run) => run.status === 'success' && !run.launchFailed).length;
  const timedOut = selected.filter((run) => run.status === 'timeout').length;
  const failed = selected.filter((run) => run.launchFailed || !['success', 'timeout'].includes(run.status)).length;
  const noOps = selected.filter((run) => run.noOp);
  const topics = new Map();
  for (const run of selected) { const key = normalizeTodo(run.todo).slice(0, 120); topics.set(key, (topics.get(key) ?? 0) + 1); }
  const nightCosts = selected.filter((run) => run.costKnown).map((run) => run.nightCostUsd);
  const nightCostUsd = nightCosts.length ? nightCosts.reduce((a, b) => a + b, 0) : null;
  let supervisorEquivalentUsd = 0;
  let hasUsage = false;
  for (const run of selected) for (const usage of Object.values(run.modelUsage)) { hasUsage = true; supervisorEquivalentUsd += tokenCost(usage, PRICING['claude-opus-5']); }
  if (!hasUsage) supervisorEquivalentUsd = null;
  const wastedCosts = noOps.filter((run) => run.costKnown).map((run) => run.nightCostUsd);
  const wastedUsd = wastedCosts.length ? wastedCosts.reduce((a, b) => a + b, 0) : (noOps.length ? null : 0);
  const modelSavingUsd = nightCostUsd === null || supervisorEquivalentUsd === null ? null : supervisorEquivalentUsd - nightCostUsd;
  const netSavingUsd = modelSavingUsd === null || wastedUsd === null ? null : modelSavingUsd - wastedUsd;
  const durations = selected.map((run) => (new Date(run.endedAt) - new Date(run.startedAt)) / 60_000).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const median = durations.length ? (durations.length % 2 ? durations[(durations.length - 1) / 2] : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2) : null;
  const backlogAtStart = backlogAtEnd + closedOvernight;
  return {
    date,
    closeRate: backlogAtStart ? closedOvernight / backlogAtStart : null,
    noOpRate: sessions ? noOps.length / sessions : null,
    netSavingUsd: round(netSavingUsd),
    backlogAtStart, closedOvernight, backlogAtEnd,
    netBurnDown: backlogAtStart - backlogAtEnd,
    dateUnknown: completed.filter((todo) => todo.dateUnknown).length,
    duplicateTodoLines: todoParse.duplicateTodoLines,
    sessions, succeeded, failed, timedOut, noOpSessions: noOps.length,
    topicConcentration: sessions ? Math.max(0, ...topics.values()) / sessions : null,
    ...batch,
    scheduledTask: taskInfo,
    nightCostUsd: round(nightCostUsd),
    supervisorEquivalentUsd: round(supervisorEquivalentUsd),
    modelSavingUsd: round(modelSavingUsd),
    wastedUsd: round(wastedUsd),
    savingPerClosedTodo: closedOvernight && netSavingUsd !== null ? round(netSavingUsd / closedOvernight) : null,
    humanMinutesSaved: median === null ? null : round(closedOvernight * median),
    medianSessionMinutes: round(median),
    costUnknownSessions: selected.filter((run) => !run.costKnown).length,
    policyViolations: [...new Set(selected.flatMap((run) => run.policyViolations))],
    costNote: 'すべて list 価格換算であり、実請求額ではありません。',
  };
}

const pct = (value) => value === null ? '不明' : `${(value * 100).toFixed(1)}%`;
const usd = (value) => value === null ? '不明' : `$${value.toFixed(2)}`;

export function improvementTodos(kpi, previous = null) {
  const todos = [];
  if (!kpi.batchRan) todos.push(`P0: 夜間バッチが起動直後に死んでログを1行も書いていない（${kpi.date}）。OrgiastNightlyBatch と同時刻に走る他タスクとの競合を疑う`);
  else if (!kpi.batchCompleted) todos.push(`P0: 夜間バッチが途中で停止（サマリ行なし）。最終ステップ = ${kpi.lastStep ?? '不明'}`);
  if (kpi.failedSteps.length) todos.push(`P1: 夜間バッチのステップ失敗: ${kpi.failedSteps.join('、')}`);
  if (kpi.noOpRate !== null && kpi.noOpRate > 0.3) todos.push(`P1: 空回り率 ${pct(kpi.noOpRate)}。完了済みTODOが引き継ぎ票に残り再配布されている。next-session.md の ✅ 済みブロックを刈る`);
  if (kpi.topicConcentration !== null && kpi.topicConcentration > 0.5) todos.push(`P1: セッションの ${pct(kpi.topicConcentration)} が同一テーマに集中。TODO の配り方を見直す`);
  if (kpi.closeRate !== null && previous?.closeRate !== null && previous?.closeRate !== undefined && kpi.closeRate < previous.closeRate && kpi.closeRate < 0.2) todos.push(`P1: 消化率が ${pct(kpi.closeRate)} に低下`);
  return todos;
}

export function appendImprovementTodos(markdown, additions) {
  const parsed = parseTodos(markdown);
  const existing = new Set(parsed.todos.filter((todo) => !todo.completed).map((todo) => todo.key));
  const pending = additions.filter((todo) => !existing.has(normalizeTodo(todo)));
  if (!pending.length) return { markdown, added: [] };
  const match = /^##\s+残TODO[^\r\n]*(?:\r?\n|$)/m.exec(markdown);
  if (!match) return { markdown, added: [] };
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = /^##\s+/m.exec(rest);
  const end = nextHeading ? start + nextHeading.index : markdown.length;
  const section = markdown.slice(start, end);
  const numbers = [...section.matchAll(/^\s*(\d+)\.\s*/gm)].map((m) => Number(m[1]));
  let number = numbers.length ? Math.max(...numbers) + 1 : 1;
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const insertion = `${section && !section.endsWith(newline) ? newline : ''}${pending.map((todo) => `${number++}. ${todo}`).join(newline)}${newline}`;
  return { markdown: markdown.slice(0, end) + insertion + markdown.slice(end), added: pending };
}

export function queryScheduledTaskInfo(spawn = spawnSync) {
  if (process.platform !== 'win32' && spawn === spawnSync) return null;
  try {
    const command = "$i=Get-ScheduledTaskInfo -TaskName 'OrgiastNightlyBatch' -ErrorAction Stop; @{LastRunTime=$i.LastRunTime.ToString('o');LastTaskResult=$i.LastTaskResult}|ConvertTo-Json -Compress";
    const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (result.error || result.status !== 0) return null;
    const value = JSON.parse(String(result.stdout).replace(/^\uFEFF/, '').trim());
    return { lastRunTime: value.LastRunTime ?? null, lastTaskResult: value.LastTaskResult ?? null };
  } catch { return null; }
}

export function formatText(kpi, previous = null, added = []) {
  const delta = (key, format) => previous && typeof kpi[key] === 'number' && typeof previous[key] === 'number' ? `（前日比 ${format(kpi[key] - previous[key])}）` : '';
  return [
    `夜間KPI ${kpi.date}`,
    `主KPI: 消化率 ${pct(kpi.closeRate)}${delta('closeRate', (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pt`)} / 空回り率 ${pct(kpi.noOpRate)}${delta('noOpRate', (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pt`)} / 純削減 ${usd(kpi.netSavingUsd)}${delta('netSavingUsd', (v) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`)}`,
    `消化: ${kpi.closedOvernight}/${kpi.backlogAtStart}件 / 残 ${kpi.backlogAtEnd}件 / 純減 ${kpi.netBurnDown}件 / 日付不明完了 ${kpi.dateUnknown}件`,
    `セッション: ${kpi.sessions}件（成功 ${kpi.succeeded} / 失敗 ${kpi.failed} / timeout ${kpi.timedOut} / 空回り ${kpi.noOpSessions}）/ テーマ集中 ${pct(kpi.topicConcentration)}`,
    `夜間バッチ: ran=${kpi.batchRan} / completed=${kpi.batchCompleted} / ok=${kpi.batchStepsOk}/${kpi.batchStepsTotal}${kpi.failedSteps.length ? ` / 失敗=${kpi.failedSteps.join('、')}` : ''}`,
    `コスト: 夜間 ${usd(kpi.nightCostUsd)} / 監督相当 ${usd(kpi.supervisorEquivalentUsd)} / モデル削減 ${usd(kpi.modelSavingUsd)} / 空回り ${usd(kpi.wastedUsd)} / 完了1件あたり ${usd(kpi.savingPerClosedTodo)}`,
    `参考: 無人消化実時間の中央値 ${kpi.medianSessionMinutes === null ? '不明' : `${kpi.medianSessionMinutes.toFixed(1)}分`} × 完了件数 = ${kpi.humanMinutesSaved === null ? '不明' : `${kpi.humanMinutesSaved.toFixed(1)}分`}`,
    `注記: ${kpi.costNote}`,
    `改善起票: ${added.length ? `${added.length}件` : 'なし'}`,
    ...kpi.policyViolations.map((v) => `規則違反: ${v}`),
  ].join('\n');
}

function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, content, 'utf8'); fs.renameSync(tmp, file); }
  finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const valueOf = (name) => {
    const equals = argv.find((arg) => arg.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const date = valueOf('--date') ?? localDate(new Date());
  const format = valueOf('--format') ?? 'text';
  const workspaceHome = process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1];
  const home = valueOf('--home') ?? io.home ?? process.env.ORGIAST_HOME ?? process.env.USERPROFILE ?? workspaceHome ?? os.homedir();
  const dryRun = argv.includes('--dry-run');
  const noNotify = argv.includes('--no-notify');
  const claude = path.join(home, '.claude');
  const runsDir = path.join(claude, 'auto-session', 'runs');
  let runNames = [];
  // feedback-* も1セッションとして実在する。manifest/deadline は実行記録ではないので名前で除外する。
  try { runNames = fs.readdirSync(runsDir).filter((name) => /^\d{4}-\d{2}-\d{2}-(?:\d+|feedback-.+)\.json$/.test(name)); } catch {}
  const runs = runNames.map((name) => { try { return JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8')); } catch { return null; } }).filter(Boolean);
  const handoffFile = path.join(claude, 'next-session.md');
  let handoff = '';
  try { handoff = fs.readFileSync(handoffFile, 'utf8'); } catch {}
  const batchFile = path.join(claude, 'logs', `nightly-batch-${date}.log`);
  let batchContent = null;
  try { batchContent = fs.readFileSync(batchFile, 'utf8'); } catch {}
  const outputDir = path.join(claude, 'nightly-kpi');
  const previousDate = localDate(new Date(nightlyWindow(date).start.getTime() - DAY_MS));
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(outputDir, `${previousDate}.json`), 'utf8')); } catch {}
  const kpi = calculateKpi({ date, todoParse: parseTodos(handoff), runs, batch: parseBatchLog(batchContent), taskInfo: queryScheduledTaskInfo(io.spawn) });
  const candidates = improvementTodos(kpi, previous);
  const appended = appendImprovementTodos(handoff, candidates);
  if (!dryRun && appended.added.length) atomicWrite(handoffFile, appended.markdown);
  if (!dryRun) atomicWrite(path.join(outputDir, `${date}.json`), `${JSON.stringify(kpi, null, 2)}\n`);
  if (!noNotify && appended.added.length) {
    try { await (io.notify ?? notifyKim)(`🚨 夜間KPI ${date}\n${appended.added.map((todo) => `- ${todo}`).join('\n')}`, { home }); }
    catch (error) { console.error(`nightly-kpi: 通知失敗: ${redactSecrets(error?.message ?? error)}`); }
  }
  const output = format === 'json' ? JSON.stringify(kpi, null, 2) : formatText(kpi, previous, appended.added);
  (io.log ?? console.log)(output);
  return { kpi, added: appended.added, output };
}

if (isEntry(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`nightly-kpi: ${redactSecrets(error?.stack ?? error)}`); process.exitCode = 1; }
}
