#!/usr/bin/env node
/**
 * ai-referral-report.mjs — GA4 Data API に直接照会し、生成AIからの流入（AI referral）と
 * 検索流入（Organic Search）の月次推移をマークダウンレポートとして書き出す。
 *
 * 認証は google-property-check.mjs から export された getToken を再利用（DWD + SA 鍵）。
 *
 * 使い方:
 *   node tools/ai-referral-report.mjs [--property <ID>] [--months <N>] [--json] [--out <path>]
 *
 * 既定:
 *   --property 279040101  （orgiast.jp GA4）
 *   --months 13          （直近 13 ヶ月）
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { defaultDriveKeyPath } from './lib/drive-auth.mjs';

// --- 定数 ----------------------------------------------------------------

const DEFAULT_PROPERTY = '279040101';
const DEFAULT_MONTHS = 13;
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/**
 * AI と判定する sessionSource の正規表現（大文字小文字無視）。
 * 判定関数 isAiSource 経由で使うこと。
 */
const AI_SOURCE_RE =
  /chatgpt\.com|chat\.openai\.com|openai|perplexity|gemini\.google|bard\.google|copilot\.microsoft|bing\.com\/chat|edgeservices|claude\.ai|anthropic|you\.com|phind|poe\.com|grok|x\.ai|deepseek|felo|genspark|manus/i;

// --- ユーティリティ --------------------------------------------------------

function b64url(v) {
  return Buffer.from(v).toString('base64url');
}

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { out.flags.add('h'); continue; }
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    if (name === 'json' || name === 'help') out.flags.add(name);
    else out[name] = argv[++i];
  }
  return out;
}

/** DWD JWT を自己署名しアクセストークンを取得（google-property-check.mjs と同一方式）。 */
async function getToken({ key, subject, scope, signal }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, 'base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      jwt,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) {
    const err = new Error(json.error_description || json.error || `token HTTP ${res.status}`);
    err.tokenError = true;
    throw err;
  }
  return json.access_token;
}

/** GA4 Data API runReport を呼び、全行を取得する（offset ページネーション対応）。 */
async function runGa4Report(propertyId, requestBody, token, signal) {
  const base = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const allRows = [];
  let offset = 0;
  const pageSize = 10000;

  for (;;) {
    const body = { ...requestBody, offset, limit: pageSize };
    const res = await fetch(base, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        json.error?.message || json.error?.status || `GA4 API HTTP ${res.status}`,
      );
      err.httpStatus = res.status;
      err.detail = json;
      throw err;
    }
    const rows = json.rows ?? [];
    allRows.push(...rows);
    if (allRows.length >= (json.rowCount ?? allRows.length)) break;
    offset += pageSize;
  }

  return allRows;
}

/** sessionSource が AI 由来か判定する。export してテスト可能。 */
function isAiSource(source) {
  return AI_SOURCE_RE.test(source);
}

/**
 * yearMonth ('YYYYMM') から YYYY年M月 の表示ラベルを返す。
 * exports してテスト可能。
 */
function fmtMonth(ym) {
  const y = ym.slice(0, 4);
  const m = String(Number(ym.slice(4, 6)));
  return `${y}年${m}月`;
}

/**
 * 月の降順で並べ替え（最新月が先）。
 */
function sortMonthsDesc(months) {
  return [...months].sort((a, b) => b.localeCompare(a));
}

/**
 * 直近 N ヶ月の日付範囲を計算する。
 * @param {number} months
 * @returns {{ startDate: string, endDate: string }}
 */
function calcDateRange(months) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const sy = start.getFullYear();
  const sm = String(start.getMonth() + 1).padStart(2, '0');
  return { startDate: `${sy}-${sm}-01`, endDate: `${y}-${m}-${d}` };
}

// --- GA4 データ取得 -------------------------------------------------------

/**
 * AI 流入データを取得する（dimensions: yearMonth, sessionSource）。
 * イベント指標は keyEvents を試し、失敗したら conversions にフォールバック。
 */
async function fetchAiData(propertyId, months, token, signal) {
  const { startDate, endDate } = calcDateRange(months);

  // keyEvents を試す
  let rows;
  let usedKeyEvents = true;
  let keyEventMetric = 'keyEvents';
  try {
    rows = await runGa4Report(
      propertyId,
      {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'yearMonth' }, { name: 'sessionSource' }],
        metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
      },
      token,
      signal,
    );
  } catch (e) {
    if (e.detail?.error?.status === 'INVALID_ARGUMENT') {
      // keyEvents が無い古いプロパティ → conversions へ
      rows = await runGa4Report(
        propertyId,
        {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'yearMonth' }, { name: 'sessionSource' }],
          metrics: [{ name: 'sessions' }, { name: 'conversions' }],
        },
        token,
        signal,
      );
      usedKeyEvents = false;
      keyEventMetric = 'conversions';
    } else {
      throw e;
    }
  }

  // 加工: 月→{ 全セッション, AIセッション, AI内訳[], 全 keyEvents, AI keyEvents }
  const monthMap = new Map();

  for (const row of rows) {
    const ym = row.dimensionValues[0].value;
    const source = row.dimensionValues[1].value;
    const sessions = Number(row.metricValues[0].value ?? 0);
    const events = Number(row.metricValues[1].value ?? 0);

    if (!monthMap.has(ym)) {
      monthMap.set(ym, {
        yearMonth: ym,
        totalSessions: 0,
        aiSessions: 0,
        aiSources: {},
        totalKeyEvents: 0,
        aiKeyEvents: 0,
      });
    }
    const m = monthMap.get(ym);
    m.totalSessions += sessions;
    m.totalKeyEvents += events;
    if (isAiSource(source)) {
      m.aiSessions += sessions;
      m.aiKeyEvents += events;
      m.aiSources[source] = (m.aiSources[source] ?? 0) + sessions;
    }
  }

  // 月降順ソート
  const monthsArr = sortMonthsDesc([...monthMap.keys()]);

  return {
    months: monthsArr.map((ym) => monthMap.get(ym)),
    keyEventMetric,
  };
}

/**
 * チャネル別データを取得する（dimensions: yearMonth, sessionDefaultChannelGroup）。
 */
async function fetchChannelData(propertyId, months, token, signal) {
  const { startDate, endDate } = calcDateRange(months);

  const rows = await runGa4Report(
    propertyId,
    {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'yearMonth' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
    },
    token,
    signal,
  );

  // 月→チャネル別セッション数
  const monthMap = new Map();

  for (const row of rows) {
    const ym = row.dimensionValues[0].value;
    const channel = row.dimensionValues[1].value;
    const sessions = Number(row.metricValues[0].value ?? 0);

    if (!monthMap.has(ym)) {
      monthMap.set(ym, { yearMonth: ym, channels: {} });
    }
    monthMap.get(ym).channels[channel] = (monthMap.get(ym).channels[channel] ?? 0) + sessions;
  }

  const monthsArr = sortMonthsDesc([...monthMap.keys()]);

  const CHANNEL_ORDER = [
    'Organic Search',
    'Direct',
    'Referral',
    'Organic Social',
    'Paid Search',
    'Email',
    'Display',
    'Organic Video',
    'Unassigned',
    '(other)',
  ];

  return monthsArr.map((ym) => {
    const m = monthMap.get(ym);
    const channels = {};
    let otherTotal = 0;
    const known = new Set(CHANNEL_ORDER);
    for (const [ch, count] of Object.entries(m.channels)) {
      if (known.has(ch)) channels[ch] = count;
      else otherTotal += count;
    }
    if (otherTotal > 0) channels['(other)'] = otherTotal;
    return { yearMonth: ym, channels };
  });
}

// --- マークダウン生成 -----------------------------------------------------

function renderMarkdown(aiData, channelData, months) {
  const lines = [];

  lines.push(`# GA4 AI経由流入レポート（orgiast.jp）`);
  lines.push('');
  lines.push(`- プロパティ: ${DEFAULT_PROPERTY}`);
  lines.push(`- 期間: 直近 ${months} ヶ月`);
  lines.push(`- 指標: ${aiData.keyEventMetric === 'keyEvents' ? 'keyEvents' : 'conversions'}`);
  lines.push(`- 生成日時: ${new Date().toISOString()}`);
  lines.push('');

  // --- ① AI流入の月次表 ---
  lines.push('## 1. AI流入の月次推移');
  lines.push('');
  lines.push(
    '| 月 | 全セッション | AI流入セッション | AI割合 | AI内訳（上位5ソース） |',
  );
  lines.push(
    '|---|---|---:|---:|:---|',
  );

  for (const m of aiData.months) {
    const ratio =
      m.totalSessions > 0
        ? ((m.aiSessions / m.totalSessions) * 100).toFixed(2) + '%'
        : '-';
    // 内訳上位5ソースを降順で
    const topSources = Object.entries(m.aiSources)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([src, cnt]) => `${src}(${cnt})`)
      .join(', ');
    lines.push(
      `| ${fmtMonth(m.yearMonth)} | ${m.totalSessions.toLocaleString()} | ${m.aiSessions.toLocaleString()} | ${ratio} | ${topSources || '-'} |`,
    );
  }

  lines.push('');

  // --- ② チャネル別月次表 ---
  lines.push('## 2. チャネル別セッション月次推移');
  lines.push('');
  const headerChannels = [
    'Organic Search',
    'Direct',
    'Referral',
    'Organic Social',
    'Paid Search',
    'Email',
    'Display',
    '(other)',
  ];
  lines.push(
    '| 月 | ' + headerChannels.join(' | ') + ' |',
  );
  lines.push(
    '|:---|' + headerChannels.map(() => '---:').join('|') + '|',
  );

  for (const m of channelData) {
    const vals = headerChannels.map((ch) =>
      (m.channels[ch] ?? 0).toLocaleString(),
    );
    lines.push('| ' + fmtMonth(m.yearMonth) + ' | ' + vals.join(' | ') + ' |');
  }

  lines.push('');

  // --- ③ AI ソース別合計上位10 ---
  lines.push('## 3. AIソース別合計（全期間・上位10）');
  lines.push('');
  // 全期間の AI ソース別セッションを集計
  const aiSourceTotal = {};
  for (const m of aiData.months) {
    for (const [src, cnt] of Object.entries(m.aiSources)) {
      aiSourceTotal[src] = (aiSourceTotal[src] ?? 0) + cnt;
    }
  }
  const sortedSources = Object.entries(aiSourceTotal)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  lines.push('| 順位 | ソース | セッション数 |');
  lines.push('|---|---:|---:|');
  sortedSources.forEach(([src, cnt], i) => {
    lines.push(`| ${i + 1} | ${src} | ${cnt.toLocaleString()} |`);
  });

  lines.push('');

  // --- ④ 直近3か月 vs 前年同期3か月の比較 ---
  lines.push('## 4. 直近3か月 vs 前年同期3か月の比較');
  lines.push('');

  // 直近3か月: 最新月から3つ
  const recent3 = aiData.months.slice(0, 3);
  // 前年同期: recent3 の各月の yearMonth から year を -1
  const allMonthsSet = new Set(aiData.months.map((m) => m.yearMonth));
  const prev3 = recent3
    .map((m) => {
      const ym = String(Number(m.yearMonth) - 100);
      return allMonthsSet.has(ym) ? ym : null;
    })
    .filter(Boolean);

  // AI セッション
  const recentAiSessions = recent3.reduce((s, m) => s + m.aiSessions, 0);
  const prevAiSessions = prev3.reduce(
    (s, ym) => s + (aiData.months.find((m) => m.yearMonth === ym)?.aiSessions ?? 0),
    0,
  );
  const recentTotalSessions = recent3.reduce((s, m) => s + m.totalSessions, 0);
  const prevTotalSessions = prev3.reduce(
    (s, ym) => s + (aiData.months.find((m) => m.yearMonth === ym)?.totalSessions ?? 0),
    0,
  );

  // Organic Search の推移
  const recentOrganic = channelData
    .slice(0, 3)
    .reduce((s, m) => s + (m.channels['Organic Search'] ?? 0), 0);
  const prevOrganic = prev3.reduce((s, ym) => {
    const m = channelData.find((c) => c.yearMonth === ym);
    return s + (m?.channels['Organic Search'] ?? 0);
  }, 0);

  lines.push('| 指標 | 直近3か月 | 前年同期3か月 | 増減 |');
  lines.push('|---|---|---:|---:|');
  lines.push(
    `| AI流入セッション | ${recentAiSessions.toLocaleString()} | ${prevAiSessions.toLocaleString()} | ${diffStr(recentAiSessions, prevAiSessions)} |`,
  );
  lines.push(
    `| 全セッション | ${recentTotalSessions.toLocaleString()} | ${prevTotalSessions.toLocaleString()} | ${diffStr(recentTotalSessions, prevTotalSessions)} |`,
  );
  lines.push(
    `| Organic Search | ${recentOrganic.toLocaleString()} | ${prevOrganic.toLocaleString()} | ${diffStr(recentOrganic, prevOrganic)} |`,
  );

  if (prevTotalSessions > 0) {
    const recentAiRatio = (recentAiSessions / recentTotalSessions) * 100;
    const prevAiRatio = (prevAiSessions / prevTotalSessions) * 100;
    lines.push(
      `| AI割合 | ${recentAiRatio.toFixed(2)}% | ${prevAiRatio.toFixed(2)}% | ${(recentAiRatio - prevAiRatio).toFixed(2)}pt |`,
    );
  }

  lines.push('');
  // 比較対象月を明示
  const recentLabel = recent3.map((m) => fmtMonth(m.yearMonth)).join('・');
  const prevLabel = prev3.length > 0 ? prev3.map((ym) => fmtMonth(ym)).join('・') : '(データなし)';
  lines.push(`- 直近3か月: ${recentLabel}`);
  lines.push(`- 前年同期: ${prevLabel}`);
  lines.push('');

  return lines.join('\n');
}

function diffStr(current, previous) {
  if (previous === 0) return current > 0 ? '+∞' : '±0';
  const diff = current - previous;
  const pct = ((diff / previous) * 100).toFixed(1);
  return `${diff > 0 ? '+' : ''}${diff.toLocaleString()} (${pct}%)`;
}

// --- JSON 出力 ------------------------------------------------------------

function renderJson(aiData, channelData) {
  return JSON.stringify(
    {
      property: DEFAULT_PROPERTY,
      generatedAt: new Date().toISOString(),
      keyEventMetric: aiData.keyEventMetric,
      aiMonthly: aiData.months.map((m) => ({
        yearMonth: m.yearMonth,
        totalSessions: m.totalSessions,
        aiSessions: m.aiSessions,
        aiRatio: m.totalSessions > 0 ? m.aiSessions / m.totalSessions : 0,
        topAiSources: Object.entries(m.aiSources)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([source, sessions]) => ({ source, sessions })),
      })),
      channelMonthly: channelData.map((m) => ({
        yearMonth: m.yearMonth,
        channels: m.channels,
      })),
    },
    null,
    2,
  );
}

// --- main ----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.flags.has('h')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }

  const property = args.property ?? DEFAULT_PROPERTY;
  const months = Number(args.months ?? DEFAULT_MONTHS);
  const keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
  const subject = process.env.GOOGLE_IMPERSONATE ?? 'kim@orgiast.jp';
  const outPath = args.out || null;

  if (!fs.existsSync(keyPath)) {
    console.error(`SA key not found: ${keyPath}`);
    return 2;
  }
  let key;
  try {
    key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (e) {
    console.error(`SA key is not valid JSON: ${keyPath} (${e.message})`);
    return 2;
  }
  if (!key.client_email || !key.private_key) {
    console.error(`SA key missing client_email/private_key: ${keyPath}`);
    return 2;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);

  try {
    const token = await getToken({ key, subject, scope: GA4_SCOPE, signal: ctrl.signal });

    const [aiData, channelData] = await Promise.all([
      fetchAiData(property, months, token, ctrl.signal),
      fetchChannelData(property, months, token, ctrl.signal),
    ]);

    clearTimeout(timer);

    if (args.flags.has('json')) {
      const json = renderJson(aiData, channelData);
      if (outPath) {
        fs.writeFileSync(outPath, json, 'utf8');
        console.log(`JSON written to ${outPath}`);
      } else {
        console.log(json);
      }
    } else {
      const md = renderMarkdown(aiData, channelData, months);
      if (outPath) {
        fs.writeFileSync(outPath, md, 'utf8');
        console.log(`Report written to ${outPath}`);
      } else {
        console.log(md);
      }
    }
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.error('aborted: GA4 API タイムアウト');
      return 3;
    }
    console.error(`error: ${e.message}`);
    if (e.detail) console.error(JSON.stringify(e.detail, null, 2).slice(0, 500));
    return 3;
  }

  return 0;
}

// --- exports -------------------------------------------------------------

export {
  isAiSource,
  fmtMonth,
  sortMonthsDesc,
  calcDateRange,
  renderMarkdown,
  renderJson,
  AI_SOURCE_RE,
  DEFAULT_PROPERTY,
  DEFAULT_MONTHS,
  GA4_SCOPE,
};

// 直接実行
main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`fatal: ${e.stack ?? e.message}`);
    process.exit(1);
  });