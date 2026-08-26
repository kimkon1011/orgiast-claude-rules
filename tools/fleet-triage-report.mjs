#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';

function parseJst(value) {
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00'] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute));
  const check = new Date(time + 9 * 60 * 60 * 1000);
  if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() + 1 !== Number(month)
      || check.getUTCDate() !== Number(day) || check.getUTCHours() !== Number(hour)
      || check.getUTCMinutes() !== Number(minute)) return null;
  return time;
}

function displayName(row) {
  const pcName = String(row?.pcName ?? '').trim();
  const label = String(row?.label ?? '').trim();
  if (pcName && label) return `${pcName}(${label})`;
  return pcName || label || '(名称未設定)';
}

function jstDate(now) {
  const date = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const two = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

export function buildDigest(rows, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const nowMs = current.getTime();
  if (Number.isNaN(nowMs)) throw new TypeError('now must be a valid date');
  const result = { fresh: [], stale: [], silent: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    const reported = parseJst(row?.reportedAt);
    const age = reported == null ? Infinity : nowMs - reported;
    if (age >= 0 && age <= 24 * 60 * 60 * 1000) result.fresh.push(row);
    else if (age > 24 * 60 * 60 * 1000 && age <= 72 * 60 * 60 * 1000) result.stale.push(row);
    else result.silent.push(row);
  }
  const lines = [`**🖥 フリート生存digest** (${jstDate(current)})`];
  const add = (items, label) => {
    if (items.length) lines.push(`${label}: ${items.length}台 — ${items.map(displayName).join(' / ')}`);
  };
  add(result.fresh, '✅ 24h以内に報告');
  add(result.stale, '⚠️ 24〜72h');
  add(result.silent, '🚨 72h超/未報告');
  return { ...result, text: lines.join('\n') };
}

async function main() {
  const sheetUrl = process.env.FLEET_SHEET_URL;
  const token = process.env.FLEET_SHEET_TOKEN;
  if (!sheetUrl || !token) {
    console.error('fleet-triage: FLEET_SHEET_URL/TOKEN 未設定のため実行しません');
    return;
  }

  try {
    const url = new URL(sheetUrl);
    url.searchParams.set('token', token);
    // GAS Web App は redirect(script.googleusercontent.com)＋コールドスタートで遅く、
    // GitHub Runner からは 20 秒では届かなかった(実測 TimeoutError)。余裕を持たせて2回試す。
    let response = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 2 && !response; attempt += 1) {
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
      }
    }
    if (!response) throw lastError || new Error('no response');
    if (!response.ok) throw new Error(`シート取得が HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(`シート応答の形式が不正 (ok=${payload?.ok})`);
    }
    const { text } = buildDigest(payload.rows, new Date());
    const webhook = process.env.DISCORD_COST_WEBHOOK;
    if (process.argv.includes('--dry-run') || !webhook) {
      console.log(text);
      return;
    }
    const posted = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'orgiast-fleet-triage/1.0' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!posted.ok) {
      console.error(`fleet-triage: Discord送信が HTTP ${posted.status}`);
      process.exitCode = 1;
    }
  } catch (error) {
    // 失敗を握り潰して exit 0 にすると、Actions は success なのに投稿ゼロになり
    // 「digest が来ない」ことに誰も気づけない(実測: TimeoutError で success 表示)。
    // Discord にも失敗を出し、ジョブは赤くする。
    const reason = `${error?.name || 'error'}${error?.message ? `: ${error.message}` : ''}`;
    console.error(`fleet-triage: 実行に失敗 (${reason})`);
    process.exitCode = 1;
    const webhook = process.env.DISCORD_COST_WEBHOOK;
    if (webhook && !process.argv.includes('--dry-run')) {
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'orgiast-fleet-triage/1.0' },
          body: JSON.stringify({ content: `🚨 **フリート生存digest 取得失敗** — ${reason}（フリートシートの doGet を確認してください）` }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {}
    }
  }
}

if (isEntry(import.meta.url)) await main();
