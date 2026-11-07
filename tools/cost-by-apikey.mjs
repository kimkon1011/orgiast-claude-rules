#!/usr/bin/env node
/**
 * cost-by-apikey.mjs — Anthropic API 費用を API キー別に診断するツール
 *
 * 環境変数:
 *   ANTHROPIC_ADMIN_KEY (必須)
 *   DAYS (既定 21) — 何日前から現在までのデータを取得するか
 *
 * 呼び出す API:
 *   GET /v1/organizations/api_keys          — 全キー一覧
 *   GET /v1/organizations/usage_report/messages — 日別・キー別・モデル別使用量
 *
 * 出力: stdout にプレーンテキスト
 */

import { isEntry } from './is-entry.mjs';

// ---- 単価表 (per 1M tokens, USD) ----
const PRICING = [
  { match: /opus/i, input: 5, output: 25 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /haiku/i, input: 1, output: 5 },
  { match: /fable/i, input: 10, output: 50 },
  { match: /.*/, input: 3, output: 15 }, // fallback
];

/** モデル名から単価を推定 */
export function estimateCostUsd(model, usage) {
  const { uncached_input_tokens = 0, cache_read_input_tokens = 0, cache_creation = {}, output_tokens = 0 } = usage;
  const c5m = cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const c1h = cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const pricing = PRICING.find((p) => p.match.test(model)) ?? PRICING[PRICING.length - 1];
  const M = 1_000_000;
  return (
    (uncached_input_tokens / M) * pricing.input +
    (cache_read_input_tokens / M) * pricing.input * 0.1 +
    (c5m / M) * pricing.input * 1.25 +
    (c1h / M) * pricing.input * 2 +
    (output_tokens / M) * pricing.output
  );
}

/** 日バケットの配列をキー別・モデル別に集計 */
export function aggregate(buckets, keyNames) {
  /** @type {Map<string, {name: string, status: string, total: number, byModel: Map<string, {uncached: number, cacheR: number, cacheW5m: number, cacheW1h: number, out: number, cost: number}>, daily: Map<string, Map<string, {model: string, uncached: number, cacheR: number, cacheW5m: number, cacheW1h: number, out: number, cost: number}>>}>} */
  const keys = new Map();

  // null api_key_id 用の特別キー
  const NULL_KEY = '__null__';
  keyNames = keyNames ?? new Map();
  keyNames.set(NULL_KEY, '(キーなし: Console/Workbench等)');

  for (const bucket of buckets) {
    const day = bucket.starting_at.slice(0, 10);
    for (const result of bucket.results ?? []) {
      const kid = result.api_key_id ?? NULL_KEY;
      if (!keys.has(kid)) {
        keys.set(kid, {
          name: keyNames.get(kid) ?? kid,
          status: '',
          total: 0,
          byModel: new Map(),
          daily: new Map(),
        });
      }
      const entry = keys.get(kid);

      const model = result.model ?? '(unknown)';
      const usage = {
        uncached_input_tokens: result.uncached_input_tokens ?? 0,
        cache_read_input_tokens: result.cache_read_input_tokens ?? 0,
        cache_creation: result.cache_creation ?? {},
        output_tokens: result.output_tokens ?? 0,
      };
      const cost = estimateCostUsd(model, usage);

      // byModel 集計
      if (!entry.byModel.has(model)) {
        entry.byModel.set(model, { uncached: 0, cacheR: 0, cacheW5m: 0, cacheW1h: 0, out: 0, cost: 0 });
      }
      const m = entry.byModel.get(model);
      m.uncached += usage.uncached_input_tokens;
      m.cacheR += usage.cache_read_input_tokens;
      m.cacheW5m += usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      m.cacheW1h += usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      m.out += usage.output_tokens;
      m.cost += cost;

      entry.total += cost;

      // daily 集計
      if (!entry.daily.has(day)) {
        entry.daily.set(day, new Map());
      }
      const dayModels = entry.daily.get(day);
      if (!dayModels.has(model)) {
        dayModels.set(model, { model, uncached: 0, cacheR: 0, cacheW5m: 0, cacheW1h: 0, out: 0, cost: 0 });
      }
      const dm = dayModels.get(model);
      dm.uncached += usage.uncached_input_tokens;
      dm.cacheR += usage.cache_read_input_tokens;
      dm.cacheW5m += usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      dm.cacheW1h += usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      dm.out += usage.output_tokens;
      dm.cost += cost;
    }
  }

  return keys;
}

// ---- HTTP helper ----
async function apiFetch(url, adminKey) {
  const res = await fetch(url, {
    headers: {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ---- Main ----
async function main() {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) {
    process.stderr.write('Error: ANTHROPIC_ADMIN_KEY 環境変数が設定されていません\n');
    process.exit(1);
  }

  const days = parseInt(process.env.DAYS || '21', 10);
  const now = new Date();
  const startingAt = new Date(now.getTime() - days * 86400_000);
  // 00:00 UTC に揃える
  startingAt.setUTCHours(0, 0, 0, 0);
  const startISO = startingAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const endISO = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // 1. API キー一覧を取得
  const keyNames = new Map();
  let afterId = null;
  let apiKeyUrl = 'https://api.anthropic.com/v1/organizations/api_keys?limit=100';
  for (;;) {
    const url = afterId ? `${apiKeyUrl}&after_id=${encodeURIComponent(afterId)}` : apiKeyUrl;
    const body = await apiFetch(url, adminKey);
    for (const k of body.data ?? []) {
      keyNames.set(k.id, k.name);
    }
    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }

  // 2. 使用量レポートを取得 (日別・キー別・モデル別)
  const allBuckets = [];
  let page = null;
  const reportBase =
    `https://api.anthropic.com/v1/organizations/usage_report/messages?` +
    `starting_at=${encodeURIComponent(startISO)}&` +
    `ending_at=${encodeURIComponent(endISO)}&` +
    `bucket_width=1d&` +
    `group_by[]=api_key_id&` +
    `group_by[]=model&` +
    `limit=31`;

  for (;;) {
    const url = page ? `${reportBase}&page=${encodeURIComponent(page)}` : reportBase;
    const body = await apiFetch(url, adminKey);
    allBuckets.push(...(body.data ?? []));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  // 3. 集計
  const keys = aggregate(allBuckets, keyNames);

  // 4. 出力 (プレーンテキスト)
  const lines = [];

  // 4a. キー別合計 (降順)
  const sortedKeys = [...keys.entries()].sort((a, b) => b[1].total - a[1].total);

  lines.push('=== APIキー別 コスト一覧 ===');
  lines.push(`期間: ${startISO} 〜 ${endISO}`);
  lines.push('');
  for (const [kid, entry] of sortedKeys) {
    const shortId = kid === '__null__' ? 'N/A' : kid.slice(-6);
    const modelParts = [...entry.byModel.entries()]
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([m, stats]) => `${m}=$${stats.cost.toFixed(2)}`)
      .join(', ');
    lines.push(`${entry.name} (${shortId}) ${entry.status ? `| ${entry.status}` : ''} | $${entry.total.toFixed(2)} | ${modelParts}`);
  }

  lines.push('');
  lines.push('=== 日別 × キー別 詳細 ===');

  // 日付順に全ユニーク日付を収集
  const allDays = [...new Set(allBuckets.map((b) => b.starting_at.slice(0, 10)))].sort();

  for (const day of allDays) {
    lines.push('');
    // その日の全キー×モデルエントリを収集し、キー単位でコスト降順
    const dayEntries = [];
    for (const [kid, entry] of keys) {
      const dayModels = entry.daily.get(day);
      if (!dayModels) continue;
      for (const [model, dm] of dayModels) {
        dayEntries.push({ kid, name: entry.name, model, ...dm });
      }
    }
    // 上位5キー (モデル合計ではなくキー合計で絞る)
    const keyCosts = new Map();
    for (const de of dayEntries) {
      keyCosts.set(de.kid, (keyCosts.get(de.kid) ?? 0) + de.cost);
    }
    const topKeys = [...keyCosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);

    const filtered = dayEntries.filter((de) => topKeys.includes(de.kid));
    for (const de of filtered) {
      const tokens = `in=${de.uncached}/cW5m=${de.cacheW5m}/cW1h=${de.cacheW1h}/cR=${de.cacheR}/out=${de.out}`;
      lines.push(`${day} | ${de.name} | ${de.model} | $${de.cost.toFixed(2)} | ${tokens}`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}

if (isEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}