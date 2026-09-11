#!/usr/bin/env node
// 委譲台帳の症状を実測と照合し、即時修復と次回 auto-session への根本修正起票を行う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const DAY = 86_400_000;
const CLAUDE_FALLBACK_RULE = '従量課金AIはオートチャージON＋Claude側監視が全社ルール（2026-09-09）';

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
}

function measured(value) {
  if (typeof value === 'number') return { usedPercent: value, windowMinutes: null, resetsAt: null };
  if (!value || !Number.isFinite(Number(value.usedPercent))) return null;
  return { usedPercent: Number(value.usedPercent), windowMinutes: Number.isFinite(Number(value.windowMinutes)) ? Number(value.windowMinutes) : null, resetsAt: Number.isFinite(Number(value.resetsAt)) ? Number(value.resetsAt) : null };
}

export function parseRateLimitsFromText(text) {
  let last = null;
  const source = String(text ?? '').replace(/\\"/g, '"');
  const anchors = [...source.matchAll(/"primary"\s*:\s*\{/g)];
  for (const anchor of anchors) {
    const fragment = source.slice(anchor.index, anchor.index + 1200);
    const used = fragment.match(/"used_percent"\s*:\s*(\d+(?:\.\d+)?)/);
    if (!used) continue;
    const window = fragment.match(/"window_minutes"\s*:\s*(\d+(?:\.\d+)?)/);
    const reset = fragment.match(/"resets_at"\s*:\s*(\d+(?:\.\d+)?)/);
    last = { usedPercent: Number(used[1]), windowMinutes: window ? Number(window[1]) : null, resetsAt: reset ? Number(reset[1]) : null };
  }
  return last;
}

export function readCodexUsedPercent(options = {}) {
  const spawnImpl = options.spawnImpl || spawnSync;
  // 単体テストでは OS に依存せず、注入した偽 spawn の出力を検証できるようにする。
  if (!options.spawnImpl && process.platform !== 'win32' && !process.env.WSL_DISTRO_NAME) return null;
  try {
    // ログ1本が数MBあるので全文 cat せず primary ブロックだけ抜く(ENOBUFS 再発防止)。新しいファイルほど後ろに並べ、最後の行を最新値にする。
    const script = `find ~/.codex/sessions -type f -name "*.jsonl" -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -n 3 | sort -n | cut -d" " -f2- | xargs -r grep -ho "\\"primary\\":{[^}]*}" 2>/dev/null | tail -n 40`;
    const result = spawnImpl('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', script], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
    if (result?.error || (result?.status != null && result.status !== 0)) return null;
    return parseRateLimitsFromText(result.stdout);
  } catch { return null; }
}

function reasonTop(rows) {
  const counts = new Map();
  for (const row of rows) { const reason = String(row.reason || '理由不明'); counts.set(reason, (counts.get(reason) || 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).slice(0, 3).map(([reason, count]) => `${reason}(${count}件)`);
}

export function collectFindings({ home, now = new Date(), codexUsedPercent = null }) {
  const current = now instanceof Date ? now : new Date(now);
  const nowMs = current.getTime(), cutoff = nowMs - DAY;
  const claudeDir = path.join(home, '.claude');
  const recent = (rows) => rows.filter((row) => { const t = Date.parse(row.t || ''); return Number.isFinite(t) && t >= cutoff && t <= nowMs; });
  const limitRows = recent(readJsonl(path.join(claudeDir, 'codex-limit-history.jsonl'))).filter((row) => String(row.reason || '').includes('usage_limit'));
  const usageRows = recent(readJsonl(path.join(claudeDir, 'executor-usage.jsonl')));
  const cooldown = readJson(path.join(claudeDir, 'provider-cooldown.json'), {});
  const metric = measured(codexUsedPercent);
  const findings = [];
  if (limitRows.length && metric && metric.usedPercent < 90) findings.push({
    id: 'codex_false_usage_limit', severity: 'high', title: 'Codex 上限検出の偽陽性',
    evidence: [`usage_limit記録 ${limitRows.length}件`, `実測 used_percent ${metric.usedPercent}`, `window ${metric.windowMinutes ?? '不明'}分`, `resets_at ${metric.resetsAt ?? '不明'}`],
    autoHealed: Number(cooldown.codex?.until) > nowMs ? 'codex cooldown を解除' : undefined,
    fixTask: 'codex-do.mjs の上限検出が偽陽性。検出ロジック(detectQuotaLimit)と直近の codex 出力を照合し、誤検出パターンを特定して修正、テスト追加',
  });
  for (const [provider, state] of Object.entries(cooldown)) if (Number(state?.until) > nowMs + 7 * DAY) findings.push({
    id: 'cooldown_too_far', severity: 'high', title: `${provider} の cooldown が7日超`, evidence: [`provider ${provider}`, `until ${state.until}`, `reason ${state.reason || '不明'}`], autoHealed: `${provider} cooldown を解除`,
    fixTask: 'codex-cooldown.mjs の再開時刻パースが暴走した本文を特定して修正', provider,
  });
  const claudeFallback = usageRows.filter((row) => row.provider === 'claude-fallback');
  if (claudeFallback.length) { const top = reasonTop(claudeFallback); findings.push({ id: 'unattended_claude_fallback', severity: 'high', title: '無人ジョブが Claude へフォールバック', evidence: [`${claudeFallback.length}件`, ...top], fixTask: `無人ジョブが Claude に落ちた理由(${top.join(', ')})を潰す。cheap-code 側の失敗原因を修正し、Claude フォールバックが opt-in のままであることを確認` }); }
  const lowYield = usageRows.filter((row) => row.provider === 'fallback' && Number(row.secs) > 900 && Number(row.out) < 300);
  if (lowYield.length >= 2) { const models = [...new Set(lowYield.map((row) => row.model || '不明'))].join(', '); findings.push({ id: 'fallback_low_yield', severity: 'medium', title: 'フォールバックの低成果', evidence: [`${lowYield.length}件`, `model ${models}`], fixTask: `フォールバック先(${models})が長時間走って成果が無い。codex-fallback-order.json の順序と各バックエンドの実効性を見直す` }); }
  // 「起動できない機体」と「起動したのに空」を分ける。前者は直せる不具合ではないので
  // fixTask を持たせない(持たせると毎日 next-session.md に同じ宿題が再起票される。2026-09-10 実測)。
  const codexRows = usageRows.filter((row) => row.provider === 'codex' && Number(row.out) === 0);
  const unusable = codexRows.filter((row) => row.status === 'native-windows-unusable');
  const empty = codexRows.filter((row) => row.status !== 'native-windows-unusable');
  if (unusable.length) findings.push({ id: 'codex_unavailable_on_host', severity: 'low', title: 'Codex はこの機体で起動できない（既知・cheap-code へ回す）', evidence: [`${unusable.length}件`, 'WSL 無し＋ネイティブ版は read-only 固定'] });
  if (empty.length) findings.push({ id: 'codex_empty_output', severity: 'medium', title: 'Codex の出力ゼロ', evidence: [`${empty.length}件`], fixTask: 'codex が出力ゼロで終了した原因（認証切れ/上限/起動失敗）を codex-do のログから特定' });
  for (const [provider, state] of Object.entries(cooldown)) if (state?.reason === 'http_402' && Number(state.until) > nowMs) findings.push({ id: 'provider_balance_exhausted', severity: 'low', title: `${provider} の残高切れ`, evidence: [`provider ${provider}`, CLAUDE_FALLBACK_RULE] });
  return findings.length ? findings : [{ id: 'healthy', severity: 'low', title: '委譲経路は正常', evidence: [] }];
}

export function applyAutoHeal({ home, findings, now = new Date() }) {
  const file = path.join(home, '.claude', 'provider-cooldown.json');
  const cooldown = readJson(file, {}), nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  let changed = false;
  if (findings.some((item) => item.id === 'codex_false_usage_limit') && Number(cooldown.codex?.until) > nowMs) { delete cooldown.codex; changed = true; }
  for (const item of findings.filter((entry) => entry.id === 'cooldown_too_far')) if (item.provider in cooldown) { delete cooldown[item.provider]; changed = true; }
  if (changed) fs.writeFileSync(file, `${JSON.stringify(cooldown, null, 2)}\n`);
  return changed;
}

function dateAgeDays(date, today) { const then = Date.parse(`${date}T00:00:00Z`), current = Date.parse(`${today}T00:00:00Z`); return Number.isFinite(then) ? Math.floor((current - then) / DAY) : Infinity; }

export function upsertFixTasks({ home, findings, now = new Date(), todayStr }) {
  const file = path.join(home, '.claude', 'next-session.md');
  let md; try { md = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const today = todayStr || (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const firstMarker = md.indexOf('<!-- NEXT-SESSION v1 -->'), secondMarker = firstMarker < 0 ? -1 : md.indexOf('<!-- NEXT-SESSION v1 -->', firstMarker + 1);
  const start = firstMarker < 0 ? 0 : firstMarker, end = secondMarker < 0 ? md.length : secondMarker;
  let block = md.slice(start, end), changed = false;
  const tasks = findings.filter((item) => ['high', 'medium'].includes(item.severity) && item.fixTask);
  for (const finding of tasks.reverse()) {
    const marker = `[delegation-health:${finding.id}]`, escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = new RegExp(`^\\s*\\d+[.)、]\\s+.*${escaped}.*$`, 'm').exec(block);
    if (existing) { const date = existing[0].match(/\(起票 (\d{4}-\d{2}-\d{2})\)/)?.[1]; if (date && dateAgeDays(date, today) < 3) continue; block = block.slice(0, existing.index) + block.slice(existing.index + existing[0].length).replace(/^\r?\n/, ''); }
    const heading = /^##[ \t]+残TODO.*$/m.exec(block); if (!heading) continue;
    const evidence = finding.evidence.join('/').slice(0, 200);
    const line = `0. ${marker} ${finding.fixTask} — 証拠: ${evidence} — 完了条件: 該当テストを追加して node --test が緑、翌日の delegation-health.json に同 id が出ないこと (起票 ${today})`;
    const insertAt = heading.index + heading[0].length;
    block = `${block.slice(0, insertAt)}\n${line}${block.slice(insertAt)}`; changed = true;
  }
  if (!changed) return false;
  let inTodos = false;
  block = block.split(/\r?\n/).map((line) => { if (/^##[ \t]+残TODO/.test(line)) { inTodos = true; return line; } if (inTodos && /^##[ \t]+/.test(line)) inTodos = false; return line; }).join('\n');
  let n = 0; inTodos = false;
  block = block.split('\n').map((line) => { if (/^##[ \t]+残TODO/.test(line)) { inTodos = true; return line; } if (inTodos && /^##[ \t]+/.test(line)) inTodos = false; return inTodos && /^\s*\d+[.)、]\s+/.test(line) ? line.replace(/^\s*\d+[.)、]/, `${++n}.`) : line; }).join('\n');
  fs.writeFileSync(file, md.slice(0, start) + block + md.slice(end));
  return true;
}

export function renderSummary(report) {
  const lines = ['## 🩺 委譲ヘルス（直近24h）'];
  for (const item of report.findings) lines.push(`- ${item.severity} / ${item.title} / 自動修復:${item.autoHealed ? 'あり' : 'なし'} / 起票先:${item.fixTask && ['high', 'medium'].includes(item.severity) ? '~/.claude/next-session.md' : 'なし'}`);
  if (lines.length < 5) lines.push(`- Codex実測: ${report.codexUsedPercent === null ? '計測不能' : `${report.codexUsedPercent}%`}`, `- 生成日時: ${report.generatedAt}`, '- high があっても夜間処理は継続');
  return `${lines.slice(0, 15).join('\n')}\n`;
}

function parseArgs(argv) { const args = { dryRun: false, home: os.homedir(), now: new Date() }; for (let i = 0; i < argv.length; i++) { if (argv[i] === '--dry-run') args.dryRun = true; else if (argv[i] === '--home') args.home = argv[++i]; else if (argv[i] === '--now') args.now = new Date(argv[++i]); else throw new Error(`不明な引数: ${argv[i]}`); } if (!Number.isFinite(args.now.getTime())) throw new Error('--now は有効な ISO 日時を指定してください'); return args; }

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), metric = readCodexUsedPercent({});
  const findings = collectFindings({ home: args.home, now: args.now, codexUsedPercent: metric });
  if (!args.dryRun) { fs.mkdirSync(path.join(args.home, '.claude'), { recursive: true }); applyAutoHeal({ home: args.home, findings, now: args.now }); upsertFixTasks({ home: args.home, findings, now: args.now }); }
  const report = { generatedAt: args.now.toISOString(), codexUsedPercent: measured(metric)?.usedPercent ?? null, findings };
  const summary = renderSummary(report);
  if (!args.dryRun) { fs.writeFileSync(path.join(args.home, '.claude', 'delegation-health.json'), `${JSON.stringify(report, null, 2)}\n`); fs.writeFileSync(path.join(args.home, '.claude', 'delegation-health.md'), summary); }
  process.stdout.write(summary);
}

if (isEntry(import.meta.url)) main();
