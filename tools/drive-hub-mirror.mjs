#!/usr/bin/env node
// drive-hub-mirror.mjs — Mirror GitHub main contents to Google Drive hub folder nightly
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getDriveToken, defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { findByTitle, listFiles, downloadFileContent, uploadFileContent } from './lib/drive-files.mjs';
import { isEntry } from './is-entry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default helper to query git commit time
export function defaultGitCommitTime(filePath, repoPath) {
  const stdout = execFileSync('git', ['log', '-1', '--format=%cI', '--', filePath], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const time = stdout.trim();
  if (!time) throw new Error('No commit time returned (file might be untracked or new)');
  return new Date(time);
}

// Default helper to query git HEAD commit hash
export function defaultGitHead(repoPath) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return 'unknown';
  }
}

// Default helper to write the final JSON report
export function defaultWriteLastJson(report) {
  const lastJsonPath = join(homedir(), '.claude', 'drive-hub-mirror-last.json');
  mkdirSync(dirname(lastJsonPath), { recursive: true });
  writeFileSync(lastJsonPath, JSON.stringify(report, null, 2), 'utf8');
}

/**
 * Core mirror routine, structured for mock injection in tests.
 */
export async function runMirror({
  repoPath = join(__dirname, '..'),
  dryRun = false,
  getDriveTokenFn = getDriveToken,
  gitCommitTimeFn = defaultGitCommitTime,
  gitHeadFn = defaultGitHead,
  listFilesFn = listFiles,
  downloadFileContentFn = downloadFileContent,
  uploadFileContentFn = uploadFileContent,
  writeLastJsonFn = defaultWriteLastJson,
} = {}) {
  const manifestPath = join(repoPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const token = await getDriveTokenFn();

  const results = [];
  const counts = { pushed: 0, unchanged: 0, conflict: 0, failed: 0, missing: 0, blocked: 0 };

  // Structural write-target allow-list. Built once from the known-safe folder
  // roles (hub/rules/skills) and explicitly excludes folders.knowledgeInbox,
  // so knowledgeInbox can never be a member regardless of how getParentId()
  // resolves any individual entry (even if a manifest were corrupted so that
  // e.g. folders.rules happened to equal folders.knowledgeInbox, the shared
  // id would still be excluded here). This makes "never write to
  // knowledgeInbox" structural rather than a per-call conditional check.
  const knowledgeInboxId = manifest.folders?.knowledgeInbox;
  const writableParentIds = new Set(
    [manifest.hubFolderId, manifest.folders?.rules, manifest.folders?.skills]
      .filter((id) => id && id !== knowledgeInboxId)
  );

  const parentFilesCache = new Map();
  async function getFilesForParent(parentId) {
    if (!parentFilesCache.has(parentId)) {
      const list = await listFilesFn(token, parentId);
      list.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      parentFilesCache.set(parentId, list);
    }
    return parentFilesCache.get(parentId);
  }

  function resolveLocalPath(entry) {
    const { title, in: category } = entry;
    if (category === 'hub') {
      return join(repoPath, title);
    } else if (category === 'rules') {
      return join(repoPath, 'rules', title);
    } else if (category === 'skills') {
      const dirName = title.endsWith('.md') ? title.slice(0, -3) : title;
      return join(repoPath, 'skills', dirName, 'SKILL.md');
    }
    throw new Error(`Unknown category: ${category}`);
  }

  function getParentId(category) {
    if (category === 'hub') return manifest.hubFolderId;
    if (category === 'rules') return manifest.folders?.rules;
    if (category === 'skills') return manifest.folders?.skills;
    throw new Error(`Unknown category: ${category}`);
  }

  // Process a single file entry
  async function processFile(entry, isManifest = false) {
    const title = entry.title;
    const parentId = isManifest ? manifest.hubFolderId : getParentId(entry.in);
    const localPath = isManifest ? join(repoPath, 'manifest.json') : resolveLocalPath(entry);
    const relativePath = isManifest ? 'manifest.json' : localPath.replace(repoPath + join('/'), ''); // clean relative path for git

    // Security guard: parentId must be a member of the structural allow-list.
    // This rejects knowledgeInbox (excluded from writableParentIds above) and
    // also rejects any unresolved/unknown parent, instead of only checking
    // equality against a single known-bad id.
    if (!writableParentIds.has(parentId)) {
      const reason = `Security violation: parent folder is not in the write-target allow-list (id=${parentId})`;
      counts.blocked++;
      results.push({ title, status: 'blocked', reason });
      console.log(`blocked ${title}`);
      return false;
    }

    if (!existsSync(localPath)) {
      counts.missing++;
      results.push({ title, status: 'missing', reason: 'Local file does not exist' });
      console.log(`missing ${title}`);
      return false;
    }

    const localContent = readFileSync(localPath);

    try {
      const siblings = await getFilesForParent(parentId);
      const matching = siblings.filter(f => f.name === title);
      const latestDriveFile = matching[0];

      if (latestDriveFile) {
        // Download and compare
        const driveContent = await downloadFileContentFn(token, latestDriveFile.id);
        if (localContent.equals(driveContent)) {
          counts.unchanged++;
          results.push({ title, status: 'unchanged', reason: null });
          console.log(`unchanged ${title}`);
          return true;
        }

        // Collision guard
        let gitTime;
        try {
          gitTime = await gitCommitTimeFn(isManifest ? 'manifest.json' : localPath, repoPath);
        } catch (err) {
          counts.blocked++;
          const reason = `Failed to get git commit time: ${err.message}`;
          results.push({ title, status: 'blocked', reason });
          console.log(`blocked ${title}`);
          return false;
        }

        const driveTime = new Date(latestDriveFile.modifiedTime);
        if (driveTime > gitTime) {
          counts.conflict++;
          const reason = `Drive version (${driveTime.toISOString()}) is newer than Git commit (${gitTime.toISOString()})`;
          results.push({ title, status: 'conflict', reason });
          console.log(`conflict ${title}`);
          return false;
        }

        // Up to date collision guard passed, upload update
        if (dryRun) {
          counts.pushed++;
          results.push({ title, status: 'pushed', reason: '[dry-run]' });
          console.log(`pushed ${title}`);
          return true;
        }

        await uploadFileContentFn(token, { fileId: latestDriveFile.id, content: localContent });

        // Readback verification
        const verifiedContent = await downloadFileContentFn(token, latestDriveFile.id);
        if (!localContent.equals(verifiedContent)) {
          counts.failed++;
          results.push({ title, status: 'failed', reason: 'Readback verification failed' });
          console.log(`failed ${title}`);
          return false;
        }

        counts.pushed++;
        results.push({ title, status: 'pushed', reason: null });
        console.log(`pushed ${title}`);
        return true;
      } else {
        // Create new file
        if (dryRun) {
          counts.pushed++;
          results.push({ title, status: 'pushed', reason: '[dry-run]' });
          console.log(`pushed ${title}`);
          return true;
        }

        const res = await uploadFileContentFn(token, { name: title, parentId, content: localContent });

        // Readback verification
        const verifiedContent = await downloadFileContentFn(token, res.id);
        if (!localContent.equals(verifiedContent)) {
          counts.failed++;
          results.push({ title, status: 'failed', reason: 'Readback verification failed' });
          console.log(`failed ${title}`);
          return false;
        }

        counts.pushed++;
        results.push({ title, status: 'pushed', reason: null });
        console.log(`pushed ${title}`);
        return true;
      }
    } catch (err) {
      counts.failed++;
      results.push({ title, status: 'failed', reason: err.message });
      console.log(`failed ${title}`);
      return false;
    }
  }

  // 1. Process regular files
  let allFilesSucceeded = true;
  for (const fileEntry of manifest.files) {
    const success = await processFile(fileEntry);
    if (!success) {
      allFilesSucceeded = false;
      // conflict/blocked mean the ground truth we rely on (git commit time,
      // or the manifest's own folder-id mapping) is not trustworthy for this
      // run. Stop touching Drive further rather than pushing some files
      // while leaving others behind (a partial, hard-to-audit write). This
      // does NOT apply to missing/failed: those are local/network problems
      // unrelated to Drive trust, so the rest of the manifest still gets a
      // chance to sync.
      const last = results[results.length - 1];
      if (last && (last.status === 'conflict' || last.status === 'blocked')) {
        break;
      }
    }
  }

  // 2. Process manifest.json only if everything else succeeded
  if (allFilesSucceeded) {
    await processFile({ title: 'manifest.json' }, true);
  } else {
    counts.blocked++;
    results.push({
      title: 'manifest.json',
      status: 'blocked',
      reason: 'Skipped uploading manifest.json because other files had failures/changes blocked',
    });
    console.log('blocked manifest.json');
  }

  // Print summary
  console.log(`Summary: pushed:${counts.pushed} unchanged:${counts.unchanged} conflict:${counts.conflict} failed:${counts.failed} missing:${counts.missing} blocked:${counts.blocked}`);

  // Write the final JSON report
  const report = {
    at: new Date().toISOString(),
    repoHead: gitHeadFn(repoPath),
    manifestVersion: manifest.version,
    counts,
    files: results.map(r => ({ title: r.title, status: r.status, reason: r.reason || undefined })),
  };
  writeLastJsonFn(report);

  // Return exit code: 0 if no errors, 1 if any failure/conflict/missing/blocked counts > 0
  const hasErrors = counts.conflict > 0 || counts.failed > 0 || counts.missing > 0 || counts.blocked > 0;
  return hasErrors ? 1 : 0;
}

// Execute CLI only when invoked directly
if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const repoIndex = args.indexOf('--repo');
  const repoPath = repoIndex !== -1 ? args[repoIndex + 1] : undefined;

  // Key exist check
  const keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
  if (!existsSync(keyPath)) {
    console.log('skipped: no SA key');
    process.exit(0);
  }

  try {
    const code = await runMirror({ repoPath, dryRun });
    process.exit(code);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
