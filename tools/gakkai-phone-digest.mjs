#!/usr/bin/env node
// 学会スマホ所在消化スクリプト
// 毎朝 9:07 に実行: 直近30日の「PHONE S00x」メッセージを読み、
// 端末ごとの最終信号を作成し学会スマホ所在チャンネルに投稿
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const ENV_PATH = path.join(os.homedir(), '.claude', 'gakkai-phone.env');
const BOT_TOKEN_PATH = path.join(os.homedir(), '.claude', 'orgiast-discord-bot-token.txt');
const TARGET_PHONES = ['S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008'];
const DAYS_BACK = 30;
const NO_SIGNAL_WARN_DAYS = 7;
const PHONE_SS = '1jAOwP41YeF09ftdhCp5RdCcnNW305ewu053HVk7VGBM';
const PHONE_SHEET_TAB = 'スマホ・タブレット管理';
const DRY_RUN = process.argv.includes('--dry-run');
const SA_KEY = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'keys', 'aujust-sheets-reader.json'), 'utf8'));
const API = 'https://discord.com/api/v10';

// --- Helpers ---
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function parseEnv(fpath) {
  const text = fs.readFileSync(fpath, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function sheetsToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: SA_KEY.client_email, sub: 'kim@orgiast.jp',
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(head + '.' + claim);
  const jwt = head + '.' + claim + '.' + b64url(sign.sign(SA_KEY.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('token ' + res.status + ' ' + JSON.stringify(json));
  return json.access_token;
}

function parsePhoneMessage(content) {
  // Format: PHONE S003 | 35.123456,135.123456 | 12m | 85% | 2026-11-07T10:00:00.000Z
  const m = content.match(/^PHONE\s+(S\d{3,4})\s*\|\s*([\d.]+),([\d.]+)\s*\|\s*([\d.]+)m?\s*\|\s*(\d+)%\s*\|\s*(.+)$/);
  if (!m) return null;
  return {
    phone: m[1],
    lat: parseFloat(m[2]),
    lng: parseFloat(m[3]),
    accuracy: parseInt(m[4], 10),
    battery: parseInt(m[5], 10),
    timestamp: new Date(m[6].trim()),
  };
}

// --- Main ---
const env = parseEnv(ENV_PATH);
const CHANNEL_ID = env.GAKKAI_PHONE_CHANNEL_ID;
const WEBHOOK_URL = env.GAKKAI_PHONE_WEBHOOK_URL;
const BOT_TOKEN = fs.readFileSync(BOT_TOKEN_PATH, 'utf8').trim();
const now = new Date();
const THIRTY_DAYS_AGO = new Date(now.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

// 1. Fetch phone management sheet (S002-S008 locations)
const t = await sheetsToken();
const phoneRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${PHONE_SS}/values/${encodeURIComponent(PHONE_SHEET_TAB + '!A1:L100')}?valueRenderOption=FORMATTED_VALUE`, {
  headers: { authorization: 'Bearer ' + t },
});
const phoneBody = await phoneRes.json();
if (!phoneRes.ok) throw new Error('phone sheet read: ' + phoneRes.status + ' ' + JSON.stringify(phoneBody));
const phoneRows = phoneBody.values || [];

// Build phone ID -> location map
// Column A = ID, Column K/L = 在庫場所
const phoneLocations = {};
for (const row of phoneRows) {
  const id = String(row[0] || '');
  if (TARGET_PHONES.includes(id)) {
    phoneLocations[id] = {
      location: row[11] || '',  // K column (0-indexed: 11) = 在庫場所
      name: String(row[1] || '').slice(0, 40),
    };
  }
}

// 2. Fetch Discord messages from the channel
let allMessages = [];
let lastId = null;
const since = Math.floor(THIRTY_DAYS_AGO.getTime() / 1000);

while (true) {
  const params = new URLSearchParams({ limit: '100' });
  if (lastId) params.set('after', lastId.toString());
  params.set('channel_id', CHANNEL_ID);

  const res = await fetch(`${API}/channels/${CHANNEL_ID}/messages?limit=100${lastId ? '&after=' + lastId : ''}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`fetch messages: ${res.status} ${await res.text().then(t=>t.slice(0,200))}`);
  const msgs = await res.json();
  if (!msgs.length) break;
  allMessages = allMessages.concat(msgs);
  lastId = msgs[msgs.length - 1].id;
  // Stop if we've gone past 30 days
  const oldest = new Date(msgs[msgs.length - 1].timestamp);
  if (oldest < THIRTY_DAYS_AGO) break;
  // Safety limit
  if (allMessages.length > 2000) break;
}

// 3. Parse phone signals, keep latest per phone
const phoneSignals = {};
for (const msg of allMessages) {
  const parsed = parsePhoneMessage(msg.content || '');
  if (!parsed || !TARGET_PHONES.includes(parsed.phone)) continue;
  const existing = phoneSignals[parsed.phone];
  if (!existing || parsed.timestamp > existing.timestamp) {
    phoneSignals[parsed.phone] = parsed;
  }
}

// 4. Build digest
const lines = [];
const warnings = [];

// 警告セクション
for (const pid of TARGET_PHONES) {
  const signal = phoneSignals[pid];
  if (!signal) {
    warnings.push(`⚠️ **${pid}**: 過去${DAYS_BACK}日間 信号なし — 所在不明！電源確認が必要です`);
    continue;
  }
  const daysSince = Math.floor((now - signal.timestamp) / (24 * 60 * 60 * 1000));
  if (daysSince >= NO_SIGNAL_WARN_DAYS) {
    warnings.push(`⚠️ **${pid}**: 最終信号から ${daysSince}日経過 — ${signal.timestamp.toISOString().slice(0,10)} 以降未確認`);
  }
}

if (warnings.length) {
  lines.push('## 🔴 要確認', ...warnings, '');
}

// 一覧ヘッダー
lines.push(`## 学会スマホ所在一覧（${now.toISOString().slice(0,10)} ${now.toISOString().slice(11,16)}）`);

const header = '| 端末 | 最終信号 | 位置 | 電池 | 在庫場所 |';
const sep = '|------|----------|------|------|----------|';
lines.push(header, sep);

for (const pid of TARGET_PHONES) {
  const signal = phoneSignals[pid];
  const loc = phoneLocations[pid];
  const location = loc ? loc.location : '—';

  if (!signal) {
    lines.push(`| ${pid} | **信号なし** | — | — | ${location} |`);
    continue;
  }

  const dateStr = signal.timestamp.toISOString().slice(0, 19).replace('T', ' ');
  const mapsLink = `https://www.google.com/maps?q=${signal.lat},${signal.lng}`;
  const posStr = `[${signal.lat.toFixed(4)},${signal.lng.toFixed(4)}±${signal.accuracy}m](${mapsLink})`;
  const battStr = `${signal.battery}%`;

  lines.push(`| ${pid} | ${dateStr} | ${posStr} | ${battStr} | ${location} |`);
}

const output = lines.join('\n');
const headerBlock = `# 学会スマホ所在確認\n`;

const fullOutput = headerBlock + '\n' + output;

// 5. Output or post
if (DRY_RUN) {
  console.log('--- GAKKAI PHONE DIGEST (DRY RUN) ---');
  console.log(`チャンネル: ${CHANNEL_ID}`);
  console.log(`直近 ${DAYS_BACK} 日間のメッセージ数: ${allMessages.length}`);
  console.log(`パース済みシグナル数: ${Object.keys(phoneSignals).length} 端末`);
  console.log('');
  console.log(fullOutput);
} else {
  // Post via webhook
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: fullOutput }),
  });
  if (!res.ok) throw new Error(`webhook post: ${res.status} ${await res.text().then(t=>t.slice(0,200))}`);
  console.log('Digest posted to Discord channel:', CHANNEL_ID);
}