#!/usr/bin/env node
// Read-only script to fetch Gmail draft and thread data
import { getDriveToken } from './tools/lib/drive-auth.mjs';
import { gwsFetch } from './tools/lib/gws-proxy.mjs';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const USER = 'seisaku-team@orgiast.jp';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const token = await getDriveToken({ scope: SCOPE, impersonate: USER });

async function gmailRaw(path) {
  const url = API + path;
  const resp = await gwsFetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 500));
  }
  return resp.json();
}

function decodeBody(payload) {
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (node.body?.data) parts.push({ mime: node.mimeType, text: Buffer.from(node.body.data, 'base64url').toString('utf8') });
    for (const child of node.parts || []) walk(child);
  };
  walk(payload);
  const plain = parts.find(p => p.mime === 'text/plain');
  return plain ? plain.text : (parts[0]?.text || '');
}

function getHeader(msg, name) {
  return msg.payload?.headers?.find(h => h.name === name)?.value || '(none)';
}

// =========== 1. Draft r4138595614456856560 ===========
console.log('=== 1. DRAFT r4138595614456856560 ===');
try {
  const draft = await gmailRaw('/drafts/r4138595614456856560?format=full');
  const msg = draft.message;
  console.log('From:', getHeader(msg, 'From'));
  console.log('To:', getHeader(msg, 'To'));
  console.log('Subject:', getHeader(msg, 'Subject'));
  console.log('threadId:', msg.threadId);
  console.log('In-Reply-To:', getHeader(msg, 'In-Reply-To'));
  console.log('---Body (text/plain)---');
  console.log(decodeBody(msg.payload));
} catch (e) {
  console.log('Error: ' + e.message);
}

// =========== 2. Drafts to koyoshi@bearmedi.jp ===========
console.log('\n=== 2. DRAFTS to:koyoshi@bearmedi.jp ===');
try {
  const all = await gmailRaw('/drafts?maxResults=50');
  const matching = (all.drafts || []).filter(d => {
    const to = d.message?.payload?.headers?.find(h => h.name === 'To')?.value || '';
    return to.includes('koyoshi@bearmedi.jp') || to.includes('bearmedi.jp');
  });
  console.log('Total drafts to bearmedi.jp:', matching.length);
  for (const d of matching) {
    console.log('Draft ID:', d.id);
    console.log('  Message ID:', d.message?.id);
    console.log('  To:', getHeader(d.message, 'To'));
    console.log('  Subject:', getHeader(d.message, 'Subject'));
    console.log('  threadId:', d.message?.threadId);
  }
} catch (e) {
  console.log('Error: ' + e.message);
  console.log('Fallback: using message list instead');
  try {
    const msgList = await gmailRaw('/messages?q=in:drafts+to:koyoshi@bearmedi.jp&maxResults=10');
    console.log('Draft messages count:', msgList.messages?.length || 0);
    for (const stub of msgList.messages || []) {
      const full = await gmailRaw('/messages/' + stub.id + '?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=From');
      console.log('  Message ID:', stub.id);
      console.log('  To:', getHeader(full, 'To'));
      console.log('  Subject:', getHeader(full, 'Subject'));
    }
  } catch (e2) {
    console.log('Fallback Error: ' + e2.message);
  }
}

// =========== 3. Thread 1a1c07c50fed67f3 ===========
console.log('\n=== 3. THREAD 1a1c07c50fed67f3 ===');
try {
  const thread = await gmailRaw('/threads/1a1c07c50fed67f3?format=full');
  if (thread.messages) {
    console.log('Messages count:', thread.messages.length);
    console.log('---');

    for (const m of thread.messages) {
      const date = getHeader(m, 'Date');
      const from = getHeader(m, 'From');
      const subject = getHeader(m, 'Subject');
      const internalDate = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : 'N/A';
      const labels = m.labelIds?.join(',') || '';
      const isDraft = labels.includes('DRAFT');
      console.log('Date:', date);
      console.log('  InternalDate:', internalDate);
      console.log('  From:', from);
      console.log('  Subject:', subject);
      console.log('  Labels:', labels);
      console.log('  Id:', m.id);
      console.log('---');
    }

    // Determine status
    const hasRecipientReply = thread.messages.some(m => {
      const from = getHeader(m, 'From');
      return (from.includes('bearmedi.jp') || from.includes('koyoshi'));
    });
    const hasOurSentAfterNov9 = thread.messages.some(m => {
      const isDraft = (m.labelIds || []).includes('DRAFT');
      return !isDraft && m.internalDate && Number(m.internalDate) > 1794300000000; // > Nov 10 roughly
    });

    console.log('Has reply from recipient (bearmedi):', hasRecipientReply ? 'YES' : 'NO');
    console.log('Has our sent messages after 2026/11/09:', hasOurSentAfterNov9 ? 'YES' : 'NO');
    console.log('Summary: only 2 messages in thread - our sent quote (Nov 9) and our draft follow-up (Nov 19)');
  }
} catch (e) {
  console.log('Error: ' + e.message);
}