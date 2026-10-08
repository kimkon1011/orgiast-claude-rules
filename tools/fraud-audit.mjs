#!/usr/bin/env node
/**
 * 営業アプリの読み取り専用内部不正監査 CLI (Node.js 20 / 外部依存なし)。
 * node tools/fraud-audit.mjs --env-file <path> [--json <snapshot.json>]
 * node tools/fraud-audit.mjs --snapshot <snapshot.json> [--out <report.md>]
 * 検出結果は確認の手掛かりであり、不正を断定するものではない。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const SEVERITIES = ['high', 'medium', 'info'];
const DEAL_COLUMNS = 'id,deal_no,customer_id,deal_title,status,progress,sales_owner,estimate_amount,sales_amount,profit_amount,profit_rate,won_at,lost_at,archived_at,archived_by,archived_reason,created_at,updated_at';
const isSet = (value) => value !== null && value !== undefined && String(value).trim() !== '';

function numeric(value) {
  if (!isSet(value) || !['string', 'number'].includes(typeof value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || !isSet(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

/** Return one finding per rule/deal, or per duplicate pair; never mutate inputs. */
export function runChecks(deals, customers) {
  const names = new Map(customers.map((customer) => [customer.id, customer.company_name]));
  const findings = [];
  const groups = new Map();
  function add(rule, severity, deal, detail) {
    findings.push({ rule, severity, deal_no: deal.deal_no ?? deal.id ?? '',
      customer: names.get(deal.customer_id) || String(deal.customer_id ?? '').slice(0, 8),
      sales_owner: deal.sales_owner ?? '', detail });
  }
  for (const deal of deals) {
    const sales = numeric(deal.sales_amount);
    const estimate = numeric(deal.estimate_amount);
    const profit = numeric(deal.profit_amount);
    const rate = numeric(deal.profit_rate);
    const won = timestamp(deal.won_at);
    const updated = timestamp(deal.updated_at);
    const created = timestamp(deal.created_at);
    if ((deal.status === '受注' || isSet(deal.won_at)) && won !== null && updated !== null && updated - won > 30 * DAY) {
      add('won-amount-edited', 'medium', deal, `受注確定後の編集疑い: won_at=${deal.won_at}, updated_at=${deal.updated_at}, 差日数=${((updated - won) / DAY).toFixed(6)}日`);
    }
    if (sales > 0 && profit !== null && rate !== null) {
      const calculated = profit / sales * 100;
      if (Number.isFinite(calculated) && Math.abs(rate - calculated) > 1.0) {
        add('profit-mismatch', 'high', deal, `利益率の不整合: 実算値=${calculated.toFixed(6)}%, 記録値=${rate}%`);
      }
    }
    if (deal.status === '受注' && isSet(deal.archived_at)) {
      const self = isSet(deal.archived_by) && isSet(deal.sales_owner) && deal.archived_by === deal.sales_owner;
      add('won-but-archived', 'high', deal, `受注案件のアーカイブ: ${deal.archived_at}${self ? '（自己アーカイブ）' : ''}`);
    }
    if (deal.status === '受注' && !isSet(deal.sales_owner)) {
      add('won-no-owner', 'medium', deal, '受注案件の担当者が未設定');
    }
    if (deal.status === '受注' && estimate > 0 && sales > 0 && (estimate - sales) / estimate >= 0.4) {
      add('big-discount', 'info', deal, `大幅値引き: 見積=${estimate}, 売上=${sales}, 値引率=${((estimate - sales) / estimate * 100).toFixed(2)}%`);
    }
    if (updated !== null) {
      const jst = new Date(updated + 9 * 60 * 60 * 1000);
      const hour = jst.getUTCHours();
      if (hour >= 22 || hour < 5 || jst.getUTCDay() === 0) {
        add('after-hours-update', 'info', deal, `時間外更新: JST ${jst.toISOString().replace('Z', '+09:00')}${jst.getUTCDay() === 0 ? '（日曜日）' : ''}`);
      }
    }
    if (isSet(deal.customer_id) && sales > 0 && created !== null) {
      const key = JSON.stringify([deal.customer_id, sales]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ deal, created });
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.created - b.created);
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length && group[j].created - group[i].created <= 7 * DAY; j += 1) {
        const first = group[i].deal;
        const second = group[j].deal;
        add('duplicate-deal', 'medium', first, `二重計上疑い: ${first.deal_no ?? first.id} / ${second.deal_no ?? second.id}, 売上=${numeric(first.sales_amount)}, 作成差=${((group[j].created - group[i].created) / DAY).toFixed(6)}日`);
      }
    }
  }
  return findings;
}

/** Parse dotenv assignments, comment lines, inline comments and quoted values. */
export function parseEnv(source) {
  const result = Object.create(null);
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error('dotenv の引用符が不正です');
      value = value.slice(1, end);
    } else {
      value = value.split('#', 1)[0].trim();
    }
    result[match[1]] = value;
  }
  return result;
}

function redact(text, secrets) {
  let result = String(text);
  const variants = secrets.filter(isSet).flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  for (const value of variants.sort((a, b) => b.length - a.length)) result = result.split(value).join('[REDACTED]');
  return result;
}

/** GET only. Injectable fetch allows offline verification of the REST contract. */
export async function fetchSnapshot(env, fetchImpl = globalThis.fetch) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!isSet(url) || !isSet(key)) throw new Error('必要な Supabase 環境変数がありません');
  let base;
  try {
    base = new URL(url);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
  } catch { throw new Error('Supabase URL の形式が不正です'); }
  const root = base.href.replace(/\/+$/, '');
  async function get(table, query) {
    let response;
    try {
      response = await fetchImpl(`${root}/rest/v1/${table}?${query}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    } catch { throw new Error(`Supabase ${table}: GET に失敗しました`); }
    let body;
    try { body = await response.text(); }
    catch { throw new Error(`Supabase ${table}: HTTP ${response.status} 本文の読み取りに失敗しました`); }
    if (!response.ok) throw new Error(`Supabase ${table}: HTTP ${response.status}\n${redact(body, [url, root, key])}`);
    try {
      const rows = JSON.parse(body);
      if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error();
      return rows;
    } catch { throw new Error(`Supabase ${table}: レスポンスの JSON 配列が不正です`); }
  }
  const deals = await get('deals', `select=${DEAL_COLUMNS}&order=updated_at.desc&limit=10000`);
  const customers = await get('customers', 'select=id,company_name&limit=10000');
  return { fetchedAt: new Date().toISOString(), deals, customers };
}

function cell(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, '<br>');
}

/** Counts always cover all findings; minSeverity filters report sections only. */
export function renderReport(findings, { mode, dealCount, minSeverity = 'info', generatedAt = new Date().toISOString() }) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]));
  const lines = ['# 営業アプリ 内部不正監査レポート',
    `- 生成: ${generatedAt} / モード: ${mode} / 対象案件数: ${dealCount}`,
    `- 件数: high ${counts.high} / medium ${counts.medium} / info ${counts.info}`, ''];
  for (const severity of SEVERITIES.slice(0, SEVERITIES.indexOf(minSeverity) + 1)) {
    lines.push(`## ${severity}`);
    const rows = findings.filter((finding) => finding.severity === severity);
    if (!rows.length) lines.push('該当なし');
    else {
      lines.push('| rule | deal_no | 顧客 | 担当 | 詳細 |', '|---|---|---|---|---|');
      for (const row of rows) lines.push(`| ${[row.rule, row.deal_no, row.customer, row.sales_owner, row.detail].map(cell).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function parseArgs(args) {
  const options = { 'min-severity': 'info' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !['env-file', 'snapshot', 'out', 'json', 'min-severity', 'fail-on-high'].includes(name) || seen.has(name)) throw new Error('CLI 引数が不正です');
    seen.add(name);
    if (name === 'fail-on-high') options[name] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('CLI 引数の値がありません');
      options[name] = args[++i];
    }
  }
  if (Boolean(options['env-file']) === Boolean(options.snapshot)) throw new Error('--env-file または --snapshot の片方を指定してください');
  if (!SEVERITIES.includes(options['min-severity'])) throw new Error('--min-severity は high|medium|info を指定してください');
  if (options.snapshot && options.json) throw new Error('--json は fetch モード専用です');
  return options;
}

async function readFile(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch { throw new Error('入力ファイルを読み込めません'); }
}

// Avoid accidentally overwriting credentials, input snapshots, or the other output.
async function checkPaths(options) {
  const files = [options['env-file'] || options.snapshot, options.out, options.json].filter(Boolean);
  const identities = [];
  for (const file of files) {
    const absolute = path.resolve(file);
    try {
      const stat = await fs.stat(absolute);
      identities.push({ canonical: await fs.realpath(absolute), inode: `${stat.dev}:${stat.ino}` });
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('入出力パスを確認できません');
      let parent;
      try { parent = await fs.realpath(path.dirname(absolute)); }
      catch { throw new Error('入出力先ディレクトリがありません'); }
      identities.push({ canonical: path.join(parent, path.basename(absolute)) });
    }
  }
  for (let i = 0; i < identities.length; i += 1) {
    for (let j = i + 1; j < identities.length; j += 1) {
      if (identities[i].canonical === identities[j].canonical || (identities[i].inode && identities[i].inode === identities[j].inode)) throw new Error('入力と出力には別のファイルを指定してください');
    }
  }
}

/** Execute CLI, returning an exit code without terminating an importing process. */
export async function main(args = process.argv.slice(2), { fetchImpl = globalThis.fetch, stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text) } = {}) {
  let secrets = [];
  try {
    const options = parseArgs(args);
    await checkPaths(options);
    const mode = options.snapshot ? 'snapshot' : 'fetch';
    let snapshot;
    if (mode === 'fetch') {
      const env = parseEnv(await readFile(options['env-file']));
      secrets = [env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, ''), env.SUPABASE_SERVICE_ROLE_KEY];
      snapshot = await fetchSnapshot(env, fetchImpl);
    } else {
      try { snapshot = JSON.parse(await readFile(options.snapshot)); }
      catch { throw new Error('snapshot ファイルを読み込めません（JSON を確認してください）'); }
    }
    if (!snapshot || timestamp(snapshot.fetchedAt) === null || ![snapshot.deals, snapshot.customers].every((rows) => Array.isArray(rows) && rows.every((row) => row && typeof row === 'object' && !Array.isArray(row)))) throw new Error('snapshot は fetchedAt, deals 配列, customers 配列が必要です');
    const findings = runChecks(snapshot.deals, snapshot.customers);
    const report = redact(renderReport(findings, { mode, dealCount: snapshot.deals.length, minSeverity: options['min-severity'] }), secrets);
    try {
      if (options.json) await fs.writeFile(options.json, redact(JSON.stringify(snapshot, null, 2), secrets) + '\n', { mode: 0o600 });
      if (options.out) await fs.writeFile(options.out, report, { mode: 0o600 });
      else stdout(report);
    } catch { throw new Error('監査結果を出力できません'); }
    return options['fail-on-high'] && findings.some((finding) => finding.severity === 'high') ? 2 : 0;
  } catch (error) {
    stderr(`fraud-audit: ${redact(error.message, secrets)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
