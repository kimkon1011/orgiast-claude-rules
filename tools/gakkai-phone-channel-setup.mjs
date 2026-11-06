// Discord: 学会制作カテゴリのチャンネル一覧確認 → 必要なら「学会スマホ所在」作成 → Webhook作成
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenFile = path.join(os.homedir(), '.claude', 'orgiast-discord-bot-token.txt');
const BOT_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
const API = 'https://discord.com/api/v10';
const GUILD = '715211007307284530';
const CATEGORY_GKK = '1382626354243174400'; // 学会制作カテゴリ
const CHANNEL_NAME = '学会スマホ所在';
const WEBHOOK_NAME = '学会スマホ通知';

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'content-type': 'application/json', ...opts.headers },
    ...opts,
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`Discord ${opts.method||'GET'} ${path}: ${res.status} ${JSON.stringify(body).slice(0,200)}`);
  return body;
}

// 1. Guild channels をリスト
const channels = await api(`/guilds/${GUILD}/channels`);
console.log('=== 全チャンネル数:', channels.length);

// 学会制作カテゴリのチャンネルを表示
const gkkChannels = channels.filter(c => c.parent_id === CATEGORY_GKK && c.type === 0);
console.log('=== 学会制作カテゴリのテキストチャンネル:');
for (const ch of gkkChannels) {
  console.log(`  ${ch.id} / ${ch.name}`);
}

// 2. チャンネルが既にあるか確認
let target = gkkChannels.find(c => c.name === CHANNEL_NAME);
if (target) {
  console.log(`\nチャンネル「${CHANNEL_NAME}」は既にあります: ${target.id}`);
} else {
  console.log(`\nチャンネル「${CHANNEL_NAME}」を作成します...`);
  const created = await api(`/guilds/${GUILD}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      name: CHANNEL_NAME,
      type: 0, // GUILD_TEXT
      parent_id: CATEGORY_GKK,
      topic: '学会スマホの自動所在通知チャンネル',
    }),
  });
  target = created;
  console.log(`  作成完了: ${target.id} / ${target.name}`);
}

// 3. Webhook作成
console.log(`\nWebhook「${WEBHOOK_NAME}」を作成します...`);
const allWebhooks = await api(`/channels/${target.id}/webhooks`);
const existing = allWebhooks.find(w => w.name === WEBHOOK_NAME);
let webhook;
if (existing) {
  webhook = existing;
  console.log(`  Webhookは既にあります: id=${webhook.id}`);
} else {
  webhook = await api(`/channels/${target.id}/webhooks`, {
    method: 'POST',
    body: JSON.stringify({ name: WEBHOOK_NAME }),
  });
  console.log(`  作成完了: id=${webhook.id} token=${webhook.token.slice(0,4)}...`);
}

const webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
console.log(`\nWebhook URL (末尾4文字): ...${webhook.token.slice(-4)}`);
console.log('Channel ID:', target.id);

// 4. env ファイル保存
const envPath = path.join(os.homedir(), '.claude', 'gakkai-phone.env');
const envContent = `# 学会スマホ所在通知
GAKKAI_PHONE_WEBHOOK_URL=${webhookUrl}
GAKKAI_PHONE_CHANNEL_ID=${target.id}
# 作成日: ${new Date().toISOString().split('T')[0]}
`;
fs.writeFileSync(envPath, envContent, 'utf8');
console.log(`\nenv 保存: ${envPath}`);
console.log('GAKKAI_PHONE_CHANNEL_ID=' + target.id);

// 5. Bot でチャンネル読取確認
const test = await api(`/channels/${target.id}/messages?limit=1`);
console.log(`  チャンネル読取確認: ${test.length} messages (OK)`);