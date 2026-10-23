#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { toPlainJa } from './lib/plain-ja.mjs';
import { redactSecrets } from './webhook-health.mjs';

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
const normalizeFailure = text => String(text).replace(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, '<日時>').replace(/\d+\s*(?:回|件|日|時間|分|秒)/g, '<回数>').replace(/\s+/g, ' ').trim();

// Use the existing next-session TODO consumer; no separate repair queue.
export async function notifyKim(text, options = {}) {
  const raw = redactSecrets(String(text ?? ''));
  const humanEvidence = /^(?:試行|試した内容|試した修復)[:：][ \t]*\S.+$/m.test(raw)
    && /^証拠[:：][ \t]*\S.+$/m.test(raw) && /^必要な操作[:：][ \t]*\S.+$/m.test(raw);
  const failure = FAILURE.test(raw), handoff = !humanEvidence && HANDOFF.test(raw);
  if (!failure && !handoff) return deliverKim(raw, options);
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const now = options.now ?? Date.now();
  const source = options.source || raw.split('\n').find(line => line.trim()) || '通知';
  const cause = options.cause || raw.match(/原因[:：][ \t]*([^\n]+)/)?.[1] || raw.split('\n').filter(line => FAILURE.test(line)).join('\n') || source;
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
    const needsTask = handoff || !/^原因[:：][ \t]*\S.+$/m.test(raw) || !/^対処[:：][ \t]*\S.+$/m.test(raw);
    if (needsTask) {
      const file = path.join(home, '.claude', 'next-session.md');
      const marker = `<!-- notify-kim:${key} -->`;
      let todo = '';
      try { todo = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!todo.split('\n').some(line => line.includes(marker) && /\[ \]/.test(line))) {
        const item = `1. [ ] 通知の原因調査・修復: ${raw.replace(/\s+/g, ' ').slice(0, 1400)}。実ログで原因を確定し、修正・再検証する。人の操作が不可欠なら試行と証拠を記録する。 ${marker}\n`;
        // Append in one write so other sessions' new TODOs are never overwritten.
        fs.appendFileSync(file, `\n<!-- NEXT-SESSION v1 -->\n## 次の1目的\n通知の原因調査と修復\n## 残TODO\n${item}`);
      }
      if (handoff) body = raw.split('\n').filter(line => !HANDOFF.test(line) && !/^\s*[123][.．]\s/.test(line)).join('\n');
      suffix = `\n原因: ${raw.match(/^原因[:：][ \t]*(.+)$/m)?.[1]?.slice(0, 240) || '未確定（実ログの調査を起票）'}\n対処: 原因調査と修復を自動起票しました。\n自動起票: ${file}（通知修復 ${key}）`;
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

async function deliverKim(text, {
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
  const translated = plainJa ? await plainJaImpl(String(text ?? '')) : text;
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
      return { delivered: 'dm' };
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

async function main() {
  await notifyKim(process.argv.slice(2).join(' '));
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
