import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const normalizeApprovedBody = value => String(value ?? '').replace(/\r\n/g, '\n').trim();
export const bodyHash = value => createHash('sha256').update(normalizeApprovedBody(value), 'utf8').digest('hex');
export const approvalFile = (hash, home = process.env.ORGIAST_HOME || os.homedir()) =>
  path.join(home, '.claude', 'send-approvals', `${hash}.json`);

export function validApprovalMarker(body, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const hash = bodyHash(body);
  try {
    const marker = JSON.parse(fs.readFileSync(approvalFile(hash, home), 'utf8'));
    const quote = marker.kimQuote ?? marker.approvalQuote ?? marker.quote;
    return marker.bodyHash === hash && Number.isFinite(Date.parse(marker.approvedAt)) && typeof quote === 'string' && quote.trim()
      ? { ok: true, hash, marker } : { ok: false, hash };
  } catch { return { ok: false, hash }; }
}

export function approvalHashReferences(text) {
  return [...String(text ?? '').matchAll(/(?:send-approval:|send-approvals[\\/])([a-f0-9]{64})(?:\.json)?/gi)].map(match => match[1].toLowerCase());
}

export function hasReferencedApproval(text, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  return approvalHashReferences(text).some(hash => {
    try {
      const marker = JSON.parse(fs.readFileSync(approvalFile(hash, home), 'utf8'));
      const quote = marker.kimQuote ?? marker.approvalQuote ?? marker.quote;
      return marker.bodyHash === hash && Number.isFinite(Date.parse(marker.approvedAt)) && typeof quote === 'string' && quote.trim();
    } catch { return false; }
  });
}
