#!/usr/bin/env node
// kim's local masters -> Drive hub. --dry-run performs reads only.
// uploaded counts existing-file updates; created counts new files (manifest excluded).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDriveToken, driveApi as api } from './lib/drive-auth.mjs';

export const FOLDERS = {
  hub: '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw',
  rules: '1cNOSlo8pcrhXiRMRK_WD3O5IW-K9lYX4',
  skills: '1oSlYjJdlIy5GRYa3-AasAeybARKh4v-E',
};
export const normalizeLf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
export const sha1Lf = (buf) => createHash('sha1').update(normalizeLf(buf)).digest('hex');
export const isUnchanged = (local, remote) => normalizeLf(local) === normalizeLf(remote);
export const tokyoDate = (date = new Date()) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

export function buildManifest(prev, pushed, today, changed = false) {
  if (!changed) return prev;
  const files = pushed.map((file) => {
    const old = prev.files.find((entry) => entry.title === file.title && entry.in === file.in)
      ?? prev.files.find((entry) => entry.title === file.title);
    const localTarget = old?.localTarget ?? (file.in === 'skills'
      ? `~/.claude/skills/${file.title.replace(/\.md$/, '')}/SKILL.md`
      : file.in === 'rules' ? `~/.claude/rules/${file.title}` : '~/.claude/ONBOARDING.md');
    return { title: file.title, in: file.in, localTarget, sha1: sha1Lf(file.content) };
  });
  for (const old of prev.files) {
    if (!pushed.some((file) => file.title === old.title && file.in === old.in)) files.push(old);
  }
  return { ...prev, version: Number(prev.version) + 1, updatedAt: today, files };
}

export function collectTargets(repo = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const onboarding = process.platform === 'win32'
    ? 'C:/Users/uers/Downloads/CLAUDE.md配布/ONBOARDING.md'
    : '/mnt/c/Users/uers/Downloads/CLAUDE.md配布/ONBOARDING.md';
  const targets = [{ path: onboarding, title: 'ONBOARDING.md', in: 'hub' }];
  for (const entry of readdirSync(join(repo, 'rules'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      targets.push({ path: join(repo, 'rules', entry.name), title: entry.name, in: 'rules' });
    }
  }
  for (const entry of readdirSync(join(repo, 'skills'), { withFileTypes: true })) {
    const path = join(repo, 'skills', entry.name, 'SKILL.md');
    if (entry.isDirectory() && existsSync(path)) targets.push({ path, title: `${entry.name}.md`, in: 'skills' });
  }
  return targets.sort((a, b) => a.path.localeCompare(b.path)).map((file) => {
    try { return { ...file, content: normalizeLf(readFileSync(file.path)) }; }
    catch (error) { throw new Error(`${file.path}: ${error.message}`); }
  });
}

async function findFile(request, file, warn) {
  const escape = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name='${escape(file.title)}' and '${FOLDERS[file.in]}' in parents and trashed=false`,
    fields: 'nextPageToken,files(id,name,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '1000',
  });
  const files = [];
  do {
    const data = await (await request(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
    files.push(...(data.files ?? []));
    if (!data.nextPageToken) break;
    params.set('pageToken', data.nextPageToken);
  } while (true);
  files.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  if (files.length > 1) warn(`WARN ${file.in}/${file.title}: ${files.length} duplicates; using latest ${files[0].id}`);
  return files[0];
}

async function upload(request, file, existing) {
  const content = normalizeLf(file.content);
  if (existing) {
    await request(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content,
    });
  } else {
    const boundary = `hub-push-${randomUUID()}`;
    const meta = JSON.stringify({ name: file.title, parents: [FOLDERS[file.in]], mimeType: 'text/plain' });
    await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${content}\r\n--${boundary}--`,
    });
  }
}

export async function pushHub({ targets, request, dryRun = false, today = tokyoDate(), log = console.log, warn = console.error }) {
  let uploaded = 0, unchanged = 0, created = 0;
  let oldVersion = '?', newVersion = '?';
  let current = 'manifest.json';
  try {
    const manifestFile = { title: 'manifest.json', in: 'hub' };
    const manifestRemote = await findFile(request, manifestFile, warn);
    if (!manifestRemote) throw new Error('not found; refusing to discard hub-only entries');
    const prev = JSON.parse(await (await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(manifestRemote.id)}?alt=media`)).text());
    if (!Array.isArray(prev.files) || !Number.isSafeInteger(Number(prev.version)) || Number(prev.version) < 0) {
      throw new Error('invalid files/version');
    }
    oldVersion = newVersion = prev.version;
    // Complete remote reads before any writes, so read failures cannot cause a partial push.
    const plan = [];
    for (const file of targets) {
      current = file.path ?? `${file.in}/${file.title}`;
      const existing = await findFile(request, file, warn);
      const remote = existing ? await (await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existing.id)}?alt=media`)).text() : null;
      if (remote !== null && isUnchanged(file.content, remote)) {
        unchanged++;
        log(`unchanged: ${file.in}/${file.title}`);
      } else {
        plan.push({ file, existing });
        log(`${dryRun ? '[dry-run] would ' : 'planned: '}${existing ? 'update' : 'create'}: ${file.in}/${file.title}`);
      }
    }
    for (const { file, existing } of plan) {
      current = file.path ?? `${file.in}/${file.title}`;
      if (!dryRun) {
        await upload(request, file, existing);
        if (existing) uploaded++; else created++;
      }
    }
    if (plan.length > 0) {
      current = 'manifest.json';
      const next = buildManifest(prev, targets, today, true);
      if (dryRun) {
        log(`[dry-run] would update: hub/manifest.json version=${oldVersion}->${next.version}`);
      } else {
        await upload(request, { ...manifestFile, content: `${JSON.stringify(next, null, 2)}\n` }, manifestRemote);
        newVersion = next.version;
      }
    }
    return { uploaded, unchanged, created, oldVersion, newVersion };
  } catch (error) {
    throw new Error(`${current}: ${error.message}`);
  } finally {
    log(`hub-push: uploaded=${uploaded} unchanged=${unchanged} created=${created} version=${oldVersion}->${newVersion}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('usage: node tools/hub-push.mjs [--dry-run]');
  const targets = collectTargets();
  const token = await getDriveToken();
  await pushHub({ targets, dryRun: args.includes('--dry-run'), request: (url, opts) => api(token, url, opts) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`hub-push: ${error.message}`); process.exitCode = 1; });
}
