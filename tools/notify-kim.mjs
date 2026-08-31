#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { redactSecrets } from './webhook-health.mjs';

const API = 'https://discord.com/api/v10';
const MAX_CONTENT = 2_000;
const OMITTED = '…(以下省略)';
const USER_AGENT = 'orgiast-notify-kim/1.0';

function readTrimmed(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }

export function clipDiscordContent(text) {
  const content = String(text ?? '');
  return content.length <= MAX_CONTENT ? content : `${content.slice(0, MAX_CONTENT - OMITTED.length)}${OMITTED}`;
}

async function postWebhook(url, content, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Webhook送信が HTTP ${response.status}`);
}

export async function notifyKim(text, {
  home = process.env.ORGIAST_HOME || os.homedir(),
  userId,
  token,
  fetchImpl = globalThis.fetch,
  webhookFallback = true,
} = {}) {
  const resolvedUserId = userId !== undefined ? userId : (process.env.ORGIAST_DISCORD_USER_ID?.trim()
    || readTrimmed(path.join(home, '.claude', 'orgiast-discord-user-id.txt')));
  const resolvedToken = token !== undefined ? token : (process.env.DISCORD_BOT_TOKEN?.trim()
    || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt')));
  const content = clipDiscordContent(text);
  let dmReason = '';

  if (resolvedUserId && resolvedToken) {
    try {
      const headers = {
        Authorization: `Bot ${resolvedToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      };
      const dm = await fetchImpl(`${API}/users/@me/channels`, {
        method: 'POST', headers, body: JSON.stringify({ recipient_id: resolvedUserId }), signal: AbortSignal.timeout(20_000),
      });
      if (!dm.ok) throw new Error(`DMチャンネル作成が HTTP ${dm.status}`);
      const channelId = (await dm.json()).id;
      if (!channelId) throw new Error('DMチャンネルIDを取得できません');
      const sent = await fetchImpl(`${API}/channels/${channelId}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ content }), signal: AbortSignal.timeout(20_000),
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
    const webhook = readTrimmed(path.join(home, '.claude', 'orgiast-discord-webhook.txt'));
    if (webhook) {
      try {
        await postWebhook(webhook, content, fetchImpl);
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
