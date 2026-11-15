#!/usr/bin/env node
// tools/knowledge-merge.mjs
// 自動の統合（kim-PC のみ）: Drive inbox (claude-common-rules/knowledge-inbox/*/*) の投稿を
// 正本 (claude-common-rules/knowledge/) へ統合する。
// 同義判定には安い LLM (llm-ask.mjs 経由: gemini -> deepseek -> groq、Claude API は使わない) を使い、
// 呼称（kim/ユーザー）や PC 固有パスは汎用化する。資格情報や顧客名が残っていれば quarantine へ隔離する。
// 3回以上の出現で promotion-queue へ載せる。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { downloadFileContent, uploadFileContent, findOrCreateFolder, listFiles, findByTitle } from './lib/drive-files.mjs';
import { findSharedSecret, parseMemoryFrontmatter, redactForShare } from './lib/share-content.mjs';
import { machineIdentity, getClaudeAccountEmail } from './machine-identity.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { isEntry } from './is-entry.mjs';

const execFileAsync = promisify(execFile);

const HUB_FOLDER_ID = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw';
const INBOX_FOLDER_ID = '1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2';

const CUSTOMER_PATTERNS = [
  ['案件ID', /C0\d{3,}/],
  ['法人名', /株式会社|有限会社|合同会社/],
];

// Category subfolder names under knowledge/
const CATEGORY_MAP = Object.freeze({
  feedback: 'feedback',
  project: 'project',
  reference: 'reference',
  playbook: 'playbook',
  incident: 'incident',
});
const EXPORT_FOLDER_NAME = '_export';
const BUNDLE_MANIFEST_NAME = 'manifest.json';
const BUNDLE_PART_PREFIX = 'part-';
const PROCESSED_FOLDER_NAME = '_processed';

export function inferCategory(content) {
  const frontmatter = parseMemoryFrontmatter(content);
  const type = frontmatter['metadata.type'] || frontmatter.type || '';
  return CATEGORY_MAP[type] || 'general';
}

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

export function generalizeContent(content) {
  let text = String(content || '');
  // Anonymize personal names / terms
  text = text.replace(/kim\b/gi, '管理者');
  text = text.replace(/ユーザー/g, 'user');

  // Anonymize PC-specific paths
  text = text.replace(/[A-Za-z]:\\[^\s"'`\n]+/g, '[path]');
  text = text.replace(/\/(?:Users|home|mnt)\/[^\s"'`\n]+/g, '[path]');

  return text;
}

export async function askLlmSynonym(candidate, masterFiles, options = {}) {
  if (options.askLlmFn) {
    return options.askLlmFn(candidate, masterFiles);
  }

  if (!masterFiles || masterFiles.length === 0) {
    return { synonym: false };
  }

  const promptText = `あなたはナレッジデータベースの重複検出AIです。
新規投稿が既存のマスターナレッジの中に同義・重複するものがあるか判定してください。

新規投稿:
タイトル: ${candidate.title}
本文:
${candidate.content.slice(0, 1500)}

既存マスター一覧:
${masterFiles.map((m, i) => `${i + 1}. [id: ${m.id}] ${m.name}`).join('\n')}

回答ルール:
- 同義・同主旨のマスターが存在する場合: JSON \`{"synonym": true, "masterFileId": "マスターのid", "masterFileName": "マスターのファイル名"}\` のみ出力してください。
- 同義のマスターが存在しない場合: JSON \`{"synonym": false}\` のみ出力してください。
- 他の文章は一切出力しないでください。`;

  try {
    const toolsDir = path.dirname(fileURLToPath(import.meta.url));
    const llmAskScript = path.join(toolsDir, 'llm-ask.mjs');

    // gemini -> deepseek -> groq (NO Claude API)
    const { stdout } = await execFileAsync(
      process.execPath,
      [llmAskScript, '--provider', 'gemini', '--category', 'classification', promptText],
      { timeout: 30000, encoding: 'utf8' }
    );

    const jsonMatch = stdout.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.synonym === 'boolean') {
        return parsed;
      }
    }
  } catch (err) {
    // Fallback: simple title match
    const match = masterFiles.find(m => m.name.includes(candidate.title) || candidate.title.includes(m.name.replace(/\.md$/, '')));
    if (match) {
      return { synonym: true, masterFileId: match.id, masterFileName: match.name };
    }
  }

  return { synonym: false };
}

export function updateMetadataCount(content, currentCount = 1) {
  const frontmatter = parseMemoryFrontmatter(content);
  const prev = Number.parseInt(frontmatter['metadata.count'] || frontmatter.count || '1', 10);
  const count = (Number.isInteger(prev) ? prev : 1) + currentCount;

  let newContent = content;
  if (/count:\s*\d+/.test(newContent)) {
    newContent = newContent.replace(/count:\s*\d+/, `count: ${count}`);
  } else if (/^---[\s\S]*?---/.test(newContent)) {
    newContent = newContent.replace(/^---/, `---\ncount: ${count}`);
  } else {
    newContent = `---\ncount: ${count}\n---\n\n${newContent}`;
  }

  const isPromote = count >= 3;
  if (isPromote) {
    if (/status:\s*\w+/.test(newContent)) {
      newContent = newContent.replace(/status:\s*\w+/, 'status: PROMOTE');
    } else if (/^---[\s\S]*?---/.test(newContent)) {
      newContent = newContent.replace(/^---/, `---\nstatus: PROMOTE`);
    }
  }

  return { content: newContent, count, isPromote };
}

export async function runKnowledgeMerge(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const env = options.env || process.env;
  const emit = options.emit || console.log;
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const now = options.now || new Date();

  // kim-PC のみ実行
  if (!force && !isKimOperated(home)) {
    emit('knowledge-merge: non kim-PC seat, skipping merge');
    return { skipped: true, reason: 'not kim-PC' };
  }

  const stateFile = options.stateFile || path.join(home, '.claude', 'knowledge-merge-state.json');
  const state = safeReadJson(stateFile, { lastRunAt: '', mergedFiles: {}, promoteQueue: [] });
  if (!state.mergedFiles) state.mergedFiles = {};
  if (!state.promoteQueue) state.promoteQueue = [];

  const getDriveTokenFn = options.getDriveTokenFn || getDriveToken;
  const findOrCreateFolderFn = options.findOrCreateFolderFn || findOrCreateFolder;
  const listFilesFn = options.listFilesFn || listFiles;
  const downloadFileContentFn = options.downloadFileContentFn || downloadFileContent;
  const uploadFileContentFn = options.uploadFileContentFn || uploadFileContent;

  const result = {
    processed: 0,
    merged: 0,
    updated: 0,
    quarantined: 0,
    promoted: 0,
    errors: [],
  };

  let token;
  let masterFolderId;
  let quarantineFolderId;

  try {
    token = await getDriveTokenFn({ home });

    // 1. Ensure master knowledge folder and quarantine folder in Drive
    const masterFolder = await findOrCreateFolderFn(token, 'knowledge', HUB_FOLDER_ID);
    masterFolderId = masterFolder.id;

    const quarantineFolder = await findOrCreateFolderFn(token, 'quarantine', HUB_FOLDER_ID);
    quarantineFolderId = quarantineFolder.id;
  } catch (err) {
    const errorMsg = `Failed Drive setup for merge: ${err.message}`;
    emit(`[knowledge-merge] ${errorMsg}`);
    result.errors.push(errorMsg);
    return result;
  }

  // 2. Read inbox subfolders (<PC>-<account>)
  let inboxSubfolders = [];
  try {
    const items = await listFilesFn(token, INBOX_FOLDER_ID);
    inboxSubfolders = items.filter(f => f.mimeType === 'application/vnd.google-apps.folder' || !f.mimeType);
  } catch (err) {
    const errorMsg = `Failed to list inbox subfolders: ${err.message}`;
    emit(`[knowledge-merge] ${errorMsg}`);
    result.errors.push(errorMsg);
    return result;
  }

  // 3. Collect unmerged files from inbox subfolders
  const inboxFiles = [];
  for (const folder of inboxSubfolders) {
    try {
      const files = await listFilesFn(token, folder.id);
      for (const f of files) {
        if (!state.mergedFiles[f.id] || force) {
          inboxFiles.push({ ...f, pcFolder: folder.name });
        }
      }
    } catch {}
  }

  if (inboxFiles.length === 0) {
    emit('knowledge-merge: up-to-date (no new inbox items)');
    return result;
  }

  emit(`knowledge-merge: found ${inboxFiles.length} new items in inbox`);

  // List existing master files
  let masterFiles = [];
  try {
    masterFiles = await listFilesFn(token, masterFolderId);
  } catch {}

  // 4. Process each inbox file
  for (const inboxItem of inboxFiles) {
    result.processed++;
    try {
      const rawContentBuf = await downloadFileContentFn(token, inboxItem.id);
      const rawContent = rawContentBuf.toString('utf8');

      // Check credentials secret gate
      const secret = findSharedSecret(rawContent);
      if (secret) {
        emit(`[quarantine] ${inboxItem.name}: contains secret pattern ${secret[0]}`);
        result.quarantined++;
        if (!dryRun) {
          await uploadFileContentFn(token, {
            name: `quarantined-${inboxItem.name}`,
            parentId: quarantineFolderId,
            content: Buffer.from(rawContent, 'utf8'),
          });
          state.mergedFiles[inboxItem.id] = { status: 'quarantined', at: now.toISOString(), reason: 'secret' };
        }
        continue;
      }

      // Check customer info gate
      const customer = CUSTOMER_PATTERNS.find(([, p]) => p.test(rawContent));
      if (customer) {
        emit(`[quarantine] ${inboxItem.name}: contains customer info (${customer[0]})`);
        result.quarantined++;
        if (!dryRun) {
          await uploadFileContentFn(token, {
            name: `quarantined-${inboxItem.name}`,
            parentId: quarantineFolderId,
            content: Buffer.from(rawContent, 'utf8'),
          });
          state.mergedFiles[inboxItem.id] = { status: 'quarantined', at: now.toISOString(), reason: 'customer' };
        }
        continue;
      }

      // Generalize content
      const generalized = generalizeContent(rawContent);
      const title = inboxItem.name.replace(/^\d{8}-/, '').replace(/\.md$/, '');

      // Check synonym with master files via LLM
      const synonymRes = await askLlmSynonym({ title, content: generalized }, masterFiles, options);

      if (synonymRes.synonym && synonymRes.masterFileId) {
        // Update existing master file
        emit(`[synonym update] ${inboxItem.name} -> master ${synonymRes.masterFileName || synonymRes.masterFileId}`);
        const existingMasterBuf = await downloadFileContentFn(token, synonymRes.masterFileId);
        const { content: updatedMaster, count, isPromote } = updateMetadataCount(existingMasterBuf.toString('utf8'), 1);

        if (!dryRun) {
          await uploadFileContentFn(token, {
            fileId: synonymRes.masterFileId,
            content: Buffer.from(updatedMaster, 'utf8'),
          });
          result.updated++;
          if (isPromote) {
            result.promoted++;
            state.promoteQueue.push({ id: synonymRes.masterFileId, title, count, at: now.toISOString() });
          }
          state.mergedFiles[inboxItem.id] = { status: 'updated', masterId: synonymRes.masterFileId, at: now.toISOString() };
        }
      } else {
        // Create new master file
        const masterFileName = inboxItem.name.replace(/^\d{8}-/, '');
        emit(`[new master] ${inboxItem.name} -> knowledge/${masterFileName}`);

        const { content: initialMaster } = updateMetadataCount(generalized, 1);

        if (!dryRun) {
          const created = await uploadFileContentFn(token, {
            name: masterFileName,
            parentId: masterFolderId,
            content: Buffer.from(initialMaster, 'utf8'),
          });
          result.merged++;
          masterFiles.push({ id: created.id, name: masterFileName });
          state.mergedFiles[inboxItem.id] = { status: 'merged', masterId: created.id, at: now.toISOString() };
        }
      }
    } catch (err) {
      const errorMsg = `Failed to merge ${inboxItem.name}: ${err.message}`;
      emit(`[error] ${errorMsg}`);
      result.errors.push(errorMsg);
    }
  }

  state.lastRunAt = now.toISOString();

  if (!dryRun) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  }

  emit(`knowledge-merge: processed=${result.processed} merged=${result.merged} updated=${result.updated} quarantined=${result.quarantined} promoted=${result.promoted}`);
  return result;
}

if (isEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const json = argv.includes('--json');
  const options = { dryRun, force, emit: json ? () => {} : console.log };

  try {
    const res = await runKnowledgeMerge(options);
    if (json) console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(`knowledge-merge error: ${err.message}`);
    process.exitCode = 1;
  }
}
