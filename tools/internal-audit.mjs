#!/usr/bin/env node
// Read-only audit; --notify permits our report upload and a DM to kim.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { notifyKim } from './notify-kim.mjs';
import { ROOT, DAY, dateOnly, USERS, UNAVAILABLE_USERS, SEVERITIES, cell, parseEnv, safeText, maskNumbers, readJson, writePrivate, scrub, reason, auditError, runProcess } from './lib/internal-audit/common.mjs';
import { collectFreee, getReadOnlyToken } from './lib/internal-audit/collect-freee.mjs';
import { runPaymentRules } from './lib/internal-audit/rules-payments.mjs';
import { createGoogle, createGmailSource, createDriveSource, createDiscord, buildFootprint, cachedStaff, normalizeSavedFootprint } from './lib/internal-audit/footprint.mjs';
import { scanDrive, scanAdmin } from './lib/internal-audit/exfil.mjs';
import { searchLeaks, webSearch, askJson, safeUrl } from './lib/internal-audit/leak-search.mjs';
import { refreshPatterns } from './lib/internal-audit/patterns-refresh.mjs';
import { acquireLock } from './lib/internal-audit/lock.mjs';
import { replaySharing } from './lib/internal-audit/sharing-baseline.mjs';
import { reportLocation } from './lib/internal-audit/report-notify.mjs';
export function parseArgs(argv) {
  const out = { 'window-days': 180, 'drive-budget-seconds': 600, 'min-severity': 'info', 'state-dir': path.join(os.homedir(), '.claude', 'internal-audit'), skip: [] }, seen = new Set();
  const flags = ['notify', 'fail-on-high'], values = ['drive-budget-seconds', 'window-days', 'json', 'snapshot', 'out', 'skip', 'min-severity', 'state-dir'];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || ![...flags, ...values].includes(key) || seen.has(key)) throw auditError('CLI 引数の重複または不正値');
    seen.add(key);
    if (flags.includes(key)) out[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw auditError('CLI 引数の値がありません'); out[key] = argv[++i]; }
  }
  if (!/^\d+$/.test(String(out['window-days'])) || +out['window-days'] < 1 || +out['window-days'] > 3650) throw auditError('--window-days は1〜3650の整数');
  out['window-days'] = +out['window-days'];
  if (!/^\d+$/.test(String(out['drive-budget-seconds'])) || +out['drive-budget-seconds'] < 1 || +out['drive-budget-seconds'] > 1680) throw auditError('--drive-budget-seconds は1〜1680の整数');
  out['drive-budget-seconds'] = +out['drive-budget-seconds'];
  if (!SEVERITIES.includes(out['min-severity'])) throw auditError('--min-severity はhigh|medium|info');
  if (typeof out.skip === 'string') out.skip = out.skip.split(',');
  if (out.skip.some(s => !['gmail','drive','discord','admin','web','patterns'].includes(s)) || new Set(out.skip).size !== out.skip.length) throw auditError('--skip が不正（freee は除外できません）');
  if (out.snapshot && out.json) throw auditError('--snapshot と --json は併用できません');
  if (out.snapshot && seen.has('window-days')) throw auditError('snapshot の対象期間を使用するため --window-days は併用不可');
  return out;
}
export function validateSnapshot(s) {
  if (s?.version !== 1 || !s.window || !/^\d{4}-\d{2}-\d{2}$/.test(s.window.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.window.end || '') || s.window.start > s.window.end || !['partners','deals','payments','wallet_txns','walletables','account_items'].every(k => Array.isArray(s[k]))) throw auditError('snapshot 形式が不正');
  return scrub(s);
}
export function validatePatterns(p) {
  const numeric = ['new_partner_days','new_partner_amount','no_footprint_high','round_unit','round_min','approval_lower_ratio','repeat_count','duplicate_days','split_days','name_mismatch_amount','unregistered_days','unregistered_min','ignored_min','benford_min_count','benford_chi_square','spike_months','spike_ratio','spike_min','download_day','download_week'];
  if (p?.version !== 1 || !p.thresholds || numeric.some(k => !Number.isFinite(p.thresholds[k]) || p.thresholds[k] <= 0) || p.thresholds.approval_lower_ratio >= 1 ||
      !Array.isArray(p.thresholds.approval) || !p.thresholds.approval.length || p.thresholds.approval.some((v,i,a) => !Number.isFinite(v) || v <= 0 || i > 0 && v <= a[i-1]) ||
      !Array.isArray(p.thresholds.free_mail_domains) || !Array.isArray(p.holidays_jp) || !Array.isArray(p.patterns) || !Array.isArray(p.allowlist_partners || []) || ['payment_agents', 'generic_partner_names'].some(k => !Array.isArray(p[k]) || p[k].some(v => typeof v !== 'string' || !v.trim()))) throw auditError('patterns.json のしきい値・構造が不正');
  return p;
}
export function findingCounts(findings) { return Object.fromEntries(SEVERITIES.map(s => [s, findings.filter(f => f.severity === s).length])); }
function link(label, url) { return safeUrl(url) ? `[${cell(label).replace(/[\[\]]/g, '')}](<${url.replace(/[<>\r\n]/g, '')}>)` : cell(label); }
export function renderReport({ snapshot, findings, unverified = [], sources, candidates = [], patterns, minSeverity = 'info', secrets = [], replay = false, findingsFile = 'findings.jsonl' }) {
  const counts = findingCounts(findings), at = snapshot.fetchedAt, payments = snapshot.payments.filter(p => p.date >= snapshot.window.start && p.date <= snapshot.window.end);
  const lines = ['# 社内不正・リスク監査レポート', '', '**検出結果は確認の手掛かりであり、不正を断定するものではありません。未確認のデータソースがある場合、問題がないとは判断できません。**', '',
    `対象: ${snapshot.window.start}〜${snapshot.window.end} / snapshot取得: ${at}${replay ? ' / 再評価（保存された形跡を使用）' : ''}`,
    `取引先 ${snapshot.partners.length} / 経費取引 ${snapshot.deals.length}（比較履歴を含む） / 対象期間の決済 ${payments.length} / 口座明細 ${snapshot.wallet_txns.length}`,
    `high ${counts.high} / medium ${counts.medium} / info ${counts.info}`, '', '## データソースの状態', '', '| ソース | 状態 | 件数 | 理由・範囲 |', '|---|---|---:|---|'];
  for (const [name, s] of Object.entries(sources)) lines.push(`| ${[name, ({ ok: 'OK', unverified: '未確認', failed: '失敗' })[s.status] || s.status, s.count ?? '—', s.reason || ''].map(cell).join(' | ')} |`);
  lines.push('', '## 未確認データソース', '');
  const missing = Object.entries(sources).filter(([, s]) => s.status !== 'ok');
  if (!missing.length) lines.push('なし（取得範囲内）');
  for (const [name, s] of missing) lines.push(`- ${cell(name)}: ${cell(s.reason)}`);
  lines.push('', '## 取得範囲と制約', '', ...[...(snapshot.coverage?.limitations || []), `Gmail 未照合ユーザー（既知の権限制限のため試行しない）: ${UNAVAILABLE_USERS.join(', ')}`, 'Drive は指定3ユーザーの所有ファイルのみ。初回と走査未完了ユーザーはベースライン構築中。', 'レポートはローカル保存。--notify 時のみ自社 Drive にアップロードしてDMで通知。'].map(s => `- ${cell(s)}`));
  lines.push('', '## ルール別件数', '', '| ルール | 件数 |', '|---|---:|');
  for (const rule of [...Array.from({ length: 15 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`), 'exfil', 'exfil-admin', 'leak-search']) lines.push(`| ${rule} | ${findings.filter(f => f.rule === rule).length} |`);
  for (const severity of SEVERITIES.slice(0, SEVERITIES.indexOf(minSeverity) + 1)) {
    lines.push('', `## ${severity}`, '', '| ルール | 対象 | 確認の手掛かり |', '|---|---|---|');
    const rows = findings.filter(f => f.severity === severity);
    const visible = rows.length > 200 ? rows.slice(0, 199) : rows;
    for (const f of visible) lines.push(`| ${cell(f.rule)} | ${cell(f.subject)} | ${cell(f.detail)}${f.url ? ` ${link('出典', f.url)}${f.owner ? `（**${cell(f.owner)}** で開く）` : ''}` : ''} |`);
    if (rows.length > visible.length) lines.push(`| — | 他 ${rows.length - visible.length} 件 | ${cell(findingsFile)} 参照 |`);
  }
  renderSharingBaseline(lines, snapshot.externalSharing);
  lines.push('', '## 支払先の仕事の形跡', '', '| 取引先 | Gmail | Drive | Discord |', '|---|---|---|---|');
  for (const p of snapshot.partners) {
    const fp = snapshot.footprint?.[String(p.id)]; if (!fp) continue;
    lines.push(`| ${cell(p.name)} | ${['gmail','drive','discord'].map(k => { const f = fp[k] || {}; return cell(`${f.countKind?.includes('推定') ? '未確認（旧推定値）' : `${f.count ?? '未照合'}${f.lowerBound ? '+' : ''}`}件 / ${f.status || 'unverified'} / ${f.latest || ''} / ${f.representative || ''} / ${f.reason || ''}${f.controlVerified ? '（対照確認済）' : ''}`); }).join(' | ')} |`);
  }
  lines.push('', '## 支払い判定の未照合', '', '| ルール | 対象 | 理由 |', '|---|---|---|');
  for (const r of unverified) lines.push(`| ${[r.rule, r.subject, r.detail].map(cell).join(' | ')} |`);
  lines.push('', '## 不正パターンの対応表', '', '| ID | パターン | 実装状況 |', '|---|---|---|');
  for (const p of patterns.patterns) lines.push(`| ${cell(p.id)} | ${cell(p.name)} | ${p.status === 'rule' ? `ルール化済み(${p.rules.join(', ')})` : `未ルール化（${p.data_sources.join(', ')} の確認が必要）`} |`);
  lines.push('', '## 今回の新規パターン候補', '', '| パターン | 兆候・判定案 | 実装状況 | 出典 |', '|---|---|---|---|');
  for (const p of candidates) lines.push(`| ${cell(p.name)} | ${cell(`${p.signal} / ${p.rule_sketch}`)} | ${p.rules.length ? `ルール化済み(${p.rules.join(', ')})` : '未ルール化'} | ${link('出典', p.source_url)} |`);
  return safeText(lines.join('\n') + '\n', secrets);
}
export function renderSharingBaseline(lines, baseline) {
  lines.push('', '## 外部共有の現状（ベースライン）', '', baseline?.building ? 'ベースライン構築中（ファイル単位の初回警告は省略）' : '取得済みベースライン', '');
  if (baseline?.limitation) lines.push(cell(baseline.limitation), '');
  lines.push('| 所有ユーザー | 共有種別 | ドメイン | 権限数 |', '|---|---|---|---:|');
  const summary = baseline?.summary || [], totals = new Map(), rest = new Map();
  for (const row of summary) if (row.type !== 'anyone') totals.set(row.domain, (totals.get(row.domain) || 0) + row.count);
  const top = new Set([...totals].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([domain]) => domain));
  for (const row of summary) {
    if (row.type === 'anyone' || top.has(row.domain)) lines.push(`| ${[row.owner, row.type, row.domain, row.count].map(cell).join(' | ')} |`);
    else {
      const key = JSON.stringify([row.owner, row.type]);
      const group = rest.get(key) || { domains: new Set(), count: 0 };
      group.domains.add(row.domain); group.count += row.count; rest.set(key, group);
    }
  }
  for (const [key, group] of rest) lines.push(`| ${JSON.parse(key).map(cell).join(' | ')} | 他 ${group.domains.size} ドメイン ${group.count} 件 | ${group.count} |`);
  if (!summary.length) lines.push('| — | — | 取得済み集計なし（未走査の場合は共有なしを意味しません） | — |');
}
export function notificationText(findings, reportPath, date) {
  const c = findingCounts(findings);
  return ['内部監査: 確認の手掛かりであり不正の断定ではありません。', `high ${c.high} / medium ${c.medium} / info ${c.info}`,
    ...findings.filter(f => f.severity === 'high').slice(0, 5).map(f => `- ${f.rule}: ${f.subject.slice(0, 80)} ${f.detail.slice(0, 120)}`), safeUrl(reportPath) ? `[内部監査レポート ${date}](${reportPath})（**kim@orgiast.jp** で開く）` : `内部監査レポート ${date}: ${reportPath}`].join('\n');
}
async function checkPaths(options, daily) {
  const sidecar = daily.replace(/\.md$/, '.findings.jsonl');
  const outputs = [options.out, options.json, daily, sidecar].filter(Boolean).map(p => path.resolve(p));
  const protectedPaths = [options.snapshot, path.join(ROOT, '.env.local'), path.join(ROOT, 'tools/internal-audit-patterns.json'), ...['state.json','footprint-cache.json','discord-cache.json','pattern-candidates.jsonl','run.lock'].map(n => path.join(options['state-dir'], n))].filter(Boolean).map(p => path.resolve(p));
  if ([options.out, options.json].filter(Boolean).some(p => path.resolve(p) === path.resolve(sidecar))) throw auditError('検出結果JSONLと出力先が衝突');
  const identities = new Map();
  for (const p of [...protectedPaths, ...outputs]) {
    if (/(^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.git)(?:[/\\]|$)/.test(p)) { if (outputs.includes(p)) throw auditError('資格情報・Git 管理ファイルへの出力は禁止'); }
    try { const stat = await fs.lstat(p); if (stat.isSymbolicLink()) throw auditError('入出力 symlink は使用できません'); identities.set(p, `${stat.dev}:${stat.ino}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const output of [options.out, options.json].filter(Boolean).map(p => path.resolve(p))) {
    if (identities.has(output) && identities.get(output) === identities.get(path.resolve(sidecar))) throw auditError('検出結果JSONLと出力先が衝突');
  }
  for (const output of outputs) if (protectedPaths.some(p => p === output || identities.has(p) && identities.get(p) === identities.get(output))) throw auditError('入力・状態・出力ファイルの衝突');
  if (options.json && (path.resolve(options.json) === path.resolve(daily) || identities.has(path.resolve(options.json)) && identities.get(path.resolve(options.json)) === identities.get(path.resolve(daily)))) throw auditError('JSON と日次レポートは別ファイルを指定');
  if (options.json && options.out && (path.resolve(options.json) === path.resolve(options.out) || identities.has(path.resolve(options.json)) && identities.get(path.resolve(options.json)) === identities.get(path.resolve(options.out)))) throw auditError('JSON とレポートは別ファイルを指定');
}
async function optionalText(file) { try { return await fs.readFile(file, 'utf8'); } catch { return ''; } }
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv), now = new Date(), date = dateOnly(now), stateDir = path.resolve(options['state-dir']); options['state-dir'] = stateDir;
  const daily = path.join(stateDir, 'reports', `${date}.md`);
  await checkPaths(options, daily);
  const defaultHome = process.platform === 'win32' ? os.homedir() : '/mnt/c/Users/uers';
  // The weekly task runs from ~/.claude/nightly-repo, which has no .env.local: fall back to the
  // main working tree the same way tools/lib/freee-auth.mjs does. Every value read is a secret.
  const env = parseEnv(await optionalText(path.join(ROOT, '.env.local'))), secrets = Object.values(env).filter(Boolean);
  const fallbackEnv = parseEnv(await optionalText(path.join(defaultHome, 'orgiast-main', '.env.local')));
  secrets.push(...Object.values(fallbackEnv).filter(Boolean));
  const databaseUrl = process.env.PURCHASING_APP_DATABASE_URL || env.PURCHASING_APP_DATABASE_URL || fallbackEnv.PURCHASING_APP_DATABASE_URL;
  if (databaseUrl) secrets.push(databaseUrl);
  const keyPath = process.env.GOOGLE_SA_KEY || path.join(defaultHome, 'Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json');
  const token = process.env.DISCORD_BOT_TOKEN || (await optionalText(path.join(defaultHome, '.claude/orgiast-discord-bot-token.txt'))).trim(); if (token) secrets.push(token);
  const patterns = validatePatterns(await readJson(path.join(ROOT, 'tools/internal-audit-patterns.json')));
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(stateDir);
  if (lock.recovered) console.error('internal-audit: 前回の中断を検出。古いrun.lockを回復');
  try {
    const state = await readJson(path.join(stateDir, 'state.json'), {}), sources = {}, findings = [], unverified = [];
    let snapshot, candidates = [], sharingAcknowledgedKeys = [];
    const checkpoint = async () => {
      if (options.json) await writePrivate(path.resolve(options.json), { ...snapshot, runStatus: 'incomplete', sources: { ...sources, collection: { status: 'unverified', reason: '収集中の途中snapshot（完了レポートではない）' } } }, secrets);
    };
    const deadline = Date.now() + 28 * 60 * 1000, signal = AbortSignal.timeout(28 * 60 * 1000);
    const childEnv = { ...process.env, ORGIAST_HOME: path.join(stateDir, 'executor-home') };
    for (const [key, names] of Object.entries({ GEMINI_API_KEY: ['.gemini/.env', '.claude/gemini.env'], GROQ_API_KEY: ['.claude/groq.env'], DEEPSEEK_API_KEY: ['.claude/deepseek.env'] })) {
      if (!childEnv[key]) for (const name of names) { const value = parseEnv(await optionalText(path.join(defaultHome, name)))[key]; if (value) { childEnv[key] = value; secrets.push(value); break; } }
    }
    for (const key of ['GEMINI_API_KEY','GROQ_API_KEY','DEEPSEEK_API_KEY']) if (childEnv[key]) secrets.push(childEnv[key]);
    const budgetRun = (cmd, args) => { if (Date.now() >= deadline) throw auditError('全体実行時間の上限'); return runProcess(cmd, args, { timeout: Math.min(120000, deadline - Date.now()), env: childEnv }); };
    const search = q => webSearch(q, budgetRun), ask = p => askJson(p, budgetRun, secrets);
    if (options.snapshot) {
      snapshot = validateSnapshot(await readJson(options.snapshot));
      Object.assign(sources, snapshot.sources || {});
      sources.freee = { status: snapshot.sources?.freee?.status || 'ok', count: snapshot.deals.length, reason: `snapshot 再評価（freee API不使用）。${snapshot.sources?.freee?.reason || ''}` };
      const sharing = replaySharing(snapshot);
      snapshot.externalSharing = sharing.baseline;
      normalizeSavedFootprint(snapshot, patterns, sources);
      for (const finding of sharing.findings) findings.push(finding);
    } else {
      try {
        const freeeToken = await getReadOnlyToken(databaseUrl); secrets.push(freeeToken);
        snapshot = await collectFreee({ token: freeeToken, windowDays: options['window-days'], now, signal });
        snapshot.baseline = { knownPartnerIds: state.knownPartnerIds };
        sources.freee = { status: 'ok', count: snapshot.deals.length, reason: 'GETのみ。トークン更新なし' };
        console.error(`internal-audit: freee 取引先 ${snapshot.partners.length} / 経費取引 ${snapshot.deals.length}`);
      } catch (e) {
        snapshot = { version: 1, fetchedAt: now.toISOString(), window: { start: dateOnly(+now - options['window-days'] * DAY), end: date, days: options['window-days'] }, partners: [], deals: [], payments: [], wallet_txns: [], walletables: [], account_items: [], coverage: { limitations: ['freee 未接続・取得失敗のため支払い監査は未実施'] } };
        sources.freee = { status: 'unverified', count: 0, reason: reason(e) };
      }
      await checkpoint();
      const google = createGoogle({ keyPath, signal });
      const active = new Set(snapshot.payments.filter(p => p.date >= snapshot.window.start && p.date <= snapshot.window.end).map(p => p.partner_id));
      const paidPartners = snapshot.partners.filter(p => active.has(p.id));
      console.error(`internal-audit: 形跡照合 ${paidPartners.length}取引先`);
      const discord = createDiscord({ token, stateDir, partners: paidPartners, now, signal });
      const adapters = { gmail: createGmailSource({ google, signal }), drive: createDriveSource({ google, now }), discord: discord.search };
      for (const k of options.skip) delete adapters[k];
      snapshot.footprint = await buildFootprint(paidPartners, { window: options['window-days'], sources: adapters, patterns, state: { secrets }, stateDir, now });
      for (const source of ['gmail','drive','discord']) {
        const results = Object.values(snapshot.footprint).map(f => f[source]);
        const bad = results.filter(r => r.status !== 'ok');
        sources[source] = { status: !results.length || bad.length || options.skip.includes(source) ? 'unverified' : 'ok', count: results.reduce((s, r) => s + (r.count || 0), 0), reason: options.skip.includes(source) ? 'skip 指定' : bad.length ? [...new Set(bad.map(r => r.reason))].join('; ') : results.length ? `${paidPartners.length}取引先を照合。正の対照確認済み` : '支払い対象の取引先がありません' };
      }
      await checkpoint();
      if (!options.skip.includes('discord')) {
        let cached = [];
        try { cached = await cachedStaff(defaultHome, now); } catch { /* Invalid cache is replaced by the read-only guild listing. */ }
        snapshot.staff = cached;
        try {
          const live = await discord.members();
          snapshot.staff = [...new Map([...cached, ...live].map(m => [JSON.stringify(m), m])).values()];
          sources['discord:members'] = { status: 'ok', count: snapshot.staff.length, reason: `既存検索名簿 ${cached.length}件を先に利用しguild一覧で補完。社員属性・未登録メールは未確認` };
        } catch (e) { sources['discord:members'] = { status: 'unverified', count: cached.length, reason: `${reason(e)}。既存検索名簿のみ使用（全員名簿ではない）` }; }
      }
      if (!options.skip.includes('admin')) {
        let clientId; try { clientId = JSON.parse(await fs.readFile(keyPath, 'utf8')).client_id; } catch { /* Report missing credentials through scanAdmin. */ }
        const result = await scanAdmin({ google, state, clientId, thresholds: patterns.thresholds, now }); for (const finding of result.findings) findings.push(finding); Object.assign(sources, result.sources); state.knownOAuth = result.knownOAuth; state.adminCursors = result.cursors;
      } else sources.admin = { status: 'unverified', count: 0, reason: 'skip 指定' };
      if (!options.skip.includes('drive')) {
        const result = await scanDrive({ google, state, userBudgetMs: options['drive-budget-seconds'] * 1000 / USERS.length,
          save: value => writePrivate(path.join(stateDir, 'state.json'), value, secrets) });
        for (const finding of result.findings) findings.push(finding);
        Object.assign(sources, result.sources);
        snapshot.externalSharing = result.baseline;
        sharingAcknowledgedKeys = result.acknowledgedKeys;
      } else sources['drive-sharing'] = { status: 'unverified', count: 0, reason: 'skip 指定' };
      console.error('internal-audit: 形跡・外部共有・監査ログの収集完了');
      snapshot.exfilFindings = findings.slice();
    }
    if (lock.recovered) {
      snapshot.coverage ||= {};
      snapshot.coverage.limitations = [...(snapshot.coverage.limitations || []), '前回の中断を検出。停止済みまたは3時間超のrun.lockを回復して続行'];
    }
    const payments = runPaymentRules(snapshot, snapshot.footprint, patterns); for (const finding of payments.findings) findings.push(finding); for (const row of payments.unverified) unverified.push(row);
    for (const key of Object.keys(sources)) if (/^(web(?:[:]|$)|github$|patterns(?:[:]|$))/.test(key)) delete sources[key];
    if (!options.skip.includes('web')) {
      const result = await searchLeaks({ state, search, ask, run: budgetRun }); for (const finding of result.findings) findings.push(finding); Object.assign(sources, result.sources); state.knownLeakUrls = result.knownLeakUrls;
    } else sources.web = { status: 'unverified', count: 0, reason: 'skip 指定' };
    if (!options.skip.includes('patterns')) try {
      const result = await refreshPatterns({ stateDir, patterns, search, ask, now }); candidates = result.candidates; Object.assign(sources, result.sources);
    } catch (e) { sources.patterns = { status: 'failed', count: 0, reason: reason(e) }; }
    else sources.patterns = { status: 'unverified', count: 0, reason: 'skip 指定' };
    snapshot.sources = sources; snapshot.runStatus = 'complete';
    const findingsFile = path.join(stateDir, 'reports', `${date}.findings.jsonl`);
    await writePrivate(findingsFile, findings.map(f => JSON.stringify(scrub(f, secrets))).join('\n') + '\n', secrets);
    const report = renderReport({ snapshot, findings, unverified, sources, candidates, patterns, minSeverity: options['min-severity'], secrets, replay: !!options.snapshot, findingsFile });
    await writePrivate(daily, report, secrets);
    if (options.out && path.resolve(options.out) !== daily) await writePrivate(path.resolve(options.out), report, secrets);
    if (options.json) await writePrivate(path.resolve(options.json), snapshot, secrets);
    if (!options.snapshot) { state.lastRun = now.toISOString(); if (sources.freee.status === 'ok') state.knownPartnerIds = snapshot.partners.map(p => p.id); }
    for (const key of sharingAcknowledgedKeys) delete state.pendingExternalFindings[key];
    // Replays may discover public URLs, but never advance freee/admin/sharing baselines.
    await writePrivate(path.join(stateDir, 'state.json'), state, secrets);
    if (options.notify) {
      const location = await reportLocation(options.out ? path.resolve(options.out) : daily, { keyPath, date });
      const result = await notifyKim(safeText(notificationText(findings, location, date), secrets), { home: defaultHome, token, webhookFallback: false });
      if (result.delivered !== 'dm') throw auditError('レポート保存済み。kim への DM 配信失敗');
    }
    if (!options.out) process.stdout.write(report);
    return options['fail-on-high'] && findings.some(f => f.severity === 'high') ? 2 : 0;
  } finally { await lock.release(); }
}
if (isEntry(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(e => { console.error(`internal-audit: ${reason(e)}`); process.exitCode = 1; });
