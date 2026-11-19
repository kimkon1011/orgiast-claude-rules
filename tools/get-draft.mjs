#!/usr/bin/env node
// Read a Gmail draft by ID and print its headers + body.
// Usage: node tools/get-draft.mjs <draftId>
import { gwsFetch } from './lib/gws-proxy.mjs';
import { mintDwdToken, DEFAULT_USER } from './gmail-draft.mjs';

const draftId = process.argv[1];
if (!draftId) { process.exit(1); }

const user = DEFAULT_USER; // seisaku-team@orgiast.jp
const token = await mintDwdToken({ user, scope: 'https://www.googleapis.com/auth/gmail.compose', fetchImpl: gwsFetch });
const res = await gwsFetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}?format=full`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(25000),
});
if (!res.ok) {
  console.error('Gmail API failed:', res.status, await res.text());
  process.exit(1);
}
const json = await res.json();
const msg = json?.message;
const headers = Object.fromEntries(
  (msg?.payload?.headers ?? []).map(h => [h.name, h.value])
);

// Extract text body from MIME parts
function extractText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  if (part.parts) return part.parts.map(extractText).join('\n');
  return '';
}

const body = extractText(msg?.payload);

const result = { headers, threadId: msg?.threadId, body };
console.log(JSON.stringify(result, null, 2));