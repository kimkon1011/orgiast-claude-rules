#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchMessages } from './discord-digest.mjs';
import { auditFleet, extractIdentity, maskEmailAddress } from './fleet-discord-audit.mjs';
import { fetchFleetSheetRows } from './fleet-triage-report.mjs';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 86_400_000;
const DEFAULT_CHANNEL_ID = '1508437329247862794';
export const TOOL_INTRODUCED = '2026-08-20';

export function toSheetState(state) {
  const states = { alive: '生存', 'discord-mute': 'Discord不通', broken: '停止', never: '報告実績なし', 'legacy-manual': '手入力のみ', uncertain: '要確認' };
  if (!Object.hasOwn(states, state)) throw new TypeError(`unknown liveness state: ${state}`);
  return states[state];
}

export async function loadPcMap(repoRoot, readFile = fs.promises.readFile) {
  try {
    const value = JSON.parse(await readFile(path.join(repoRoot, 'fleet-pc-map.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([name]) => !name.startsWith('_')))
      : {};
  } catch { return {}; }
}

function parseEnv(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) return null;
      return [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')];
    }).filter(Boolean));
  } catch { return {}; }
}

function timeOf(value) {
  const text = String(value ?? '').trim();
  const jst = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(text);
  const time = jst
    ? Date.UTC(+jst[1], +jst[2] - 1, +jst[3], +(jst[4] || 0) - 9, +(jst[5] || 0))
    : Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

function clean(value) { return String(value ?? '').trim(); }
function key(value) { return clean(value).toLocaleLowerCase('ja'); }
function lastDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

function discordObservations(discord) {
  if (!discord) return [];
  if (Array.isArray(discord)) return discord.map((message) => {
    const identity = extractIdentity(message?.content, { maskEmail: true });
    return { label: identity.label, hostname: identity.hostname, names: [identity.label, identity.hostname].filter(Boolean), at: timeOf(message?.timestamp) };
  });
  const rows = [];
  for (const [name, stat] of Object.entries(discord.labels || {})) rows.push({ label: name, hostname: discord.labelToHostnames?.[name]?.[0], names: [name, ...(discord.labelToHostnames?.[name] || [])], at: timeOf(stat.last) });
  for (const [name, stat] of Object.entries(discord.hostnames || {})) rows.push({ label: discord.hostnameToLabels?.[name]?.[0], hostname: name, names: [name, ...(discord.hostnameToLabels?.[name] || [])], at: timeOf(stat.last) });
  return rows;
}

export function classifyFleet({ discord, sheet, pcMap = {}, now = new Date(), errors = {} }) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date');
  const unavailable = discord == null && sheet == null;
  const warnings = [];
  if (discord == null) warnings.push(`⚠️ Discord の取得に失敗（${errors.discord || '理由不明'}）。シート側のみで判定しています`);
  if (sheet == null) warnings.push(`⚠️ シートの取得に失敗（${errors.sheet || '理由不明'}）。Discord 側のみで判定しています`);
  const emptyCounts = { alive: 0, 'discord-mute': 0, broken: 0, never: 0, 'legacy-manual': 0, uncertain: 0 };
  if (unavailable) return { items: [], counts: emptyCounts, warnings, unavailable: true };

  const groups = [];
  const byName = new Map();
  const mappedNames = new Map();
  for (const [discordLabel, mapped] of Object.entries(pcMap || {})) {
    if (discordLabel.startsWith('_') || !mapped || typeof mapped !== 'object') continue;
    // aliases は「同じPCを指す別表記のシート行/ラベル」。実データでは1台が
    // 手入力行と機械書き込み行に分かれて存在するため、1つの sheetName では足りない。
    const names = [discordLabel, mapped.sheetName, mapped.hostname, ...(Array.isArray(mapped.aliases) ? mapped.aliases : [])].filter(Boolean);
    for (const name of names) mappedNames.set(key(name), names);
  }
  const obtain = (names) => {
    const expandedNames = [...new Set(names.flatMap((name) => mappedNames.get(key(name)) || [name]))];
    const found = expandedNames.map((name) => byName.get(key(name))).find(Boolean);
    const group = found || { names: new Set(), discordAt: null, sheetAt: null, sheetDate: null, discordLabel: null, sheetName: null, hostname: null, uncertainReason: null, explicitlyMapped: false };
    for (const name of expandedNames.filter(Boolean)) { group.names.add(clean(name)); byName.set(key(name), group); }
    if (!groups.includes(group)) groups.push(group);
    return group;
  };
  for (const observation of discordObservations(discord)) {
    const group = obtain(observation.names);
    group.discordLabel ||= clean(observation.label) || null;
    group.hostname ||= clean(observation.hostname) || null;
    if (observation.at != null && (group.discordAt == null || observation.at > group.discordAt)) group.discordAt = observation.at;
  }
  const mappedBySheet = new Map();
  for (const [discordLabel, mapped] of Object.entries(pcMap || {})) {
    if (!mapped || typeof mapped !== 'object') continue;
    const group = byName.get(key(discordLabel)) || obtain([discordLabel, mapped.hostname]);
    group.discordLabel ||= clean(discordLabel);
    group.sheetName ||= clean(mapped.sheetName) || null;
    group.hostname ||= clean(mapped.hostname) || null;
    group.explicitlyMapped = true;
    for (const alias of [mapped.sheetName, ...(Array.isArray(mapped.aliases) ? mapped.aliases : [])].filter(Boolean)) {
      mappedBySheet.set(key(alias), group);
    }
  }
  for (const row of Array.isArray(sheet) ? sheet : []) {
    const sheetName = clean(row?.pcName || row?.label);
    const hostname = clean(row?.hostname);
    let group = mappedBySheet.get(key(sheetName)) || byName.get(key(sheetName));
    if (!group && hostname) {
      const discordGroup = byName.get(key(hostname));
      if (discordGroup?.discordLabel) {
        group = obtain([sheetName]);
        group.uncertainReason = `シートの ${sheetName} 行に hostname ${hostname} が入っているが、これは ${discordGroup.discordLabel} の hostname。どちらの行が実機か kim の判断が必要`;
      }
    }
    group ||= obtain([sheetName]);
    group.sheetName ||= sheetName || null;
    if (!group.uncertainReason && hostname) { group.names.add(hostname); byName.set(key(hostname), group); group.hostname ||= hostname; }
    const at = timeOf(row?.reportedAt);
    if (at != null && (group.sheetAt == null || at > group.sheetAt)) {
      group.sheetAt = at;
      group.sheetDate = clean(row?.reportedAt).slice(0, 10);
    }
  }

  const items = groups.map((group) => {
    const discordAge = group.discordAt == null ? Infinity : nowMs - group.discordAt;
    const sheetAge = group.sheetAt == null ? Infinity : nowMs - group.sheetAt;
    const latest = Math.max(group.discordAt ?? -Infinity, group.sheetAt ?? -Infinity);
    // シート表記と Discord ラベルが同じときに「kim-PC（kim-PC）」と二重に出さない
    const bothNames = group.explicitlyMapped && group.sheetName && group.discordLabel && group.sheetName !== group.discordLabel;
    const name = bothNames ? `${group.sheetName}（${group.discordLabel}）` : group.sheetName || group.discordLabel || [...group.names][0] || '(名称未設定)';
    if (group.uncertainReason) return { name, state: 'uncertain', reason: group.uncertainReason, lastReportedAt: group.sheetAt == null ? null : new Date(group.sheetAt).toISOString() };
    if (Math.min(discordAge, sheetAge) <= DAY_MS) {
      const routes = [discordAge <= DAY_MS && 'Discord', sheetAge <= DAY_MS && 'シート'].filter(Boolean).join('/');
      return { name, state: 'alive', reason: `24h以内に報告あり（${routes}）`, lastReportedAt: new Date(latest).toISOString() };
    }
    if (sheetAge > DAY_MS && sheetAge <= 3 * DAY_MS && discordAge > 3 * DAY_MS) {
      return { name, state: 'discord-mute', reason: 'シートには届いている。Discord webhook が死んでいる疑い（2026-08-19 の削除が原因）', lastReportedAt: new Date(latest).toISOString() };
    }
    if (group.discordAt == null && group.sheetAt != null && (group.sheetDate || lastDate(group.sheetAt)) < TOOL_INTRODUCED) {
      return { name, state: 'legacy-manual', reason: 'ツール導入(2026-08-20)より前の日付＝手入力データ。機械の報告実績ではない', lastReportedAt: new Date(group.sheetAt).toISOString() };
    }
    if (latest !== -Infinity) return { name, state: 'broken', reason: `${lastDate(latest)} に停止。以後の報告なし`, lastReportedAt: new Date(latest).toISOString() };
    return { name, state: 'never', reason: '報告実績なし（未導入 / 電源が入っていない のどちらか。区別不能）', lastReportedAt: null };
  });
  const counts = { ...emptyCounts };
  for (const item of items) counts[item.state]++;
  return { items, counts, warnings, unavailable: false };
}

export function formatLiveness(result) {
  const headings = { alive: '✅ 生存', 'discord-mute': '📡 Discordにだけ届かない', broken: '🚨 壊れて停止', never: '◻️ 報告実績なし（未導入/電源off）', 'legacy-manual': '📝 手入力データのみ（機械の報告実績なし）', uncertain: '❓ ラベル対応が未確定（kim の判断待ち）' };
  const lines = ['# フリート生存判定', ...result.warnings];
  for (const [state, heading] of Object.entries(headings)) {
    lines.push('', `## ${heading} (${result.counts[state]}台)`);
    const items = result.items.filter((item) => item.state === state);
    lines.push(...(items.length ? items.map((item) => `- ${maskEmailAddress(item.name)} — ${item.reason}`) : ['- なし']));
  }
  lines.push('', '## 次にやること');
  if (result.counts['discord-mute'] || result.counts.broken) lines.push('壊れて停止 / Discord不通: 該当PCで Claude Code を開けば keyserve が新しい webhook を配る（.ps1 のままのPCは2セッション必要）');
  if (result.counts.never) lines.push('報告実績なし: 対処不要。導入状況は人が確認する');
  if (result.counts['legacy-manual']) lines.push('手入力データのみ: 対処不要');
  if (result.counts.uncertain) lines.push('ラベル対応未確定: kim の判断待ち');
  if (!result.counts['discord-mute'] && !result.counts.broken && !result.counts.never && !result.counts['legacy-manual'] && !result.counts.uncertain) lines.push('対処不要');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), now = new Date()) {
  const allowed = new Set(['--json', '--post', '--post-sheet']);
  const invalid = argv.find((arg) => !allowed.has(arg));
  if (invalid) { console.error(`不正な引数: ${invalid}`); return 2; }
  const home = os.homedir();
  const claude = path.join(home, '.claude');
  const fleetEnv = { ...parseEnv(path.join(claude, 'fleet-sheet.env')), ...process.env };
  const costEnv = { ...parseEnv(path.join(claude, 'cost-reporter.env')), ...process.env };
  let discord = null, sheet = null;
  const errors = {};
  try {
    const token = process.env.DISCORD_BOT_TOKEN?.trim() || fs.readFileSync(path.join(claude, 'orgiast-discord-bot-token.txt'), 'utf8').trim();
    const channelId = (() => { try { return fs.readFileSync(path.join(claude, 'orgiast-discord-channel-id.txt'), 'utf8').trim(); } catch { return DEFAULT_CHANNEL_ID; } })();
    const { messages } = await fetchMessages({ channelId, limit: 1000, since: now.getTime() - 30 * DAY_MS, token });
    discord = auditFleet(messages, now);
  } catch (error) { errors.discord = error.message; }
  try { sheet = await fetchFleetSheetRows({ sheetUrl: fleetEnv.FLEET_SHEET_URL, token: fleetEnv.FLEET_SHEET_TOKEN }); }
  catch (error) { errors.sheet = error.message; }
  // Windows では new URL(import.meta.url).pathname が "/C:/..." になりファイルパスとして使えない
  // （path.resolve が "C:\C:\..." を作り fleet-pc-map.json が読めず、統合が黙って効かなくなる）。
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const pcMap = await loadPcMap(repoRoot);
  const result = classifyFleet({ discord, sheet, pcMap, now, errors });
  const output = argv.includes('--json') ? JSON.stringify(result, null, 2) : formatLiveness(result);
  process.stdout.write(`${output}\n`);
  if (argv.includes('--post')) {
    const webhook = costEnv.DISCORD_COST_WEBHOOK;
    if (!webhook) { console.error('DISCORD_COST_WEBHOOK が未設定です'); return 1; }
    const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'orgiast-fleet-liveness/1.0' }, body: JSON.stringify({ content: output }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { console.error(`Discord送信が HTTP ${response.status}`); return 1; }
  }
  if (argv.includes('--post-sheet')) {
    if (!fleetEnv.FLEET_SHEET_URL || !fleetEnv.FLEET_SHEET_TOKEN) { console.error('FLEET_SHEET_URL/TOKEN が未設定です'); return 1; }
    const candidates = Object.entries(pcMap).map(([label, mapped]) => [label, mapped.sheetName, mapped.hostname, ...(Array.isArray(mapped.aliases) ? mapped.aliases : [])].filter(Boolean));
    const items = result.items.map((item) => {
      const mapped = candidates.find((names) => names.some((name) => item.name === name || item.name.includes(`（${name}）`)));
      return { names: [...new Set(mapped || [item.name])], state: toSheetState(item.state), reason: item.reason };
    });
    const checkedAt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const response = await fetch(fleetEnv.FLEET_SHEET_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'orgiast-fleet-liveness/1.0' }, body: JSON.stringify({ token: fleetEnv.FLEET_SHEET_TOKEN, kind: 'liveness', checkedAt, items }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { console.error(`シート送信が HTTP ${response.status}`); return 1; }
    const body = await response.json();
    if (!body.ok) { console.error(`シート書き込み失敗: ${body.error || 'unknown'}`); return 1; }
    // 成功時も必ず結果を出す。黙って成功すると「届いていない」ことに誰も気付けない。
    // written は書き込んだ列見出し＝許可リストが守られたことをシートを読まずに検証できる。
    console.log(`\nシート書き込み: ${body.updated ?? 0}行を更新 / 列: ${(body.written || []).join(', ') || '(なし)'}`);
    if (body.unmatched?.length) console.log(`シート未突合(行は作っていません): ${body.unmatched.join(', ')}`);
  }
  return result.unavailable ? 1 : 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
