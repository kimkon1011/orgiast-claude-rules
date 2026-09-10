#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';

export async function fetchAdminCostReport({ startingAt, adminKey, fetchImpl = fetch } = {}) {
  if (!adminKey) return { available: false, reason: 'Admin key 未設定' };
  const buckets = []; let page = null;
  try {
    for (let p = 0; p < 40; p++) {
      let uri = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startingAt}&group_by[]=description`;
      if (page) uri += `&page=${encodeURIComponent(page)}`;
      const response = await fetchImpl(uri, { headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' } });
      if (!response.ok) return { available: false, reason: `cost_report HTTP ${response.status}` };
      const json = await response.json(); buckets.push(...(json.data || []));
      if (json.has_more && json.next_page) page = json.next_page; else break;
    }
    let totalUsd = 0; const byModel = {}, byDay = {};
    for (const bucket of buckets) { const day = String(typeof bucket.starting_at === 'string' ? bucket.starting_at : new Date(bucket.starting_at).toISOString()).slice(0, 10); for (const result of bucket.results || []) { const usd = (parseFloat(result.amount) || 0) / 100; totalUsd += usd; const match = /^(Claude .+?) Usage/.exec(result.description || ''), model = match ? match[1] : (result.description || 'other'); byModel[model] = (byModel[model] || 0) + usd; byDay[day] = (byDay[day] || 0) + usd; } }
    return { available: true, totalUsd, byModel, byDay };
  } catch (error) { return { available: false, reason: `network: ${error.name || 'error'}` }; }
}

async function main() {
  const key = process.env.ANTHROPIC_ADMIN_KEY, hook = process.env.DISCORD_COST_WEBHOOK;
  if (!key || !hook) { console.error('missing ANTHROPIC_ADMIN_KEY / DISCORD_COST_WEBHOOK'); process.exitCode = 1; return; }
  const now = new Date(), monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`, yesterday = new Date(now - 864e5).toISOString().slice(0, 10);
  const report = await fetchAdminCostReport({ startingAt: monthStart, adminKey: key });
  if (!report.available) throw new Error(report.reason);
  const fable = Object.entries(report.byModel).filter(([name]) => /Fable|Mythos/i.test(name)).reduce((sum, [, usd]) => sum + usd, 0);
  let message = `**💰 Claude API課金 日次監視** (Developer Platform / MTD ${monthStart}〜)\nMTD合計: **$${report.totalUsd.toFixed(2)}** ／ 前日 ${yesterday}: **$${(report.byDay[yesterday] || 0).toFixed(2)}**\n`;
  if (fable) message += `🚨 **Fable5 MTD $${fable.toFixed(2)}**\n`;
  message += Object.entries(report.byModel).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, usd]) => `- ${name}: $${usd.toFixed(2)}`).join('\n');
  message += '\n※Admin cost_report。Claude Team 定額利用は含まれません。';
  const posted = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message.slice(0, 1950) }) });
  console.log(message); console.log(posted.ok ? 'posted to #claude-code' : `discord POST failed ${posted.status}`);
}
if (isEntry(import.meta.url)) await main();
