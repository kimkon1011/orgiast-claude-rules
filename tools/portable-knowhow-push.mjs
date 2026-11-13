#!/usr/bin/env node
// portable-knowhow/*.md を Drive ハブ配下の「AI共通ノウハウ」フォルダに
// Google ドキュメントとして公開する。毎晩の自動更新用。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { getDriveToken, driveApi as defaultApi } from './lib/drive-auth.mjs';
import { uploadFileContent } from './lib/drive-files.mjs';
import { redactForShare, findSharedSecret } from './lib/share-content.mjs';
import { ensureKimEditor } from './lib/kim-editor.mjs';

const HUB_ID = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw';
const FOLDER_NAME = 'AI共通ノウハウ（Gemini・ChatGPT・Claude用）';
const GDOC_MIME = 'application/vnd.google-apps.document';
const INDEX_FILE = '00_目次・使い方（まずこれを読む）';

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function knowhowDir(root) {
  return path.join(root, 'portable-knowhow');
}

export function collectFiles(root) {
  const dir = knowhowDir(root);
  const names = [];
  try {
    fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'README.md').sort().forEach(n => names.push(n));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return names.map(name => ({
    name: name.replace(/\.md$/, ''),
    path: path.join(dir, name),
    content: fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n'),
  }));
}

const sha256 = buf => createHash('sha256').update(buf.toString()).digest('hex');

async function findFolder(token, apiFn) {
  const q = encodeURIComponent(
    `name='${FOLDER_NAME.replace(/'/g, "\\'")}' and '${HUB_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await apiFn(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime`);
  const json = await res.json();
  const folders = json.files ?? [];
  if (folders.length > 0) {
    if (folders.length > 1) {
      console.warn(`WARN: ${FOLDER_NAME}: ${folders.length} duplicates; using oldest ${folders[0].id}`);
    }
    return folders[0].id;
  }
  const res2 = await apiFn(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, parents: [HUB_ID], mimeType: 'application/vnd.google-apps.folder' }),
  });
  const created = await res2.json();
  await ensureKimEditor(created.id, { token, api: apiFn, created: true });
  return created.id;
}

async function findDoc(token, name, folderId, apiFn) {
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`
  );
  const res = await apiFn(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime`);
  const json = await res.json();
  const docs = json.files ?? [];
  if (docs.length > 1) {
    console.warn(`WARN: ${name}: ${docs.length} duplicates; using oldest ${docs[0].id}`);
  }
  return docs[0];
}

const DESCS = {
  '01_カレンダー空き日程の出し方': '2本のカレンダーを合算した空き時間の計算ルール',
  '02_日程確定と返信メールの書き方': '予定登録・招待・返信のセット手順',
  '03_会食先の選び方': '店探しのリサーチ手順と出力フォーマット',
  '04_メール送信の作法': '送信元アカウント・承認プロセス・書き方ルール',
  '05_請求から入金確認まで': '請求書発行→入金確認→催促の一連の流れ',
  '06_見せる資料の作り方': 'ハイブリッド企画書モデルと手順',
  '07_中古品・部品の探し方': 'フリマ横断検索と互換性確認の手順',
  '08_名刺発注': 'マヒト法人名刺の発注手順',
  '09_GoogleのURLの渡し方': 'authuser パラメータの付け方',
  '10_社内に頼む・聞くときの書き方': '受け手が1通で用が済む連絡の書き方',
};

function buildIndex(docs) {
  const lines = [
    '# オージャスト AI共通ノウハウ（目次）',
    '',
    'このフォルダには、オージャストの業務ノウハウを AI に依存しない形で記述したドキュメントがあります。',
    'どのAI（Gemini・ChatGPT・Claude・NotebookLM 等）からでも読んで使えます。',
    '',
    '---',
    '## 各ドキュメント',
    '',
  ];
  for (const doc of docs) {
    const desc = DESCS[doc.name] || '';
    const link = doc.id ? `https://docs.google.com/document/d/${doc.id}/edit` : `（${doc.name}）`;
    lines.push(`### ${doc.name}`);
    if (desc) lines.push(`- ${desc}`);
    if (doc.id) lines.push(`  - orgiast.jp のアカウントで開いてください: ${link}`);
    lines.push('');
  }
  lines.push(...[
    '---',
    '## AI別の使い方',
    '',
    '### Gemini（Gemini アプリ）',
    '- 左メニューの「@Google ドライブ」を選択 → このフォルダのドキュメントを指定',
    '- 「この手順で空き日程を出して」のように指示',
    '',
    '### Gemini（Gem）',
    '- Gem の「指示」欄にこの目次の内容を追加し、ナレッジとして各ドキュメントを追加',
    '',
    '### ChatGPT',
    '- Google ドライブ連携（有料プラン）でファイルを添付、またはプロジェクトのファイルに追加',
    '',
    '### NotebookLM',
    '- 「ソース」としてこのフォルダのドキュメントを追加',
    '',
    '### 他アカウントの Claude Code',
    '- Google Drive コネクタで download して読む',
    '- Claude Code 専用スキルは別途 claude-common-rules/skills/ を参照',
    '',
    '### Codex / Gemini CLI',
    '- リポジトリ orgiast-claude-rules の portable-knowhow/ と tools/calendar-free-slots.mjs を直接使う',
    '',
    '---',
    '## 関連リソース',
    '',
    '- 制作・営業ナレッジ: ハブ内「production-sales-knowledge」フォルダ',
    '',
  ]);
  return lines.join('\n');
}

export async function runPortableKnowhow({ files, token, dryRun = false, emit = console.log, apiFn = defaultApi } = {}) {
  const root = repoRoot();
  const collected = files || collectFiles(root);
  if (!collected.length) { emit('portable-knowhow: 公開対象ファイルなし'); return { updated: 0, unchanged: 0, skipped: 0 }; }

  const stats = { updated: 0, unchanged: 0, skipped: 0 };

  // 秘密チェック
  for (const file of collected) {
    const redacted = redactForShare(file.content);
    const secret = findSharedSecret(file.content) || findSharedSecret(redacted);
    if (secret) {
      emit(`秘密検出: ${file.name} — ${secret[0]}`);
      if (!dryRun) throw new Error(`portable-knowhow: ${file.name} に秘密情報が含まれています: ${secret[0]}`);
      stats.skipped++;
    }
  }
  if (stats.skipped && !dryRun) return stats;

  const folderId = dryRun ? 'dry-run-folder' : await findFolder(token, apiFn);
  const plan = [];

  for (const file of collected) {
    const sha = sha256(file.content);
    let existingId = null;
    let existingSha = null;

    if (!dryRun) {
      const existing = await findDoc(token, file.name, folderId, apiFn);
      if (existing) {
        existingId = existing.id;
        const propsRes = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${existing.id}?fields=appProperties`);
        const props = await propsRes.json();
        existingSha = props?.appProperties?.pkSha;
      }
    }

    if (!dryRun && existingSha === sha) {
      emit(`unchanged: ${file.name}`);
      stats.unchanged++;
      plan.push({ ...file, id: existingId, status: 'unchanged' });
      continue;
    }

    if (dryRun) {
      const action = existingId ? 'update' : 'create';
      emit(`[dry-run] ${action}: ${file.name} (sha: ${sha.slice(0, 8)}...)`);
      plan.push({ ...file, id: existingId, status: action });
      continue;
    }

    const uploadResult = await uploadFileContent(token, {
      fileId: existingId, name: file.name, parentId: folderId, content: file.content,
      mimeType: GDOC_MIME, contentType: 'text/markdown; charset=utf-8', apiFn,
    });
    const newId = uploadResult.id;

    // 検証: mimeType が Google ドキュメントであることを確認
    const mimeRes = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${newId}?fields=mimeType`);
    const mimeData = await mimeRes.json();
    if (mimeData.mimeType !== GDOC_MIME) {
      throw new Error(`portable-knowhow: ${file.name} — expected ${GDOC_MIME}, got ${mimeData.mimeType}`);
    }

    await apiFn(token, `https://www.googleapis.com/drive/v3/files/${newId}?supportsAllDrives=true`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { pkSha: sha } }),
    });

    // 検証: pkSha が正しく書き込まれたことを確認
    const propsRes = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${newId}?fields=appProperties`);
    const propsData = await propsRes.json();
    if (propsData?.appProperties?.pkSha !== sha) {
      throw new Error(`portable-knowhow: ${file.name} — pkSha mismatch after update`);
    }

    await ensureKimEditor(newId, { token, api: apiFn });
    emit(`published: ${file.name} (${newId})`);
    stats.updated++;
    plan.push({ ...file, id: newId, status: existingId ? 'updated' : 'created' });
  }

  // 目次生成
  const publishedFiles = plan.filter(f => f.id || dryRun);
  const docsWithIds = plan.some(f => f.id);
  const indexDocs = docsWithIds ? plan.filter(f => f.id).map(f => ({ name: f.name, id: f.id })) : collected.map(f => ({ name: f.name, id: null }));
  const indexContent = buildIndex(indexDocs);
  const indexSha = sha256(indexContent);

  if (!dryRun) {
    const existingIndex = await findDoc(token, INDEX_FILE, folderId, apiFn);
    const indexId = existingIndex?.id;
    let existingIndexSha = null;
    if (existingIndex) {
      const propsRes = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${indexId}?fields=appProperties`);
      const props = await propsRes.json();
      existingIndexSha = props?.appProperties?.pkSha;
    }

    if (existingIndexSha !== indexSha) {
      const uploadResult = await uploadFileContent(token, {
        fileId: indexId, name: INDEX_FILE, parentId: folderId, content: indexContent,
        mimeType: GDOC_MIME, contentType: 'text/markdown; charset=utf-8', apiFn,
      });
      const newIndexId = uploadResult.id;

      // 検証: mimeType
      const idxMimeRes = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${newIndexId}?fields=mimeType`);
      const idxMimeData = await idxMimeRes.json();
      if (idxMimeData.mimeType !== GDOC_MIME) {
        throw new Error(`portable-knowhow: ${INDEX_FILE} — expected ${GDOC_MIME}, got ${idxMimeData.mimeType}`);
      }

      await apiFn(token, `https://www.googleapis.com/drive/v3/files/${newIndexId}?supportsAllDrives=true`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties: { pkSha: indexSha } }),
      });

      // 検証: pkSha
      const idxPropsRes = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${newIndexId}?fields=appProperties`);
      const idxPropsData = await idxPropsRes.json();
      if (idxPropsData?.appProperties?.pkSha !== indexSha) {
        throw new Error(`portable-knowhow: ${INDEX_FILE} — pkSha mismatch after update`);
      }

      await ensureKimEditor(newIndexId, { token, api: apiFn });
      emit(`published: ${INDEX_FILE} (${newIndexId})`);
      stats.updated++;
    } else {
      emit(`unchanged: ${INDEX_FILE}`);
      stats.unchanged++;
    }
  } else {
    emit(`[dry-run] would update: ${INDEX_FILE}`);
  }

  return stats;
}

export function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

if (isEntry(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.dryRun) {
      const token = await getDriveToken({ signal: AbortSignal.timeout(30000) });
      const result = await runPortableKnowhow({ token, emit: console.log });
      console.log(`portable-knowhow: updated=${result.updated} unchanged=${result.unchanged} skipped=${result.skipped}`);
    } else {
      const result = await runPortableKnowhow({ dryRun: true, emit: console.log });
      console.log(`portable-knowhow: updated=${result.updated} unchanged=${result.unchanged} skipped=${result.skipped}`);
    }
  } catch (e) {
    console.error(`portable-knowhow-push: ${e.message}`);
    process.exitCode = 1;
  }
}