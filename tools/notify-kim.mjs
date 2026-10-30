#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { toPlainJa } from './lib/plain-ja.mjs';
import { classifyKimDm } from './lib/kim-dm-policy.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { annotateAccounts } from './url-account-gate.mjs';

const API = 'https://discord.com/api/v10';
const MAX_CONTENT = 2_000;
const OMITTED = '…(以下省略)';
const USER_AGENT = 'orgiast-notify-kim/1.0';
// kim の Discord ユーザーID（秘密ではない）。設定ファイルの無い PC でも DM が届くよう既定値にする。
export const KIM_DISCORD_USER_ID = '715210673642012733';

function readTrimmed(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }

// 監視側も同じ秘密の取得経路を使う。
export function resolveDiscordBotToken(home = process.env.ORGIAST_HOME || os.homedir()) {
  return process.env.DISCORD_BOT_TOKEN?.trim()
    || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'));
}

export function clipDiscordContent(text) {
  const content = String(text ?? '');
  return content.length <= MAX_CONTENT ? content : `${content.slice(0, MAX_CONTENT - OMITTED.length)}${OMITTED}`;
}

async function postWebhook(url, content, fetchImpl, signal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ content }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Webhook送信が HTTP ${response.status}`);
}

const FAILURE = /failed|failure|失敗|停止|異常|エラー|timeout|timed out|タイムアウト|未計測|取得不可/i;
const HANDOFF = /接続し[て、]|接続して確認|どれを選|選んでほしい|原因調査.*(?:選択|選ん)|(?:ログ|結果|接続|認証).*確認(?:して|するよう|してください)/;
// 完了報告・定時ダイジェストは「結果の知らせ」であって失敗通知ではない。本文には経過説明として
// failed / 失敗 が引用されることが多く、それを失敗とみなして next-session.md へ修復TODOを起票すると、
// そのTODO（目的が「通知の原因調査と修復」になる）が次の自動セッションを生み、その完了報告が
// また起票される自己増殖ループになる（2026-10-24 実測: 06:15 と 12:05 の完了DMが
// next-session.md の第5・第6ブロックとして起票され、同じ目的のセッションが繰り返された）。
const STATUS_REPORT = /✅\s*自動進行が完了しました|^【[^\n]*の自動進行】\s*完了/m;
// 既に起票した本文（マーカー付き）を別経路が再通知しても二重起票しない。
const ALREADY_FILED = /<!--\s*notify-kim:[0-9a-f]{20}\s*-->/;
// notify-owner.mjs は本文の先頭に「宛先: ...」行を付ける。これは通知経路のメタ情報で、
// 失敗の同一性（重複起票のキー）や本文の分類には含めない（2026-10-25 実測: 宛先文言の差で
// 同じ freee トークン依頼が2件に分かれた）。
const OWNER_ADDRESS_LINE = /^宛先[:：][^\n]{0,80}$/;
export function stripOwnerAddress(text) {
  return String(text ?? '').split('\n').filter((line) => !OWNER_ADDRESS_LINE.test(line.trim())).join('\n');
}
// 利用者への判断依頼は「失敗」ではない。無人レーンでは実行できないので [判断待ち] として起票する。
const JUDGMENT_REQUEST = /^自動進行が判断待ちです[:：]/m;
// auto-progress が API エラーで止まった依頼を自動再開したときの案内。修復対象ではない。
const AUTO_RESUME_NOTICE = /^エラーで止まっていた依頼を見つけ、自動で再開します。?$/m;
const RESUME_REPORT = /^夜間セッション再開 \([^\n)]*\)$/m;
const RESUME_ROW = /\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\): (?:progressed|no-progress|error)$/mi;
const RESUME_ERROR = /\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\): error$/mi;
// 目的文に引用された過去の失敗ではなく、今回の結果と中止の有無で判定する。
// 結果行が1行も無い本文は再開レポートとみなさない（見出しだけの失敗通知を塞がない）。
function isSuccessfulResumeReport(text) {
  return RESUME_REPORT.test(text) && RESUME_ROW.test(text) && !RESUME_ERROR.test(text)
    && !text.includes('連続2件エラーのため今晩は中止');
}
const normalizeFailure = text => String(text).replace(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, '<日時>').replace(/\d+\s*(?:回|件|日|時間|分|秒)/g, '<回数>').replace(/\d+(?:\.\d+)?%/g, '<割合>').replace(/\btick\s*:\s*\d+\b/gi, 'tick: <番号>').replace(/\s+/g, ' ').trim();

// Use the existing next-session TODO consumer; no separate repair queue.
export async function notifyKim(text, options = {}) {
  if (options.kimActionRequired !== true) {
    const policy = classifyKimDm(text);
    if (!policy.allowed) {
      console.error(`kim への Discord DM を止めました（${policy.reason}）。PR のマージ・他PCへの依頼は fleet-mail --to kim-PC で送ってください`);
      return { delivered: 'blocked', category: policy.category, reason: policy.reason };
    }
  }
  const raw = redactSecrets(String(text ?? ''));
  const bodyText = stripOwnerAddress(raw);
  if (STATUS_REPORT.test(bodyText) || ALREADY_FILED.test(bodyText) || isSuccessfulResumeReport(bodyText) || AUTO_RESUME_NOTICE.test(bodyText)) return deliverKim(raw, options);
  const judgment = JUDGMENT_REQUEST.test(bodyText);
  const humanEvidence = /^(?:試行|試した内容|試した修復)[:：][ \t]*\S.+$/m.test(bodyText)
    && /^証拠[:：][ \t]*\S.+$/m.test(bodyText) && /^必要な操作[:：][ \t]*\S.+$/m.test(bodyText);
  const benignQuotaReport = benignQuotaSweepReport(bodyText);
  const failure = !judgment && !benignQuotaReport && (FAILURE.test(bodyText) || (RESUME_REPORT.test(bodyText) && RESUME_ERROR.test(bodyText)));
  const handoff = !judgment && !benignQuotaReport && !humanEvidence && HANDOFF.test(bodyText);
  if (!judgment && !failure && !handoff) return deliverKim(raw, options);
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const now = options.now ?? Date.now();
  const source = options.source ? stripOwnerAddress(options.source) : bodyText.split('\n').find(line => line.trim()) || '通知';
  const cause = options.cause || (judgment
    ? bodyText.match(/^自動進行が判断待ちです[:：][ \t]*([^\n]+)$/m)?.[1] || source
    : bodyText.match(/原因[:：][ \t]*([^\n]+)/)?.[1] || bodyText.split('\n').filter(line => FAILURE.test(line)).join('\n') || source);
  const key = createHash('sha256').update(`${options.userId || KIM_DISCORD_USER_ID}\n${normalizeFailure(source)}\n${normalizeFailure(cause)}`).digest('hex').slice(0, 20);
  const dir = path.join(home, '.claude', 'notify-kim');
  const stateFile = path.join(dir, `${key}.json`);
  const lock = path.join(dir, `${key}.lock`);
  let fd;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Serialize identical failures; unrelated notifications need not wait for network I/O.
    for (let retry = 0; ; retry++) {
      try {
        fd = fs.openSync(lock, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), platform: process.platform }));
        break;
      }
      catch (error) {
        if (error.code !== 'EEXIST' || retry >= 100) throw error;
        try {
          const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (owner.host === os.hostname() && owner.platform === process.platform && Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (pidError) { if (pidError.code === 'ESRCH') fs.unlinkSync(lock); }
          }
        } catch { /* Unknown lock owners are never removed. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.sentAt != null && now >= state.sentAt && now - state.sentAt < 86_400_000) return { delivered: 'suppressed', reason: 'same-source-cause-24h' };
    let suffix = '';
    let body = raw;
    // 起票済みの修復TODOを引用した通知（quota-sweep の目標報告等）を再起票すると、TODO を包んだ TODO が新キーで増殖する（2026-10-29 b575a7d3）。
    const nested = !judgment && /通知の原因調査・修復[:：]/.test(bodyText);
    const needsTask = !judgment && !nested && (handoff || !/^原因[:：][ \t]*\S.+$/m.test(bodyText) || !/^対処[:：][ \t]*\S.+$/m.test(bodyText));
    if (nested) suffix = '\n対処: 引用元の修復TODOで追跡中（新規起票なし）';
    else if (judgment || needsTask) {
      const file = path.join(home, '.claude', 'next-session.md');
      const marker = `<!-- notify-kim:${key} -->`;
      let todo = '';
      try { todo = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!todo.split('\n').some(line => line.includes(marker) && /\[ \]/.test(line))) {
        const item = judgment
          ? `1. [ ] [判断待ち] ${bodyText.replace(/\s+/g, ' ').slice(0, 1400)} ${marker}\n`
          : `1. [ ] 通知の原因調査・修復: ${bodyText.replace(/\s+/g, ' ').slice(0, 1400)}。実ログで原因を確定し、修正・再検証する。人の操作が不可欠なら試行と証拠を記録する。 ${marker}\n`;
        // Append in one write so other sessions' new TODOs are never overwritten.
        fs.appendFileSync(file, `\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n${item}`);
      }
      if (judgment) suffix = `\n自動起票: ${file}（判断待ち ${key}）`;
      else {
        if (handoff) body = raw.split('\n').filter(line => !HANDOFF.test(line) && !/^\s*[123][.．]\s/.test(line)).join('\n');
        suffix = `\n原因: ${bodyText.match(/^原因[:：][ \t]*(.+)$/m)?.[1]?.slice(0, 240) || '未確定（実ログの調査を起票）'}\n対処: 原因調査と修復を自動起票しました。\n自動起票: ${file}（通知修復 ${key}）`;
      }
    } else {
      // Preserve evidence across LLM rewriting and Discord's content limit.
      suffix = '\n' + ['原因', '対処'].map(label => raw.split('\n').find(line => line.startsWith(label + ':') || line.startsWith(label + '：')).slice(0, 400)).join('\n');
    }
    const result = await deliverKim(body, { ...options, suffix, allowHumanRequest: humanEvidence });
    if (result.delivered === 'dm' || result.delivered === 'webhook') {
      const temp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ sentAt: now })); fs.renameSync(temp, stateFile);
    }
    return result;
  } catch (error) {
    return { delivered: 'none', reason: `通知ゲート: ${redactSecrets(error.message)}` };
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

// quota-sweep の進捗通知は outcome 行が結果の正本。目的文には過去の失敗説明
// （例:「window-info の連続失敗」）が引用されるため本文全体で判定すると、deferred
// （一時的な 429 で次回へ延期）や final（完了）まで失敗と誤判定して修復TODOを起票する。
// 2026-10-25 実測: 10:41/10:56 の deferred 通知は 04:13:45 と同一キーの24時間抑制に
// 守られていただけで、抑制が切れれば同じ「通知の原因調査と修復」TODOが再生成される。
const QUOTA_SWEEP_OUTCOME = /^(?:failed|deferred|final|deadline|ceiling|exhausted|成果あり・未完了)$/;
const QUOTA_SWEEP_BENIGN = new Set(['final', 'deferred', '成果あり・未完了']);
function benignQuotaSweepReport(text) {
  const lines = String(text ?? '').split('\n').map(line => line.trim());
  if (lines.length < 6) return false;
  if (!/^[^\s/]+\/[^\s/]+$/.test(lines[0])) return false;
  if (!/^\d+% → (?:\d+|\?)%$/.test(lines[1])) return false;
  if (!/^tick: \d+$/.test(lines[2])) return false;
  const outcome = lines.find((line, index) => index >= 4 && QUOTA_SWEEP_OUTCOME.test(line));
  return QUOTA_SWEEP_BENIGN.has(outcome);
}

export async function deliverKim(text, {
  home = process.env.ORGIAST_HOME || os.homedir(),
  userId,
  token,
  fetchImpl = globalThis.fetch,
  webhookFallback = true,
  fleetFallback = false,
  signal,
  plainJa = process.env.NOTIFY_PLAIN_JA !== '0',
  plainJaImpl = toPlainJa,
  suffix = '',
  allowHumanRequest = false,
} = {}) {
  const resolvedUserId = userId !== undefined ? userId : (process.env.ORGIAST_DISCORD_USER_ID?.trim()
    || readTrimmed(path.join(home, '.claude', 'orgiast-discord-user-id.txt'))
    || KIM_DISCORD_USER_ID);
  const resolvedToken = token !== undefined ? token : resolveDiscordBotToken(home);
  // kim 宛の全通知を、システムを知らない人でも読める日本語にしてから送る。
  // 失敗しても送信は止めない(plainJaImpl は例外を投げない契約)。
  // 平易化の書き換えでアカウント表記が落ちることがあるため、書き換え後の本文で補う。
  const translated = annotateAccounts(plainJa ? await plainJaImpl(String(text ?? '')) : text);
  const body = suffix && !allowHumanRequest ? String(translated).split('\n').filter(line => !HANDOFF.test(line)).join('\n') : translated;
  const content = suffix ? String(body).slice(0, Math.max(0, MAX_CONTENT - suffix.length)) + suffix : clipDiscordContent(body);
  let dmReason = '';

  if (resolvedUserId && resolvedToken) {
    try {
      const headers = {
        Authorization: `Bot ${resolvedToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      };
      const dm = await fetchImpl(`${API}/users/@me/channels`, {
        method: 'POST', headers, body: JSON.stringify({ recipient_id: resolvedUserId }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      if (!dm.ok) throw new Error(`DMチャンネル作成が HTTP ${dm.status}`);
      const channelId = (await dm.json()).id;
      if (!channelId) throw new Error('DMチャンネルIDを取得できません');
      const sent = await fetchImpl(`${API}/channels/${channelId}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ content }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      if (!sent.ok) throw new Error(`DM送信が HTTP ${sent.status}`);
      const messageId = (await sent.json()).id;
      if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('DMメッセージIDを取得できません');
      return { delivered: 'dm', messageId, channelId, recipientId: resolvedUserId, httpStatus: sent.status };
    } catch (error) {
      dmReason = redactSecrets(error?.message ?? error);
    }
  } else {
    dmReason = !resolvedToken ? 'Discord Bot トークンがありません' : 'kim の Discord ユーザーIDがありません';
  }

  if (webhookFallback) {
    const webhook = (fleetFallback ? readEnvValue(path.join(home, '.claude', 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK') : '')
      || readTrimmed(path.join(home, '.claude', 'orgiast-discord-webhook.txt'));
    if (webhook) {
      try {
        await postWebhook(webhook, content, fetchImpl, signal);
        console.error(`notify-kim: DMで送れないため webhook へフォールバックしました (${dmReason})`);
        return { delivered: 'webhook', reason: dmReason };
      } catch (error) {
        const webhookReason = redactSecrets(error?.message ?? error);
        console.error(`notify-kim: DM/webhook のどちらにも送れません (${dmReason}; ${webhookReason})`);
        return { delivered: 'none', reason: `${dmReason}; ${webhookReason}` };
      }
    }
  }
  console.error(`notify-kim: 通知先を解決できず送信しません (${dmReason})`);
  return { delivered: 'none', reason: dmReason };
}

export async function main(args = process.argv.slice(2), options = {}) {
  const kimActionRequired = args.includes('--kim-action-required');
  const text = args.filter(arg => arg !== '--kim-action-required').join(' ');
  const result = await notifyKim(text, { ...options, kimActionRequired });
  return result.delivered === 'blocked' ? 3 : 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
