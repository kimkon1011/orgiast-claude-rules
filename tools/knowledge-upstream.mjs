#!/usr/bin/env node
// tools/knowledge-upstream.mjs
// 自動の吸い上げ（全PC）: このPCの auto-memory (feedback/project/reference), 学びの台帳, playbooks, incident の差分を Drive inbox へ送信する。
// 資格情報・顧客情報の除外門を通し、share: false は送信しない。失敗はキューに残して再送する。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDriveToken } from './lib/drive-auth.mjs';
import { uploadFileContent, findOrCreateFolder, findByTitle } from './lib/drive-files.mjs';
import { findSharedSecret, parseMemoryFrontmatter, redactForShare } from './lib/share-content.mjs';
import { machineIdentity } from './machine-identity.mjs';
import { installFromDriveMaster } from './memory-share.mjs';
import { isEntry } from './is-entry.mjs';

const INBOX_FOLDER_ID = '1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2';
const CUSTOMER_PATTERNS = [
  ['案件ID', /C0\d{3,}/],
  ['法人名', /株式会社|有限会社|合同会社/],
];

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

export function sourcePcIdentity(home, env = process.env) {
  let identity = {};
  try { identity = machineIdentity() || {}; } catch {}
  const pcId = env.ORGIAST_KEYSERVE_PC || safeReadJson(path.join(home, '.claude', 'keyserve.env'))?.ORGIAST_KEYSERVE_PC || identity.label || env.COMPUTERNAME || os.hostname() || 'unknown-pc';
  const account = safeReadJson(path.join(home, '.claude.json'))?.oauthAccount?.emailAddress || 'unknown';
  return { pcId, account, folderName: `${pcId}-${account}` };
}

export function scanUpstreamCandidates(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const repoPath = options.repoPath || path.join(home, 'orgiast-claude-rules');
  const emit = options.emit || (() => {});
  const candidates = [];

  // 1. Auto-memory (feedback, project, reference)
  const projectsRoot = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projectsRoot)) {
    try {
      for (const projectDir of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!projectDir.isDirectory()) continue;
        const memoryDir = path.join(projectsRoot, projectDir.name, 'memory');
        if (!fs.existsSync(memoryDir)) continue;

        const memoryFiles = [];
        const walk = (d, rel = '') => {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name === 'index') {
              walk(path.join(d, 'index'), 'index/');
            } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md' && entry.name !== 'EXCLUDED.md') {
              memoryFiles.push({ file: path.join(d, entry.name), name: rel + entry.name });
            }
          }
        };
        try { walk(memoryDir); } catch {}

        for (const item of memoryFiles) {
          try {
            const raw = fs.readFileSync(item.file, 'utf8');
            const frontmatter = parseMemoryFrontmatter(raw);
            const type = frontmatter['metadata.type'] || frontmatter.type;

            // user 型は除外
            if (type === 'user' || /^user_[^/]*\.md$/.test(item.name)) {
              emit(`[skip] ${item.name}: user memory is excluded from upstream`);
              continue;
            }

            // share: false 除外
            if ([frontmatter.share, frontmatter['metadata.share']].some(v => /^false(?:\s+#.*)?$/i.test(v || ''))) {
              emit(`[skip] ${item.name}: share: false`);
              continue;
            }

            // 伏字処理
            const redacted = redactForShare(raw);

            // 資格情報除外門
            const secret = findSharedSecret(redacted);
            if (secret) {
              emit(`[exclude] ${item.name}: contains credential secret pattern ${secret[0]}`);
              continue;
            }

            // 顧客情報除外門
            const customer = CUSTOMER_PATTERNS.find(([, p]) => p.test(redacted));
            if (customer) {
              emit(`[exclude] ${item.name}: contains customer info (${customer[0]})`);
              continue;
            }

            candidates.push({
              id: `memory:${item.name}`,
              category: 'memory',
              title: item.name.replace(/\//g, '__'),
              content: redacted,
              sha256: sha256(redacted),
              sourcePath: item.file,
            });
          } catch (err) {
            emit(`[error] reading ${item.file}: ${err.message}`);
          }
        }
      }
    } catch {}
  }

  // 2. Playbooks in repo or home
  const playbooksDirs = [path.join(repoPath, 'playbooks'), path.join(home, '.claude', 'playbooks')];
  for (const pbDir of playbooksDirs) {
    if (!fs.existsSync(pbDir)) continue;
    try {
      for (const entry of fs.readdirSync(pbDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = path.join(pbDir, entry.name);
          const raw = fs.readFileSync(filePath, 'utf8');
          if (findSharedSecret(raw)) continue;
          if (CUSTOMER_PATTERNS.some(([, p]) => p.test(raw))) continue;
          candidates.push({
            id: `playbook:${entry.name}`,
            category: 'playbook',
            title: `playbook__${entry.name}`,
            content: raw,
            sha256: sha256(raw),
            sourcePath: filePath,
          });
        }
      }
    } catch {}
  }

  // 3. Incident types in repo or home
  const incidentFiles = [path.join(repoPath, 'protocols', 'INCIDENT-TYPES.md'), path.join(home, '.claude', 'INCIDENT-TYPES.md')];
  for (const incFile of incidentFiles) {
    if (!fs.existsSync(incFile)) continue;
    try {
      const raw = fs.readFileSync(incFile, 'utf8');
      if (!findSharedSecret(raw) && !CUSTOMER_PATTERNS.some(([, p]) => p.test(raw))) {
        candidates.push({
          id: `incident:${path.basename(incFile)}`,
          category: 'incident',
          title: `incident__${path.basename(incFile)}`,
          content: raw,
          sha256: sha256(raw),
          sourcePath: incFile,
        });
      }
    } catch {}
  }

  return candidates;
}

export async function runKnowledgeUpstream(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const env = options.env || process.env;
  const emit = options.emit || console.log;
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const now = options.now || new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

  const stateFile = options.stateFile || path.join(home, '.claude', 'knowledge-upstream-state.json');
  const state = safeReadJson(stateFile, { lastRunAt: '', sentHashes: {}, unsentQueue: [] });
  if (!state.sentHashes) state.sentHashes = {};
  if (!state.unsentQueue) state.unsentQueue = [];

  const identity = sourcePcIdentity(home, env);
  const candidates = scanUpstreamCandidates({ home, repoPath: options.repoPath, emit });

  // 1. Determine items to send (unsent queue + new/modified candidates)
  const toSend = new Map();

  // Re-add items from previous unsentQueue
  for (const item of state.unsentQueue) {
    toSend.set(item.id, item);
  }

  // Add new or changed candidates
  for (const cand of candidates) {
    const prev = state.sentHashes[cand.id];
    if (force || !prev || prev.sha256 !== cand.sha256) {
      toSend.set(cand.id, {
        id: cand.id,
        category: cand.category,
        title: cand.title,
        content: cand.content,
        sha256: cand.sha256,
        sourcePath: cand.sourcePath,
      });
    }
  }

  const itemsList = [...toSend.values()];
  const result = {
    pcFolder: identity.folderName,
    scanned: candidates.length,
    toSend: itemsList.length,
    sent: 0,
    queued: 0,
    errors: [],
  };

  if (itemsList.length === 0) {
    emit(`knowledge-upstream: up-to-date (scanned ${candidates.length} items)`);
    return result;
  }

  if (dryRun) {
    emit(`knowledge-upstream [dry-run]: would send ${itemsList.length} items to folder '${identity.folderName}' in Drive inbox`);
    return result;
  }

  // 2. Drive Authentication & Folder Resolution
  let token;
  let targetFolderId;
  const getDriveTokenFn = options.getDriveTokenFn || getDriveToken;
  const findOrCreateFolderFn = options.findOrCreateFolderFn || findOrCreateFolder;
  const uploadFileContentFn = options.uploadFileContentFn || uploadFileContent;
  const findByTitleFn = options.findByTitleFn || findByTitle;

  try {
    token = await getDriveTokenFn({ home });
    const pcFolder = await findOrCreateFolderFn(token, identity.folderName, INBOX_FOLDER_ID);
    targetFolderId = pcFolder.id;
  } catch (err) {
    const errorMsg = `Failed Drive auth/folder setup: ${err.message}`;
    emit(`[knowledge-upstream] ${errorMsg}`);
    result.errors.push(errorMsg);
    // Keep all unsent in queue
    state.unsentQueue = itemsList;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    }
    return result;
  }

  // 3. Upload items one by one
  const remainingQueue = [];
  for (const item of itemsList) {
    const fileName = `${dateStr}-${item.title}`;
    try {
      // Check if file with title exists in pcFolder
      const existing = await findByTitleFn(token, fileName, targetFolderId);
      const fileId = existing?.[0]?.id;

      await uploadFileContentFn(token, {
        fileId,
        name: fileName,
        parentId: targetFolderId,
        content: Buffer.from(item.content, 'utf8'),
      });

      state.sentHashes[item.id] = { sha256: item.sha256, sentAt: now.toISOString(), name: fileName };
      result.sent++;
      emit(`[sent] ${item.id} -> ${identity.folderName}/${fileName}`);
    } catch (err) {
      const errorMsg = `Failed to send ${item.id}: ${err.message}`;
      emit(`[error] ${errorMsg}`);
      result.errors.push(errorMsg);
      remainingQueue.push(item);
    }
  }

  state.unsentQueue = remainingQueue;
  state.lastRunAt = now.toISOString();
  result.queued = remainingQueue.length;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  }

  emit(`knowledge-upstream: sent=${result.sent} queued=${result.queued} errors=${result.errors.length}`);
  return result;
}

if (isEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const json = argv.includes('--json');
  const syncDown = argv.includes('--sync-down');
  const options = { dryRun, force, emit: json ? () => {} : console.log };

  try {
    const res = await runKnowledgeUpstream(options);
    if (json) console.log(JSON.stringify(res, null, 2));

    // --sync-down: Pull Drive master knowledge to ~/.claude/shared-memory/
    if (syncDown && !res.errors.length) {
      const home = options.home || process.env.ORGIAST_HOME || os.homedir();
      if (!dryRun) {
        try {
          const downRes = await installFromDriveMaster({ home, emit: options.emit || (() => {}) });
          if (downRes) {
            options.emit(`knowledge-downstream: installed=${downRes.installed} updated=${downRes.updated} unchanged=${downRes.unchanged}`);
          }
        } catch (err) {
          options.emit(`knowledge-downstream error: ${err.message}`);
        }
      } else {
        options.emit('[dry-run] knowledge-downstream: would sync from Drive master');
      }
    }
  } catch (err) {
    console.error(`knowledge-upstream error: ${err.message}`);
    process.exitCode = 1;
  }
}
