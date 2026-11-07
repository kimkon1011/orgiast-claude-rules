#!/usr/bin/env node
// LINE グループへ、その場の Claude Code から直接送る（kim-PC への中継は使わない）。
// 送信者は LINE 公式アカウント「オージャスト金(読取専用)」@458zwuhb（グループに参加済みの bot）。
// 使い方: node tools/line-group-send.mjs --group <groupId|グループ名> --text-file <本文.txt> [--image <png/jpg> ...] [--dry-run]
//   画像は Supabase Storage（line-media/outbound/）へ上げ、1年有効の署名URLで送る。1MB 超は送れないので先に JPEG 化すること。
//   送信後は push の HTTP 200 と sentMessages の件数を表示する。同じ --retry-key で再実行しても二重送信されない。
// 鍵: LINE_CHANNEL_ACCESS_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を env → ~/.claude/line-send.env の順に読む。
//   どちらにも無ければ ~/.claude/vercel.env の VERCEL_TOKEN で営業アプリ（aujust-sales-automation）の development env から取り、line-send.env に保存する。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';

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
const SALES_PROJECT = 'aujust-sales-automation';
const KEYS = ['LINE_CHANNEL_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const MAX_IMAGE_BYTES = 1024 * 1024;

export function parseArgs(argv) {
  const o = { images: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--group') { o.group = v; i += 1; }
    else if (a === '--text-file') { o.textFile = v; i += 1; }
    else if (a === '--image') { o.images.push(v); i += 1; }
    else if (a === '--retry-key') { o.retryKey = v; i += 1; }
    else throw new Error(`不明なオプション: ${a}\n${USAGE}`);
  }
  if (!o.group || (!o.textFile && o.images.length === 0)) throw new Error(USAGE);
  return o;
}

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^(?:export\s+)?([A-Z_0-9]+)\s*=\s*"?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

async function fetchFromVercel(home) {
  const token = readEnvFile(path.join(home, '.claude', 'vercel.env')).VERCEL_TOKEN;
  if (!token) throw new Error('LINE の鍵がありません: env / ~/.claude/line-send.env / ~/.claude/vercel.env(VERCEL_TOKEN) のどれにも無い');
  const H = { Authorization: `Bearer ${token}` };
  const projects = await (await fetch(`https://api.vercel.com/v9/projects?search=${SALES_PROJECT}&limit=5`, { headers: H })).json();
  const proj = (projects.projects || []).find((p) => p.name === SALES_PROJECT);
  if (!proj) throw new Error(`Vercel に ${SALES_PROJECT} が見つからない: ${JSON.stringify(projects).slice(0, 200)}`);
  const list = await (await fetch(`https://api.vercel.com/v10/projects/${proj.id}/env`, { headers: H })).json();
  const want = { LINE_CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN', SUPABASE_URL: 'NEXT_PUBLIC_SUPABASE_URL', SUPABASE_SERVICE_ROLE_KEY: 'SUPABASE_SERVICE_ROLE_KEY' };
  const out = {};
  for (const [dst, src] of Object.entries(want)) {
    const e = (list.envs || []).find((x) => x.key === src && (x.target || []).includes('development'));
    if (!e) continue;
    const one = await (await fetch(`https://api.vercel.com/v1/projects/${proj.id}/env/${e.id}`, { headers: H })).json();
    if (one.value) out[dst] = one.value;
  }
  return out;
}

export async function loadSecrets({ env = process.env, home = homedir() } = {}) {
  const file = path.join(home, '.claude', 'line-send.env');
  const s = { ...readEnvFile(file) };
  for (const k of KEYS) if (env[k]) s[k] = env[k];
  if (KEYS.every((k) => s[k])) return s;
  Object.assign(s, await fetchFromVercel(home), Object.fromEntries(KEYS.filter((k) => env[k]).map((k) => [k, env[k]])));
  if (!s.LINE_CHANNEL_ACCESS_TOKEN) throw new Error('LINE_CHANNEL_ACCESS_TOKEN を取得できなかった');
  writeFileSync(file, `${KEYS.filter((k) => s[k]).map((k) => `${k}=${s[k]}`).join('\n')}\n`, { mode: 0o600 });
  return s;
}

const sbHeaders = (s) => ({ apikey: s.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${s.SUPABASE_SERVICE_ROLE_KEY}` });

export async function resolveGroup(s, group) {
  if (/^C[0-9a-f]{32}$/.test(group)) return group;
  if (!s.SUPABASE_URL) throw new Error('グループ名から ID を引くには SUPABASE_URL が必要。groupId（C で始まる33文字）で指定してください');
  const url = `${s.SUPABASE_URL}/rest/v1/channel_messages?select=external_thread_id,subject&channel=eq.line&subject=eq.${encodeURIComponent(`LINE: ${group}`)}&order=created_at.desc&limit=1`;
  const rows = await (await fetch(url, { headers: sbHeaders(s) })).json();
  if (!Array.isArray(rows) || !rows[0]) throw new Error(`グループ「${group}」が受信記録（channel_messages）に無い。bot が未参加か名前違い`);
  return rows[0].external_thread_id;
}

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
export function assertSendableText(text) {
  if (!text) return;
  const japanese = (text.match(/[぀-ヿ一-鿿]/g) || []).length;
  const latin1 = (text.match(/[\u0080-ÿ]/g) || []).length;
  if (japanese === 0 && latin1 >= 5) throw new Error('本文が文字化けしている（日本語0文字・U+0080-00FF が多数）');
  const placeholder = text.match(/XX|\{\{|\}\}|【要記入】|（記入）|TODO/);
  if (placeholder) throw new Error(`本文にプレースホルダが残っている: ${placeholder[0]}`);
}

export function buildMessages(text, imageUrls) {
  const msgs = [];
  if (text) msgs.push({ type: 'text', text });
  for (const u of imageUrls) msgs.push({ type: 'image', originalContentUrl: u, previewImageUrl: u });
  const chunks = [];
  for (let i = 0; i < msgs.length; i += 5) chunks.push(msgs.slice(i, i + 5));
  return chunks;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const s = await loadSecrets();
  const L = { Authorization: `Bearer ${s.LINE_CHANNEL_ACCESS_TOKEN}` };
  const groupId = await resolveGroup(s, o.group);
  const summary = await (await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, { headers: L })).json();
  if (!summary.groupName) throw new Error(`bot がグループに参加していない: ${JSON.stringify(summary)}`);
  const text = o.textFile ? readFileSync(o.textFile, 'utf8').trim() : '';
  assertSendableText(text);
  console.log(`送信先: ${summary.groupName} (${groupId}) / 本文 ${text.length} 字 / 画像 ${o.images.length} 枚`);
  if (o.dryRun) { console.log('[dry-run] 送信しない'); return; }
  const urls = [];
  for (const f of o.images) urls.push(await uploadImage(s, f));
  const chunks = buildMessages(text, urls);
  const rawKey = o.retryKey || randomUUID();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const baseKey = UUID_RE.test(rawKey) ? rawKey : strToUUID(rawKey);
  for (const [i, messages] of chunks.entries()) {
    const retryKey = i === 0 ? baseKey : randomUUID();
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST', headers: { ...L, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to: groupId, messages }),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`push 失敗 ${r.status} ${body}`);
    const sent = JSON.parse(body).sentMessages || [];
    console.log(`push ${i + 1}/${chunks.length}: HTTP ${r.status} sentMessages=${sent.length} ids=${sent.map((m) => m.id).join(',')} retryKey=${retryKey}`);
  }
}

if (isEntry(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
