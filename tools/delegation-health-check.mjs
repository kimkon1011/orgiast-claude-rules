#!/usr/bin/env node
// 委譲台帳の症状を実測と照合し、即時修復と次回 auto-session への根本修正起票を行う。
import fs from 'node:fs';
import { writeHandoff } from './next-session-rotate.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeExecutorStatus } from './executor-status.mjs';
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

// 出力ゼロの原因を分類する。打ち切り(timeout)は「codex が使えない」証拠ではない ——
// SIGKILL されると codex は最終メッセージを stdout に書く前に死ぬため out=0 になる。
// 2026-09-11 実測: 404秒/487秒で打ち切られた実行は rollout ログ上は tsc 実行など実作業の途中だった。
// codex は WSL の名前解決失敗などで、セッションを作る前に exit 1 / 出力ゼロで死ぬことがある。
// これは codex 本体の故障ではなく一過性のインフラ障害で、codex-do 側の再試行で回復する。
const INFRA_TRANSIENT = /failed to lookup address information|failed to connect to websocket|stream error|connection reset|i\/o timeout|dns/i;

// WSL のディストリが1つも無い PC では codex レーンを環境修復する必要がある。
// 「そもそも走っていない」の中でも、コードで直せる起動失敗(codex_launch_failed)と分けて扱う
// （2026-09-19 実測: この PC は `wsl -l -q` が空）。
const WSL_LANE_ABSENT = /WSL ディストリが見つかりません/;

// フォールバック先の子プロセスが OS エラーで起動できなかった行(例: spawn ENAMETOOLONG / ENOENT)。
// 1件で発火させる: 低成果(2件閾値)では単発の故障が翌朝 healthy と判定されてしまった (2026-09-21)。
const SPAWN_FAILED = /syscall: 'spawn'|\bspawn E[A-Z]+\b|code: 'E[A-Z]{4,}'/;

// codex CLI 自身の認証欠落。WSL 側 ~/.codex/auth.json が未認証/失効だと、セッションを作る前に
// 401 で死ぬ。Windows 側の認証情報をコピーして復旧を試す環境要因（2026-09-22 診断: 09-20 の11件中4件）。
const CODEX_AUTH_FAILED = /401 unauthorized|missing bearer or basic authentication/i;

// ChatGPT アカウント認証なのに sol/astra を選ぶと 400 で即死する。codex-do 側のレーン選択の
// 問題なので、直せる欠陥として起票する（2026-09-22 診断: 09-20 の11件中7件）。
const CODEX_MODEL_AUTH_MISMATCH = /is not supported when using codex with a chatgpt account/i;

export function emptyOutputReason(row) {
  if (row?.timedOut === true) return 'timeout';
  // 旧行(timedOut 未記録)は経過秒数から推定する。codex の正常終了は実測で中央値~100秒、
  // 打ち切りは --timeout 到達時にのみ現れ、実測値は 300 秒以上だった。
  if (row?.timedOut == null && Number(row?.secs) >= 300) return 'timeout';
  if (WSL_LANE_ABSENT.test(String(row?.stderrTail || ''))) return 'launch_failed';
  // 起動前のゲートが「意図的に止めた」行。launched:false だが codex は一度も起動されておらず、
  // 起動失敗ではない。codex-do が書く行の status は必ず数値で、起動前ゲートは文字列の番兵を書く
  // (2026-09-23 実測: status:"spec-missing-context" / stderrTail 空)。これを launch_failed に
  // 混ぜると「codex-do が codex を起動できずに終了している」と誤診され、直せない欠陥として
  // 同 id が毎日起票され続ける(2026-09-24 診断: 2件がこれだった)。
  if (row?.launched === false && typeof row?.status === 'string') return 'preflight_blocked';
  // codex を起動できずに終わった行。出力ゼロではなく「そもそも走っていない」ので、
  // no_output に混ぜると原因が埋もれて同 id が永久に消えない（2026-09-16 診断）。
  // 起動を試みた行は必ず数値 status(3) と失敗理由の stderrTail を伴うため、ここは起動失敗のまま。
  if (row?.launched === false) return 'launch_failed';
  // 子プロセスの spawn 自体が失敗した行。execute() の child.on('error') 経路では status が
  // 数値で残らず(exitCode:null)、原因は stderr ではなく result.error に載る。
  // 出力ゼロの実体は「codex が走って何も出さなかった」ではなく「そもそも起動できていない」ので
  // no_output に混ぜてはならない（2026-10-04 診断: 直近24hの no_output 3件は全てこれ）。
  // status を欠く旧行・部分行(undefined)は spawn_failed にしない。
  if (row?.launched !== false && row?.exitCode == null && (row?.status === 'error' || row?.status === null)) return 'spawn_failed';
  if (/Not inside a trusted directory/.test(String(row?.stderrTail || ''))) return 'untrusted_cwd';
  if (CODEX_AUTH_FAILED.test(String(row?.stderrTail || ''))) return 'auth_failed';
  if (CODEX_MODEL_AUTH_MISMATCH.test(String(row?.stderrTail || ''))) return 'model_auth_mismatch';
  if (INFRA_TRANSIENT.test(String(row?.stderrTail || ''))) return 'infra_transient';
  const status = Number(row?.status);
  if (Number.isFinite(status) && status !== 0) return `exit_${status}`;
  return 'no_output';
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
  const spawnFailed = usageRows.filter((row) => row.provider === 'fallback' && Number(row.out) === 0 && SPAWN_FAILED.test(String(row.stderrTail || '')));
  if (spawnFailed.length) {
    const models = [...new Set(spawnFailed.map((row) => row.model || '不明'))].join(', ');
    const codes = [...new Set(spawnFailed.map((row) => (String(row.stderrTail || '').match(/\bE[A-Z]{4,}\b/) || ['不明'])[0]))].join(', ');
    findings.push({ id: 'fallback_spawn_failed', severity: 'medium', title: 'フォールバック先の子プロセスが起動失敗',
      evidence: [`${spawnFailed.length}件`, `model ${models}`, `code ${codes}`],
      fixTask: `フォールバック先(${models})の子プロセス起動が OS エラー(${codes})で失敗している。spawn の引数長・実行ファイルパスを確認し、再現テストを追加して修正` });
  }
  const lowYield = usageRows.filter((row) => row.provider === 'fallback' && Number(row.secs) > 900 && Number(row.out) < 300);
  if (lowYield.length >= 2) { const models = [...new Set(lowYield.map((row) => row.model || '不明'))].join(', '); findings.push({ id: 'fallback_low_yield', severity: 'medium', title: 'フォールバックの低成果', evidence: [`${lowYield.length}件`, `model ${models}`], fixTask: `フォールバック先(${models})が長時間走って成果が無い。codex-fallback-order.json の順序と各バックエンドの実効性を見直す` }); }
  const chainTimeout = usageRows.filter((row) => row.provider === 'fallback' && Array.isArray(row.chain)
    && row.chain.some((a) => a && a.outcome === 'timeout'));
  if (chainTimeout.length >= 2) {
    const timeoutAttempts = chainTimeout.flatMap((row) => (row.chain || []).filter((a) => a && a.outcome === 'timeout'));
    const backendsSet = new Set(timeoutAttempts.map((a) => a.backend).filter((b) => typeof b === 'string' && b !== ''));
    const backends = backendsSet.size > 0 ? [...backendsSet].join(', ') : '不明';
    const wastedSecs = Math.round(timeoutAttempts.reduce((sum, a) => sum + Number(a.secs || 0), 0));
    findings.push({ id: 'fallback_chain_timeout', severity: 'medium', title: 'フォールバック連鎖のタイムアウト',
      evidence: [`${chainTimeout.length}件`, `backend ${backends}`, `捨てた秒数 合計${wastedSecs}秒`],
      fixTask: `フォールバック先(${backends})がタイムアウトして時間を捨てている。codex-fallback-order.json の順序を見直すか、そのバックエンドのタイムアウト秒数(fallbackBackendTimeoutSecs)を短くする` });
  }
  const empty = usageRows
    .filter((row) => row.provider === 'codex' && Number(row.out) === 0)
    .map((source) => ({ t: source.t, reason: emptyOutputReason(source), stderrTail: source.stderrTail }))
    .filter((item) => item.reason !== 'timeout');
  const codexSuccessTimes = usageRows
    .filter((row) => row.provider === 'codex' && normalizeExecutorStatus(row) === 'ok' && Number(row.out) > 0)
    .map((row) => Date.parse(row.t));
  // 台帳の並び順ではなく、種類ごとの最後の失敗より後の成功で修復を確認する。
  const repairedAfter = (failures) => {
    const lastFailureTime = Math.max(...failures.map((row) => Date.parse(row.t)));
    return codexSuccessTimes.some((time) => time > lastFailureTime);
  };
  const realEmpty = empty.filter((item) => !['infra_transient', 'launch_failed', 'auth_failed', 'model_auth_mismatch', 'preflight_blocked', 'spawn_failed'].includes(item.reason));
  const launchFailed = empty.filter((item) => item.reason === 'launch_failed');
  const authFailed = empty.filter((item) => item.reason === 'auth_failed');
  const modelAuthMismatch = empty.filter((item) => item.reason === 'model_auth_mismatch');
  const laneAbsent = launchFailed.filter((item) => WSL_LANE_ABSENT.test(String(item.stderrTail || '')));
  const fixableLaunchFailed = launchFailed.filter((item) => !WSL_LANE_ABSENT.test(String(item.stderrTail || '')));
  if (fixableLaunchFailed.length) findings.push({ id: 'codex_launch_failed', severity: 'medium', title: 'Codex の起動失敗', evidence: [`${fixableLaunchFailed.length}件`, ...reasonTop(fixableLaunchFailed)], fixTask: 'codex-do が codex を起動できずに終了している。WSL の状態と起動経路のログを確認し、起動失敗を再現するテストを追加して修正' });
  // 2026-10-09: 環境故障を low にして Codex が43日・112回起動不能のまま放置された。環境故障こそ high + fixTask の修理対象。
  if (laneAbsent.length && !repairedAfter(laneAbsent)) findings.push({ id: 'codex_lane_unavailable', severity: 'high', title: 'codex レーンは WSL 不在のため使用不可（要修理）', evidence: [`${laneAbsent.length}件`, 'WSL ディストリ 0 件'], fixTask: "WSL にディストリが無い。wsl --install -d Ubuntu --no-launch → wsl -d Ubuntu -u root -- bash -lc 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; npm i -g @openai/codex' → Windows の %USERPROFILE%\\.codex\\auth.json を WSL の /root/.codex/auth.json にコピー → codex login status で確認 → codex-do で1ファイル作成を試し実測" });
  // 起動前ゲートが止めた行も事実として残す。原因は codex 側ではなく指示(spec)側なので
  // codex_launch_failed とは別 id にし、fixTask を付けない(low)＝毎日の起票対象にしない。
  const preflightBlocked = empty.filter((item) => item.reason === 'preflight_blocked');
  if (preflightBlocked.length) findings.push({ id: 'codex_preflight_blocked', severity: 'low', title: 'Codex は起動前ゲートで意図的に止められた（起動失敗ではない）', evidence: [`${preflightBlocked.length}件`, 'status が文字列の番兵（起動前ゲートが記録）'] });
  // spawn 自体の失敗は「そもそも起動できていない」ので、no_output として起票しない。
  const spawnFailedRows = empty.filter((item) => item.reason === 'spawn_failed');
  if (spawnFailedRows.length && !repairedAfter(spawnFailedRows)) findings.push({ id: 'codex_spawn_failed', severity: 'high', title: 'Codex の子プロセスが spawn に失敗（起動できていない）', evidence: [`${spawnFailedRows.length}件`, ...reasonTop(spawnFailedRows)], fixTask: 'where codex／WSL 内 command -v codex で実体を確認し、無ければ npm i -g @openai/codex で入れ直す' });
  // 直せる欠陥なので fixTask を付ける（medium）。
  if (modelAuthMismatch.length) findings.push({ id: 'codex_model_auth_mismatch', severity: 'medium', title: 'Codex が ChatGPT アカウントで sol/astra を選んで失敗', evidence: [`${modelAuthMismatch.length}件`, ...reasonTop(modelAuthMismatch)], fixTask: 'codex-do のレーン選択が ChatGPT アカウント認証を検出できず sol/astra を選んでいる。detectChatGptAuth と decideCodexLane の判定を照合し、再現テストを追加して修正' });
  if (authFailed.length && !repairedAfter(authFailed)) findings.push({ id: 'codex_auth_failed', severity: 'high', title: 'Codex CLI が未認証（WSL 側の再ログインが必要）', evidence: [`${authFailed.length}件`, 'WSL の ~/.codex/auth.json を確認し codex login を実行'], fixTask: 'Windows の %USERPROFILE%\\.codex\\auth.json を WSL の ~/.codex/ にコピーし codex login status。Windows 側も未ログインのときだけ人の codex login が要る' });
  if (realEmpty.length) findings.push({ id: 'codex_empty_output', severity: 'medium', title: 'Codex の出力ゼロ', evidence: [`${realEmpty.length}件`, ...reasonTop(realEmpty), ...(empty.length > realEmpty.length ? [`インフラ/起動失敗で除外 ${empty.length - realEmpty.length}件`] : [])], fixTask: 'codex が出力ゼロで終了した原因（認証切れ/上限/起動失敗）を codex-do のログから特定' });
  for (const [provider, state] of Object.entries(cooldown)) if (state?.reason === 'http_402' && Number(state.until) > nowMs) findings.push({ id: 'provider_balance_exhausted', severity: 'low', title: `${provider} の残高切れ`, evidence: [`provider ${provider}`, CLAUDE_FALLBACK_RULE] });
  const providers = new Map();
  for (const row of usageRows) {
    if (!row.provider) continue;
    const rows = providers.get(row.provider) || [];
    rows.push(row); providers.set(row.provider, rows);
  }
  for (const [provider, rows] of providers) {
    // llm-ask は status:'ok'、cheap-code は ok、codex-do は終了状態と出力を記録する。
    const succeeded = rows.some(row => normalizeExecutorStatus(row) === 'ok' && Number(row.out) > 0);
    if (rows.length < 3 || succeeded) continue;
    const times = rows.map(row => row.t).sort((a, b) => Date.parse(a) - Date.parse(b));
    findings.push({ id: 'lane_outage_unrepaired', provider, severity: 'high', title: `${provider} レーンが全滅したまま（未修理）`,
      evidence: [`${rows.length}件すべて失敗`, `最初 ${times[0]}`, `最後 ${times.at(-1)}`, ...reasonTop(rows.map(row => ({ reason: row.stderrTail || row.reason || emptyOutputReason(row) })))],
      fixTask: `${provider} が直近 ${rows.length} 件すべて失敗している。代替レーンや Claude 本体へ逃げて放置せず、stderrTail から原因を特定して修復し、修復後に1回実行して成功を実測する。直せないときは試した手段と出力を記録する` });
  }
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
  writeHandoff(file, md.slice(0, start) + block + md.slice(end));
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
