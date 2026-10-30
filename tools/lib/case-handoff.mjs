import crypto from 'node:crypto';
import { redactForShare } from './share-secrets.mjs';

// The live case-list sheet still uses C0001 IDs (verified 2026-10-29).
// Accept both its canonical legacy IDs and the requested new format.
export const CASE_ID = /^(?:\d{6}[A-Z]{2,6}|C\d{4,})$/;
export const STATE_LIMIT = 4096;
export const RESUME_LIMIT = 6144;
export const HEADINGS = ['目的', '顧客の意向', '決定事項', '未完了・次の一手', '関連ファイル・ID', '最終更新', '作業中の席'];
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Boundary-only empty records advance the cursor without changing the payload.
export const canonicalMarkdown = value => value.replace(/^\n+|\n+$/g, '');
export const batchIdentity = body => hash(JSON.stringify([
  body.caseId, body.sessionId, body.previousUuid || '', body.lastUuid, hash(body.markdown),
]));
export const bytes = value => Buffer.byteLength(value, 'utf8');
export function clip(value, limit) {
  let result = '', size = 0;
  for (const char of String(value)) { size += bytes(char); if (size > limit) break; result += char; }
  return result;
}
export function detectCases(prompt, catalog = []) {
  const ids = [...String(prompt).matchAll(/(?<![A-Za-z0-9])(?:\d{6}[A-Z]{2,6}|C\d{4,})(?![A-Za-z0-9])/g)].map(m => m[0]);
  for (const item of catalog) if (CASE_ID.test(item.id) && item.name?.length >= 2 && String(prompt).includes(item.name)) ids.push(item.id);
  return [...new Set(ids)];
}
const safe = value => /^[A-Za-z0-9@._-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype', '.', '..'].includes(value);
export function validateIdentity({ sessionId, account, pc }) {
  if (![sessionId, account, pc].every(v => typeof v === 'string' && safe(v))) throw Error('invalid session/account/PC');
}
function artifactRefs(value, key = '', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string' && /^(?:file_?path|path|file_?id|drive_?id|url|uri|filename)$/i.test(name)) found.push(`${name}: ${item}`);
    else if (typeof item === 'object') artifactRefs(item, name, found);
  }
  return found;
}
// Only complete JSONL records are acknowledged. A corrupt middle line is loud;
// a partial tail remains unacknowledged until the next hook.
export function transcriptRecords(raw) {
  const lines = raw.split('\n');
  if (lines.at(-1)?.trim()) { try { JSON.parse(lines.at(-1)); } catch { lines.pop(); } }
  const records = [], occurrences = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let row; try { row = JSON.parse(lines[i]); } catch { throw Error(`transcript JSONL invalid at line ${i + 1}`); }
    const legacyUuid = row.uuid ? undefined : `line-${hash(lines[i])}`;
    const occurrence = legacyUuid ? (occurrences.get(legacyUuid) || 0) + 1 : 0;
    if (legacyUuid) occurrences.set(legacyUuid, occurrence);
    // Identical bridge/progress records recur in an append-only JSONL file.
    // A content hash alone points findIndex back to their first occurrence.
    const uuid = row.uuid || `${legacyUuid}-${occurrence}`;
    if (!['user', 'assistant'].includes(row.type)) { records.push({ uuid, legacyUuid, markdown: '' }); continue; }
    const blocks = typeof row.message?.content === 'string' ? [{ type: 'text', text: row.message.content }]
      : row.message?.content || (typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : row.content) || [];
    const parts = [];
    for (const block of blocks) {
      if (block.type === 'text') parts.push(redactForShare(block.text || ''));
      else if (block.type === 'tool_use') parts.push(`Tool: ${block.name}\nArguments: ${clip(redactForShare(JSON.stringify(block.input || {})), 4000)}`);
      else if (block.type === 'tool_result') parts.push(`Result (${block.tool_use_id || ''}): ${[...redactForShare(typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''))].slice(0, 500).join('')}`);
      else if (['image', 'document', 'file'].includes(block.type)) parts.push(`Attachment: ${block.title || block.filename || block.type} (${block.source?.media_type || 'see local transcript'})`);
      const refs = artifactRefs(block);
      if (refs.length) parts.push(`Files / Drive IDs:\n${redactForShare([...new Set(refs)].join('\n'))}`);
    }
    const refs = artifactRefs(row.attachment || row.attachments || {});
    if (refs.length) parts.push(`Files / Drive IDs:\n${redactForShare(refs.join('\n'))}`);
    const role = blocks.some(b => b.type === 'text') ? row.type : 'tool';
    records.push({ uuid, legacyUuid, role, timestamp: row.timestamp || '', markdown: parts.length ? `<!-- event:${uuid} -->\n## ${role} | ${row.timestamp || 'unknown'} | ${uuid}\n\n${parts.join('\n\n')}\n` : '' });
  }
  return records;
}
export function nextBatch(raw, cursor, identity, caseId, maxBytes = 180000) {
  validateIdentity(identity);
  if (!CASE_ID.test(caseId)) throw Error('invalid case ID');
  const records = transcriptRecords(raw);
  let at = cursor ? records.findIndex(row => row.uuid === cursor) : -1;
  // An ambiguous pre-v2 checkpoint is replayed from its earliest occurrence:
  // the server deduplicates events, so migration cannot skip unsaved speech.
  if (cursor && at < 0) at = records.findIndex(row => row.legacyUuid === cursor);
  if (cursor && at < 0) throw Error('送信済み uuid が transcript にありません。元ログを保全して復旧してください');
  const selected = []; let size = 0;
  for (const row of records.slice(at + 1)) {
    if (size + bytes(row.markdown) > maxBytes && selected.length) break;
    if (bytes(row.markdown) > 3000000) throw Error('単一発言が3MB超。全文を保持したまま分割対応が必要です');
    size += bytes(row.markdown); selected.push(row);
  }
  if (!selected.length) return null;
  const lastUuid = selected.at(-1).uuid;
  const timestamp = selected.find(r => r.timestamp)?.timestamp || new Date().toISOString();
  const batch = { version: 2, caseId, ...identity, previousUuid: cursor || '', lastUuid, timestamp,
    markdown: canonicalMarkdown(selected.map(r => r.markdown).join('\n')),
    userCount: selected.filter(r => r.role === 'user').length };
  return { ...batch, batchId: batchIdentity(batch) };
}
// The renderer bounds every section independently so late headings never vanish.
export function renderState(model, source, seats = []) {
  let decision = '';
  for (const d of model.decisions || []) {
    const citation = ` [${d.source || source.file} ${d.date || source.timestamp}]`;
    const remaining = 1250 - bytes(decision) - bytes(citation) - 4;
    if (remaining < 20) break;
    decision += `- ${clip(d.text, Math.min(250, remaining))}${citation}\n`;
  }
  const values = [model.purpose, model.customer, decision, model.next, model.files,
    `${source.account} / ${source.pc} / ${source.timestamp}`,
    seats.map(s => `${s.account} / ${s.pc} / ${s.at}`).join('\n') || 'なし'];
  const budgets = [350, 450, 1250, 600, 500, 200, 300];
  return HEADINGS.map((h, i) => `## ${h}\n${clip(redactForShare(values[i] || '未確認'), budgets[i])}\n`).join('\n');
}
export function resumeText(state, log) {
  return `${clip(state, STATE_LIMIT)}\n\n${clip(log, RESUME_LIMIT - STATE_LIMIT - 2)}`;
}
