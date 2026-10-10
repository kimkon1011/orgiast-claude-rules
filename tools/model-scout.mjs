#!/usr/bin/env node
// 新モデルと値下げを週次で偵察する。品質は未検証なので採用せず eval にだけ追加する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { userHome } from './eval-harness.mjs';
import { notifyKim } from './notify-kim.mjs';
import { COST_PER_MILLION } from './llm-fallback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://openrouter.ai/api/v1/models';
const REFERENCE = 'スキップ: tools/llm-ask.mjs の Gemini 呼び出しは Web 検索に未対応。';
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, text); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const validNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const clean = (value) => String(value).replace(/[\r\n\t]/g, ' ').replace(/@/g, '＠');

export function normalizeModels(payload) {
  if (!Array.isArray(payload?.data) || !payload.data.length) throw new Error('invalid catalog');
  const models = payload.data.filter((m) => typeof m.id === 'string' && m.id && validNumber(m.pricing?.prompt) && validNumber(m.pricing?.completion))
    .map((m) => ({ id: m.id, name: clean(m.name || m.id), created: Number(m.created),
      pricing: { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) },
      context_length: Number(m.context_length) || 0, modality: String(m.architecture?.modality || '') }));
  if (!models.length) throw new Error('invalid catalog');
  return models;
}

export function detectChanges(models, previous, now = new Date()) {
  const first = previous === null;
  if (!first && (!previous.models || typeof previous.models !== 'object' || Array.isArray(previous.models))) throw new Error('invalid state');
  return models.flatMap((model) => {
    const old = previous?.models?.[model.id];
    const age = now.getTime() / 1000 - model.created;
    const fresh = first ? age >= 0 && age <= 14 * 86400 : !old;
    const discounted = old && ['prompt', 'completion'].some((key) => validNumber(old.pricing?.[key]) && old.pricing[key] > 0 && model.pricing[key] <= old.pricing[key] * 0.8);
    return fresh || discounted ? [{ ...model, reason: fresh ? '新規モデル' : '値下げ（20%以上）' }] : [];
  });
}

// 別プロバイダの価格は既存料金表を使用。文脈長の曖昧な別名推定はしない。
export function selectCandidates(changes, models, routing) {
  const warnings = [], baselines = [];
  if (!routing?.categories || !Object.keys(routing.categories).length) warnings.push('tools/routing-table.json が未生成、またはカテゴリが空のため比較不能。');
  for (const [category, route] of Object.entries(routing?.categories || {})) {
    const matches = models.filter((m) => m.id === route.model || m.id === `${route.provider}/${route.model}` || m.id.split('/').slice(1).join('/') === route.model);
    const current = matches.length === 1 ? matches[0] : null;
    const price = route.provider === 'openrouter' ? current && [current.pricing.prompt * 1e6, current.pricing.completion * 1e6] : COST_PER_MILLION[route.provider];
    const context = Number(route.context_length) || current?.context_length;
    if (!price || !context) { warnings.push(`${category}: ${route.provider}/${route.model} の単価または文脈長が不明のため比較保留。`); continue; }
    baselines.push({ category, route, price, context });
  }
  const candidates = changes.filter((m) => m.modality.split('->')[0]?.split('+').includes('text') && m.modality.split('->')[1] === 'text')
    .map((model) => ({ ...model, replacements: baselines.filter(({ route, price, context }) =>
      !(route.provider === 'openrouter' && route.model === model.id) && model.context_length >= context &&
      model.pricing.prompt * 1e6 <= price[0] && model.pricing.completion * 1e6 <= price[1] &&
      (model.pricing.prompt * 1e6 < price[0] || model.pricing.completion * 1e6 < price[1])) }))
    .filter((m) => m.replacements.length).sort((a, b) => a.id.localeCompare(b.id));
  return { candidates, warnings };
}

export function enqueueCandidates(candidates, configFile, dryRun) {
  if (!candidates.length) return '評価候補なし';
  try {
    const config = readJson(configFile, []);
    if (!Array.isArray(config) || config.some((x) => !x || typeof x.provider !== 'string' || typeof x.model !== 'string')) throw new Error('invalid config');
    for (const model of candidates) {
      const existing = config.find((x) => x.provider === 'openrouter' && x.model === model.id);
      if (existing?.skip) continue; // 人が明示的に止めた評価は復活させない。
      const entry = existing || { provider: 'openrouter', model: model.id };
      entry.costPerMillion = [model.pricing.prompt * 1e6, model.pricing.completion * 1e6];
      if (!existing) config.push(entry);
    }
    if (!dryRun) writeAtomic(configFile, json(config));
    return candidates.some((m) => config.some((x) => x.provider === 'openrouter' && x.model === m.id && x.skip))
      ? 'eval 追加は手動（~/.claude/eval/providers.local.json: skip 指定あり）'
      : dryRun ? 'eval 投入予定（dry-run）' : 'eval に投入済み';
  } catch { return 'eval 追加は手動（~/.claude/eval/providers.local.json: 読込・更新不可）'; }
}

function candidateLine(model, action) {
  const price = [model.pricing.prompt, model.pricing.completion].map((n) => Number((n * 1e6).toFixed(6)));
  const replacements = model.replacements.map(({ category, route }) => `${category}: ${route.provider}/${route.model}`).join(', ');
  return `${model.name} (${model.id})／$${price[0]} 入力・$${price[1]} 出力 per MTok／${replacements} を置換候補／次アクション＝eval 投入: ${action}`;
}

export function formatDm(candidates, count, action, warnings = []) {
  let dm = `今週の新AI候補 ${candidates.length} 件`;
  if (!candidates.length) dm += `\n新規なし（監視 ${count} モデル）`;
  for (const model of candidates) {
    const line = `\n${candidateLine(model, action)}`;
    if (dm.length + line.length > 1650) { dm += '\n残りの候補は model-scout-latest.md を参照。'; break; }
    dm += line;
  }
  if (warnings.length) dm += '\n比較保留あり。詳細は model-scout-latest.md を参照。';
  return dm.slice(0, 1800);
}

export async function runScout({ home = process.env.ORGIAST_HOME || userHome(), dryRun = false, now = new Date(),
  routingFile = path.join(HERE, 'routing-table.json'), configFile = path.join(home, '.claude', 'eval', 'providers.local.json'),
  fetchImpl = globalThis.fetch, notify = notifyKim, log = console.log } = {}) {
  const dir = path.join(home, '.claude'), stateFile = path.join(dir, 'model-scout-state.json');
  let notifyAttempted = false;
  try {
    const previous = readJson(stateFile, null);
    const response = await fetchImpl(API, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('catalog unavailable');
    const models = normalizeModels(await response.json());
    const changes = detectChanges(models, previous, now);
    const { candidates, warnings } = selectCandidates(changes, models, readJson(routingFile, null));
    const action = enqueueCandidates(candidates, configFile, dryRun);
    const dm = formatDm(candidates, models.length, action, warnings);
    const report = [`# model-scout ${now.toISOString()}`, '', dm.split('\n')[0], `監視 ${models.length} モデル / 差分 ${changes.length} 件`,
      '', '## 評価候補', ...(candidates.length ? candidates.map((m) => `- ${candidateLine(m, action)}`) : [`新規なし（監視 ${models.length} モデル）`]),
      '', '価格比較は入力・出力の両方が同額以下、片方以上が安価で、文脈長が同等以上。品質は eval で確認する。',
      '', '## 検出した差分', ...(changes.length ? changes.map((m) => `- ${m.reason}: ${m.id} / $${Number((m.pricing.prompt * 1e6).toFixed(6))} 入力・$${Number((m.pricing.completion * 1e6).toFixed(6))} 出力 per MTok / 文脈 ${m.context_length} / ${m.modality}`) : ['なし']),
      '', '## 比較保留', ...(warnings.length ? warnings : ['なし']), '', '## 参考情報', REFERENCE,
      '', `情報源: ${API}`, '既存単価: OpenRouter はカタログ、それ以外は tools/llm-fallback.mjs の COST_PER_MILLION。', ''].join('\n');
    if (dryRun) log(`${report}\n## DM 予定（送信なし）\n${dm}`);
    else {
      writeAtomic(path.join(dir, 'model-scout-latest.md'), report);
      notifyAttempted = true;
      const sent = await notify(dm, { home, webhookFallback: false });
      if (sent?.delivered !== 'dm') throw new Error('notification failed');
      // 通知失敗時は差分を消費せず、次回もう一度通知する。
      const snapshot = { ...previous?.models, ...Object.fromEntries(models.map((m) => [m.id, { pricing: m.pricing }])) };
      writeAtomic(stateFile, json({ updatedAt: now.toISOString(), models: snapshot }));
      log(dm);
    }
    return { ok: true, candidates, changes, report, dm, action };
  } catch {
    // 外部例外や資格情報をログに流さない。失敗も必ず観測可能にする。
    const message = '今週の新AI候補 0 件\n偵察失敗（取得・設定・保存・通知のいずれか）。状態を進めず次回再試行します。';
    log(message);
    if (!dryRun && !notifyAttempted) {
      try { await notify(message, { home, webhookFallback: false }); } catch {}
    }
    return { ok: false, dm: message };
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  if (argv.some((arg) => !['--once', '--dry-run'].includes(arg))) {
    (options.log || console.log)('使い方: node tools/model-scout.mjs [--once] [--dry-run]');
    return 0;
  }
  await runScout({ ...options, dryRun: argv.includes('--dry-run') });
  return 0; // 週次ループを止めない。
}
if (isEntry(import.meta.url)) process.exitCode = await main();
