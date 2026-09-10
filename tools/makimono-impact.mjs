#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const homeDir = () => process.env.ORGIAST_HOME || os.homedir();
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readLedger = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };

export function aggregate({ days = 7, now = new Date() } = {}) {
  const home = homeDir();
  const gate = readJson(path.join(home, '.claude', '.makimono-gate-state.json'), {});
  const ledger = readLedger(path.join(home, '.claude', 'makimono-usage-ledger.jsonl'));
  const nowMs = new Date(now).getTime();
  const since = days === Infinity ? -Infinity : nowMs - Number(days) * 24 * 60 * 60 * 1000;
  const inWindow = (at) => { const time = new Date(at).getTime(); return Number.isFinite(time) && time >= since && time <= nowMs; };
  const sessions = Object.values(gate && typeof gate === 'object' ? gate : {}).filter((entry) => entry && typeof entry === 'object');
  const fireCount = (entries) => entries.reduce((sum, entry) => sum + (Number.isFinite(Number(entry.count)) ? Number(entry.count) : 0), 0);
  const windowSessions = sessions.filter((entry) => inWindow(entry.at));
  const fires = { window: fireCount(windowSessions), total: fireCount(sessions) };
  const readsAll = ledger.filter((entry) => entry?.t === 'read');
  const readsWindow = readsAll.filter((entry) => inWindow(entry.at));
  const reportsWindow = ledger.filter((entry) => entry?.t === 'report' && inWindow(entry.at));
  const slugCounts = new Map();
  for (const entry of readsWindow) if (entry.slug) slugCounts.set(entry.slug, (slugCounts.get(entry.slug) || 0) + 1);
  const uniqueSlugs = [...slugCounts].map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug)).slice(0, 5);
  const lastFire = sessions.map((entry) => entry.at).filter((at) => Number.isFinite(new Date(at).getTime())).sort((a, b) => new Date(b) - new Date(a))[0] || null;
  return {
    days: days === Infinity ? null : Number(days),
    fires,
    sessions: windowSessions.length,
    sessions_total: sessions.length,
    last_fire_at: lastFire,
    reads: { window: readsWindow.length, total: readsAll.length },
    unique_slugs: uniqueSlugs,
    rate: fires.window ? readsWindow.length / fires.window : null,
    reports: reportsWindow.length,
    saved_sum: reportsWindow.reduce((sum, entry) => sum + (Number.isFinite(Number(entry.saved)) ? Number(entry.saved) : 0), 0),
  };
}

function value(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function cli() {
  const args = process.argv.slice(2);
  const rawDays = value(args, '--days');
  const days = args.includes('--all') ? Infinity : rawDays === undefined ? 7 : Number(rawDays);
  const result = aggregate({ days: days === Infinity || Number.isFinite(days) && days >= 0 ? days : 7, now: new Date() });
  if (args.includes('--json')) { console.log(JSON.stringify(result)); return; }
  console.log(`gate発火(窓内/総数)\t${result.fires.window}/${result.fires.total}`);
  console.log(`対象セッション数\t${result.sessions}`);
  console.log(`最終発火時刻\t${result.last_fire_at || '-'}`);
  console.log(`本文読込(窓内/総数)\t${result.reads.window}/${result.reads.total}`);
  console.log(`読込ユニークslug(窓内上位5・回数付き)\t${result.unique_slugs.map((x) => `${x.slug}(${x.count})`).join(', ') || '-'}`);
  console.log(`読了率\t${result.rate === null ? '-' : `${(result.rate * 100).toFixed(1)}%`}`);
  console.log(`実績報告回数\t${result.reports}`);
  console.log(`報告saved合計tok\t${result.saved_sum}`);
  if (!result.reports) console.log('⚠ 実績報告が0件 — サーバーROIは空のままコスト削減効果を外部証明できない');
}

if (isEntry(import.meta.url)) { try { cli(); } catch (error) { console.error(`マキモノ効果集計エラー: ${error.message}`); } }
