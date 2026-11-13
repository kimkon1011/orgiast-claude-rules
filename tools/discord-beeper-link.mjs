// Discord link resolver for Beeper's local SQLite database.
// Reads index.db to extract Discord-native channel IDs from bridge metadata.
// Never writes to the database.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const snowflake = value => typeof value === 'string' && /^\d{15,22}$/.test(value);
const nativeLink = values => values.find(v => typeof v === 'string'
  && /^https:\/\/discord\.com\/channels\/@me\/\d{15,22}\/\d{15,22}$/.test(v));
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

// Match the exact room and internal message, never infer a Discord ID from a
// timestamp, a Matrix event hash, a reply target, or Beeper's numeric IDs.
export function getDiscordMessageLink(db, roomID, messageID) {
  if (!db || !roomID || !messageID) return null;
  try {
    const row = db.prepare('SELECT eventID, message FROM mx_room_messages WHERE roomID = ? AND id = ?').get(roomID, messageID);
    if (!row) return null;
    const message = parse(row.message);
    const event = db.prepare('SELECT event FROM mx_events WHERE roomID = ? AND eventID = ?').get(roomID, row.eventID);
    const content = parse(event?.event)?.content;
    return nativeLink([message?.external_url, message?.extra?.external_url, content?.external_url]) || null;
  } catch { return null; }
}

/**
 * Opens the Beeper index.db read-only. The caller must close the handle.
 * Returns null if the database is unavailable.
 */
function openIndexDb({ appData = process.env.APPDATA, home = os.homedir() } = {}) {
  const base = appData || path.join(home, 'AppData', 'Roaming');
  const dbPath = path.join(base, 'BeeperTexts', 'index.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * Extracts the Discord channel ID from the thread JSON stored in index.db.
 * The thread JSON contains bridge metadata with the Discord channel ID.
 *
 * @param {DatabaseSync} db - Open read-only handle to index.db
 * @param {string} roomID - Matrix room ID from chat.id (e.g. "!7WqVOzgmzsHP3reyxbmy:beeper.local")
 * @returns {string|null} Discord channel ID (snowflake) or null
 */
export function getDiscordChannelID(db, roomID) {
  if (!db || !roomID) return null;
  try {
    const row = db.prepare('SELECT thread FROM threads WHERE threadID = ?').get(roomID);
    if (!row?.thread) return null;
    const t = typeof row.thread === 'string' ? JSON.parse(row.thread) : row.thread;
    const bridge = t?.extra?.bridge;
    return bridge?.protocol?.id === 'discordgo' && snowflake(bridge.channel?.id) ? bridge.channel.id : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the Discord user ID from a Beeper senderID.
 * Format: @discordgo_<userId>:beeper.local
 *
 * @param {string} senderID - Beeper sender ID
 * @returns {string|null} Discord user ID (snowflake) or null
 */
export function extractDiscordUserID(senderID) {
  if (!senderID) return null;
  const match = String(senderID).match(/^@discordgo_(\d{15,22}):/);
  return match ? match[1] : null;
}

/**
 * Resolves the best possible Discord link for a chat/message pair.
 *
 * Priority:
 *   ① https://discord.com/channels/@me/<channelId>/<messageId> — requires both IDs
 *   ② https://discord.com/channels/@me/<channelId> — channel ID only
 *   ③ https://discord.com/users/<userId> — for DMs, sender's user ID
 *   ④ 会話名: <title> — fallback (current behavior)
 *
 * @param {object} chat - Beeper chat object (must have id, the Matrix room ID)
 * @param {object} message - Beeper message object (optional)
 * @param {object} [options] - Options
 * @param {string} [options.appData] - Override AppData path
 * @param {DatabaseSync} [options.db] - Reusable DB handle (for testing)
 * @returns {string} Discord link or conversation name fallback
 */
export function resolveDiscordLink(chat, message, { appData, db: externalDb } = {}) {
  const native = nativeLink([message?.discordUrl, message?.permalink, message?.url, message?.external_url]);
  if (native) return native;

  // API chat.id is the Matrix room ID. localChatID (e.g. 828) is not
  // threads.threadID and must never be used as a Discord channel ID.
  const roomID = chat?.id;
  let db;
  let storedLink, storedChannel;
  try {
    db = externalDb || openIndexDb({ appData });
    storedChannel = getDiscordChannelID(db, roomID);
    storedLink = getDiscordMessageLink(db, roomID, message?.id);
  } finally {
    if (db && !externalDb) db.close();
  }
  if (storedLink) return storedLink;
  const channelID = chat?.discordChannelID || chat?.discordChannelId || storedChannel;
  if (snowflake(channelID)) {
    const msgID = message?.discordMessageID || message?.discordMessageId;
    return `https://discord.com/channels/@me/${channelID}${snowflake(msgID) ? '/' + msgID : ''}`;
  }

  const sender = !message?.isSender && extractDiscordUserID(message?.senderID);
  if (sender) return `https://discord.com/users/${sender}${chat?.type === 'group' ? '\n会話名: ' + (chat.title || chat.id || '不明') : ''}`;
  // Priority ③: For single DMs, use the other participant's Discord user ID
  if (chat?.type === 'single') {
    // Use the sender of the message if they're not kim
    // Also check participants
    if (chat.participants?.items) {
      const other = chat.participants.items.find(p => !p.isSelf);
      if (other) {
        const pid = extractDiscordUserID(other.id);
        if (pid) return `https://discord.com/users/${pid}`;
      }
    }
  }

  return `会話名: ${chat?.title || chat?.id || '不明'}`;
}
