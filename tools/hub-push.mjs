#!/usr/bin/env node
// kim's local masters -> Drive hub. No writes with --dry-run.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { getDriveToken, driveApi as api } from './lib/drive-auth.mjs';
import { uploadFileContent } from './lib/drive-files.mjs';

export const FOLDERS = {
  hub: '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw',
  rules: '1cNOSlo8pcrhXiRMRK_WD3O5IW-K9lYX4',
  skills: '1oSlYjJdlIy5GRYa3-AasAeybARKh4v-E',
};
export const normalizeLf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
export const sha1Lf = (buf) => createHash('sha1').update(normalizeLf(buf), 'utf8').digest('hex');
export const isUnchanged = (local, remote) => normalizeLf(local) === normalizeLf(remote);
export const tokyoDate = (date = new Date()) => date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

function localTarget(file) {
  if (file.in === 'skills') return `~/.claude/skills/${file.title.replace(/\.md$/, '')}/SKILL.md`;
  if (file.in === 'rules') return `~/.claude/rules/${file.title}`;
  return `~/.claude/${file.title}`;
}

// pushed includes unchanged targets too; status records successful writes only.
export function buildManifest(prev, pushed, today) {
  if (!pushed.some((file) => ['uploaded', 'created'].includes(file.status))) return prev;
  const files = pushed.map((file) => ({
    title: file.title,
    in: file.in,
    localTarget: (prev.files.find((entry) => entry.title === file.title && entry.in === file.in)
      ?? prev.files.find((entry) => entry.title === file.title))?.localTarget ?? localTarget(file),
    sha1: sha1Lf(file.content),
  }));
  const retained = prev.files.filter((entry) => !pushed.some((file) => file.title === entry.title && file.in === entry.in));
  return { ...prev, version: prev.version + 1, updatedAt: today, files: [...files, ...retained] };
}

export function collectTargets(repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  onboarding = process.platform === 'win32'
    ? 'C:/Users/uers/Downloads/CLAUDE.md配布/ONBOARDING.md'
    : '/mnt/c/Users/uers/Downloads/CLAUDE.md配布/ONBOARDING.md') {
  const targets = [{ title: 'ONBOARDING.md', in: 'hub', path: onboarding }];
  for (const entry of readdirSync(join(repo, 'rules'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.md')) targets.push({ title: entry.name, in: 'rules', path: join(repo, 'rules', entry.name) });
  }
  for (const entry of readdirSync(join(repo, 'skills'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(repo, 'skills', entry.name, 'SKILL.md');
    try {
      targets.push({ title: `${entry.name}.md`, in: 'skills', path, content: normalizeLf(readFileSync(path)) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return targets.map((file) => ({ ...file, content: file.content ?? normalizeLf(readFileSync(file.path)) }));
}

async function findLatest(token, file, apiFn, warn) {
  const matches = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `name='${file.title.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and '${FOLDERS[file.in]}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await apiFn(token, `https://www.googleapis.com/drive/v3/files?${params}`);
    const data = await response.json();
    matches.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  matches.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  if (matches.length > 1) warn(`WARN: ${file.in}/${file.title}: ${matches.length} duplicates; using latest ${matches[0].id}`);
  return matches[0];
}

export async function pushHub({ targets, token, apiFn = api, dryRun = false,
  today = tokyoDate(), log = console.log, warn = console.error } = {}) {
  const stats = { uploaded: 0, unchanged: 0, created: 0 };
  let oldVersion = '?';
  let newVersion = '?';
  let current = 'manifest.json';
  try {
    const manifestFile = await findLatest(token, { title: current, in: 'hub' }, apiFn, warn);
    if (!manifestFile) throw new Error('existing manifest not found');
    const response = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${manifestFile.id}?alt=media`);
    const prev = JSON.parse(normalizeLf(await response.text()));
    if (!Number.isSafeInteger(prev.version) || !Array.isArray(prev.files)) throw new Error('invalid version or files');
    oldVersion = newVersion = prev.version;
    // Read and compare everything before writing, so read failures cannot cause partial pushes.
    const plan = [];
    for (const file of targets) {
      current = `${file.in}/${file.title}`;
      const existing = await findLatest(token, file, apiFn, warn);
      let status = 'created';
      if (existing) {
        const remote = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`);
        status = isUnchanged(file.content, await remote.text()) ? 'unchanged' : 'uploaded';
      }
      plan.push({ ...file, content: normalizeLf(file.content), fileId: existing?.id, status });
      if (status === 'unchanged') stats.unchanged++;
      log(`${dryRun ? '[dry-run] ' : ''}${status === 'uploaded' ? 'update' : status === 'created' ? 'create' : status}: ${current}`);
    }
    if (dryRun) {
      log(`[dry-run] manifest.json: ${plan.some((file) => file.status !== 'unchanged') ? `would update version ${prev.version}->${prev.version + 1}` : 'unchanged'}`);
      return stats;
    }
    for (const file of plan) {
      if (file.status === 'unchanged') continue;
      current = `${file.in}/${file.title}`;
      await uploadFileContent(token, { fileId: file.fileId, name: file.title,
        parentId: FOLDERS[file.in], content: file.content, apiFn });
      stats.uploaded++;
      if (file.status === 'created') stats.created++;
    }
    if (stats.uploaded > 0) {
      current = 'manifest.json';
      const next = buildManifest(prev, plan, today);
      await uploadFileContent(token, { fileId: manifestFile.id, content: `${JSON.stringify(next, null, 2)}\n`, apiFn });
      newVersion = next.version;
    }
    return stats;
  } catch (error) {
    throw new Error(`${current}: ${error.message}`, { cause: error });
  } finally {
    log(`hub-push: uploaded=${stats.uploaded} unchanged=${stats.unchanged} created=${stats.created} version=${oldVersion}->${newVersion}`);
  }
}

if (isEntry(import.meta.url)) {
  let started = false;
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) throw new Error('usage: node tools/hub-push.mjs [--dry-run]');
    const targets = collectTargets();
    const token = await getDriveToken();
    started = true;
    await pushHub({ targets, token, dryRun: process.argv.includes('--dry-run') });
  } catch (error) {
    console.error(`hub-push: ${error.message}`);
    if (!started) console.log('hub-push: uploaded=0 unchanged=0 created=0 version=?->?');
    process.exitCode = 1;
  }
}
