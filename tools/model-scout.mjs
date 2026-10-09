#!/usr/bin/env node
// 新モデルと値下げを週次で偵察し、eval完了後の採用判断を提案セッションへ届ける。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { submitProposal } from './proposal-session.mjs';
import { aggregateMeasurements } from './routing-table.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readConfig, userHome } from './eval-harness.mjs';
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

// カテゴリ別の同じ評価集計を比較する。eval未了・不安定な計測は採用根拠にしない。
export async function proposeEvaluated(candidates, { home, dryRun = false, resultsFile = path.join(home, '.claude', 'eval-results.jsonl'),
  submit = submitProposal, notify = notifyKim, log = console.log } = {}) {
  let rows = [];
  try { rows = fs.readFileSync(resultsFile, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let proposed = 0;
  for (const candidate of candidates) {
    for (const { category, route, price } of candidate.replacements) {
      const measurements = aggregateMeasurements(rows, category);
      const measured = measurements.find(x => x.provider === 'openrouter' && x.model === candidate.id);
      const baseline = measurements.find(x => x.provider === route.provider && x.model === route.model);
      const baselineRate = baseline?.rate ?? route.rate;
      if (!measured || !Number.isFinite(baselineRate) || measured.rate + 0.030000001 < baselineRate) continue;
      const candidatePrice = [candidate.pricing.prompt * 1e6, candidate.pricing.completion * 1e6];
      if (!price || !candidatePrice.every((x, i) => x <= price[i]) || !candidatePrice.some((x, i) => x < price[i])) continue;
      const id = `model-scout-${createHash('sha256').update(`${category}:${candidate.id}:${route.provider}/${route.model}`).digest('hex').slice(0, 20)}`;
      const promptFile = path.join(home, '.claude', 'proposals', `${id}.codex.md`);
      const title = `${category} に ${candidate.name} (${candidate.id}) を採用`;
      const promptText = `目的: ${title}\n対象: kimkon1011/orgiast-claude-rules\n` +
        `routing-table の ${category} の採用モデルを ${route.provider}/${route.model} から openrouter/${candidate.id} に変更し、llm-ask.mjs の既定経路に反映する。関連テストを更新する。\n` +
        `routing-table.json は生成物なので生成側も確認し、再生成後も採用設定が保持されることを検証する。\n` +
        `根拠: 合格率 ${measured.rate}（現行 ${baselineRate}、許容差 -3pt）、入力/出力単価 $${candidatePrice.join('/')} per MTok（現行 $${price.join('/')}）。\n` +
        `実装前に最新 eval と単価を再確認。条件が崩れたら採用を止めて報告する。変更・関連テスト・git diff --check を完了し、PR を作成する。マージは監督が pr-merge.mjs で行う。\n`;
      const result = await submit({ id, title, source: 'model-scout',
        evidence: [`eval-results.jsonl: openrouter/${candidate.id} / ${category} 合格率 ${(measured.rate * 100).toFixed(1)}%（現行 ${(baselineRate * 100).toFixed(1)}%）`, `評価日時 ${measured.measuredAt} / 集計 ${measured.samples} 回`],
        proposal: { summary: `${category} の品質を確認済みの安価なモデルへ変更する。`,
          changes: [{ file: 'tools/routing-table.json（生成側含む）', before: `${category}: ${route.provider}/${route.model}`, after: `${category}: openrouter/${candidate.id}` },
            { file: 'tools/llm-ask.mjs・関連テスト', before: '現行の既定経路', after: '採用モデルへの経路とテストを更新' }],
          costImpact: { perMonthUsd: null, basis: `入力/出力 per MTok: $${price.join('/')} → $${candidatePrice.join('/')}。月間トークン量未集計のため月額は未算定。` },
          risks: ['評価タスク外の品質差、レート制限。採用前に最新結果を再確認する。'] },
        onApprove: { kind: 'codex-task', promptFile }, onReject: '現行ルーティングを維持し、次の候補を評価する。' },
      { home, dryRun, promptText, notify, log });
      if (!result.ok) throw new Error('proposal failed');
      if (!result.skipped) { proposed++; log(`提案セッション: ${title}`); }
    }
  }
  if (!proposed) log(rows.some(r => candidates.some(c => r.provider === 'openrouter' && r.model === c.id))
    ? '提案なし（カテゴリ別品質・単価の条件を満たす未処理候補なし）' : 'eval 未了のため提案なし');
  return proposed;
}

// eval --all の完了時にも呼ぶ。カタログ再取得や週次差分の再検出は不要。
export async function proposeSavedEvaluations({ home = process.env.ORGIAST_HOME || userHome(), ...options } = {}) {
  const state = readJson(path.join(home, '.claude', 'model-scout-state.json'), null);
  const routing = readJson(options.routingFile || path.join(HERE, 'routing-table.json'), null);
  const pending = (state?.pendingCandidates || []).map(candidate => ({ ...candidate,
    replacements: candidate.replacements.filter(({ category, route }) => {
      const current = routing?.categories?.[category];
      return current?.provider === route.provider && current?.model === route.model;
    }) }));
  return proposeEvaluated(pending, { home, ...options });
}

export async function runScout({ home = process.env.ORGIAST_HOME || userHome(), dryRun = false, now = new Date(),
  routingFile = path.join(HERE, 'routing-table.json'), configFile = path.join(home, '.claude', 'eval', 'providers.local.json'),
  fetchImpl = globalThis.fetch, notify = notifyKim, log = console.log, submit = submitProposal, resultsFile } = {}) {
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
    const config = readConfig({ overlayFile: configFile });
    // 既に週次差分を消費した候補も eval 完了時に再判定する（既存状態の移行も兼ねる）。
    const trackedIds = new Set([...(previous?.pendingCandidates || []).map(x => x.id), ...config.filter(x => x.provider === 'openrouter' && !x.skip).map(x => x.model), ...candidates.map(x => x.id)]);
    const skippedIds = new Set(config.filter(x => x.provider === 'openrouter' && x.skip).map(x => x.model));
    const evaluatedCandidates = selectCandidates(models.filter(x => trackedIds.has(x.id) && !skippedIds.has(x.id)), models, readJson(routingFile, null)).candidates;
    const proposed = await proposeEvaluated(evaluatedCandidates, { home, dryRun, resultsFile, submit, notify, log });
    let evaluatedIds = new Set();
    try { evaluatedIds = new Set(fs.readFileSync(resultsFile || path.join(dir, 'eval-results.jsonl'), 'utf8').split(/\r?\n/).flatMap(line => {
      try { const r = JSON.parse(line); return r.provider === 'openrouter' ? [r.model] : []; } catch { return []; }
    })); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const waiting = candidates.filter(c => !evaluatedIds.has(c.id));
    const dm = proposed && !waiting.length ? `実装提案セッション ${proposed} 件を用意しました。` :
      formatDm(waiting, models.length, `${action}。評価中。結果が出たら提案セッションを開きます`, warnings);
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
      // 提案済みだけの場合、submitProposal の1行DMに集約する。
      if (!proposed || waiting.length) {
        const sent = await notify(dm, { home, webhookFallback: false });
        if (sent?.delivered !== 'dm') throw new Error('notification failed');
      }
      // 通知失敗時は差分を消費せず、次回もう一度通知する。
      const snapshot = { ...previous?.models, ...Object.fromEntries(models.map((m) => [m.id, { pricing: m.pricing }])) };
      writeAtomic(stateFile, json({ updatedAt: now.toISOString(), models: snapshot, pendingCandidates: evaluatedCandidates }));
      log(dm);
    }
    return { ok: true, candidates, changes, report, dm, action, proposed };
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
