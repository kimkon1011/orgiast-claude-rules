#!/usr/bin/env node
// P-0148: API実測と決定的な採点・集計を分離する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readEnvValue } from './env-kv.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PROVIDERS = {
  genspark: { base: 'https://www.genspark.ai/api/llm_proxy/v1/chat/completions', keyEnv: 'GSK_PROXY_KEY', keyFile: 'genspark-proxy.env' },
  openrouter: { base: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', headers: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast-model-relay' } },
  anthropic: { base: 'https://api.anthropic.com/v1/messages', keyEnv: 'ANTHROPIC_API_KEY', keyFile: 'anthropic.env' }
};
const mean = (xs) => { const values = xs.filter((x) => x !== null); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
const sumCost = (xs) => xs.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) ? xs.reduce((a, b) => a + b, 0) : null;
const ratio = (a, b) => a !== null && b !== null && b > 0 ? a / b : null;
const mentions = (item, text) => item.any.some((keyword) => String(text).toLowerCase().includes(keyword.toLowerCase()));

export function gradeRequired(required, text) {
  const hit = [], missed = [];
  for (const item of required) (mentions(item, text) ? hit : missed).push(item.id);
  return { total: required.length, hit, missed, recall: required.length ? hit.length / required.length : 0 };
}
function extractJson(text) {
  const source = String(text), start = source.indexOf('{');
  if (start < 0) throw new Error('JSONなし');
  const stack = []; let quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      const open = stack.pop();
      if ((open === '{' && c !== '}') || (open === '[' && c !== ']')) throw new Error('JSON不正');
      if (!stack.length) return source.slice(start, i + 1);
    }
  }
  throw new Error('JSON未完');
}
export function parseMissed(text) {
  try {
    const value = JSON.parse(extractJson(text));
    if (!Array.isArray(value.missed) || !['ok', 'insufficient'].includes(value.verdict) || !value.missed.every((x) => x && typeof x.label === 'string' && typeof x.why === 'string')) throw new Error('形式不正');
    return { missed: value.missed, verdict: value.verdict, invalid: false };
  } catch { return { missed: [], invalid: true }; }
}
export function detectionFor(required, answer1, critique) {
  const grade = gradeRequired(required, answer1), parsed = typeof critique === 'string' ? parseMissed(critique) : critique;
  const mentioned = required.filter((item) => parsed.missed.some((x) => mentions(item, `${x.label} ${x.why}`))).map((x) => x.id);
  const actuallyMissed = grade.missed;
  const truePositive = actuallyMissed.filter((id) => mentioned.includes(id)).length;
  const falsePositive = grade.hit.filter((id) => mentioned.includes(id)).length;
  return { actuallyMissed, truePositive, falsePositive, detectionRecall: parsed.invalid ? null : ratio(truePositive, actuallyMissed.length), detectionPrecision: parsed.invalid ? null : ratio(truePositive, truePositive + falsePositive), invalid: parsed.invalid };
}

// results.runs: レーン組ごとの { lanes: {a,b}, t, tasks: [{taskId, repetition, status, stage1, stage2, stage3}] }。
// 各stageは {status, text, inTok, outTok, costUsd, ms, error}。費用未取得はnull。
export function summarize(results, catalog) {
  const rows = (results?.runs || []).flatMap((run) => (run.tasks || []).map((row) => ({ ...row, lanes: run.lanes })));
  let errors = 0;
  const samples = [];
  for (const row of rows) {
    const task = catalog.tasks.find((x) => x.id === row.taskId);
    if (!task || row.status === 'error' || ![row.stage1, row.stage2, row.stage3].every((s) => s?.status === 'ok')) { errors++; continue; }
    const g1 = gradeRequired(task.required, row.stage1.text), g2 = gradeRequired(task.required, row.stage3.text);
    samples.push({ taskId: task.id, recall1: g1.recall, recall2: g2.recall, lift: g2.recall - g1.recall, costUsd: sumCost([row.stage1.costUsd, row.stage2.costUsd, row.stage3.costUsd]), costUsdSingle: sumCost([row.stage1.costUsd]), msTotal: row.stage1.ms + row.stage2.ms + row.stage3.ms, ...detectionFor(task.required, row.stage1.text, row.stage2.text) });
  }
  const tasks = catalog.tasks.map((task) => {
    const xs = samples.filter((x) => x.taskId === task.id);
    const costUsd = xs.length ? sumCost(xs.map((x) => x.costUsd)) : null, costUsdSingle = xs.length ? sumCost(xs.map((x) => x.costUsdSingle)) : null;
    return { taskId: task.id, title: task.title, n: xs.length, errors: rows.filter((x) => x.taskId === task.id).length - xs.length, recall1: mean(xs.map((x) => x.recall1)), recall2: mean(xs.map((x) => x.recall2)), lift: mean(xs.map((x) => x.lift)), costUsd, costUsdSingle, costMultiplier: ratio(costUsd, costUsdSingle), msTotal: xs.reduce((s, x) => s + x.msTotal, 0), truePositive: xs.reduce((s, x) => s + x.truePositive, 0), falsePositive: xs.reduce((s, x) => s + x.falsePositive, 0), detectionRecall: mean(xs.map((x) => x.detectionRecall)), detectionPrecision: mean(xs.map((x) => x.detectionPrecision)), invalid: xs.filter((x) => x.invalid).length };
  });
  const costUsd = samples.length ? sumCost(samples.map((x) => x.costUsd)) : null, costUsdSingle = samples.length ? sumCost(samples.map((x) => x.costUsdSingle)) : null;
  const agg = { measured: samples.length > 0, n: samples.length, errors, tasks, recall1Avg: mean(tasks.map((x) => x.recall1)), recall2Avg: mean(tasks.map((x) => x.recall2)), liftAvg: mean(tasks.map((x) => x.lift)), detectionRecallAvg: mean(tasks.map((x) => x.detectionRecall)), detectionPrecisionAvg: mean(tasks.map((x) => x.detectionPrecision)), costUsd, costUsdSingle, costMultiplier: ratio(costUsd, costUsdSingle), errorCostUsd: sumCost(rows.filter((row) => row.status === 'error').flatMap((row) => [row.stage1, row.stage2, row.stage3].filter(Boolean).map((s) => s.costUsd))) };
  return { ...agg, ...verdictFor(agg) };
}
export function verdictFor(agg) {
  if (!agg.measured) return { verdict: '未実測', reason: '実測runなし' };
  if (agg.liftAvg <= 0) return { verdict: 'リレー効果なし', reason: '見落としの回復が0以下' };
  if (agg.costMultiplier !== null && agg.costMultiplier > 3) return { verdict: '条件付きで有効', reason: '品質は上がるがコストが3倍超' };
  if (agg.detectionRecallAvg === null) return { verdict: '条件付きで有効', reason: '見落とし検出の実測が無い' };
  return { verdict: 'リレー有効', reason: '見落としを回復しコスト増は3倍以内' };
}
const pct = (x) => x === null ? '-' : `${(x * 100).toFixed(1)}%`;
const num = (x, digits = 3) => x === null ? '不明' : x.toFixed(digits);
const cell = (x) => String(x).replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
export function renderMarkdown(results, catalog) {
  const a = summarize(results, catalog);
  const lines = ['> このファイルは生成物。手で編集しない。再生成: `node tools/model-relay.mjs --write`', '', '# 複数推論モデルリレー（P-0148）', '', '## 結論', '', `**${a.verdict}** — ${a.reason}。`];
  if (!a.measured) lines.push('`node tools/model-relay.mjs --live` で計測後、再生成する。');
  else lines.push(`単発 ${pct(a.recall1Avg)} → 統合 ${pct(a.recall2Avg)}、lift ${pct(a.liftAvg)}（差分）、コスト倍率 ${num(a.costMultiplier)}。`);
  if (a.costMultiplier === null) lines.push('費用未取得または単発費用0のため、コスト3倍以内という条件は未確認（判定文は規定の分岐による）。');
  lines.push('', '## 実測結果', '', `採点対象 ${a.n} 件 / errors ${a.errors} 件。反復はタスク内で平均し、全体はタスク平均。`, '', '| task | n | errors | recall1 | recall2 | lift | 検出recall | 検出precision | コスト倍率 | ms合計 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const t of a.tasks) lines.push(`| ${cell(t.taskId)} ${cell(t.title)} | ${t.n} | ${t.errors} | ${pct(t.recall1)} | ${pct(t.recall2)} | ${pct(t.lift)} | ${pct(t.detectionRecall)} | ${pct(t.detectionPrecision)} | ${num(t.costMultiplier)} | ${t.msTotal} |`);
  lines.push('', '## 見落とし検出の精度', '', `検出recall平均 ${pct(a.detectionRecallAvg)} / precision平均 ${pct(a.detectionPrecisionAvg)}。`, 'requiredのキーワード一致による決定的採点。意味の正しさや文字数・禁止事項の遵守自体は保証しない。壊れたstage2 JSONはinvalidとして検出率の平均から除外する。', '', '| task | TP | FP | invalid |', '|---|---:|---:|---:|');
  for (const t of a.tasks) lines.push(`| ${cell(t.taskId)} ${cell(t.title)} | ${t.truePositive} | ${t.falsePositive} | ${t.invalid} |`);
  lines.push('', '## コスト', '', `成功リレー総額 USD ${num(a.costUsd, 6)} / 単発総額 USD ${num(a.costUsdSingle, 6)} / 倍率 ${num(a.costMultiplier)}。`, `失敗リレーの費用（別枠） USD ${num(a.errorCostUsd, 6)}。`, 'API usage.cost（USD）を記録する。未提供の費用はnullであり、0円や推定単価では補完しない。', '', '## 前提値（assumed）', '', ...Object.entries(catalog.assumptions).map(([k, v]) => `- ${k}: ${cell(v)}（assumed）`), '', '## 未検証', '', '- 2モデル・6タスクに限定。', '- API 失敗は errors として分母から除外。', '- 既定レーンは同一プロバイダ(代理経由)であり純粋なベンダ比較ではない。', '- 複数レーン組が保存されている場合、全体平均はそれらを含む。', '', '## 出典', '', '- タスクと前提: `tools/model-relay-catalog.json`（実務を想定した架空課題）。', '- 実測: `tools/model-relay.results.json`（--liveで取得。未取得の値は記載しない）。');
  for (const run of results?.runs || []) lines.push(`- 実測レーン A=${cell(run.lanes.a)} / B=${cell(run.lanes.b)} / ${cell(run.t)}。`);
  return `${lines.join('\n')}\n`;
}

export function parseLane(value) {
  const match = typeof value === 'string' && value.match(/^([^:]+):([^\s:][^\s]*)$/u);
  if (!match || !Object.hasOwn(PROVIDERS, match[1])) throw new Error('レーンは対応provider:modelで指定してください');
  return { provider: match[1], model: match[2] };
}
export function buildPrompt(task, stage, answer1 = '', critique = '') {
  const input = `${task.brief}\n\n成果物: ${task.deliverable}`;
  if (stage === 1) return { system: task.system, user: input };
  if (stage === 2) return { system: 'タスクと回答を照合し、要件の見落としだけを指摘してください。文章の好みや新しい要件は追加しないでください。JSONのみで返してください: {"missed":[{"label":"...","why":"..."}],"verdict":"ok"または"insufficient"}', user: JSON.stringify({ task: input, taskSystem: task.system, answer1 }) };
  return { system: task.system, user: `${input}\n\n次の初回回答と指摘を検討し、タスクを満たす最終回答だけを返してください。\n${JSON.stringify({ answer1, critique })}` };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function callProvider(lane, prompt, max = 800, options = {}) {
  const started = Date.now();
  try {
    const { provider, model } = parseLane(lane), p = PROVIDERS[provider];
    const key = options.key ?? (process.env[p.keyEnv] || readEnvValue(path.join(process.env.USERPROFILE || os.homedir(), '.claude', p.keyFile), p.keyEnv));
    if (!key) return { status: 'error', text: '', costUsd: null, ms: Date.now() - started, error: `${p.keyEnv} 未設定` };
    const headers = { 'content-type': 'application/json', ...(p.headers || {}) };
    const body = { model, max_tokens: max, messages: [{ role: 'user', content: prompt.user }] };
    if (provider === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; if (prompt.system) body.system = prompt.system; }
    else { headers.Authorization = `Bearer ${key}`; if (prompt.system) body.messages.unshift({ role: 'system', content: prompt.system }); }
    for (let attempt = 0; attempt <= 3; attempt++) {
      const response = await (options.fetch || fetch)(p.base, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      if (!response.ok) {
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500 && response.status <= 599) && attempt < 3) { await (options.sleep || sleep)(1000 * 2 ** attempt); continue; }
        return { status: 'error', text: '', costUsd: null, ms: Date.now() - started, error: `HTTP ${response.status}` };
      }
      const data = await response.json(), raw = provider === 'anthropic' ? data.content?.[0]?.text : data.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') throw new Error('出力不正');
      // レスポンスが認証値を反射しても結果ファイルに残さない。
      const text = raw.replaceAll(key, '[REDACTED]'), usage = data.usage || {};
      return { status: 'ok', text, inTok: usage.input_tokens ?? usage.prompt_tokens ?? 0, outTok: usage.output_tokens ?? usage.completion_tokens ?? 0, costUsd: typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null, ms: Date.now() - started, error: null };
    }
  } catch { return { status: 'error', text: '', costUsd: null, ms: Date.now() - started, error: 'API呼び出し失敗（通信またはレスポンス不正）' }; }
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`JSONを読めません: ${path.basename(file)}`); } }
async function runNetwork(options, catalog, results, resultsPath, stdout) {
  const lanes = { a: options.laneA || catalog.lanes.a, b: options.laneB || catalog.lanes.b };
  parseLane(lanes.a); parseLane(lanes.b);
  const tasks = [];
  for (const task of catalog.tasks.slice(0, options.limit || undefined)) for (let i = 0; i < (options.repeat ?? 1); i++) {
    const row = { taskId: task.id, repetition: i + 1, status: 'ok' };
    for (const stage of [1, 2, 3]) {
      row[`stage${stage}`] = await callProvider(stage === 2 ? lanes.b : lanes.a, buildPrompt(task, stage, row.stage1?.text, row.stage2?.text), task.max ?? 800, options.transport);
      if (row[`stage${stage}`].status === 'error') { row.status = 'error'; break; }
    }
    tasks.push(row);
    const passed = row.status === 'ok' && gradeRequired(task.required, row.stage3.text).recall === 1;
    stdout.write(`${passed ? 'PASS' : 'FAIL'} ${task.id} repeat=${i + 1} status=${row.status}\n`);
  }
  const t = new Date().toISOString();
  const runs = (results.runs || []).filter((r) => r.lanes.a !== lanes.a || r.lanes.b !== lanes.b);
  runs.push({ lanes, t, tasks });
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, `${JSON.stringify({ updatedAt: t, lanes, runs }, null, 2)}\n`, 'utf8');
}
export async function runCli(options = {}) {
  const repo = options.repo || DEFAULT_REPO, stdout = options.stdout || process.stdout, stderr = options.stderr || process.stderr;
  const catalogPath = options.catalogPath || path.join(repo, 'tools', 'model-relay-catalog.json'), resultsPath = options.resultsPath || path.join(repo, 'tools', 'model-relay.results.json'), docPath = options.docPath || path.join(repo, 'docs', 'model-relay.md');
  try {
    const catalog = readJson(catalogPath, null);
    if (!catalog) throw new Error('カタログを読めません');
    const results = readJson(resultsPath, { updatedAt: null, runs: [] });
    if (options.live) await runNetwork(options, catalog, results, resultsPath, stdout);
    else if (options.json) stdout.write(`${JSON.stringify(summarize(results, catalog), null, 2)}\n`);
    else {
      const markdown = renderMarkdown(results, catalog);
      if (options.check) {
        const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
        if (current !== markdown) throw new Error('drift: docs/model-relay.md が古い。node tools/model-relay.mjs --write で再生成');
      } else if (options.write) { fs.mkdirSync(path.dirname(docPath), { recursive: true }); fs.writeFileSync(docPath, markdown, 'utf8'); }
      else stdout.write(markdown);
    }
    return 0;
  } catch (error) { stderr.write(`${error.message}\n`); return 1; }
}
export function parseArgs(args) {
  const modes = ['--live', '--write', '--check', '--json'], values = { '--repeat': 'repeat', '--limit': 'limit', '--lane-a': 'laneA', '--lane-b': 'laneB' };
  const out = { live: false, write: false, check: false, json: false, repeat: 1, limit: 0 }, seen = new Set(); let modeCount = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (modes.includes(arg)) { if (++modeCount > 1) throw new Error('モードは1つだけ指定してください'); out[arg.slice(2)] = true; continue; }
    if (!Object.hasOwn(values, arg) || seen.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`不正な引数です: ${arg}`);
    seen.add(arg); const value = args[++i];
    if (arg.startsWith('--lane-')) { parseLane(value); out[values[arg]] = value; }
    else { if (!/^\d+$/u.test(value)) throw new Error('repeat/limitは整数で指定してください'); out[values[arg]] = Number(value); }
  }
  if (!Number.isSafeInteger(out.repeat) || out.repeat < 1 || !Number.isSafeInteger(out.limit) || out.limit < 0) throw new Error('repeatは正整数、limitは0以上の整数で指定してください');
  if (seen.size && !out.live) throw new Error('--repeat/--limit/--lane-a/--lane-bには--liveが必要です');
  return out;
}
if (isEntry(import.meta.url)) { try { process.exitCode = await runCli(parseArgs(process.argv.slice(2))); } catch (error) { process.stderr.write(`使用法: node tools/model-relay.mjs [--live [--repeat N] [--limit N] [--lane-a P:M] [--lane-b P:M]|--write|--check|--json]\n${error.message}\n`); process.exitCode = 1; } }
