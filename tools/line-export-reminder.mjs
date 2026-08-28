#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;
const COOLDOWN_MS = 3 * DAY_MS;
const KIM_USER_ID = '715210673642012733';
const API = 'https://discord.com/api/v10';
const SETUP_URL = 'https://claude-pc.tailc5d751.ts.net/line-setup';

function latestLineTimestamp(dir) {
  let latest = null;
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
    : [];
  for (const name of names) {
    const rows = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);
    for (const row of rows) {
      if (!row.trim()) continue;
      try {
        const record = JSON.parse(row);
        if (typeof record.ts === 'number' && Number.isFinite(record.ts)) {
          latest = latest === null ? record.ts : Math.max(latest, record.ts);
        }
      } catch {
        // 壊れた1行があっても、ほかの取り込み済みレコードから判定を続ける。
      }
    }
  }
  return latest;
}

function reminderMessage(dataAgeDays) {
  if (dataAgeDays === null) {
    return `📥 LINEの取り込みがまだ1件もありません。手順:\n${SETUP_URL}`;
  }
  if (dataAgeDays >= 14) {
    return `🔴 LINEの取り込みが ${dataAgeDays} 日空いています。14日より前の投稿はもう取り込めません（今エクスポートしても捨てられます）。手順: ≡ → Export chat history → 共有先「Claude PC」\n${SETUP_URL}`;
  }
  return `📥 LINEの取り込みが ${dataAgeDays} 日空きました。オープンチャットを開いて ≡ → Export chat history → 共有先「Claude PC」でお願いします。14日を過ぎた分は取り込めなくなります。\n${SETUP_URL}`;
}

function readSentAt(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')).sentAt;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

async function sendDiscordDm({ home, message, fetchImpl = fetch }) {
  let token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    try { token = fs.readFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'utf8').trim(); }
    catch { token = ''; }
  }
  if (!token) throw new Error('Discord Bot トークンが見つかりません');

  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'orgiast-line-export-reminder/1.0',
  };
  const dm = await fetchImpl(`${API}/users/@me/channels`, {
    method: 'POST', headers, body: JSON.stringify({ recipient_id: KIM_USER_ID }), signal: AbortSignal.timeout(20_000),
  });
  if (!dm.ok) throw new Error(`DMチャンネル作成が HTTP ${dm.status}`);
  const channelId = (await dm.json()).id;
  if (!channelId) throw new Error('DMチャンネルIDを取得できません');
  const sent = await fetchImpl(`${API}/channels/${channelId}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ content: message }), signal: AbortSignal.timeout(20_000),
  });
  if (!sent.ok) throw new Error(`DM送信が HTTP ${sent.status}`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const invalid = argv.find((arg) => !['--dry-run', '--force'].includes(arg));
  if (invalid) {
    process.stdout.write(`LINE催促: 不正な引数 ${invalid}\n`);
    return 0;
  }
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const now = options.now ?? new Date();
  const home = options.home ?? os.homedir();
  const dir = path.join(home, '.claude', 'line-openchat');
  const stateFile = path.join(dir, 'reminder-state.json');

  try {
    const latestTs = latestLineTimestamp(dir);
    const dataAgeDays = latestTs === null ? null : Math.max(0, Math.floor((now.getTime() - latestTs) / DAY_MS));
    const message = reminderMessage(dataAgeDays);
    const sentAt = readSentAt(stateFile);
    let reason = '送信対象';
    let shouldSend = force || dataAgeDays === null || dataAgeDays >= 7;
    if (!force && !shouldSend) reason = `最新データは${dataAgeDays}日前のため送らない`;
    if (!force && shouldSend && sentAt !== null && now.getTime() - sentAt <= COOLDOWN_MS) {
      shouldSend = false;
      reason = '前回送信から3日以内のため送らない';
    }

    if (dryRun) {
      process.stdout.write(`LINE催促 dry-run: ${shouldSend ? '送信予定' : reason} | ${message.replace(/\n/g, ' / ')}\n`);
      return 0;
    }
    if (!shouldSend) {
      process.stdout.write(`LINE催促: ${reason}\n`);
      return 0;
    }

    await (options.sendDm ?? sendDiscordDm)({ home, message });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ sentAt: now.toISOString() })}\n`, 'utf8');
    process.stdout.write(`LINE催促: Discord DMを送信しました（${dataAgeDays === null ? '未取り込み' : `${dataAgeDays}日前`}）\n`);
  } catch (error) {
    process.stdout.write(`LINE催促: 送信せず終了しました（${error.message}）\n`);
  }
  return 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) process.exitCode = await main();
