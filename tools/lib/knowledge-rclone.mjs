import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyToRclone, runRclone } from './rclone-copy.mjs';

export function isDriveWriteBlocked(error) {
  return [403, 413].includes(Number(error?.status)) ||
    /(?:^|\bHTTP\s+)(?:403|413)\b/i.test(error?.message || '') ||
    (error?.cause ? isDriveWriteBlocked(error.cause) : false);
}

function safeSegment(value) {
  if (!value || value === '.' || value === '..' || /[\\/\x00-\x1f]/.test(value)) {
    throw new Error('Invalid knowledge destination path segment');
  }
  return value;
}

export async function uploadKnowledgeWithRclone({ items, folderName, inboxFolderId, run = runRclone,
  stagingRoot = os.tmpdir(), emit = () => {} }) {
  const remotes = (await run(['listremotes'])).split(/\r?\n/).map(s => s.trim());
  if (!remotes.includes('claude-backup:')) throw new Error('rclone remote claude-backup is unavailable');
  const destination = `claude-backup:${safeSegment(folderName)}`;
  const expected = new Map();
  for (const item of items) {
    const name = safeSegment(item.name);
    const content = Buffer.from(item.content, 'utf8');
    if (expected.has(name)) throw new Error(`Duplicate knowledge destination: ${name}`);
    expected.set(name, { content, size: content.length, md5: crypto.createHash('md5').update(content).digest('hex') });
  }
  // Retain the redacted staging files for diagnosis; never remove user data.
  const staging = fs.mkdtempSync(path.join(stagingRoot, 'knowledge-upstream-'));
  for (const [name, file] of expected) fs.writeFileSync(path.join(staging, name), file.content);
  const flags = ['--drive-root-folder-id', inboxFolderId, '--retries', '1', '--low-level-retries', '2'];
  let copyError;
  try {
    await copyToRclone({ source: staging, destination, directory: true,
      extraArgs: [...flags, '--checksum'], run });
  } catch (error) {
    copyError = error;
    emit('[rclone] copy failed; checking which files reached Drive');
  }
  const files = JSON.parse(await run(['lsjson', destination, '--files-only', '--max-depth', '1',
    '--hash-type', 'MD5', ...flags]));
  const verified = new Set();
  const errors = new Map();
  for (const [name, expectedFile] of expected) {
    const matches = files.filter(file => file.Path === name && !file.IsDir);
    if (matches.length === 1 && matches[0].Size === expectedFile.size &&
        matches[0].Hashes?.md5?.toLowerCase() === expectedFile.md5) {
      verified.add(name);
    } else {
      errors.set(name, `rclone read-back mismatch or missing file${copyError ? ` (${copyError.message})` : ''}`);
    }
  }
  emit(`[rclone] verified=${verified.size}/${items.length} destination=${destination} inbox=${inboxFolderId}`);
  return { verified, errors };
}
