#!/usr/bin/env node
import { isKimRecipient } from './lib/kim-dm-policy.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { getDiscordMembers, matchMember } from './discord-member-directory.mjs';
import { isEntry } from './is-entry.mjs';
import { clipDiscordContent, KIM_DISCORD_USER_ID, resolveDiscordBotToken } from './notify-kim.mjs';
import { addItem, isKimSeat } from './kim-inbox.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { assertContextApproved, latestOf, recordOutbound } from './lib/send-context.mjs';
import { detectPlaceholders } from './lib/placeholder-detect.mjs';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'orgiast-discord-dm/1.0';
// Bot 宛ての返信は kim の目に入らないため、kim 以外への代筆には毎回返答先を明記する（kim 2026-10-30）。
export const REPLY_TO_KIM_FOOTER = 'このメッセージへの返答は、Bot ではなく金に直接お願いします。';

export function withReplyToKimFooter(body) {
  const text = String(body ?? '').trimEnd();
  return text.includes(REPLY_TO_KIM_FOOTER) ? text : `${text}\n\n${REPLY_TO_KIM_FOOTER}`;
}

// ログ・台帳向け: 秘匿値を隠す。送信本文には適用しない（送信は原文をそのまま送る）。
function safeContent(value) {
  return clipDiscordContent(redactSecrets(value)
    .replace(/([?&]Authorization=)[^&\s]+/gi, '$1[REDACTED]'));
}

// 送信後に Discord からメッセージを読み戻し、送った本文と一致するか検証する。
// 不一致なら readBack: "mismatch" を返して exit 非0相当のエラーを投げる。
export async function readBackMessage(channelId, messageId, expectedBody, options = {}) {
  const token = options.token ?? resolveDiscordBotToken(options.home ?? process.env.ORGIAST_HOME ?? os.homedir());
  if (!token) throw new Error('readBack: Discord Bot トークンが見つかりません');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = {
    Authorization: `Bot ${token}`,
    'User-Agent': USER_AGENT,
  };
  const response = await fetchImpl(`${API}/channels/${channelId}/messages/${messageId}`, { headers });
  if (!response.ok) throw new Error(`readBack: メッセージ取得が HTTP ${response.status}`);
  const message = await response.json();
  const actualContent = String(message.content ?? '');
  return actualContent === expectedBody ? 'match' : 'mismatch';
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

  // 🔴 無人(ヘッドレス・auto-session)からの人宛て送信は拒否する（2026-11-09 事故）。
  // kim-inbox に ask として本文を積み、送信しない。
  const unattended = process.env.CLAUDE_HEADLESS === '1' || /^(?:auto-progress|auto-session)(?::|$)/.test(String(process.env.ORGIAST_HEADLESS_JOB || ''));
  if (unattended && !options.unattendedOverride) {
    const item = await addItem(home, { kind: 'ask', text: `【無人送信ブロック】${target} への DM 本文:\n${body ?? ''}`, source: 'discord-dm-blocked' });
    return { delivered: 'blocked', reason: 'unattended', inboxItem: item.id, recipient };
  }

  // 🔴 本文に伏せ字・プレースホルダが含まれていたら送信しない（2026-11-09 事故）。
  const { hasPlaceholder, matches } = detectPlaceholders(body);
  if (hasPlaceholder && !options.overridePlaceholder) {
    const snippet = matches.join(', ');
    throw Object.assign(new Error(`本文に伏せ字/プレースホルダが含まれています: ${snippet}`), { code: 'PLACEHOLDER_IN_BODY' });
  }

  // kim 宛のシステム通知と違い、社内メンバーへの連絡は本文そのものが成果物。
  // notify-kim の toPlainJa（LLM 平易化）は通さない（実測: 「dry-run 検証」が
  // 「本番前のテスト確認」に書き換わり意味が変わる）。
  // 送信本文は原文のまま（safeContent はログ・台帳向けにのみ使う）。
  let copyToKim = 'skipped';
  const recipientName = recipient.displayName ?? recipient.label ?? recipient.username ?? '';
  const isKim = isKimRecipient({ id: recipient.id, name: recipientName });
  const inbox = isKim;
  if (!options.noCopyKim && !isKim) copyToKim = isKimSeat(home) ? 'in-session' : 'session-inbox';
  const finalBody = isKim || options.noReplyFooter ? String(body ?? '').trimEnd() : withReplyToKimFooter(body);
  // ログ用にのみ秘匿値を隠す（送信本文は原文のまま）。
  const displayContent = safeContent(finalBody);
  if (options.dryRun) return { dryRun: true, recipient, content: displayContent, copyToKim, ...(inbox ? { delivered: 'session-inbox' } : {}) };
  if (inbox) {
    const item = await addItem(home, { kind: options.kimActionRequired || ['action', 'ask'].includes(options.kind) ? 'ask' : 'info', text: body, source: 'discord-dm' });
    return { delivered: 'session-inbox', id: item.id, copyToKim };
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
    await (options.assertContextApproved ?? assertContextApproved)({ channel: 'discord', target: channelId, text: body, home, getLatest: async () => {
      const history = await fetchImpl(`${API}/channels/${channelId}/messages?limit=1`, { headers });
      if (!history.ok) throw new Error(`Discord 履歴取得が HTTP ${history.status}`);
      return latestOf((await history.json()).map(m => ({ id: m.id, at: m.timestamp })));
    }});
    const sent = await fetchImpl(`${API}/channels/${channelId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ content: message }),
    });
    if (!sent.ok) throw new Error(`DM送信が HTTP ${sent.status}`);
    const sentMessage = await sent.json();
    recordOutbound({ channel: 'discord', target: channelId, text: body, messageId: sentMessage.id }, home);
    return { channelId, messageId: sentMessage.id };
  };
  // 送信は原文のまま（safeContent 未適用の finalBody を送る）
  const { channelId, messageId } = await deliver(recipient, finalBody);

  // 🔴 送信後に Discord からメッセージを読み戻し、送った本文と一致するか検証する（2026-11-09 事故）。
  let readBack = 'unchecked';
  try {
    readBack = await readBackMessage(channelId, messageId, finalBody, { home, token, fetchImpl });
  } catch (error) {
    readBack = `error: ${error.message}`;
  }

  if (copyToKim === 'session-inbox') {
    const displayName = recipient.displayName ?? recipient.label ?? recipient.username ?? target;
    try {
      const item = await addItem(home, { kind: 'info', text: `（写し）${displayName} へ送信: ${displayContent}`, source: 'discord-dm-copy' });
      copyToKim = { delivered: 'session-inbox', id: item.id, status: item.status };
    } catch (error) { copyToKim = { delivered: false, error: error.message }; }
  }

  return { delivered: true, recipient, channelId, messageId, readBack, copyToKim };
}

function parseArgs(args) {
  const target = args[0] && !args[0].startsWith('--') ? args[0] : '';
  let body;
  let bodyFile;
  let dryRun = false;
  let noCopyKim = false;
  let kimActionRequired = false;
  let noReplyFooter = false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--body') body = args[++i];
    else if (args[i] === '--body-file') bodyFile = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--no-copy-kim') noCopyKim = true;
    else if (args[i] === '--kim-action-required') kimActionRequired = true;
    else if (args[i] === '--no-reply-footer') noReplyFooter = true;
    else throw new Error(`不明な引数です: ${args[i]}`);
  }
  if (!target || (body === undefined) === (bodyFile === undefined)) {
    throw new Error('usage: discord-dm.mjs <名前 or メール> (--body <本文> | --body-file <path>) [--dry-run] [--no-copy-kim] [--no-reply-footer] [--kim-action-required]');
  }
  return { target, body: bodyFile === undefined ? body : fs.readFileSync(bodyFile, 'utf8'), dryRun, noCopyKim, noReplyFooter, kimActionRequired };
}

export async function main(args = process.argv.slice(2), options = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) { console.error(`discord-dm: ${error.message}`); return 1; }
  try {
    const result = await sendDiscordDm(parsed.target, parsed.body, { ...options, dryRun: parsed.dryRun, noCopyKim: parsed.noCopyKim, noReplyFooter: parsed.noReplyFooter, kimActionRequired: parsed.kimActionRequired });
    console.log(JSON.stringify(result));
    return result.delivered === 'blocked' ? 3 : 0; // blocked は exit 3 で呼び出し元に知らせる
  } catch (error) {
    const exitCode = error.code === 'RECIPIENT_UNRESOLVED' ? 3 : error.code === 'PLACEHOLDER_IN_BODY' ? 4 : error.code === 'DISCORD_TOKEN_MISSING' ? 2 : 1;
    console.error(`discord-dm: ${error.message}`);
    console.log(JSON.stringify({ ok: false, target: parsed.target, error: error.code ?? 'SEND_FAILED' }));
    return exitCode;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
