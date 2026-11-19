// Generic messages require per-message approval. Lahaina standing authorization is scoped separately.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { listChats, listMessages } from './beeper-api.mjs';
import { enqueueItems, getItem, saveDraft, present, issueReceipt, markSent, markUncertain } from './reply-queue.mjs';
import { addItem } from './kim-inbox.mjs';
import { isEntry } from './is-entry.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const beeperSendTool = path.join(toolsDir, 'beeper-send.mjs');
const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();
import { findChat as findExactChat } from './lahaina-standing-policy.mjs';
export const findChat = (title, read = listChats) => findExactChat(title, read);

export async function prepareApproval({ date, text, title, dryRun = false, home = defaultHome(), readChats = listChats, inbox = addItem }) {
  const chat = await findChat(title, readChats);
  if (dryRun) return { dryRun: true, route: 'beeper-approval', chatID: chat.id, textLength: text.length, date };
  const queued = enqueueItems(home, [{ channel: 'line', thread: chat.id, message: `daily-post:${date}`, from: { name: title, external: true }, body: text, category: 'daily-post' }]);
  const id = queued.added[0] || queued.duplicates[0];
  let item = getItem(home, id);
  if (item.body !== text || (item.draft && item.draft.text !== text)) throw new Error('当日本文が登録後に変更されています。再確認が必要です');
  if (item.state === 'queued') { saveDraft(home, id, { text }); item = getItem(home, id); }
  if (item.state === 'drafted') { present(home, id); item = getItem(home, id); }
  if (item.state !== 'presented') return { queueID: id, state: item.state, chatID: chat.id };
  const request = `【${date} 日次写真依頼・Beeper送信承認】\n宛先: ${title}\n経路: kim の LINE（Beeper・追加費用なし）\n\n${text}\n\n確認: この本文を今日送ってよいですか。「1 可」または「1 否」で返答できます（受信箱表示の番号に従ってください）。\n担当セッション用: reply-queue ${id}。kim の返答を確認してから decide approved を実行し、node "${fileURLToPath(import.meta.url)}" --send-approved ${id} で履歴チェック・正規receipt・送信を行う。翌日へ持ち越して送らない。`;
  const notification = await inbox(home, { kind: 'ask', text: request, source: 'daily-beeper-approval', dedupeKey: `daily-beeper:${id}` }, { drain: false });
  return { queueID: id, inboxID: notification.id, state: 'presented', chatID: chat.id };
}

// Called by the responding session ONLY after recording kim's actual approval.
// This function cannot approve drafts and does not accept a bypass flag.
export async function sendApproved(id, { home = defaultHome(), now = new Date(), readMessages = listMessages,
  exec = execFileSync } = {}) {
  const item = getItem(home, id);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (item.category !== 'daily-post' || item.message !== `daily-post:${today}`) throw new Error('当日の日次投稿だけ送信できます');
  if (item.state !== 'approved' || item.decision?.finalText !== item.body || item.draft?.text !== item.body) throw new Error('本文一致のkim承認が必要です');
  const bodyFile = path.join(home, '.claude', 'reply-queue', `${id}-body.txt`);
  fs.writeFileSync(bodyFile, item.body, 'utf8');
  const invoke = (tool, args) => exec(process.execPath, [tool === 'beeper-send.mjs' ? beeperSendTool : path.join(toolsDir, tool), ...args], {
    cwd: path.dirname(toolsDir), encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, ORGIAST_HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
  });
  // Context check must succeed before receipt's 60-second window begins.
  await invoke('send-context-check.mjs', ['--channel', 'beeper', '--target', item.thread, '--text-file', bodyFile]);
  const latest = await readMessages(item.thread, { limit: 100 });
  const incoming = (latest.items || []).filter(m => !m.isSender && (!m.timestamp || Date.parse(m.timestamp) > Date.parse(item.receivedAt)))
    .map(m => ({ id: m.id, content: m.text, authorId: m.senderID }));
  const receipt = issueReceipt(home, id, { fetchLatest: () => incoming });
  if (!receipt.ok) throw new Error(receipt.reason);
  try {
    const result = JSON.parse(await invoke('beeper-send.mjs', ['--chat', item.thread, '--body-file', bodyFile, '--queue-id', id, '--receipt', receipt.receipt.id]));
    if (!result.ok || !result.messageID || result.chatID !== item.thread) throw new Error('送信結果が不確定です');
    markSent(home, id, { receiptId: receipt.receipt.id, messageId: result.messageID });
    return result;
  } catch (error) {
    // Never automatically retry a possibly delivered message.
    markUncertain(home, id, { reason: 'Beeper送信結果要確認。自動再送禁止' });
    throw error;
  }
}

if (isEntry(import.meta.url)) {
  if (process.argv[2] !== '--send-approved' || !process.argv[3]) throw new Error('--send-approved <queue-id> が必要です');
  console.log(JSON.stringify(await sendApproved(process.argv[3])));
}
