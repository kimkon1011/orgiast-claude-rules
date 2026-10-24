#!/usr/bin/env node
// 委譲台帳の症状を実測と照合し、即時修復と次回 auto-session への根本修正起票を行う。
import fs from 'node:fs';
import { writeHandoff } from './next-session-rotate.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeExecutorStatus } from './executor-status.mjs';
import { isEntry } from './is-entry.mjs';
import { judgeTimeoutRows } from './timeout-waste-judge.mjs';
import { isPermanentBillingDetail } from './llm-fallback.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const CLAUDE_FALLBACK_RULE = '従量課金AIはオートチャージON＋Claude側監視が全社ルール（2026-09-09）';

// 記録された上限の再開時刻(until)からこの余裕を超えて「次のレート制限ウィンドウ」へ進んでいたら、
// codex は上限を抜けて回復している＝その低い使用率は「検出が偽陽性だった」証拠にならない。
// 2026-10-10 実測: 12:16Z に usage_limit 2件(until 1791982380000) を記録した後、18:56Z の
// 次セッションは別の窓(window_minutes 43200 / resets_at 1794249388)で used_percent 3 を返した。
// これを「実測 used_percent 3」として突き合わせ、本物の上限を毎晩起票し直し、生きている
// cooldown まで消していた（同じ fixTask が永久に消えない起票ループ）。
export function windowResetsAfterLimit(limitRows, metric) {
  if (!metric || metric.resetsAt === null || metric.resetsAt === undefined) return false;
  const untils = limitRows.map((row) => Number(row.until)).filter((until) => Number.isFinite(until));
  // until を持つ行が無い(旧形式・不明)ときは判定しない＝従来どおり起票する側に倒す。
  if (!untils.length) return false;
  return metric.resetsAt * 1000 > Math.max(...untils) + HOUR;
}

// 測定値が「上限を記録した時点より後に始まった短い窓」のものなら、その低い使用率は反証にならない。
// 2026-10-20 19:15Z の実測: 本物の上限を検出したが until のパースが壊れて 13.8 時間後になり、
// 翌夜の 300 分窓(02:52Z 開始)の 8% を windowResetsAfterLimit が弾けず偽陽性を起票した。
// 5〜6 時間窓は検出時刻より後に始まっていれば必ず別の窓なので、until の値に依存せず判定できる。
// 7 日窓などの長い窓はこの判定を使わない（従来どおり until 比較だけで判断する）。
export function metricFromLaterWindow(limitRows, metric) {
  if (!metric || metric.resetsAt === null || metric.resetsAt === undefined) return false;
  const windowMinutes = Number(metric.windowMinutes);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || windowMinutes > 6 * 60) return false;
  const detectedTimes = limitRows.map((row) => Date.parse(row.t)).filter((time) => Number.isFinite(time));
  if (!detectedTimes.length) return false;
  const windowStart = Number(metric.resetsAt) * 1000 - windowMinutes * 60_000;
  return windowStart > Math.max(...detectedTimes) + HOUR;
}

// 同じ1回の上限検出は usage_limit と usage_limit_no_fallback の2行になる。until が同じなら1件と数える。
export function dedupeLimitEvents(limitRows) {
  const seen = new Set();
  const events = [];
  for (const row of limitRows) {
    const until = Number(row.until);
    if (!Number.isFinite(until)) { events.push(row); continue; }
    if (seen.has(until)) continue;
    seen.add(until);
    events.push(row);
  }
  return events;
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
}

export function authRestoredAfter(home, failures, options = {}) {
  const failureTimes = (Array.isArray(failures) ? failures : [])
    .map((row) => Date.parse(row?.t))
    .filter((time) => Number.isFinite(time));
  if (!failureTimes.length) return false;
  const lastFailureTime = Math.max(...failureTimes);
  const statImpl = options.statImpl || fs.statSync;
  const readFile = options.readFile || fs.readFileSync;
  try {
    const authFile = path.join(home, '.codex', 'auth.json');
    if (!(statImpl(authFile).mtimeMs > lastFailureTime)) return false;
    const auth = JSON.parse(String(readFile(authFile, 'utf8')).replace(/^\uFEFF/, ''));
    return [auth?.tokens?.id_token, auth?.tokens?.access_token]
      .some((token) => typeof token === 'string' && token.length > 0);
  } catch {
    return false;
  }
}

function measured(value) {
  if (typeof value === 'number') return { usedPercent: value, windowMinutes: null, resetsAt: null };
  if (!value || !Number.isFinite(Number(value.usedPercent))) return null;
  return { usedPercent: Number(value.usedPercent), windowMinutes: Number.isFinite(Number(value.windowMinutes)) ? Number(value.windowMinutes) : null, resetsAt: Number.isFinite(Number(value.resetsAt)) ? Number(value.resetsAt) : null };
}

export function parseRateLimitsFromText(text) {
  let last = null;
  const source = String(text ?? '').replace(/\\"/g, '"');
  // primary が null の行も拾う。上限に達した codex は rate_limits.primary を null にして返すため
  // (2026-10-10 実測: 上限到達の2セッションだけが "primary":null、他66ファイルには無い)。
  const anchors = [...source.matchAll(/"primary"\s*:\s*(\{|null\b)/g)];
  for (const anchor of anchors) {
    // 古い非 null 値を最新値として返すと「実測 58% なのに上限」という誤った反証になる。
    if (anchor[1] === 'null') { last = { exhausted: true }; continue; }
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
    const script = `find ~/.codex/sessions -type f -name "*.jsonl" -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -n 3 | sort -n | cut -d" " -f2- | xargs -r grep -ho "\\"primary\\":{[^}]*}\\|\\"primary\\":null" 2>/dev/null | tail -n 40`;
    const result = spawnImpl('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', script], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
    if (result?.error || (result?.status != null && result.status !== 0)) return null;
    return parseRateLimitsFromText(result.stdout);
  } catch { return null; }
}

// フォールバックの「長時間なのに成果が無い」を、実際に秒数を使ったバックエンドへ帰属させる。
// row.secs はチェーン全体、row.out / row.model は最後に走ったバックエンドの値なので、行そのままで
// 判定すると前半の timeout が捨てた秒数を末尾のバックエンドの「長時間」と誤認する
// (2026-10-14 診断: 低成果7件すべてが「gemini-cli の timeout + cheap-code:deepseek の短い成功」で、
//  実際には 107〜311 秒で終わっている deepseek を毎晩起票していた。捨てた秒数は
//  fallback_chain_timeout 側の症状)。chain があるときは timeout した試行を除いた各試行で、
//  chain が無い旧形式の行は行そのもので判定する。戻り値は モデル名 → 件数。
export function lowYieldBackends(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    if (row?.provider !== 'fallback') continue;
    const attempts = Array.isArray(row.chain) && row.chain.length
      ? row.chain.filter((a) => a && a.outcome !== 'timeout')
      : [row];
    for (const attempt of attempts) {
      if (!(Number(attempt.secs) > 900 && Number(attempt.out) < 300)) continue;
      const name = attempt.model || attempt.backend || '不明';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return counts;
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

// 上限・レート制限は欠陥ではない（後段の codex usage_limit と同じ扱い＝low・fixTask なし）。
// 2026-10-13 診断: glm の「3件すべて失敗」は 1 リクエストの再試行(attempt 0/1/2)で、
// 実体は z.ai Coding Plan の weekly/monthly 上限到達(HTTP 429 / error.code 1310,
// "Weekly/Monthly Limit Exhausted")。レーンは壊れておらず、上限リセットで自動回復する。
export function isQuotaLimitedRow(row = {}) {
  return /^http_?(402|429)$/.test(String(row?.status ?? '').toLowerCase());
}

export function isBillingSuspendedRow(row = {}) {
  return /^http_?(402|429)$/.test(String(row?.status ?? '').toLowerCase())
    && isPermanentBillingDetail(row?.reason);
}

// cooldown の行は「上限/レート制限中なのでリクエストを投げなかった」記録(cheap-code.mjs が
// status:'cooldown' で残す)。失敗ではなく未試行なので、全滅判定の分母に入れてはならない。
// 入れると (a) 実体が上限到達でも証拠が「N件すべて失敗」の high 未修理全滅になり、
// (b) isQuotaLimitedRow の all 判定が cooldown 行で必ず false になる
// (2026-10-13 診断: glm の11件 = cooldown 5件 + http_429 6件。実体は Coding Plan の上限到達)。
export function isCooldownSkippedRow(row = {}) {
  return String(row?.status ?? '').toLowerCase() === 'cooldown';
}

// quota-sweep は終了状態をそのまま status に書く(final/exhausted/ceiling/deadline/no-goal/failed)。
// exhausted は「累積上限まで走り切った」＝レーンは動いている。トークンを消費した行を成功証拠に
// 数えないと、8 tick 走った翌晩も 24h 窓の過去失敗だけで「全滅」の high 起票が続く
// (2026-10-22T02:55Z 実測: exhausted / in=1,126,575 / out=10,422 の翌日に再起票)。
export function quotaSweepProgressRow(row = {}) {
  if (!String(row?.provider ?? '').startsWith('quota-sweep:')) return false;
  if (String(row?.status ?? '').toLowerCase() === 'failed') return false;
  return Number(row.in) > 0 || Number(row.out) > 0;
}

// quota-sweep は子処理が成果を返した後の終了処理で失敗しても status:'failed' を記録する。
// 2026-10-23/24 実測の quota-sweep:claude は failed でも in/out が
// 62/19609、172/35469 あり、レーン全滅ではなく「作業後に失敗」した行だった。
export function quotaSweepPartialProgressRow(row = {}) {
  return String(row?.provider ?? '').startsWith('quota-sweep:')
    && String(row?.status ?? '').toLowerCase() === 'failed'
    && (Number(row.in) > 0 || Number(row.out) > 0);
}

// quota-sweep の status は停止理由そのもの。`failed` 以外（deadline/ceiling/exhausted/no-goal 等）は
// レーンが正常に判断して止まった記録で、トークン0でも故障ではない。これを含めると
// 「窓が無いので見送った」が3回続いただけで lane_outage_unrepaired(high) になる
// (2026-10-22 の起票は failed 4件が実体だが、正常停止も同じ分母に入る構造だった)。
export function isQuotaSweepBenignRow(row = {}) {
  return String(row?.provider ?? '').startsWith('quota-sweep:') && String(row?.status ?? '').toLowerCase() !== 'failed';
}

// fallback バックエンド自体は走って応答を返した(chain の outcome が ok)のに、作業ツリーを
// 1行も変えなかった行。codex-do が reason:'empty_diff' を付ける。
// これはレーン(バックエンド)の全滅ではなく、昇格元(codex sol→astra)が空diffだった作業を
// 代替が実装しなかった＝成果の失敗。全滅の分母に入れると、代替が正常に動いているのに
// 毎晩 high の「未修理」が積まれる(2026-10-19 実測: fallback の3件が全てこれ)。
export function isEmptyDiffEscalationRow(row = {}) {
  if (row?.provider !== 'fallback' || String(row?.reason || '') !== 'empty_diff') return false;
  const chain = Array.isArray(row?.chain) ? row.chain : [];
  return chain.some((item) => item?.outcome === 'ok');
}

// フォールバック先の子プロセスが OS エラーで起動できなかった行(例: spawn ENAMETOOLONG / ENOENT)。
// 1件で発火させる: 低成果(2件閾値)では単発の故障が翌朝 healthy と判定されてしまった (2026-09-21)。
const SPAWN_FAILED = /syscall: 'spawn'|\bspawn E[A-Z]+\b|code: 'E[A-Z]{4,}'/;

// codex CLI 自身の認証欠落。WSL 側 ~/.codex/auth.json が未認証/失効だと、セッションを作る前に
// 401 で死ぬ。Windows 側の認証情報をコピーして復旧を試す環境要因（2026-09-22 診断: 09-20 の11件中4件）。
// token_revoked のとき codex は "workspace routing discovery unauthorized (401)" の語順で 401 を出す。
// 旧パターン /401 unauthorized/ は語順が逆で一致せず、実測8件(2026-10-12〜10-14)が no_output に
// 埋もれて codex_empty_output が毎晩起票された（2026-10-16 診断。修復=Windows の auth.json を WSL へコピー）。
const CODEX_AUTH_FAILED = /401 unauthorized|unauthorized \(401\)|missing bearer or basic authentication/i;

// ChatGPT アカウント認証なのに sol/astra を選ぶと 400 で即死する。codex-do 側のレーン選択の
// 問題なので、直せる欠陥として起票する（2026-09-22 診断: 09-20 の11件中7件）。
const CODEX_MODEL_AUTH_MISMATCH = /is not supported when using codex with a chatgpt account/i;

// Codex の利用上限到達。コードの欠陥ではなく上限到達による停止。
// アポストロフィは U+2019(’) と U+0027(') の両方に一致させる。
// 台帳の stderrTail は codex-do.mjs が末尾200字へ切り詰める(slice(-200))ため、上限メッセージの
// 先頭が欠けて "t your usage limit. Upgrade to Pro ..." だけが残ることがある。
// 実測 2026-10-21T00:32Z の2件(astra→sol 退避)が旧パターンに一致せず no_output に落ち、
// codex_empty_output が毎晩起票された。先頭欠落を許容する語("your usage limit" + "Upgrade to Pro"、
// 最後の砦として ChatGPT の購入URL)も一致させる。
const CODEX_USAGE_LIMIT = /You(?:[’']ve| have) hit your usage limit|your usage limit[.!]?\s*Upgrade to Pro|Upgrade to Pro \(https:\/\/chatgpt\.com\/explore\/pro\)|Usage limit (?:reached|exceeded)/i;

// 選択モデルが一時的に満員のときは、codex 自体の出力異常ではない。
const CODEX_MODEL_CAPACITY = /Selected model is at capacity\. Please try a different model\./i;

export function emptyOutputReason(row) {
  if (row?.timedOut === true) return 'timeout';
  // 旧行(timedOut 未記録)は経過秒数から推定する。codex の正常終了は実測で中央値~100秒、
  // 打ち切りは --timeout 到達時にのみ現れ、実測値は 300 秒以上だった。
  if (row?.timedOut == null && Number(row?.secs) >= 300) return 'timeout';
  if (String(row?.status ?? '').toLowerCase() === 'network') return 'infra_transient';
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
  if (CODEX_USAGE_LIMIT.test(String(row?.stderrTail || ''))) return 'usage_limit';
  if (CODEX_MODEL_CAPACITY.test(String(row?.stderrTail || ''))) return 'model_capacity';
  if (INFRA_TRANSIENT.test(String(row?.stderrTail || ''))) return 'infra_transient';
  // 台帳の status は数値(終了コード)だけではない。llm-fallback / cheap-code は失敗の種類を
  // そのまま文字列で書く(http_429 / http_402 / cooldown)。これを知らずに catch-all の
  // no_output へ落とすと、証拠が「no_output(11件)」になり、上限到達が原因不明のレーン故障に見える
  // (2026-10-13 診断: glm の11件の実体は HTTP 429 と、その間の cooldown スキップだった)。
  if (isQuotaLimitedRow(row)) return 'quota_limited';
  if (isCooldownSkippedRow(row)) return 'cooldown_skipped';
  const status = Number(row?.status);
  if (Number.isFinite(status) && status !== 0) return `exit_${status}`;
  return 'no_output';
}

// 停滞の打ち切りを「実装として期待できる」最も早い時刻。これ以前の停滞は対象外。
// #964（2026-10-21T17:04:12Z マージ）は stderr の chunk 到着時にしか判定しておらず、
// 拒否3回の後に無音になる停滞を拾えなかった。それを #1059（2026-10-23T20:03:24Z マージ）が
// 周期タイマーへ直したので、期待できる起点は #1059。ここを #964 のままにすると、
// #1059 で直した症状の過去行が永久に「未修理」として毎晩起票され続け、完了判定ができなくなる
// （2026-10-25 実測: 打ち切り未発火の最終行は 2026-10-23T10:43:58Z で #1059 より前）。
export const POLICY_STALL_SINCE = '2026-10-23T20:03:24Z';
// 打ち切り判定（POLICY_STALL_MIN_ELAPSED_SECS=300）に届いた停滞だけを「打ち切られるべきだった」と数える。
export const POLICY_STALL_MIN_ABORTABLE_SECS = 300;
export const POLICY_DENIAL_RE = /tool execution denied by policy/gi;

export function countPolicyDenial(text) {
  return typeof text === 'string' ? (String(text).match(POLICY_DENIAL_RE) || []).length : 0;
}

// 台帳1行（chain があれば試行ごと）から、ポリシー拒否の痕跡がある試行を抽出する。
// stderrTail は末尾200字へ切り詰められているため回数は下限値。outcome は #964 以降
// 'blocked'（早期打ち切り）, 'timeout'（締切）, 'ok'/'failed' のいずれか。
export function policyStallAttempts(rows) {
  const attempts = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const chain = Array.isArray(row.chain) && row.chain.length ? row.chain : null;
    const list = chain ?? [null];
    for (const attempt of list) {
      const stderr = String(attempt?.stderrTail ?? (chain ? '' : row.stderrTail) ?? '');
      const denials = countPolicyDenial(stderr);
      if (!denials) continue;
      const secs = Number(attempt?.secs ?? row.secs);
      const out = Number(attempt?.out ?? row.out);
      attempts.push({
        t: String(row.t || ''),
        backend: attempt?.backend ?? row.provider ?? null,
        model: attempt?.model ?? row.model ?? null,
        outcome: attempt?.outcome ?? (row.timedOut === true || row.status === 'timeout' ? 'timeout' : 'ok'),
        secs: Number.isFinite(secs) ? secs : 0,
        out: Number.isFinite(out) ? out : 0,
        budgetSecs: Number(attempt?.budgetSecs ?? row.timeoutSecs) || null,
        denials,
      });
    }
  }
  return attempts;
}

export function collectFindings({ home, now = new Date(), codexUsedPercent = null }) {
  const current = now instanceof Date ? now : new Date(now);
  const nowMs = current.getTime(), cutoff = nowMs - DAY;
  const claudeDir = path.join(home, '.claude');
  const recent = (rows) => rows.filter((row) => { const t = Date.parse(row.t || ''); return Number.isFinite(t) && t >= cutoff && t <= nowMs; });
  const limitRows = recent(readJsonl(path.join(claudeDir, 'codex-limit-history.jsonl'))).filter((row) => String(row.reason || '').includes('usage_limit'));
  const limitEvents = dedupeLimitEvents(limitRows);
  const usageRows = recent(readJsonl(path.join(claudeDir, 'executor-usage.jsonl')));
  const cooldown = readJson(path.join(claudeDir, 'provider-cooldown.json'), {});
  // 上限到達中の codex は primary を null で返す＝実測値は「不明」であって「58%」ではない。
  // measured() は exhausted を null にするので、ここで metric が無ければ偽陽性とは判定しない
  // (2026-10-10 実測: 本物の上限メッセージ + 期限切れの primary 58% を突き合わせて
  //  「偽陽性」と誤判定し、生きていた cooldown を解除していた)。
  const metric = measured(codexUsedPercent);
  // 上限後に別の窓へ進んでいたら、その低い使用率は反証にならない（windowResetsAfterLimit の説明を参照）。
  const supersededWindow = windowResetsAfterLimit(limitRows, metric) || metricFromLaterWindow(limitRows, metric);
  const findings = [];
  // #773(600→900秒＋連鎖予算)以降の timeout が上限を超えて秒数を捨てたかは、
  // Claude セッションを待たず夜間で判定する。判定器は台帳全体（配備前を含む）を見る必要が
  // あるため、24時間窓の usageRows ではなく executor-usage.jsonl を全件読む。
  // (2026-10-20: 判定器が CLI 専用で、台帳が伸びても人手で実行するまで判定が止まっていた)
  // 予算は試行ごとに判定する: フォールバック試行は与えた budgetSecs（無い旧行は 900 秒）、
  // 主経路は与えた --timeout の timeoutSecs（無い旧行は 1800 秒）。900 秒固定で主経路を見ると
  // 既定 1800 秒を使い切っただけの行を回帰と誤検出する（2026-10-20 実測 / 2026-10-22 修正）。
  const timeoutWaste = judgeTimeoutRows(readJsonl(path.join(claudeDir, 'executor-usage.jsonl')));
  if (timeoutWaste.verdict === 'waste-exceeds-cap') {
    const overCap = (timeoutWaste.overCapAttempts || []).map((a) => {
      const label = a.path === 'primary' ? '主経路' : 'フォールバック';
      const name = a.model ? `${a.backend ?? '不明'}(${a.model})` : (a.backend ?? '不明');
      return `超過: ${name} ${label} ${Math.round(a.secs)}秒/予算${Math.round(a.budgetSecs)}秒`;
    });
    findings.push({
      id: 'timeout_waste_exceeds_cap',
      severity: 'high',
      title: 'タイムアウトで捨てた秒数が上限超過（#773 の回帰）',
      evidence: [`${timeoutWaste.overCapRows}件`, `最大試行 ${timeoutWaste.maxAttemptSecs}秒`, `上限 ${timeoutWaste.capSecs}秒`, ...overCap],
      fixTask: 'killProcessTree と fallbackBackendTimeoutSecs(#773)が効いていない。timeout 行の chain[].secs を実測し、上限を超えた試行のバックエンドと起動経路を特定して修正・テスト追加',
    });
  }
  // #964（2026-10-21T17:04Z マージ）は、gemini CLI が run_shell_command をポリシー拒否し続けて
  // 900 秒締切まで空回りする症状に早期打ち切り（300秒・拒否3回・出力400字未満で outcome='blocked'）と
  // 1試行600秒上限を入れた。効果は「実 chain が policy 拒否で停滞した時」しか観測できないため、
  // 台帳を毎晩ここで走査し、打ち切られずに時間を消費した停滞だけを起票する（Claude の手動再計測を不要にする）。
  const policyStalls = policyStallAttempts(readJsonl(path.join(claudeDir, 'executor-usage.jsonl')))
    .filter((a) => a.t >= POLICY_STALL_SINCE);
  const unabortedStalls = policyStalls.filter((a) => a.outcome !== 'blocked' && a.secs >= POLICY_STALL_MIN_ABORTABLE_SECS);
  if (unabortedStalls.length) {
    findings.push({
      id: 'policy_stall_not_aborted',
      severity: 'medium',
      title: 'ポリシー拒否の停滞が打ち切られずに時間を消費（#964 の回帰）',
      evidence: [
        `${unabortedStalls.length}件`,
        `最大 ${Math.round(Math.max(...unabortedStalls.map((a) => a.secs)))}秒`,
        `打ち切り済み ${policyStalls.filter((a) => a.outcome === 'blocked').length}件`,
        ...unabortedStalls.slice(-3).map((a) => `${a.t} ${a.backend ?? '不明'} ${Math.round(a.secs)}秒/予算${a.budgetSecs ?? '不明'}秒 out${a.out} outcome=${a.outcome}`),
      ],
      fixTask: 'codex-do の shouldAbortPolicyStall が実 chain で発火していない。stderrTail の拒否回数・経過秒・出力字数を実測し、打ち切り判定が実行ループ（stderr 逐次監視）に繋がっているか確認して修正・テスト追加',
    });
  }
  if (limitRows.length && metric && !supersededWindow && metric.usedPercent < 90) findings.push({
    id: 'codex_false_usage_limit', severity: 'high', title: 'Codex 上限検出の偽陽性',
    evidence: [`usage_limit記録 ${limitEvents.length}件`, `実測 used_percent ${metric.usedPercent}`, `window ${metric.windowMinutes ?? '不明'}分`, `resets_at ${metric.resetsAt ?? '不明'}`],
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
  const lowYieldByBackend = lowYieldBackends(usageRows);
  const lowYieldCount = [...lowYieldByBackend.values()].reduce((sum, count) => sum + count, 0);
  if (lowYieldCount >= 2) {
    const models = [...lowYieldByBackend.keys()].join(', ');
    findings.push({ id: 'fallback_low_yield', severity: 'medium', title: 'フォールバックの低成果',
      evidence: [`${lowYieldCount}件`, `model ${models}`],
      fixTask: `フォールバック先(${models})が長時間走って成果が無い。codex-fallback-order.json の順序と各バックエンドの実効性を見直す` });
  }
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
  const realEmpty = empty.filter((item) => !['infra_transient', 'launch_failed', 'auth_failed', 'model_auth_mismatch', 'preflight_blocked', 'spawn_failed', 'usage_limit', 'model_capacity'].includes(item.reason));
  const launchFailed = empty.filter((item) => item.reason === 'launch_failed');
  const authFailed = empty.filter((item) => item.reason === 'auth_failed');
  const modelAuthMismatch = empty.filter((item) => item.reason === 'model_auth_mismatch');
  const usageLimit = empty.filter((item) => item.reason === 'usage_limit');
  const laneAbsent = launchFailed.filter((item) => WSL_LANE_ABSENT.test(String(item.stderrTail || '')));
  const fixableLaunchFailed = launchFailed.filter((item) => !WSL_LANE_ABSENT.test(String(item.stderrTail || '')));
  if (fixableLaunchFailed.length) findings.push({ id: 'codex_launch_failed', severity: 'medium', title: 'Codex の起動失敗', evidence: [`${fixableLaunchFailed.length}件`, ...reasonTop(fixableLaunchFailed)], fixTask: 'codex-do が codex を起動できずに終了している。WSL の状態と起動経路のログを確認し、起動失敗を再現するテストを追加して修正' });
  // 2026-10-09: 環境故障を low にして Codex が43日・112回起動不能のまま放置された。環境故障こそ high + fixTask の修理対象。
  if (laneAbsent.length && !repairedAfter(laneAbsent)) findings.push({ id: 'codex_lane_unavailable', severity: 'high', title: 'codex レーンは WSL 不在のため使用不可（要修理）', evidence: [`${laneAbsent.length}件`, 'WSL ディストリ 0 件'], fixTask: "WSL にディストリが無い。wsl --install -d Ubuntu --no-launch → wsl -d Ubuntu -u root -- bash -lc 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; npm i -g @openai/codex' → Windows の %USERPROFILE%\\.codex\\auth.json を WSL の /root/.codex/auth.json にコピー → codex login status で確認 → codex-do で1ファイル作成を試し実測" });
  // 上限到達は欠陥ではないので fixTask を付けない low の可視化 finding とする。
  if (usageLimit.length) findings.push({ id: 'codex_usage_limit', severity: 'low', title: 'Codex は上限到達で停止（欠陥ではない）', evidence: [`${usageLimit.length}件`, ...reasonTop(usageLimit)] });
  // 起動前ゲートが止めた行も事実として残す。原因は codex 側ではなく指示(spec)側なので
  // codex_launch_failed とは別 id にし、fixTask を付けない(low)＝毎日の起票対象にしない。
  const preflightBlocked = empty.filter((item) => item.reason === 'preflight_blocked');
  if (preflightBlocked.length) findings.push({ id: 'codex_preflight_blocked', severity: 'low', title: 'Codex は起動前ゲートで意図的に止められた（起動失敗ではない）', evidence: [`${preflightBlocked.length}件`, 'status が文字列の番兵（起動前ゲートが記録）'] });
  // spawn 自体の失敗は「そもそも起動できていない」ので、no_output として起票しない。
  const spawnFailedRows = empty.filter((item) => item.reason === 'spawn_failed');
  if (spawnFailedRows.length && !repairedAfter(spawnFailedRows)) findings.push({ id: 'codex_spawn_failed', severity: 'high', title: 'Codex の子プロセスが spawn に失敗（起動できていない）', evidence: [`${spawnFailedRows.length}件`, ...reasonTop(spawnFailedRows)], fixTask: 'where codex／WSL 内 command -v codex で実体を確認し、無ければ npm i -g @openai/codex で入れ直す' });
  // 直せる欠陥なので fixTask を付ける（medium）。
  if (modelAuthMismatch.length) findings.push({ id: 'codex_model_auth_mismatch', severity: 'medium', title: 'Codex が ChatGPT アカウントで sol/astra を選んで失敗', evidence: [`${modelAuthMismatch.length}件`, ...reasonTop(modelAuthMismatch)], fixTask: 'codex-do のレーン選択が ChatGPT アカウント認証を検出できず sol/astra を選んでいる。detectChatGptAuth と decideCodexLane の判定を照合し、再現テストを追加して修正' });
  // 2026-10-19 実測: Windows はログイン済みなのに、WSL 側 401 の履歴だけで毎晩 high 起票されていた。
  // codex-do は起動時に Windows の auth.json を WSL へ同期するため、失敗後の再ログインも修復として扱う。
  if (authFailed.length && !repairedAfter(authFailed) && !authRestoredAfter(home, authFailed)) findings.push({ id: 'codex_auth_failed', severity: 'high', title: 'Codex CLI が未認証（WSL 側の再ログインが必要）', evidence: [`${authFailed.length}件`, 'WSL の ~/.codex/auth.json を確認し codex login を実行'], fixTask: 'Windows の %USERPROFILE%\\.codex\\auth.json を WSL の ~/.codex/ にコピーし codex login status。Windows 側も未ログインのときだけ人の codex login が要る' });
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
    const partialProgress = rows.filter(quotaSweepPartialProgressRow);
    const succeeded = rows.some(row => (normalizeExecutorStatus(row) === 'ok' && Number(row.out) > 0) || quotaSweepProgressRow(row)) || partialProgress.length > 0;
    if (succeeded) {
      if (partialProgress.length > 0) {
        const times = partialProgress.map(row => row.t).sort((a, b) => Date.parse(a) - Date.parse(b));
        findings.push({ id: 'quota_sweep_failed_after_progress', provider, severity: 'low', title: `${provider} は作業後に失敗（レーン全滅ではない・要観察）`,
          evidence: [`${partialProgress.length}件`, `最初 ${times[0]}`, `最後 ${times.at(-1)}`, ...reasonTop(partialProgress)] });
      }
      continue;
    }
    // 全滅の分母は「実際に投げた回(attempts)」。cooldown 行は上限中で投げなかった記録なので
    // 分母から外す。外さないと上限到達の実体が「N件すべて失敗」の high 未修理全滅に見える
    // (2026-10-13 診断: glm の11件 = cooldown 5件 + http_429 6件)。
    const emptyDiffRows = rows.filter(isEmptyDiffEscalationRow);
    // quota-sweep は停止理由を status に書くので、failed 以外（deadline/ceiling/exhausted/no-goal）は
    // 正常停止。トークン0でも分母に入れない（入れると「窓が無いので見送った」3回で high 起票になる）。
    const attempts = rows.filter((row) => !isCooldownSkippedRow(row) && !isEmptyDiffEscalationRow(row) && !isQuotaSweepBenignRow(row));
    // 24h 窓が cooldown だけで埋まる＝上限中で一度も試行していない。レーンは止まっているが
    // 原因は上限側で、コードの欠陥ではない。low の可視化だけ残す(high にすると上限が明けるまで
    // 毎晩同じ偽の修理タスクが積まれる。黙って消すと止まっている事実自体が見えなくなる)。
    if (!attempts.length) {
      // quota-sweep の正常停止は cooldown ではないので、cooldown の low 表示も付けない。
      if (rows.every(isQuotaSweepBenignRow)) continue;
      // 窓が「代替は応答したが1行も変えなかった」行だけで埋まった場合も、レーン障害ではない。
      // 止まっている事実は low で可視化し、修理タスク(high)にはしない。
      if (emptyDiffRows.length === rows.length && rows.length >= 3) {
        const times = rows.map(row => row.t).sort((a, b) => Date.parse(a) - Date.parse(b));
        findings.push({ id: 'fallback_empty_diff_escalation', provider, severity: 'low', title: `${provider} の昇格先は応答したが作業ツリーを変更できていない（レーン障害ではない）`,
          evidence: [`${rows.length}件すべて空diff`, `最初 ${times[0]}`, `最後 ${times.at(-1)}`,
            'chain の outcome は ok（バックエンドは起動・応答している）'] });
      } else if (rows.length >= 3) {
        const state = cooldown[provider], until = Number(state?.until);
        const skipped = rows.map(row => row.t).sort((a, b) => Date.parse(a) - Date.parse(b));
        findings.push({ id: 'provider_cooldown_skipped', provider, severity: 'low', title: `${provider} は cooldown 中で試行されていない（欠陥ではない）`,
          evidence: [`${rows.length}件すべて cooldown`, `最初 ${skipped[0]}`, `最後 ${skipped.at(-1)}`,
            `cooldown ${state?.reason || '理由不明'}${Number.isFinite(until) ? ` / until ${new Date(until).toISOString()}` : ''}`] });
      }
      continue;
    }
    if (attempts.length < 3) continue;
    // 上限/レート制限だけで全滅した行は「レーンが壊れている」証拠ではない。high + fixTask で
    // 起票すると、上限が続く限り毎晩同じ偽の修理タスクが積まれる（2026-10-13 診断: glm の
    // 3件は 1 リクエストの再試行で、実体は Coding Plan の週次/月次上限到達）。
    // codex の usage_limit と同じく low・fixTask なしの可視化だけにする。
    // 上限・課金切れ・一過性ネットワークだけで全滅した行は「レーンが壊れている」証拠ではない。
    // 実測 2026-10-22: kimi の 24h 449 行 = http_429 440 + status:'network' 9(10.7秒で
    // タイムアウト) で、network を no_output 扱いしていたため毎日 high になっていた。
    const benign = attempts.filter((row) => isQuotaLimitedRow(row) || emptyOutputReason(row) === 'infra_transient');
    const billingSuspended = attempts.filter(isBillingSuspendedRow);
    // 行に reason が無い旧記録でも、llm-fallback が残した 24h の恒久課金切れ cooldown で判別できる。
    const billingCooldown = cooldown[provider]?.permanentBilling === true && Number(cooldown[provider]?.until) > nowMs;
    if ((billingSuspended.length || billingCooldown) && benign.length === attempts.length) {
      findings.push({ id: 'provider_billing_suspended', provider, severity: 'low', title: `${provider} は残高切れで停止（チャージ待ち・コードでは直せない）`,
        evidence: [`${billingSuspended.length}件が恒久課金切れ`, ...(billingCooldown ? [`cooldown ${cooldown[provider].reason} until ${new Date(Number(cooldown[provider].until)).toISOString()}`] : []),
          ...reasonTop(billingSuspended.map(row => ({ reason: row.reason || row.stderrTail || emptyOutputReason(row) })))] });
      continue;
    }
    if (benign.length === attempts.length) {
      findings.push({ id: 'provider_usage_limit', provider, severity: 'low', title: `${provider} は上限/レート制限で停止（欠陥ではない）`,
        evidence: [`${attempts.length}件すべて失敗`, ...reasonTop(attempts.map(row => ({ reason: row.stderrTail || row.reason || emptyOutputReason(row) })))] });
      continue;
    }
    const times = attempts.map(row => row.t).sort((a, b) => Date.parse(a) - Date.parse(b));
    const skipped = rows.length - attempts.length;
    findings.push({ id: 'lane_outage_unrepaired', provider, severity: 'high', title: `${provider} レーンが全滅したまま（未修理）`,
      evidence: [`${attempts.length}件すべて失敗`, `最初 ${times[0]}`, `最後 ${times.at(-1)}`, ...(skipped ? [`cooldown スキップ ${skipped}件`] : []), ...reasonTop(attempts.map(row => ({ reason: row.stderrTail || row.reason || emptyOutputReason(row) })))],
      fixTask: `${provider} が直近 ${attempts.length} 件すべて失敗している。代替レーンや Claude 本体へ逃げて放置せず、stderrTail から原因を特定して修復し、修復後に1回実行して成功を実測する。直せないときは試した手段と出力を記録する` });
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
    if (existing) { const date = existing[0].match(/\(起票 (\d{4}-\d{2}-\d{2})\)/)?.[1]; if (!/~~/.test(existing[0]) && date && dateAgeDays(date, today) < 3) continue; block = block.slice(0, existing.index) + block.slice(existing.index + existing[0].length).replace(/^\r?\n/, ''); }
    const heading = /^##[ \t]+残TODO.*$/m.exec(block); if (!heading) continue;
    const evidence = finding.evidence.join('/').slice(0, 200);
    const line = `0. ${marker} ${finding.fixTask} — 証拠: ${evidence} — 完了条件: 該当テストを追加して node --test が緑、翌日の delegation-health.json に同 id が出ないこと (起票 ${today})`;
    const insertAt = heading.index + heading[0].length;
    block = `${block.slice(0, insertAt)}\n${line}${block.slice(insertAt)}`; changed = true;
  }
  const firedIds = new Set(findings.map((item) => item.id));
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  // 解消した全滅障害の起票が4日残り、自動セッションを空費したため未検出の行を閉じる。
  // 直近24hの台帳が無い日は未検証とみなし、読み失敗でも既存の起票を閉じない。
  const hasRecentUsage = readJsonl(path.join(home, '.claude', 'executor-usage.jsonl')).some((row) => { const time = Date.parse(row.t); return time >= nowMs - DAY && time <= nowMs; });
  if (hasRecentUsage) {
    let inTodos = false;
    block = block.split(/\r?\n/).map((line) => {
      if (/^##[ \t]+残TODO/.test(line)) { inTodos = true; return line; }
      if (inTodos && /^##[ \t]+/.test(line)) inTodos = false;
      const item = inTodos && line.match(/^\s*(\d+)[.)、]\s+(.+)$/);
      const id = item && item[2].match(/\[delegation-health:([a-z_]+)\]/)?.[1];
      if (!id || /~~/.test(line) || firedIds.has(id)) return line;
      changed = true;
      return `${item[1]}. ~~${item[2]}~~ → ✅ ${today} 完了（delegation-health 自動閉鎖: 当日の findings に id なし）`;
    }).join('\n');
  }
  if (!changed) return false;
  let inTodos = false;
  block = block.split(/\r?\n/).map((line) => { if (/^##[ \t]+残TODO/.test(line)) { inTodos = true; return line; } if (inTodos && /^##[ \t]+/.test(line)) inTodos = false; return line; }).join('\n');
  let n = 0; inTodos = false;
  block = block.split('\n').map((line) => { if (/^##[ \t]+残TODO/.test(line)) { inTodos = true; return line; } if (inTodos && /^##[ \t]+/.test(line)) inTodos = false; return inTodos && /^\s*\d+[.)、]\s+/.test(line) ? line.replace(/^\s*\d+[.)、]/, `${++n}.`) : line; }).join('\n');
  writeHandoff(file, md.slice(0, start) + block + md.slice(end));
  return true;
}

// 判定結果は「上限超過のときだけ」finding になるため、上限内だった事実は report に残らない。
// 台帳の配備後 timeout を毎晩そのまま記録し、再発した夜に「捨てた秒数が600秒級に収まったか」を
// 判定器を叩き直さずに読めるようにする
// (2026-10-21: #765/#773 の効果判定が再発待ちのまま、判定した証跡がどこにも残らなかった)。
export function timeoutWasteSummary(rows = []) {
  const report = judgeTimeoutRows(rows);
  const lastPostDeploy = report.events.filter((event) => event.postDeploy).map((event) => event.t).sort().at(-1) || null;
  return {
    verdict: report.verdict,
    postDeployTimeoutRows: report.postDeployTimeoutRows,
    overCapRows: report.overCapRows,
    maxAttemptSecs: report.maxAttemptSecs,
    lastPostDeployTimeoutAt: lastPostDeploy,
  };
}

export function renderSummary(report) {
  const lines = ['## 🩺 委譲ヘルス（直近24h）'];
  for (const item of report.findings) lines.push(`- ${item.severity} / ${item.title} / 自動修復:${item.autoHealed ? 'あり' : 'なし'} / 起票先:${item.fixTask && ['high', 'medium'].includes(item.severity) ? '~/.claude/next-session.md' : 'なし'}`);
  if (report.timeoutWaste) lines.push(`- timeout判定: ${report.timeoutWaste.verdict} / 配備後 ${report.timeoutWaste.postDeployTimeoutRows}件 / 上限超過 ${report.timeoutWaste.overCapRows}件 / 最大試行 ${report.timeoutWaste.maxAttemptSecs}秒${report.timeoutWaste.lastPostDeployTimeoutAt ? ` / 最終 ${report.timeoutWaste.lastPostDeployTimeoutAt}` : ''}`);
  if (lines.length < 5) lines.push(`- Codex実測: ${report.codexExhausted ? '上限到達（primary なし）' : report.codexUsedPercent === null ? '計測不能' : `${report.codexUsedPercent}%`}`, `- 生成日時: ${report.generatedAt}`, '- high があっても夜間処理は継続');
  return `${lines.slice(0, 15).join('\n')}\n`;
}

function parseArgs(argv) { const args = { dryRun: false, home: os.homedir(), now: new Date() }; for (let i = 0; i < argv.length; i++) { if (argv[i] === '--dry-run') args.dryRun = true; else if (argv[i] === '--home') args.home = argv[++i]; else if (argv[i] === '--now') args.now = new Date(argv[++i]); else throw new Error(`不明な引数: ${argv[i]}`); } if (!Number.isFinite(args.now.getTime())) throw new Error('--now は有効な ISO 日時を指定してください'); return args; }

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), metric = readCodexUsedPercent({});
  const findings = collectFindings({ home: args.home, now: args.now, codexUsedPercent: metric });
  if (!args.dryRun) { fs.mkdirSync(path.join(args.home, '.claude'), { recursive: true }); applyAutoHeal({ home: args.home, findings, now: args.now }); upsertFixTasks({ home: args.home, findings, now: args.now }); }
  const report = { generatedAt: args.now.toISOString(), timeoutWaste: timeoutWasteSummary(readJsonl(path.join(args.home, '.claude', 'executor-usage.jsonl'))), codexUsedPercent: measured(metric)?.usedPercent ?? null, codexExhausted: metric?.exhausted === true, findings };
  const summary = renderSummary(report);
  if (!args.dryRun) { fs.writeFileSync(path.join(args.home, '.claude', 'delegation-health.json'), `${JSON.stringify(report, null, 2)}\n`); fs.writeFileSync(path.join(args.home, '.claude', 'delegation-health.md'), summary); }
  process.stdout.write(summary);
}

if (isEntry(import.meta.url)) main();
