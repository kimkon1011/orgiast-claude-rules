#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { getDiscordMembers, matchMember } from './discord-member-directory.mjs';
import { isEntry } from './is-entry.mjs';
import { clipDiscordContent, KIM_DISCORD_USER_ID, resolveDiscordBotToken } from './notify-kim.mjs';
import { classifyKimDm } from './lib/kim-dm-policy.mjs';
import { redactSecrets } from './webhook-health.mjs';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'orgiast-discord-dm/1.0';

function safeContent(value) {
  return clipDiscordContent(redactSecrets(value)
    .replace(/([?&]Authorization=)[^&\s]+/gi, '$1[REDACTED]'));
}

async function defaultResolve(target, options) {
  const members = await getDiscordMembers({
    query: target,
    home: options.home,
    fetchImpl: options.directoryFetchImpl ?? options.fetchImpl,
  });
  return members && matchMember(target, members);
}

export async function sendDiscordDm(target, body, options = {}) {
  const home = options.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolve = options.resolve ?? defaultResolve;
  const recipient = await resolve(target, { ...options, home, fetchImpl });
  if (!recipient) {
    const error = new Error(`宛先「${target}」を一意に特定できません`);
    error.code = 'RECIPIENT_UNRESOLVED';
    throw error;
  }

  // kim 宛のシステム通知と違い、社内メンバーへの連絡は本文そのものが成果物。
  // notify-kim の toPlainJa（LLM 平易化）は通さない（実測: 「dry-run 検証」が
  // 「本番前のテスト確認」に書き換わり意味が変わる）。秘匿値の除去と長さ調整だけ行う。
  const content = safeContent(String(body ?? ''));
  let kimRecipient = null;
  let copyToKim = 'skipped';
  if (!options.noCopyKim) {
    try {
      kimRecipient = await resolve('金功勇', { ...options, home, fetchImpl });
      if (!kimRecipient) throw new Error('金功勇を一意に特定できません');
    } catch (error) {
      copyToKim = { delivered: false, error: error.message };
    }
  }
  const recipientName = recipient.displayName ?? recipient.label ?? recipient.username ?? '';
  const isKim = Boolean((kimRecipient && String(kimRecipient.id) === String(recipient.id))
    || String(recipient.id) === KIM_DISCORD_USER_ID || recipientName === '金功勇');
  if (isKim && options.kimActionRequired !== true) {
    const policy = classifyKimDm(body);
    if (!policy.allowed) {
      console.error(`kim への Discord DM を止めました（${policy.reason}）。PR のマージ・他PCへの依頼は fleet-mail --to kim-PC で送ってください`);
      return { delivered: 'blocked', category: policy.category, reason: policy.reason };
    }
  }
  if (options.dryRun) {
    if (kimRecipient && !isKim) copyToKim = { dryRun: true, recipient: kimRecipient };
    return { dryRun: true, recipient, content, copyToKim };
  }

  const token = options.token !== undefined ? options.token : resolveDiscordBotToken(home);
  if (!token) {
    const error = new Error('Discord Bot トークンが見つかりません');
    error.code = 'DISCORD_TOKEN_MISSING';
    throw error;
  }
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  const deliver = async (to, message) => {
    const dm = await fetchImpl(`${API}/users/@me/channels`, {
      method: 'POST', headers, body: JSON.stringify({ recipient_id: to.id }),
    });
    if (!dm.ok) throw new Error(`DMチャンネル作成が HTTP ${dm.status}`);
    const channelId = (await dm.json()).id;
    if (!channelId) throw new Error('DMチャンネルIDを取得できません');
    const sent = await fetchImpl(`${API}/channels/${channelId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ content: message }),
    });
    if (!sent.ok) throw new Error(`DM送信が HTTP ${sent.status}`);
    return channelId;
  };
  const channelId = await deliver(recipient, content);
  if (kimRecipient && !isKim) {
    const displayName = recipient.displayName ?? recipient.label ?? recipient.username ?? target;
    try {
      const copyChannelId = await deliver(kimRecipient, safeContent(`【写し】${displayName}さんへ送った内容\n\n${body ?? ''}`));
      copyToKim = { delivered: true, recipient: kimRecipient, channelId: copyChannelId };
    } catch (error) {
      copyToKim = { delivered: false, error: error.message };
    }
  }
  return { delivered: true, recipient, channelId, copyToKim };
}

function parseArgs(args) {
  const target = args[0] && !args[0].startsWith('--') ? args[0] : '';
  let body;
  let bodyFile;
  let dryRun = false;
  let noCopyKim = false;
  let kimActionRequired = false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--body') body = args[++i];
    else if (args[i] === '--body-file') bodyFile = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--no-copy-kim') noCopyKim = true;
    else if (args[i] === '--kim-action-required') kimActionRequired = true;
    else throw new Error(`不明な引数です: ${args[i]}`);
  }
  if (!target || (body === undefined) === (bodyFile === undefined)) {
    throw new Error('usage: discord-dm.mjs <名前 or メール> (--body <本文> | --body-file <path>) [--dry-run] [--no-copy-kim] [--kim-action-required]');
  }
  return { target, body: bodyFile === undefined ? body : fs.readFileSync(bodyFile, 'utf8'), dryRun, noCopyKim, kimActionRequired };
}

export async function main(args = process.argv.slice(2), options = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) { console.error(`discord-dm: ${error.message}`); return 1; }
  try {
    const result = await sendDiscordDm(parsed.target, parsed.body, { ...options, dryRun: parsed.dryRun, noCopyKim: parsed.noCopyKim, kimActionRequired: parsed.kimActionRequired });
    console.log(JSON.stringify(result));
    return result.delivered === 'blocked' ? 3 : 0;
  } catch (error) {
    const exitCode = error.code === 'RECIPIENT_UNRESOLVED' ? 3 : error.code === 'DISCORD_TOKEN_MISSING' ? 2 : 1;
    console.error(`discord-dm: ${error.message}`);
    console.log(JSON.stringify({ ok: false, target: parsed.target, error: error.code ?? 'SEND_FAILED' }));
    return exitCode;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
