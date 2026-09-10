#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';

const HOUR = 60 * 60 * 1000;

function pcName(row) { return String(row?.pcName || row?.label || '(名称未設定)').trim(); }

const WEEKLY_MAX_AGE_HOURS = 8 * 24 + 2; // 週次(毎週月曜)は 8日+2h 以内に OK が1回あれば良い。

// 週次コスト改善ループ(OrgiastCostWeeklyImprove)の heartbeat 監視。日次とは別の列 pair を読む(仕様C3)。
export function inspectWeeklyHeartbeats(rows, now = new Date(), maxAgeHours = WEEKLY_MAX_AGE_HOURS, runner = '') {
  const nowMs = new Date(now).getTime();
  const allRows = Array.isArray(rows) ? rows : [];
  const normalizedRunner = String(runner || '').trim().toLowerCase();
  const heartbeatRows = allRows.filter((row) => String(row?.costWeeklyRanAt || '').trim());
  const freshnessRows = normalizedRunner
    ? heartbeatRows.filter((row) => [row?.pcName, row?.hostname, row?.label].some((value) => String(value || '').trim().toLowerCase() === normalizedRunner))
    : heartbeatRows;
  const items = heartbeatRows.flatMap((row) => {
    const name = pcName(row);
    const ranAt = String(row?.costWeeklyRanAt || '').trim();
    const status = String(row?.costWeeklyStatus || '').trim();
    if (status === 'NG') return [{ pcName: name, ranAt, reason: '直近の週次改善ループ実行結果がNGです', action: 'そのPCの cost-weekly-improve.log の NG 行を確認してください' }];
    return [];
  });
  const hasFreshOk = freshnessRows.some((row) => {
    const timestamp = Date.parse(String(row?.costWeeklyRanAt || '').trim());
    return String(row?.costWeeklyStatus || '').trim() === 'OK'
      && Number.isFinite(timestamp)
      && (nowMs - timestamp) / HOUR <= maxAgeHours;
  });
  if (!hasFreshOk && items.length === 0) {
    items.push({
      pcName: normalizedRunner ? String(runner).trim() : 'フリート全体',
      ranAt: `${maxAgeHours}時間以内のOK記録なし`,
      reason: normalizedRunner
        ? `指定実行機の週次コスト改善ループが${maxAgeHours}時間以上動いていません`
        : `週次コスト改善ループがフリート全体で${maxAgeHours}時間以上実行されていません`,
      action: normalizedRunner
        ? 'そのPCで `Get-ScheduledTask OrgiastCostWeeklyImprove` の State を確認してください'
        : '実行機で `Get-ScheduledTask OrgiastCostWeeklyImprove` の State を確認してください'
    });
  }
  return items;
}

export function inspectHeartbeats(rows, now = new Date(), maxAgeHours = 36, runner = '') {
  const nowMs = new Date(now).getTime();
  const allRows = Array.isArray(rows) ? rows : [];
  const normalizedRunner = String(runner || '').trim().toLowerCase();
  const heartbeatRows = allRows.filter((row) => String(row?.costLoopRanAt || '').trim());
  const freshnessRows = normalizedRunner
    ? heartbeatRows.filter((row) => [row?.pcName, row?.hostname, row?.label].some((value) => String(value || '').trim().toLowerCase() === normalizedRunner))
    : heartbeatRows;
  const items = heartbeatRows.flatMap((row) => {
    const name = pcName(row);
    const ranAt = String(row?.costLoopRanAt || '').trim();
    const status = String(row?.costLoopStatus || '').trim();
    if (status === 'NG') return [{ pcName: name, ranAt, reason: '直近の実行結果がNGです', action: `そのPCで cost-improve-loop.log の NG 行を確認してください` }];
    return [];
  });
  const hasFreshOk = freshnessRows.some((row) => {
    const timestamp = Date.parse(String(row?.costLoopRanAt || '').trim());
    return String(row?.costLoopStatus || '').trim() === 'OK'
      && Number.isFinite(timestamp)
      && (nowMs - timestamp) / HOUR <= maxAgeHours;
  });
  // NG はそれ自体が強い異常通知なので、同じ実行機不足を重ねて通知しない。
  if (!hasFreshOk && items.length === 0) {
    items.push({
      pcName: normalizedRunner ? String(runner).trim() : 'フリート全体',
      ranAt: '36時間以内のOK記録なし',
      reason: normalizedRunner
        ? `指定実行機のコスト改善ループが${maxAgeHours}時間以上動いていません`
        : `コスト改善ループがフリート全体で${maxAgeHours}時間以上実行されていません`,
      action: normalizedRunner
        ? `そのPCで \`Get-ScheduledTask OrgiastCostImproveLoop\` の State を確認してください`
        : '実行機で `Get-ScheduledTask OrgiastCostImproveLoop` の State を確認してください'
    });
  }
  return items;
}

export function buildWatchdogMessage(items) {
  const lines = ['🚨 **コスト改善ループ死活監視**'];
  for (const item of items) lines.push(`- **${item.pcName}** / 最終実行: ${item.ranAt} / ${item.reason}。次の対応: ${item.action}`);
  return lines.join('\n');
}

export async function fetchWatchdogRows({ sheetUrl, token, fetchImpl = globalThis.fetch }) {
  if (!sheetUrl || !token) throw new Error('FLEET_SHEET_URL/TOKEN 未設定');
  const url = new URL(sheetUrl); url.searchParams.set('token', token);
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`フリートシート取得が HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok || !Array.isArray(payload.rows)) throw new Error(`フリートシート応答不正: ${payload?.error || 'rowsなし'}`);
  return payload.rows;
}

async function postDiscord(text, webhook, fetchImpl) {
  if (!webhook) throw new Error('DISCORD_COST_WEBHOOK 未設定');
  const response = await fetchImpl(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'orgiast-cost-improve-watchdog/1.0' }, body: JSON.stringify({ content: text }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Discord通知が HTTP ${response.status}`);
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const dryRun = argv.includes('--dry-run');
  const fetchImpl = io.fetchImpl || globalThis.fetch;
  let items;
  try {
    const rows = await (io.fetchRows || fetchWatchdogRows)({ sheetUrl: process.env.FLEET_SHEET_URL, token: process.env.FLEET_SHEET_TOKEN, fetchImpl });
    const now = io.now || new Date();
    items = inspectHeartbeats(rows, now, 36, process.env.COST_IMPROVE_RUNNER);
    items = items.concat(inspectWeeklyHeartbeats(rows, now, WEEKLY_MAX_AGE_HOURS, process.env.COST_IMPROVE_RUNNER));
  } catch (error) {
    items = [{ pcName: 'フリートシート', ranAt: '取得不能', reason: `死活情報を見に行けませんでした (${String(error?.message ?? error)})`, action: 'FLEET_SHEET_URL/TOKEN と GAS doGet を確認してください' }];
  }
  if (!items.length) { console.log('コスト改善ループ: 異常なし'); return { ok: true, items, notified: false }; }
  const text = buildWatchdogMessage(items);
  console.log(text);
  if (!dryRun) await (io.notify || postDiscord)(text, process.env.DISCORD_COST_WEBHOOK, fetchImpl);
  return { ok: false, items, notified: !dryRun };
}

if (isEntry(import.meta.url)) main().catch((error) => { console.error(`cost-improve-watchdog: ${error.message}`); process.exitCode = 1; });
