import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PURPOSE_MARKER = '**[本セッションの目的]**';

function extractPurpose(raw, purpose, onParseError) {
  for (const line of raw.split(/\r?\n/)) {
    const hasMarker = line.includes(PURPOSE_MARKER);
    if (!hasMarker && (!onParseError || !line.trim() || line.trimEnd().endsWith('}'))) continue;
    let record;
    try { record = JSON.parse(line); } catch (error) { onParseError?.(error); continue; }
    if (!hasMarker || record?.type !== 'assistant') continue;
    const content = record.message?.content ?? record.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
    for (const textLine of text.split(/\r?\n/)) {
      const at = textLine.lastIndexOf(PURPOSE_MARKER);
      if (at >= 0) purpose = textLine.slice(at + PURPOSE_MARKER.length).trim();
    }
  }
  return purpose;
}

export function diagnosticTranscriptPurpose(file, onParseError) {
  return extractPurpose(fs.readFileSync(file, 'utf8'), '', onParseError);
}

function validEntry(entry) {
  return entry && Number.isSafeInteger(entry.size) && Number.isFinite(entry.mtimeMs)
    && typeof entry.purpose === 'string' && Number.isSafeInteger(entry.scannedBytes)
    && entry.scannedBytes >= 0 && entry.scannedBytes <= entry.size
    && (entry.pendingPurpose === undefined || typeof entry.pendingPurpose === 'string');
}

export function openSessionClaimCache(base, now, activeAgeMs) {
  const cacheFile = path.join(base, 'session-claim-cache.json');
  let previous = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
  } catch { /* Rebuild from transcripts. */ }
  const entries = new Map(Object.entries(previous).filter(([, entry]) =>
    validEntry(entry) && now - entry.mtimeMs <= activeAgeMs));
  let dirty = entries.size !== Object.keys(previous).length;

  // Both consumers use the same metadata snapshot during one hook run.
  const stats = new Map();
  const directories = new Map();
  return {
    readDirectory(dir) {
      if (!directories.has(dir)) directories.set(dir, fs.readdirSync(dir, { withFileTypes: true }));
      return directories.get(dir);
    },

    stat(file) {
      if (!stats.has(file)) stats.set(file, fs.statSync(file));
      return stats.get(file);
    },

    purpose(file, { size, mtimeMs }) {
      const key = path.resolve(file);
      const cached = entries.get(key);
      if (cached?.size === size && cached.mtimeMs === mtimeMs) {
        return cached.pendingPurpose ?? cached.purpose;
      }
      const append = cached && size > cached.size && mtimeMs >= cached.mtimeMs;
      const start = append ? cached.scannedBytes : 0;
      const raw = Buffer.allocUnsafe(size - start);
      const fd = fs.openSync(file, 'r');
      try {
        let offset = 0;
        while (offset < raw.length) {
          const count = fs.readSync(fd, raw, offset, raw.length - offset, start + offset);
          if (count === 0) throw new Error('Transcript changed during read');
          offset += count;
        }
      } finally {
        fs.closeSync(fd);
      }
      const completeBytes = raw.lastIndexOf(10) + 1;
      const purpose = extractPurpose(raw.toString('utf8', 0, completeBytes), append ? cached.purpose : '');
      const entry = { size, mtimeMs, purpose, scannedBytes: start + completeBytes };
      // A complete JSON record can be visible before its newline. Use it for
      // this snapshot, and reparse it on append in case the tail changes meaning.
      if (completeBytes < raw.length) {
        const pendingPurpose = extractPurpose(raw.toString('utf8', completeBytes), purpose);
        if (pendingPurpose !== purpose) entry.pendingPurpose = pendingPurpose;
      }
      entries.set(key, entry);
      dirty = true;
      return entry.pendingPurpose ?? purpose;
    },

    discard(file) {
      if (entries.delete(path.resolve(file))) dirty = true;
    },

    save() {
      if (!dirty) return;
      const temp = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, cacheFile);
      } catch {
        // Windows readers can temporarily prevent replacement. The old cache
        // remains usable and a later invocation can publish its snapshot.
        try { fs.unlinkSync(temp); } catch { /* Best effort for our temporary file. */ }
      }
    },
  };
}
