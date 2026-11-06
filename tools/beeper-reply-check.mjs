#!/usr/bin/env node
// Beeper reply-check: scans reply-waiting.json for Beeper-compatible channels
// (LINE, Messenger, Instagram, WhatsApp, Facebook) and checks for replies.
// Exit: 0 = no pending entries / all replied, 1 = still waiting, 2 = error
// Usage: node tools/beeper-reply-check.mjs [--ledger <path>] [--mark-replied]
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ORGIAST_HOME = process.env.ORGIAST_HOME || process.env.HOME || process.env.USERPROFILE || '.';
const LEDGER_PATH = path.join(ORGIAST_HOME, '.claude', 'reply-waiting.json');
const BEEPER_API = 'http://localhost:23373/v1';
const BEEPER_TIMEOUT = 10_000;
const ACCOUNT_DB = path.join(process.env.APPDATA || 'C:/Users/uers/AppData/Roaming', 'BeeperTexts', 'account.db');

// Beeper-compatible channels that we can check
const BEEPER_CHANNELS = ['LINE', 'Messenger', 'Instagram', 'WhatsApp', 'Facebook'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function getBeeperToken() {
  // Extract access_token from Beeper's account.db (SQLite)
  try {
    const localAppData = process.env.LOCALAPPDATA || 'C:/Users/uers/AppData/Local';
    const sqlite = path.join(localAppData,
      'Microsoft', 'WinGet', 'Packages',
      'Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe',
      'platform-tools', 'sqlite3');
    const result = execFileSync(sqlite,
      [ACCOUNT_DB, 'SELECT access_token FROM account LIMIT 1'],
      { encoding: 'utf8', timeout: 5000 });
    return result.trim();
  } catch (e) {
    throw new Error(`Beeper token 取得失敗: ${e.message}`);
  }
}

async function beeperGet(pathname, token) {
  const url = `${BEEPER_API}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BEEPER_TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Beeper API ${r.status}: ${body.slice(0, 200)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function elapsedDays(dateStr) {
  return Math.floor((Date.now() - Date.parse(dateStr)) / 86400_000);
}

async function main() {
  const args = process.argv.slice(1);
  const ledgerPath = args.includes('--ledger')
    ? args[args.indexOf('--ledger') + 1]
    : LEDGER_PATH;
  const markReplied = args.includes('--mark-replied');

  const ledger = readJson(ledgerPath);
  if (!ledger || !ledger.entries?.length) {
    console.log('reply-waiting.json: 空または不存在');
    process.exit(0);
  }

  // Filter entries on Beeper-compatible channels
  const targetEntries = ledger.entries.filter(e =>
    BEEPER_CHANNELS.includes(e.channel) && e.status === 'waiting'
  );

  if (!targetEntries.length) {
    console.log(`Beeper対象エントリなし（全${ledger.entries.length}件中、Beeper対象外）`);
    process.exit(0);
  }

  // Get Beeper API token
  let token;
  try {
    token = getBeeperToken();
  } catch (e) {
    console.error(`Beeper token 取得失敗: ${e.message}`);
    process.exit(2);
  }

  console.log(`Beeper reply-check: ${targetEntries.length}件を確認（台帳: ${ledgerPath}）`);
  const foundReplies = [];
  const stillWaiting = [];

  for (const entry of targetEntries) {
    const who = entry.who;
    const sentAt = entry.sentAt;
    const staleDays = entry.staleDays || 7;

    console.log(`\n【${who}】(${entry.channel}) sent:${sentAt} stale:${staleDays}日`);

    try {
      // Search Beeper for this person's chat: try multiple search strategies
      const searchNames = [
        who,                                          // full name as-is
        who.replace(/[（(].*[）)]/g, '').trim(),      // without parenthesised org
        who.replace(/^.*?[ 　]/, ''),                 // last word (likely given name)
        who.split(/[ 　]/)[0],                        // first word (likely surname)
      ].filter(Boolean);
      // Deduplicate
      const uniqueNames = [...new Set(searchNames)];
      let chat = null;
      for (const q of uniqueNames) {
        console.log(`  → 検索: "${q}"`);
        const searchData = await beeperGet(`/search?query=${encodeURIComponent(q)}`, token);
        const candidates = searchData?.results?.chats?.filter(c => c.type === 'single') || [];
        // Match if any significant name overlap
        chat = candidates.find(c => {
          const ct = c.title || '';
          // Direct or partial match
          return ct.includes(q) || q.includes(ct) ||
            // Token overlap (split by space/bracket)
            q.split(/[ 　(（]/).some(t => t.length >= 2 && ct.includes(t)) ||
            ct.split(/[ 　(（]/).some(t => t.length >= 2 && q.includes(t));
        });
        if (chat) break;
      }

      if (!chat) {
        console.log(`  → チャット見つからず`);
        stillWaiting.push(entry);
        continue;
      }

      console.log(`  → チャット: ${chat.title} (${chat.id})`);

      // Check messages since sentAt
      const sinceMs = Date.parse(sentAt);
      const msgsData = await beeperGet(
        `/chats/${encodeURIComponent(chat.id)}/messages?limit=20&direction=before`,
        token
      );
      const messages = msgsData?.items || [];

      const replies = messages.filter(m =>
        !m.isSender &&
        new Date(m.timestamp).getTime() > sinceMs &&
        m.type === 'TEXT' && m.text?.trim()
      );

      if (replies.length > 0) {
        const latest = replies[replies.length - 1];
        const replyTime = new Date(latest.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        console.log(`  ✅ 返信あり (${replyTime}): ${latest.text?.slice(0, 100)}`);
        foundReplies.push({ entry, messages: replies, chat });

        // If --mark-replied, update the ledger
        if (markReplied) {
          entry.status = 'replied';
          entry.repliedAt = latest.timestamp;
          entry.replyText = latest.text?.slice(0, 200);
          entry.replyChannel = 'Beeper(' + entry.channel + ')';
        }
      } else {
        const days = elapsedDays(sentAt);
        console.log(`  ⏳ 未返信（経過${days}日）`);
        stillWaiting.push(entry);
      }
    } catch (e) {
      console.log(`  ⚠️ エラー: ${e.message}`);
      stillWaiting.push(entry);
    }
  }

  // Save updated ledger if --mark-replied
  if (markReplied && foundReplies.length > 0) {
    const tmp = `${ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, ledgerPath);
    console.log(`\n📝 reply-waiting.json 更新済み（${foundReplies.length}件を replied に）`);
  }

  // Summary
  console.log(`\n=== 結果 ===`);
  console.log(`返信あり: ${foundReplies.length}件 / 未返信: ${stillWaiting.length}件`);

  for (const fr of foundReplies) {
    const msgs = fr.messages.map(m => `${m.senderName}: ${m.text?.slice(0, 60)}`);
    console.log(`✅ ${fr.entry.who}: ${msgs.join(' / ')}`);
  }
  for (const sw of stillWaiting) {
    console.log(`⏳ ${sw.who} (${sw.channel}): ${elapsedDays(sw.sentAt)}日経過`);
  }

  process.exit(stillWaiting.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`beeper-reply-check エラー: ${e.message}`);
  process.exit(2);
});