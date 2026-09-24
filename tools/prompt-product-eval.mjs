#!/usr/bin/env node
// プロンプト商材の上乗せ価値を、同一タスク・同一モデルで決定論的に比較する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { COST_PER_MILLION } from './llm-fallback.mjs';
import { isEntry } from './is-entry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.dirname(HERE);
const VARIANTS = ['plain', 'pack', 'workflow'];
const SENSITIVITY_PRICES = [1000, 5000, 10000, 30000, 100000];
export const PACK_SCAFFOLD = '以下のタスクを、ステップバイステップで慎重に、網羅的かつプロフェッショナルに実行してください。ユーザーの意図を深く理解し、見落としがないよう十分に検討したうえで、最高品質の回答を提供してください。出力は読みやすく整形し、必要に応じて見出しや箇条書きを用いてください。';
const PROVIDERS = {
  groq: { base: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', keyFile: 'groq.env', model: 'openai/gpt-oss-120b' },
  deepseek: { base: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY', keyFile: 'deepseek.env', model: 'deepseek-chat' },
  openrouter: { base: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', model: 'meta-llama/llama-3.3-70b-instruct', headers: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast-prompt-product-eval' } },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyEnv: 'GEMINI_API_KEY', keyFile: 'gemini.env', model: 'gemini-3.7-flash' },
  kimi: { base: 'https://api.moonshot.ai/v1/chat/completions', keyEnv: 'MOONSHOT_API_KEY', keyFile: 'kimi-api.env', model: 'kimi-k3' },
  mistral: { base: 'https://api.mistral.ai/v1/chat/completions', keyEnv: 'MISTRAL_API_KEY', keyFile: 'mistral.env', model: 'mistral-large-latest' },
  ollama: { base: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1/chat/completions', keyEnv: null, model: '' }
};

export function buildPrompts(task) {
  return {
    plain: { system: '', user: `${task.plainAsk}\n\n${task.input}` },
    pack: { system: 'あなたは世界トップクラスのビジネスコンサルタントです。', user: `${PACK_SCAFFOLD}\n\n${task.plainAsk}\n\n${task.input}` },
    workflow: { system: 'あなたは業務システムに組み込む前処理エンジンです。', user: `${task.workflowSpec}\n\n${task.input}` }
  };
}

function stripFence(text) { return String(text).trim().replace(/^```(?:json|text|csv)?\s*/iu, '').replace(/\s*```$/u, '').trim(); }
export function extractJson(text) {
  const source = stripFence(text); let start = -1;
  for (let i = 0; i < source.length; i++) if (source[i] === '{' || source[i] === '[') { start = i; break; }
  if (start < 0) throw new Error('JSONの開始括弧がありません');
  const stack = []; let quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') { const open = stack.pop(); if ((open === '{' && c !== '}') || (open === '[' && c !== ']')) throw new Error('JSONの括弧が対応していません'); if (!stack.length) return source.slice(start, i + 1); }
  }
  throw new Error('JSONの閉じ括弧がありません');
}

export function grade(expect, text) {
  if (expect.type === 'json_path') { try { return isDeepStrictEqual(JSON.parse(extractJson(text)), expect.value); } catch { return false; } }
  if (expect.type === 'enum') return stripFence(text) === expect.equal;
  if (expect.type === 'exact_lines') return isDeepStrictEqual(stripFence(text).split(/\r?\n/u).map((x) => x.trim()).filter(Boolean), expect.value);
  if (expect.type === 'constraints') { const value = String(text); return value.length <= expect.maxChars && expect.containsAll.every((x) => value.includes(x)) && (!expect.noNewline || !value.includes('\n')); }
  throw new Error(`未知の採点type: ${expect.type}`);
}

function metricFor(run, variant, usdJpy) {
  const x = run.byVariant?.[variant] || { n: 0, pass: 0, errors: 0, costUsd: 0, outTok: 0, msAvg: 0 };
  const graded = Number(x.n) - Number(x.errors); return { ...x, rate: graded > 0 ? Number(x.pass) / graded : null, costPerTaskYen: Number(x.n) > 0 ? Number(x.costUsd) / Number(x.n) * usdJpy : null, avgOutTok: Number(x.n) > 0 ? Number(x.outTok) / Number(x.n) : null };
}
export function verdictFor(product, summary) {
  const lift = summary.lift[product.variant], breakEven = summary.breakEvenPriceYen[product.variant];
  if (lift === null || lift <= summary.noiseBand) return { verdict: '購入価値なし', reason: `上乗せ効果が測定誤差帯 ${summary.noiseBand} 以下` };
  if (product.priceYen > breakEven) return { verdict: '購入価値なし', reason: '価格が損益分岐を上回る' };
  if (product.priceYen > summary.selfWriteCostYen) return { verdict: '条件付きで価値あり', reason: '自分で書くより高いが損益分岐内' };
  return { verdict: '購入価値あり', reason: '自作費以下かつ損益分岐内' };
}
export function summarize(results, catalog) {
  const assumptions = catalog.assumptions; const runs = (results?.runs || []).map((run) => {
    const variants = Object.fromEntries(VARIANTS.map((v) => [v, metricFor(run, v, assumptions.usdJpy)]));
    const base = variants.plain.rate; const lift = { pack: base === null || variants.pack.rate === null ? null : variants.pack.rate - base, workflow: base === null || variants.workflow.rate === null ? null : variants.workflow.rate - base };
    const monthlySavingYen = {}; const breakEvenPriceYen = {};
    for (const v of ['pack', 'workflow']) { monthlySavingYen[v] = lift[v] === null ? null : lift[v] * assumptions.fixMinutesPerFailure / 60 * assumptions.tasksPerMonth * assumptions.hourlyYen; breakEvenPriceYen[v] = monthlySavingYen[v] === null ? null : monthlySavingYen[v] * assumptions.paybackMonthsTarget; }
    const summary = { provider: run.provider, model: run.model, t: run.t, variants, lift, monthlySavingYen, breakEvenPriceYen, selfWriteCostYen: assumptions.selfWriteMinutes / 60 * assumptions.hourlyYen, noiseBand: assumptions.noiseBand };
    summary.products = catalog.products.map((p) => ({ ...p, breakEvenPriceYen: breakEvenPriceYen[p.variant], ...verdictFor(p, summary) }));
    summary.sensitivity = catalog.products.flatMap((p) => SENSITIVITY_PRICES.map((priceYen) => ({ productId: p.id, variant: p.variant, priceYen, ...verdictFor({ ...p, priceYen }, summary) })));
    return summary;
  });
  return { measured: runs.length > 0, assumptions, runs };
}

const pct = (x) => x === null ? '未実測' : `${(x * 100).toFixed(1)}%`;
const num = (x, digits = 1) => x === null ? '-' : Number(x).toFixed(digits);
const yen = (x) => x === null ? '-' : Math.round(x).toLocaleString('ja-JP');
export function renderMarkdown(results, catalog) {
  const report = summarize(results, catalog); const lines = ['# プロンプト商材の購入価値 実測（P-0100）', '', '> このファイルは生成物。手で編集しない。再生成: `node tools/prompt-product-eval.mjs --write`', '> 台帳: `tools/prompt-product-catalog.json` / 実測: `tools/prompt-product-eval.results.json`', '> 出典区分: `primary`=一次情報 / `media`=報道 / `assumed`=前提値 / `unknown`=未取得', '', '## 結論', ''];
  if (!report.measured) lines.push('- **未実測**。結果ファイルにprovider/model別の実測runがないため、購入価値はまだ判定できない。', '- `--run` で同一入力・同一モデルの3変種を計測後、この文書を再生成する。', '- 価格・作業時間・月間件数はすべて前提値であり、実測結果ではない。');
  else for (const r of report.runs) lines.push(`- ${r.provider}/${r.model}: plain ${pct(r.variants.plain.rate)}、pack ${pct(r.variants.pack.rate)}（lift ${pct(r.lift.pack)}）、workflow ${pct(r.variants.workflow.rate)}（lift ${pct(r.lift.workflow)}）。`, ...r.products.map((p) => `- ${p.name}: ${p.verdict}（価格 ${yen(p.priceYen)}円 / 損益分岐 ${yen(p.breakEvenPriceYen)}円）。`));
  if (report.measured) {
    // 実測から言えることだけを書く。モデル横断で「汎用型が素の依頼を上回ったか」を1行にまとめる。
    const packNeverBetter = report.runs.every((r) => r.lift.pack !== null && r.lift.pack <= 0);
    const workflowRates = report.runs.map((r) => r.variants.workflow.rate).filter((x) => x !== null);
    lines.push(`- 汎用型はどのモデルでも素の依頼を上回らなかった: ${packNeverBetter ? '該当' : '非該当'}（lift.pack が全モデルで0以下）。`, `- 業務ロジック型の合格率は ${pct(workflowRates.length ? Math.min(...workflowRates) : null)} 以上（最低値）。`, '- つまり「プロンプトの書き方」より「出力契約・例外規則・実例の有無」が合格率を支配している。本計測は汎用型商材の購入価値を支持しない。');
  }
  lines.push('', '## 実測結果', '', '| model | variant | 合格率 | n | errors | 平均出力tok | 1タスクあたり円 | 平均ms |', '|---|---|---:|---:|---:|---:|---:|---:|');
  if (!report.measured) lines.push('| 未実測 | - | - | 0 | 0 | - | - | - |');
  for (const r of report.runs) for (const v of VARIANTS) { const x = r.variants[v]; lines.push(`| ${r.provider}/${r.model} | ${v} | ${pct(x.rate)} | ${x.n} | ${x.errors} | ${num(x.avgOutTok)} | ${num(x.costPerTaskYen, 4)} | ${num(x.msAvg, 0)} |`); }
  lines.push('', '## リフト', '', '| model | lift.pack | lift.workflow | noiseBand |', '|---|---:|---:|---:|');
  if (!report.measured) lines.push(`| 未実測 | - | - | ${pct(catalog.assumptions.noiseBand)} |`); for (const r of report.runs) lines.push(`| ${r.provider}/${r.model} | ${pct(r.lift.pack)} | ${pct(r.lift.workflow)} | ${pct(r.noiseBand)} |`);
  lines.push('', '## 商材価値の判定', '', '| model | 商品名 | 価格（前提） | 損益分岐価格 | 判定 | 理由 |', '|---|---|---:|---:|---|---|');
  if (!report.measured) lines.push('| 未実測 | - | - | - | 未判定 | 実測runなし |'); for (const r of report.runs) for (const p of r.products) lines.push(`| ${r.provider}/${r.model} | ${p.name} | ${yen(p.priceYen)}円 | ${yen(p.breakEvenPriceYen)}円 | ${p.verdict} | ${p.reason} |`);
  lines.push('', '## 価格感度', '', '| model | 商品 | 価格円 | 判定 |', '|---|---|---:|---|'); if (!report.measured) lines.push('| 未実測 | - | - | 未判定 |'); for (const r of report.runs) for (const x of r.sensitivity) lines.push(`| ${r.provider}/${r.model} | ${x.productId} | ${yen(x.priceYen)} | ${x.verdict} |`);
  lines.push('', '## 前提値（assumed）', '', '| 項目 | 値 | 検証状態 |', '|---|---:|---|', ...Object.entries(catalog.assumptions).map(([k, v]) => `| ${k} | ${v} | assumed（実測ではない） |`), '', `- **結論を支配する前提:** fixMinutesPerFailure=${catalog.assumptions.fixMinutesPerFailure}、tasksPerMonth=${catalog.assumptions.tasksPerMonth}、hourlyYen=${catalog.assumptions.hourlyYen}、paybackMonthsTarget=${catalog.assumptions.paybackMonthsTarget}。これらが損益分岐価格を直接決める。`, '', '## 未検証', '', '- 実際に販売されている商材の中身は購入していない。', '- 商品価格と価格帯は想定であり、個別商品の実売価格ではない。', '- 対象モデルと6タスクに限定した結果であり、一般化には追加計測が必要。', '- プロンプトの言い回しを変えると結果が動きうる。', '- API失敗はerrorsとして合格率の分母から除外し、表に件数を明記する。', '', '## 出典', '', '- 一次情報なし（本計測は自前タスクによる実測）。', ''); return `${lines.join('\n')}\n`;
}

function homeDir() { const mounted = process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/iu); return process.env.USERPROFILE || mounted?.[1] || os.homedir(); }
function loadKey(name) { const p = PROVIDERS[name]; if (!p.keyEnv) return 'local'; if (process.env[p.keyEnv]) return process.env[p.keyEnv]; const files = name === 'gemini' ? [path.join(homeDir(), '.gemini', '.env'), path.join(homeDir(), '.claude', p.keyFile)] : [path.join(homeDir(), '.claude', p.keyFile)]; for (const file of files) try { for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) if (line.startsWith(`${p.keyEnv}=`)) return line.slice(p.keyEnv.length + 1).trim(); } catch {} return ''; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function callProvider(name, model, prompt, params = {}) { const p = PROVIDERS[name], messages = []; if (prompt.system) messages.push({ role: 'system', content: prompt.system }); messages.push({ role: 'user', content: prompt.user }); const body = { model, messages, max_tokens: 512, stream: false, ...params }; let last; for (let attempt = 0; attempt <= 3; attempt++) { const started = Date.now(); const response = await fetch(p.base, { method: 'POST', headers: { Authorization: `Bearer ${loadKey(name)}`, 'content-type': 'application/json', ...(p.headers || {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) }); if (response.ok) { const json = await response.json(); const text = json.choices?.[0]?.message?.content; if (typeof text !== 'string') throw new Error('レスポンス不正: モデル出力がありません'); return { text, inTok: json.usage?.prompt_tokens || 0, outTok: json.usage?.completion_tokens || 0, ms: Date.now() - started }; } const detail = (await response.text().catch(() => '')).slice(0, 300); last = new Error(`${response.status}: ${detail}`); if ((response.status === 429 || response.status >= 500) && attempt < 3) { await sleep(1000 * (2 ** attempt)); continue; } throw last; } throw last; }
function aggregate(rows) { const out = {}; for (const v of VARIANTS) { const xs = rows.filter((x) => x.variant === v), totalMs = xs.reduce((a, x) => a + x.ms, 0); out[v] = { n: xs.length, pass: xs.filter((x) => x.pass).length, errors: xs.filter((x) => x.status === 'error').length, inTok: xs.reduce((a, x) => a + x.inTok, 0), outTok: xs.reduce((a, x) => a + x.outTok, 0), costUsd: xs.reduce((a, x) => a + x.costUsd, 0), msAvg: xs.length ? totalMs / xs.length : 0 }; } return out; }
async function runNetwork({ provider, model, repeat, limit, concurrency, catalog, resultsPath, stdout }) { const p = PROVIDERS[provider]; if (!p) throw new Error(`未対応provider: ${provider}`); if (!loadKey(provider)) { stdout.write(`SKIP ${provider}: ${p.keyEnv} 未設定\n`); return; } const selected = catalog.models.find((x) => x.provider === provider && (!model || x.model === model)); const actualModel = model || selected?.model || p.model; if (!actualModel) throw new Error('modelを指定してください'); const jobs = []; for (const task of catalog.tasks.slice(0, limit || undefined)) for (const variant of VARIANTS) for (let i = 0; i < repeat; i++) jobs.push({ task, variant }); const rows = new Array(jobs.length); let cursor = 0;
  async function worker() { for (;;) { const index = cursor++; if (index >= jobs.length) return; const { task, variant } = jobs[index], t = new Date().toISOString(); try { const x = await callProvider(provider, actualModel, buildPrompts(task)[variant], selected?.params || {}); const pass = grade(task.expect, x.text), rates = COST_PER_MILLION[provider] || [0, 0], costUsd = (x.inTok * rates[0] + x.outTok * rates[1]) / 1e6; rows[index] = { t, taskId: task.id, category: task.category, variant, status: pass ? 'pass' : 'fail', pass, inTok: x.inTok, outTok: x.outTok, costUsd, ms: x.ms, output: x.text.slice(0, 300), error: null }; stdout.write(`${pass ? 'PASS' : 'FAIL'} ${provider} ${task.id} ${variant} in=${x.inTok} out=${x.outTok} $${costUsd.toFixed(6)} ${x.ms}ms\n`); } catch (error) { rows[index] = { t, taskId: task.id, category: task.category, variant, status: 'error', pass: false, inTok: 0, outTok: 0, costUsd: 0, ms: 0, output: '', error: String(error.message || error).slice(0, 400) }; stdout.write(`ERROR ${provider} ${task.id} ${variant} in=0 out=0 $0.000000 0ms\n`); } } }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker)); let results = { updatedAt: new Date().toISOString(), runs: [] }; try { results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch {} const run = { provider, model: actualModel, t: new Date().toISOString(), repeat, byVariant: aggregate(rows), tasks: rows }; results.updatedAt = run.t; results.runs = (results.runs || []).filter((x) => !(x.provider === provider && x.model === actualModel)); results.runs.push(run); fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8'); }

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export async function runCli(options = {}) { const repo = options.repo || DEFAULT_REPO, catalogPath = options.catalogPath || path.join(repo, 'tools', 'prompt-product-catalog.json'), resultsPath = options.resultsPath || path.join(repo, 'tools', 'prompt-product-eval.results.json'), docPath = options.docPath || path.join(repo, 'docs', 'prompt-product-eval.md'), stdout = options.stdout || process.stdout, stderr = options.stderr || process.stderr; try { const catalog = readJson(catalogPath, null); if (!catalog) throw new Error('カタログを読めません'); const results = readJson(resultsPath, { updatedAt: null, runs: [] }); if (options.run) await runNetwork({ ...options, catalog, resultsPath, stdout }); else { const markdown = renderMarkdown(results, catalog); if (options.check) { const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null; if (current !== markdown) throw new Error('drift: docs/prompt-product-eval.md が古い。node tools/prompt-product-eval.mjs --write で再生成'); } else if (options.write) { fs.mkdirSync(path.dirname(docPath), { recursive: true }); fs.writeFileSync(docPath, markdown, 'utf8'); } else if (options.json) stdout.write(`${JSON.stringify(summarize(results, catalog), null, 2)}\n`); else stdout.write(markdown); } return 0; } catch (error) { stderr.write(`${error.message}\n`); return 1; } }

export function parseArgs(args) { const valueOpts = new Set(['--provider', '--model', '--repeat', '--limit', '--concurrency']), modes = args.filter((x) => ['--run', '--write', '--check', '--json'].includes(x)); if (modes.length > 1) throw new Error('モードは1つだけ指定してください'); const out = { run: modes[0] === '--run', write: modes[0] === '--write', check: modes[0] === '--check', json: modes[0] === '--json', repeat: 3, limit: 0, concurrency: 1 }; for (let i = 0; i < args.length; i++) { const arg = args[i]; if (['--run', '--write', '--check', '--json'].includes(arg)) continue; if (!valueOpts.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`不正な引数です: ${arg}`); const value = args[++i]; if (arg === '--provider') out.provider = value; else if (arg === '--model') out.model = value; else out[arg.slice(2)] = Number(value); } if (out.run && !out.provider) throw new Error('--run には --provider が必要です'); if (![out.repeat, out.concurrency].every((x) => Number.isInteger(x) && x > 0) || !Number.isInteger(out.limit) || out.limit < 0) throw new Error('repeat/concurrencyは正整数、limitは0以上の整数で指定してください'); return out; }
if (isEntry(import.meta.url)) { try { process.exitCode = await runCli(parseArgs(process.argv.slice(2))); } catch (error) { process.stderr.write(`使用法: node tools/prompt-product-eval.mjs [--run --provider P [--model M] [--repeat N] [--limit N] [--concurrency N]|--write|--check|--json]\n${error.message}\n`); process.exitCode = 1; } }
