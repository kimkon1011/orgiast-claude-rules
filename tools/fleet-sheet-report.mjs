#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './env-kv.mjs';
import { scanBrowserExtensions } from './browser-extension-audit.mjs';

const dryRun = process.argv.includes('--dry-run');
const home = process.env.ORGIAST_HOME || os.homedir();
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readEnv(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function cheapAiCounts(file) {
  const counts = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return counts; }
  for (const line of text.split(/\r?\n/)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const provider = String(row.provider ?? row.tool ?? '').trim().toLowerCase();
    if (provider) counts[provider] = (counts[provider] || 0) + 1;
  }
  return counts;
}

// G列は「最終報告(JST)」。UTC の ISO 文字列をそのまま入れると列の意味と食い違うため JST に整形する。
function toJst(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${p2(jst.getUTCMonth() + 1)}-${p2(jst.getUTCDate())} ${p2(jst.getUTCHours())}:${p2(jst.getUTCMinutes())}`;
}

async function main() {
  const claudeDir = path.join(home, '.claude');
  const fleetEnv = readEnv(path.join(claudeDir, 'fleet-sheet.env'));
  if (!fleetEnv.FLEET_SHEET_URL || !fleetEnv.FLEET_SHEET_TOKEN) {
    console.error('fleet-sheet: FLEET_SHEET_URL/TOKEN 未設定のため送信しません(~/.claude/fleet-sheet.env)');
    return;
  }
  const reporterEnv = readEnv(path.join(claudeDir, 'cost-reporter.env'));

  const cost = readJson(path.join(claudeDir, 'cost-loop-state.json'));
  const enforce = readJson(path.join(claudeDir, 'cost-enforce.json'));
  const adoption = readJson(path.join(claudeDir, '.tool-adoption-state.json'));
  const reporter = readJson(path.join(claudeDir, '.cost-reporter-state.json'));
  const map = readJson(path.join(repo, 'fleet-pc-map.json'));
  const label = reporterEnv.REPORTER_LABEL || (process.platform === 'win32' ? process.env.COMPUTERNAME : os.hostname()) || 'unknown';
  const counts = cheapAiCounts(path.join(claudeDir, 'executor-usage.jsonl'));
  const mappedName = Object.prototype.hasOwnProperty.call(map, label) && typeof map[label] === 'string' ? map[label] : null;
  const topModel = Array.isArray(reporter.topModels) && reporter.topModels[0] ? reporter.topModels[0].model : '';
  // Fable5(§1.16 全用途禁止)は「データが無い」を「未検出」と断定しない。
  // 判定できないのに合格扱いにするのは「timeout を未導入と誤報告」と同じ誤り。
  const fableKnown = reporter.fable5Detected !== undefined || adoption.fable5OutTok !== undefined;
  const fableDetected = Boolean(reporter.fable5Detected || Number(adoption.fable5OutTok || 0) > 0);
  const payload = {
    token: fleetEnv.FLEET_SHEET_TOKEN,
    label,
    mappedName,
    hostname: os.hostname(),
    reportedAt: toJst(cost.t || adoption.last || reporter.lastRun),
    claudeUsd: Math.round((Number.isFinite(Number(cost.claudeUSD)) ? Number(cost.claudeUSD) : Number(reporter.mtdUsd || 0)) * 100) / 100,
    mainModel: topModel,
    // 既存行が "0%" 表記なので、人が読む列で表記が混ざらないようパーセント文字列にする。
    delegRatio: `${(Math.round((Number.isFinite(Number(cost.delegRatio)) ? Number(cost.delegRatio) : Number(enforce.delegRatio || 0)) * 1000) / 10).toFixed(1)}%`,
    cheapAiUse: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([provider, count]) => `${provider}:${count}`).join(', ') || 'なし',
    codexLogin: adoption.codexAuthed === true ? '済' : adoption.codexAuthed === false ? '未' : '判定不能',
    fable5: fableDetected ? '検出' : fableKnown ? '未検出' : '判定不能',
    disciplineAlert: enforce.mode ? `${enforce.mode}${enforce.reason ? ': ' + enforce.reason : ''}` : '判定不能',
  };
  const audit = scanBrowserExtensions();
  const extensionPayload = {
    token: fleetEnv.FLEET_SHEET_TOKEN, kind: 'extensions', label, hostname: os.hostname(), reportedAt: payload.reportedAt,
    rows: audit.rows.filter((row) => !(row.risk === 'low' && row.builtin)).map(({ browser, profile, account, name, id, version, enabled, risk, builtin, broadHost, keyPerms }) => ({ browser, profile, account, name, id, version, enabled, risk, builtin, broadHost, keyPerms })),
  };
  if (dryRun) {
    // 秘匿値は出さない(状態だけ見せる)。ログ・CI・端末履歴に残るため。
    const shown = payload.token ? "<設定あり:" + payload.token.length + "文字>" : "<未設定>";
    console.log(JSON.stringify({ ...payload, token: shown, extensionAudit: { ...extensionPayload, token: shown } }, null, 2));
    return;
  }
  await fetch(fleetEnv.FLEET_SHEET_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000), redirect: 'follow',
  });
  await fetch(fleetEnv.FLEET_SHEET_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(extensionPayload), signal: AbortSignal.timeout(20_000), redirect: 'follow',
  });
}

main().catch(() => {});
