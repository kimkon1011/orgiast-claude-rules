#!/usr/bin/env node
// cost-weekly-improve.mjs — 週次「改善提案→自動適用→効果検証」ループ(仕様C)。
// 日次ループ(cost-improve-loop)は閾値違反→定型対処。週1回、直近の KPI 履歴・台帳・違反・料金一次情報を
// 安いAI(既定 deepseek / gemini 可。Claude 系は呼ばない)に渡して改善提案を作る。
// 許可リストに載っている command だけを自動適用し、残りは kim へ DM する。
// 適用した提案は ~/.claude/cost-improve-state.json の actions に mode:'auto-weekly' で登録し、
// 日次ループの verifyPreviousActions(効果検証)に載せる。翌週 no_effect なら同種提案を4週間抑止する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { atomicWrite } from './cost-improve-loop.mjs';
import { notifyKim } from './notify-kim.mjs';
import { collectProviderHealth, collectClaudeStats } from './usage-stats.mjs';
import { collectBudgetStatus } from './budget-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const WEEKLY_ALLOWED_PROVIDERS = ['deepseek', 'gemini', 'groq', 'openrouter', 'kimi', 'mistral', 'glm', 'cerebras'];
const FOUR_WEEKS = 4 * 7 * 86400000;

export function isAllowedWeeklyProvider(provider) {
  const name = String(provider || '').toLowerCase();
  return WEEKLY_ALLOWED_PROVIDERS.includes(name) && !/anthropic|claude/.test(name);
}

export function formatJst(date) {
  const jst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const two = (value) => String(value).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${two(jst.getUTCMonth() + 1)}-${two(jst.getUTCDate())} ${two(jst.getUTCHours())}:${two(jst.getUTCMinutes())}:${two(jst.getUTCSeconds())}`;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ---- 提案JSONの解釈 ----
export function parseProposalsText(text) {
  const body = String(text || '').trim();
  if (!body) return [];
  let json = null;
  try { json = JSON.parse(body); } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { json = JSON.parse(body.slice(start, end + 1)); } catch {}
    }
  }
  if (!json || !Array.isArray(json.proposals)) return [];
  return json.proposals
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const action = raw.action && typeof raw.action === 'object' ? raw.action : {};
      return {
        id: String(raw.id || `proposal-${index + 1}`),
        title: String(raw.title || `提案${index + 1}`).slice(0, 120),
        rationale: String(raw.rationale || '').slice(0, 500),
        expectedSavingJpyPerMonth: Number(raw.expectedSavingJpyPerMonth) || 0,
        confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
        risk: String(raw.risk || ''),
        action: { type: action.type === 'command' ? 'command' : 'human', command: action.command, note: String(action.note || '') },
      };
    })
    .filter(Boolean);
}

// 提案がどの指標を改善しようとしているかを、タイトル/理由から推定する(日次ループの verify 対象 metric に写像)。
export function proposalMetric(proposal) {
  const text = `${proposal?.title || ''} ${proposal?.rationale || ''} ${proposal?.action?.note || ''}`;
  if (/無人|headless|自動セッション|auto-session|next-session/.test(text)) return 'headlessClaudeOut';
  if (/予算|ペース|budget|月次|コスト超過|削減額/.test(text)) return 'pacePercent';
  return 'delegRatio';
}

function commandSignature(parts) {
  return (parts || []).slice(0, 4).join(' ');
}

export function proposalSignature(proposal, metric) {
  const command = Array.isArray(proposal?.action?.command) ? proposal.action.command : [];
  const head = commandSignature(command.map((x) => String(x)));
  return `${metric}:${head || (proposal?.title || 'human')}`;
}

// ---- command の許可リスト判定 ----
// 許可リスト外は自動実行しない(→ human 扱い)。配列でない・不正な形は拒否(→ 記録せず落とす)。
export function classifyWeeklyCommand(command) {
  if (!Array.isArray(command)) return { ok: false, reason: '配列でない command は許可しません', reject: true };
  const parts = command.map((x) => String(x)).filter(Boolean);
  if (!parts.length) return { ok: false, reason: 'command が空です', reject: true };
  const head = parts.join(' ');
  const fixed = [
    'node tools/routing-table.mjs --rebuild',
    'node tools/batch-enqueue.mjs --kind eval-harness',
    'node tools/llm-ask.mjs --print-key-status',
    'node tools/auto-session-executor.mjs --set cheap-code --provider glm',
    'node tools/auto-session-executor.mjs --set cheap-code --provider deepseek',
  ];
  if (fixed.includes(head)) return { ok: true, parts };
  if (parts[0] === 'node' && parts[1] === 'tools/routing-table.mjs' && parts[2] === '--demote') {
    const provider = String(parts[3] || '');
    if (!/^[a-z0-9_-]+$/.test(provider)) return { ok: false, reason: 'demote の provider 名が不正です', reject: true };
    if (parts.length === 4) return { ok: true, parts: [...parts, '--days', '3'] };
    const days = parts[4] === '--days' ? Number(parts[5]) : NaN;
    if (parts.length !== 6 || !Number.isFinite(days) || days < 0) return { ok: false, reason: 'demote は --days <N> だけ追加できます', reject: true };
    return { ok: true, parts };
  }
  if (parts[0] === 'node' && parts[1] === 'tools/routing-table.mjs' && parts[2] === '--promote') {
    const provider = String(parts[3] || '');
    if (parts.length !== 4 || !/^[a-z0-9_-]+$/.test(provider)) return { ok: false, reason: 'promote の引数が不正です', reject: true };
    return { ok: true, parts };
  }
  return { ok: false, reason: `許可リスト外の command です: ${head}`, reject: false };
}

// ---- 4週間抑止(no_effect 検証済みの同種提案) ----
export function suppressNoEffectProposals(proposals, actions, now) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const suppressed = new Set();
  for (const act of Array.isArray(actions) ? actions : []) {
    if (act.source !== 'cost-weekly' || act.result !== 'no_effect') continue;
    const verifiedAt = Date.parse(act.verifiedAt || '');
    if (Number.isFinite(verifiedAt) && nowMs - verifiedAt < FOUR_WEEKS && act.signature) suppressed.add(act.signature);
  }
  if (!suppressed.size) return proposals;
  const kept = [];
  for (const proposal of proposals) {
    const signature = proposalSignature(proposal, proposalMetric(proposal));
    if (suppressed.has(signature)) continue;
    kept.push(proposal);
  }
  return kept;
}

// ---- LLM(安いAI)で提案生成 ----
export async function askForProposals({ provider, context, claudeDir, askImpl = null, now = new Date(), includeRaw = false }) {
  if (askImpl) {
    const result = await askImpl({ provider, context, claudeDir, now });
    const rawResponse = typeof result === 'string' ? result : String(result?.text || '');
    const proposals = parseProposalsText(rawResponse);
    return includeRaw ? { proposals, rawResponse: rawResponse.slice(0, 4000) } : proposals;
  }
  const system = 'あなたはコスト改善コンサルタントです。与えられたデータだけを根拠に、安全で実行可能な改善提案を最大5件、次のJSONだけで返してください。Markdownや前後の文章は付けないでください。' + JSON.stringify({
    proposals: [
      { id: 'string', title: 'string', rationale: 'string', expectedSavingJpyPerMonth: 0, confidence: 'high|medium|low', action: { type: 'command|human', command: ['node', 'tools/...', '...'], note: 'string' }, risk: 'string' }
    ]
  });
  const prompt = `[headless:cost-weekly-improve]\n下記は今週のコスト状況です。JSON の proposals だけを返してください。\n\n${context}`;
  const tool = path.join(REPO_ROOT, 'tools', 'llm-ask.mjs');
  const result = spawnSync(process.execPath, [tool, '--provider', provider, '--max', '3000', '--system', system, prompt], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide: true,
    env: { ...process.env, ORGIAST_HOME: claudeDir ? path.dirname(claudeDir) : process.env.ORGIAST_HOME },
  });
  if (result.status !== 0) throw new Error(`提案生成の LLM 呼び出しが失敗しました(exit ${result.status}): ${String(result.stderr || '').slice(0, 300)}`);
  const rawResponse = String(result.stdout || '');
  const proposals = parseProposalsText(rawResponse);
  return includeRaw ? { proposals, rawResponse: rawResponse.slice(0, 4000) } : proposals;
}

// ---- 許可済み command の実行(shell なし) ----
export function executeWeeklyCommand({ parts, cwd = REPO_ROOT, spawnImpl = null, timeoutMs = 120000 }) {
  const args = parts.map((x) => String(x));
  const res = (spawnImpl || spawnSync)(args[0], args.slice(1), { cwd, encoding: 'utf8', shell: false, timeout: timeoutMs, windowsHide: true });
  if (res.status === 0) return { ok: true, output: String(res.stdout || '').trim().slice(0, 500) };
  return { ok: false, output: String(res.stderr || res.stdout || res.error?.message || `exit ${res.status}`).trim().slice(0, 500) };
}

// ---- 効果検証のための metric 現在値 ----
export function metricCurrentValue(metric, ctx) {
  if (metric === 'headlessClaudeOut') return Number(ctx.signals?.headlessClaudeOut ?? ctx.localState?.headlessClaudeOut ?? 0);
  if (metric === 'pacePercent') return Number(ctx.budget?.budgetPacePct ?? ctx.localState?.budgetPacePct ?? 0);
  const deleg = Number(ctx.localState?.nonClaudeDelegRatio ?? ctx.localState?.delegRatio);
  return Number.isFinite(deleg) ? deleg : 0;
}

export function buildContext({ claudeDir, now, localState, improveState, providerHealth, budget, routingTable, pricingBrief, cooldowns, headlessJobs, headlessClaudeOut }) {
  const jst = formatJst(now);
  const history = Array.isArray(localState?.history) ? localState.history : [];
  const recentHistory = history.slice(-28).map((h) => `${h.date} deleg=${h.nonClaudeDelegRatio ?? h.delegRatio} lines=${h.linesRatio} claudeOut=${h.claudeOut}`);
  const recentViolations = Object.entries((improveState?.actions || []).reduce((acc, act) => { if (act.result === 'pending' || act.result === 'escalated') acc[act.kind || 'unknown'] = (acc[act.kind] || 0) + 1; return acc; }, {})).map(([k, v]) => `${k}:${v}`);
  const providerHealthLines = Object.entries(providerHealth?.providers || {})
    .map(([name, s]) => `${name}: calls=${s.calls} failRate=${Number(s.failRate || 0).toFixed(2)} 429=${s.http429}${s.cooldown ? ` cooldown=${s.cooldown.reason}` : ''}`).join('\n');
  const cooldownLines = Object.entries(cooldowns || {}).map(([name, s]) => `${name}: until=${s.until} reason=${s.reason}`).join('\n');
  const headlessLines = Object.entries(headlessJobs || {}).sort((a, b) => b[1] - a[1]).map(([name, out]) => `${name}:${out}tok`).join(', ');
  const routingLines = Object.entries(routingTable?.categories || {}).map(([cat, e]) => `${cat}: ${e.provider}/${e.model} rate=${e.rate} usd=${e.usdPerTask} ms=${e.msAvg} n=${e.samples}${e.provisional ? '(暫定)' : ''}`).join('\n');
  const pricing = String(pricingBrief || '').slice(0, 2500);
  return [
    `計測日時: ${jst}`,
    `コスト改善状態: 保留中/人対応中の違反 ${recentViolations.length ? recentViolations.join(', ') : 'なし'} / actions ${(improveState?.actions || []).length}件`,
    `委譲率の直近履歴(最大28日): ${recentHistory.length ? recentHistory.join(' | ') : '履歴なし'}`,
    `無人ジョブ(headless): Claude課金tier出力 ${headlessClaudeOut} tok / 内訳 ${headlessLines || 'なし'}`,
    budget ? `月次予算: 確定 ${budget.totalKnownJpy}¥ / 予算 ${budget.monthlyBudgetJpy}¥ / 使用 ${budget.budgetUsedPct?.toFixed(1)}% / 月末見込み ${budget.projectedJpy}¥ / ペース ${budget.budgetPacePct?.toFixed(1)}%` : '月次予算: 計測不能',
    `プロバイダ健全性(7日):\n${providerHealthLines || '- データなし'}`,
    `ルーティング表(routing-table.json):\n${routingLines || '- 未生成'}`,
    `provider-cooldown:\n${cooldownLines || '- なし'}`,
    `料金一次情報(pricing-brief 抜粋):\n${pricing || '- 未収集'}`,
    '',
    '制約: 自動適用は次のコマンドだけが許可されます。これ以外の command は type を "human" にするか、command 自体を外してください。',
    '- node tools/routing-table.mjs --rebuild',
    '- node tools/routing-table.mjs --demote <provider> --days <N>',
    '- node tools/routing-table.mjs --promote <provider>',
    '- node tools/batch-enqueue.mjs --kind eval-harness',
    '- node tools/llm-ask.mjs --print-key-status',
    '- node tools/auto-session-executor.mjs --set cheap-code --provider glm  (または deepseek)',
    'command は必ず argv の配列(command: ["node","tools/..."])で返してください。配列にしない/許可外の command は自動実行されません。',
  ].join('\n');
}

export async function collectInputs({ claudeDir, home, now, io = {} }) {
  const localState = io.localState !== undefined ? io.localState : readJson(path.join(claudeDir, 'cost-loop-state.json'), { history: [] });
  const improveState = io.improveState !== undefined ? io.improveState : readJson(path.join(claudeDir, 'cost-improve-state.json'), { actions: [], lastKpis: {} });
  const providerHealth = io.providerHealth !== undefined ? io.providerHealth : collectProviderHealth({ home, days: 7, now: now.getTime() });
  let claudeStats = { headlessClaudeOut: 0, headlessJobs: {} };
  try { claudeStats = io.claudeStats !== undefined ? io.claudeStats : collectClaudeStats({ home, days: 7, now: now.getTime() }); } catch {}
  let budget = null;
  try { budget = io.budget !== undefined ? io.budget : await (io.collectBudget || collectBudgetStatus)({ home, now }); } catch { budget = null; }
  const routingTable = readJson(path.join(HERE, 'routing-table.json'), null);
  const pricingBrief = readJsonSafeText(path.join(claudeDir, 'pricing-brief.md'));
  const cooldowns = readJson(path.join(claudeDir, 'provider-cooldown.json'), {});
  return { localState, improveState, providerHealth, claudeStats, budget, routingTable, pricingBrief, cooldowns };
}

function readJsonSafeText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function formatProposalLine(proposal, id) {
  const command = Array.isArray(proposal.action?.command)
    ? `\n  実行: ${proposal.action.command.join(' ')}`
    : (proposal.action?.note ? `\n  補足: ${proposal.action.note}` : '');
  const approve = proposal.id
    ? `\n  承認するとき: \`node tools/cost-weekly-improve.mjs --approve ${proposal.id}\``
    : '';
  return `【${proposal.title}】(id: ${proposal.id})\n  期待削減: 約${Math.round(proposal.expectedSavingJpyPerMonth).toLocaleString('ja-JP')}円/月 / 信頼度: ${proposal.confidence} / リスク: ${proposal.risk || '記載なし'}\n  理由: ${proposal.rationale}${command}${approve}`;
}

async function appendActionsAndSave({ claudeDir, improveState, newActions, dryRun }) {
  const nextState = { ...improveState, actions: [...(improveState?.actions || []), ...newActions] };
  if (!dryRun) atomicWrite(path.join(claudeDir, 'cost-improve-state.json'), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

function auditFilePath(claudeDir, now) {
  const date = formatJst(now).slice(0, 10);
  return path.join(claudeDir, 'cost-improve', 'weekly', `${date}.json`);
}

function saveWeeklyAudit({ claudeDir, now, audit }) {
  const file = auditFilePath(claudeDir, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(audit, null, 2)}\n`);
  return file;
}

function formatListLine(kind, proposal) {
  const saving = Math.round(proposal.expectedSavingJpyPerMonth).toLocaleString('ja-JP');
  return `- [${kind}] ${proposal.title} (¥${saving}/月, ${proposal.confidence})`;
}

export async function runWeekly({ home, provider = 'deepseek', dryRun = false, noNotify = false, approveId = '', now = new Date(), quiet = false, io = {} } = {}) {
  if (!isAllowedWeeklyProvider(provider)) throw new Error(`提案生成に ${provider} は使えません(deepseek/gemini 等の安いAIのみ。anthropic/claude は禁止)`);
  const claudeDir = path.join(home, '.claude');
  const startedJst = formatJst(now);
  let status = 'OK';
  let outcome = { proposals: 0, applied: 0, human: 0, rejected: 0, provider, approveId: approveId || undefined };
  const log = (...args) => { if (!quiet) console.log(...args); };

  if (approveId) {
    // kim 明示承認: state に保存された human 提案の command を実行する(許可リスト外でも人の意思なので実行)。
    const improveState = readJson(path.join(claudeDir, 'cost-improve-state.json'), { actions: [] });
    const act = (improveState.actions || []).find((a) => a.id === approveId);
    if (!act) return { ok: false, reason: `approve: 該当する提案がありません (id=${approveId})`, outcome };
    if (!Array.isArray(act.command) || !act.command.length) return { ok: false, reason: `approve: 実行する command がありません (id=${approveId})`, outcome };
    if (!dryRun) {
      const res = executeWeeklyCommand({ parts: act.command, spawnImpl: io.spawnImpl });
      const idx = improveState.actions.findIndex((a) => a.id === approveId);
      improveState.actions[idx] = { ...act, result: res.ok ? 'pending' : 'failed', approvedAt: now.toISOString(), note: res.ok ? `kim承認により実行済み: ${res.output}` : `kim承認実行に失敗: ${res.output}` };
      atomicWrite(path.join(claudeDir, 'cost-improve-state.json'), `${JSON.stringify(improveState, null, 2)}\n`);
      log(res.ok ? `OK approve ${approveId}` : `NG approve ${approveId}: ${res.output}`);
    }
    return { ok: true, outcome };
  }

  const inputs = await collectInputs({ claudeDir, home, now, io });
  const { localState, improveState, providerHealth, claudeStats, budget, routingTable, pricingBrief, cooldowns } = inputs;
  const context = buildContext({ claudeDir, now, localState, improveState, providerHealth, budget, routingTable, pricingBrief, cooldowns, headlessJobs: claudeStats.headlessJobs, headlessClaudeOut: claudeStats.headlessClaudeOut });
  let proposals;
  let rawResponse = '';
  try {
    const generated = await askForProposals({ provider, context, claudeDir, askImpl: io.askImpl, now, includeRaw: true });
    proposals = generated.proposals;
    rawResponse = generated.rawResponse;
  } catch (error) {
    status = 'NG';
    console.error(`提案生成に失敗: ${String(error?.message ?? error)}`);
    proposals = [];
  }
  const beforeSuppress = proposals.length;
  const filtered = suppressNoEffectProposals(proposals, improveState?.actions, now);
  const suppressedCount = beforeSuppress - filtered.length;

  const newActions = [];
  const humanLines = [];
  const autoLines = [];
  const proposalAudits = [];
  const applied = [];
  const human = [];
  const rejected = [];
  const suppressedSignatures = new Set(
    proposals.filter((proposal) => !filtered.includes(proposal)).map((proposal) => proposalSignature(proposal, proposalMetric(proposal))),
  );
  for (const proposal of filtered) {
    const metric = proposalMetric(proposal);
    const baseline = { metric, value: metricCurrentValue(metric, { localState, budget, signals: { headlessClaudeOut: claudeStats.headlessClaudeOut } }) };
    const actionType = proposal.action?.type === 'command' ? 'command' : 'human';
    const common = {
      id: proposal.id,
      kind: 'weekly_improve',
      pc: 'self',
      mode: 'auto-weekly',
      source: 'cost-weekly',
      signature: proposalSignature(proposal, metric),
      proposalTitle: proposal.title,
      dispatchedAt: now.toISOString(),
      baseline,
      result: 'pending',
      verifiedAt: null,
    };
    if (actionType === 'command') {
      const classified = classifyWeeklyCommand(proposal.action.command);
      if (classified.reject) {
        // 形が不正(配列でない等)の提案は実行せず記録もしない。
        outcome.rejected++;
        const reason = classified.reason;
        proposalAudits.push({ ...proposal, decision: `rejected(${reason})` });
        rejected.push({ id: proposal.id, reason, command: Array.isArray(proposal.action.command) ? proposal.action.command : [] });
        console.error(`rejected proposal ${proposal.id}: ${classified.reason}`);
        continue;
      }
      if (!classified.ok) {
        // 許可リスト外 command: 自動実行せず human 扱いで kim に DM(承認で実行できるよう command は保持)。
        const act = { ...common, mode: 'human', result: 'escalated', note: `許可リスト外のため自動実行せず kim 承認待ち: ${classified.reason}`, command: proposal.action.command };
        newActions.push(act);
        humanLines.push(formatProposalLine({ ...proposal, action: { ...proposal.action } }, act.id));
        proposalAudits.push({ ...proposal, decision: 'human' });
        human.push({ id: proposal.id, reason: classified.reason, command: Array.isArray(proposal.action.command) ? proposal.action.command : [] });
        outcome.human++;
        continue;
      }
      // 自動適用
      const parts = classified.parts;
      if (dryRun) {
        const act = { ...common, note: `[dry-run] 適用は見送り: ${parts.join(' ')}`, command: parts };
        newActions.push(act);
        const reason = 'dry-run のため未実行';
        proposalAudits.push({ ...proposal, action: { ...proposal.action, command: parts }, decision: 'dry-run-would-apply' });
        applied.push({ id: proposal.id, reason, command: parts });
        outcome.applied++;
        continue;
      }
      const res = executeWeeklyCommand({ parts, spawnImpl: io.spawnImpl });
      const act = { ...common, command: parts, note: res.ok ? `適用済み: ${parts.join(' ')}` : `適用に失敗: ${res.output}` };
      if (!res.ok) act.result = 'failed';
      newActions.push(act);
      const reason = res.ok ? '自動適用済み' : `自動適用に失敗: ${res.output}`;
      proposalAudits.push({ ...proposal, action: { ...proposal.action, command: parts }, decision: 'auto-applied' });
      applied.push({ id: proposal.id, reason, command: parts });
      autoLines.push(`${proposal.title} — 期待削減 ¥${Math.round(proposal.expectedSavingJpyPerMonth).toLocaleString('ja-JP')}/月 — 実行 ${parts.join(' ')}`);
      outcome.applied++;
    } else {
      // human 提案: 自動実行しない。kim が --approve するか手動で実施する。
      const act = { ...common, mode: 'human', result: 'escalated', note: proposal.action.note || '人間の判断が必要です', command: proposal.action.command && Array.isArray(proposal.action.command) ? proposal.action.command : undefined };
      newActions.push(act);
      humanLines.push(formatProposalLine(proposal, act.id));
      proposalAudits.push({ ...proposal, decision: 'human' });
      human.push({ id: proposal.id, reason: proposal.action.note || '人間の判断が必要', command: Array.isArray(proposal.action.command) ? proposal.action.command : [] });
      outcome.human++;
    }
  }
  for (const proposal of proposals) {
    const signature = proposalSignature(proposal, proposalMetric(proposal));
    if (!suppressedSignatures.has(signature)) continue;
    const reason = '過去4週間以内に同種提案が no_effect と判定済み';
    proposalAudits.push({ ...proposal, decision: `rejected(${reason})` });
    rejected.push({ id: proposal.id, reason, command: Array.isArray(proposal.action?.command) ? proposal.action.command : [] });
  }
  outcome.proposals = filtered.length;
  outcome.rejected += suppressedCount;
  if (suppressedCount) log(`4週間抑止で ${suppressedCount}件の同種提案を除外`);

  await appendActionsAndSave({ claudeDir, improveState, newActions, dryRun });
  const summary = `proposals=${outcome.proposals} applied=${outcome.applied} human=${outcome.human} rejected=${outcome.rejected} suppressed=${suppressedCount} provider=${provider}`;
  const audit = { ok: status === 'OK', ranAt: now.toISOString(), provider, dryRun, outcome, proposals: proposalAudits, applied, human, rejected, rawResponse };
  const auditFile = saveWeeklyAudit({ claudeDir, now, audit });

  if ((autoLines.length || humanLines.length) && !dryRun && !noNotify) {
    const sections = [];
    if (autoLines.length) sections.push(`**自動適用(${autoLines.length}件)**\n${autoLines.join('\n')}`);
    if (humanLines.length) sections.push(`**kim の判断待ち提案(${humanLines.length}件)**\n\n${humanLines.join('\n\n')}`);
    const dmText = `**📈 週次コスト改善**\n\n${sections.join('\n\n')}`;
    try {
      const notifyResult = await (io.notifyKim || notifyKim)(dmText, { home, webhookFallback: false });
      if (!notifyResult || notifyResult.delivered !== 'dm') throw new Error(notifyResult?.reason || 'kim の DM に配信されませんでした');
    } catch (error) {
      status = 'NG';
      console.error(`週次提案 DM 送信失敗: ${String(error?.message ?? error)}`);
    }
  }

  if (!dryRun) {
    const logLine = `${startedJst} / ${status} / ${summary}`;
    try {
      fs.mkdirSync(path.join(claudeDir, 'logs'), { recursive: true });
      fs.appendFileSync(path.join(claudeDir, 'logs', 'cost-weekly-improve.log'), `${logLine}\n`, 'utf8');
    } catch (error) {
      console.error(`cost-weekly-improve ログ書き込み失敗: ${String(error?.message ?? error)}`);
    }
    try {
      await (io.sendHeartbeat || sendCostWeeklyHeartbeat)({ claudeDir, label: io.hostname || os.hostname(), ranAt: now.toISOString(), status, summary, fetchImpl: io.fetchImpl });
    } catch (error) {
      console.error(`cost-weekly heartbeat 送信失敗: ${String(error?.message ?? error)}`);
    }
  }
  for (const proposal of proposalAudits) {
    const kind = proposal.decision.startsWith('auto-') || proposal.decision === 'dry-run-would-apply' ? 'auto' : proposal.decision === 'human' ? 'human' : 'reject';
    log(formatListLine(kind, proposal));
  }
  log(`OK / ${summary}`);
  return { ok: status === 'OK', outcome, proposals: proposalAudits, applied, human, rejected, rawResponse, auditFile, humanLines };
}

export async function sendCostWeeklyHeartbeat({ claudeDir, label, ranAt, status, summary, fetchImpl = globalThis.fetch }) {
  const env = { ...readEnvLike(claudeDir), ...process.env };
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) throw new Error('FLEET_SHEET_URL/TOKEN 未設定');
  const response = await fetchImpl(env.FLEET_SHEET_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: env.FLEET_SHEET_TOKEN, kind: 'cost-weekly-heartbeat', label, ranAt, status, summary }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`heartbeat HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok) throw new Error(`heartbeat rejected: ${payload?.error || 'unknown'}`);
}

function readEnvLike(claudeDir) {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(claudeDir, 'fleet-sheet.env'), 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
      return match ? [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')] : null;
    }).filter(Boolean));
  } catch { return {}; }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const dryRun = argv.includes('--dry-run');
  const noNotify = argv.includes('--no-notify');
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex >= 0 ? String(argv[providerIndex + 1] || '') : 'deepseek';
  const approveIndex = argv.indexOf('--approve');
  const approveId = approveIndex >= 0 ? String(argv[approveIndex + 1] || '') : '';
  const json = argv.includes('--json');
  try {
    const result = await runWeekly({ home, provider, dryRun, noNotify, approveId, now: io.now || new Date(), quiet: json, io });
    if (json) console.log(JSON.stringify(result, null, 2));
    if (result.ok === false && result.reason) { console.error(result.reason); return 1; }
    return 0;
  } catch (error) {
    console.error(`cost-weekly-improve: ${String(error?.message ?? error)}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
