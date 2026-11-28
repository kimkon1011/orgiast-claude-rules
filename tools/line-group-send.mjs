#!/usr/bin/env node
// LINE グループへ、その場の Claude Code から直接送る（kim-PC への中継は使わない）。
// 一回にまとめる：出す前に同じ案件・同じ相手・同じ締切の作業（直送・控え・別送・追加署名など）を全部洗い出して1回にまとめる。分けるときは理由を書く（詳細はCLAUDE.md『一回にまとめる』）
// 送信者は LINE 公式アカウント「オージャスト金(読取専用)」@458zwuhb（グループに参加済みの bot）。
// 使い方: node tools/line-group-send.mjs --group <groupId|グループ名> --text-file <本文.txt> [--image <png/jpg> ...] [--dry-run]
//   画像は Supabase Storage（line-media/outbound/）へ上げ、1年有効の署名URLで送る。1MB 超は送れないので先に JPEG 化すること。
//   送信後は push の HTTP 200 と sentMessages の件数を表示する。同じ --retry-key で再実行しても二重送信されない。
// 鍵: LINE_CHANNEL_ACCESS_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を env → ~/.claude/line-send.env の順に読む。
//   どちらにも無ければ ~/.claude/vercel.env の VERCEL_TOKEN で営業アプリ（aujust-sales-automation）の development env から取り、line-send.env に保存する。
import { readFileSync } from 'node:fs';
import { loadSecrets, resolveGroup } from './lib/line-group-access.mjs';
export { loadSecrets, resolveGroup, normalizeGroupName } from './lib/line-group-access.mjs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { assertContextApproved, latestOf, readOutbound, recordOutbound } from './lib/send-context.mjs';
import { assertSendConsistency, afterSendCleanup } from './send-consistency-check.mjs';
import { assertNoHandback, stripHumanOnly } from './lib/handback-guard.mjs';
import { checkChannelReply, assertReplyCheck } from './lib/pre-send-reply-check.mjs';
import { findSecretaryBookingUrls, SECRETARY_BOOKING_URL_REASON } from './lib/secretary-booking-url.mjs';

/** 任意の文字列を UUID v5 形式（SHA-256 ベース・決定論的）に変換する。同じ文字列→同じUUID。
 *  LINE API の X-Line-Retry-Key は UUID 形式が必要だが、人間が覚えやすい任意文字列を指定できるようにするため。 */
export function strToUUID(s) {
  const h = createHash('sha256');
  h.update(s);
  const hex = Buffer.from(h.digest()).toString('hex');
  // UUID v5 形式: version=5 (0101), variant=8 (10xx)
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

const USAGE = '使い方: node tools/line-group-send.mjs --group <groupId|グループ名> --text-file <本文.txt> [--image <画像> ...] [--retry-key <uuid>] [--dry-run]';
const MAX_IMAGE_BYTES = 1024 * 1024;

export function parseArgs(argv) {
  const o = { images: [], dryRun: false, skipContextCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--skip-context-check') o.skipContextCheck = true;
    else if (a === '--group') { o.group = v; i += 1; }
    else if (a === '--text-file') { o.textFile = v; i += 1; }
    else if (a === '--image') { o.images.push(v); i += 1; }
    else if (a === '--retry-key') { o.retryKey = v; i += 1; }
    else throw new Error(`不明なオプション: ${a}\n${USAGE}`);
  }
  if (!o.group || (!o.textFile && o.images.length === 0)) throw new Error(USAGE);
  return o;
}

const sbHeaders = (s) => ({ apikey: s.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${s.SUPABASE_SERVICE_ROLE_KEY}` });

async function uploadImage(s, file) {
  const buf = readFileSync(file);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${file} が 1MB を超えている（${buf.length} bytes）。JPEG に変換してから送る`);
  const ext = file.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const key = `outbound/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
  const up = await fetch(`${s.SUPABASE_URL}/storage/v1/object/line-media/${key}`, {
    method: 'POST', headers: { ...sbHeaders(s), 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg' }, body: buf,
  });
  if (!up.ok) throw new Error(`画像アップロード失敗 ${up.status} ${await up.text()}`);
  const sign = await (await fetch(`${s.SUPABASE_URL}/storage/v1/object/sign/line-media/${key}`, {
    method: 'POST', headers: { ...sbHeaders(s), 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 365 }),
  })).json();
  if (!sign.signedURL) throw new Error(`署名URLの発行に失敗: ${JSON.stringify(sign).slice(0, 200)}`);
  return `${s.SUPABASE_URL}/storage/v1${sign.signedURL}`;
}

// ONBOARDING「人が読む配信」の送信前ガード: 文字化け・プレースホルダ残りは送らずに落とす。
export function applyLineHandbackGuard(text, { env = process.env, skipHandbackGuard = false, ...options } = {}) {
  const src = String(text ?? '');
  if (!skipHandbackGuard) assertNoHandback(src, { env, ...options, channel: 'line' });
  return stripHumanOnly(src).trim();
}

export function assertSendableText(text) {
  if (!text) return;
  const japanese = (text.match(/[぀-ヿ一-鿿]/g) || []).length;
  const latin1 = (text.match(/[\u0080-ÿ]/g) || []).length;
  if (japanese === 0 && latin1 >= 5) throw new Error('本文が文字化けしている（日本語0文字・U+0080-00FF が多数）');
  const placeholder = text.match(/XX|\{\{|\}\}|【要記入】|（記入）|TODO/);
  if (placeholder) throw new Error(`本文にプレースホルダが残っている: ${placeholder[0]}`);
  const bookingUrls = findSecretaryBookingUrls(text);
  if (bookingUrls.length) throw new Error(SECRETARY_BOOKING_URL_REASON);
}

export function buildMessages(text, imageUrls) {
  const msgs = [];
  if (text) msgs.push({ type: 'text', text });
  for (const u of imageUrls) msgs.push({ type: 'image', originalContentUrl: u, previewImageUrl: u });
  const chunks = [];
  for (let i = 0; i < msgs.length; i += 5) chunks.push(msgs.slice(i, i + 5));
  return chunks;
}

export function assertPushSucceeded(response, body) {
  if (response.ok) return;
  if (response.status === 429) {
    console.error('[line-group-send] LINE bot の月間枠切れ。代替: Beeper 経由で kim の LINE から送る → node tools/send-context-check.mjs --channel beeper --target <beeperChatID> --text-file <本文> の後、reply-queue で receipt を作り node tools/beeper-send.mjs --chat <beeperChatID> --body-file <本文> --queue-id <id> --receipt <rid>。kim に手動コピペ・有料プランを選ばせない。');
  }
  throw new Error(`push 失敗 ${response.status} ${body}`);
}

import { prepareTemaSend } from './lib/unattended-tema.mjs';
export async function main(argv=process.argv.slice(2), deps={}) {
  const o = parseArgs(argv);
  const fetch = deps.fetchImpl ?? globalThis.fetch;
  const s = await (deps.loadSecrets ?? loadSecrets)();
  const L = { Authorization: `Bearer ${s.LINE_CHANNEL_ACCESS_TOKEN}` };
  const groupId = await (deps.resolveGroup ?? resolveGroup)(s, o.group);
  const summary = await (await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, { headers: L })).json();
  if (!summary.groupName) throw new Error(`bot がグループに参加していない: ${JSON.stringify(summary)}`);
  const text = (await prepareTemaSend(o.textFile ? readFileSync(o.textFile, 'utf8').trim() : '', { ...deps, to: groupId, channel: 'line', source: 'line-group-send', dryRun: o.dryRun })).trim();
  assertSendableText(text);
  console.log(`送信先: ${summary.groupName} (${groupId}) / 本文 ${text.length} 字 / 画像 ${o.images.length} 枚`);
  if (o.dryRun) { console.log('[dry-run] 送信しない'); return; }
  if (!o.skipContextCheck) {
    await (deps.assertContextApproved ?? assertContextApproved)({ channel: 'line', target: groupId, text, getLatest: async () => {
    const url = `${s.SUPABASE_URL}/rest/v1/channel_messages?select=id,created_at,external_message_id&channel=eq.line&external_thread_id=eq.${encodeURIComponent(groupId)}&order=created_at.desc&limit=1`;
    const rows = await (await fetch(url, { headers: sbHeaders(s) })).json();
    const received = (rows || []).map(x => ({ id: x.external_message_id || x.id, at: x.created_at }));
    const sent = readOutbound(groupId).map(x => ({ id: x.messageId, at: x.at }));
    return latestOf([...received, ...sent]);
    }});
  }
  const urls = [];
  assertReplyCheck(await (deps.preSendCheck || checkChannelReply)({ channel: 'line', target: groupId, draft: text, home: deps.home, fetchImpl: fetch }));
  for (const f of o.images) urls.push(await (deps.uploadImage ?? uploadImage)(s, f));
  const chunks = buildMessages(text, urls);
  const rawKey = o.retryKey || randomUUID();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const baseKey = UUID_RE.test(rawKey) ? rawKey : strToUUID(rawKey);
  const checkInput={channel:'line',to:groupId,text,draftId:o.retryKey || baseKey};
  const checked=await (deps.consistencyCheck ?? assertSendConsistency)(checkInput,deps);
  for (const [i, messages] of chunks.entries()) {
    const retryKey = i === 0 ? baseKey : randomUUID();
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST', headers: { ...L, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to: groupId, messages }),
    });
    const body = await r.text();
    assertPushSucceeded(r, body);
    const sent = JSON.parse(body).sentMessages || [];
    await (deps.cleanup ?? afterSendCleanup)({...checkInput,sentMessageId:sent[0]?.id || retryKey,scheduledSends:checked?.input?.scheduledSends},deps);
    for (const message of sent) recordOutbound({ channel: 'line', target: groupId, text: messages.find(m => m.type === 'text')?.text ?? '', messageId: message.id },deps.home);
    console.log(`push ${i + 1}/${chunks.length}: HTTP ${r.status} sentMessages=${sent.length} ids=${sent.map((m) => m.id).join(',')} retryKey=${retryKey}`);
  }
}

if (isEntry(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(e.code === 'HANDBACK_BLOCKED' ? 4 : 1); });
}
