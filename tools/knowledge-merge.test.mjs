import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generalizeContent, updateMetadataCount, runKnowledgeMerge } from './knowledge-merge.mjs';

test('generalizeContent replaces personal names and local paths', () => {
  const raw = 'kim さんが C:\\Users\\uers\\Downloads\\test.txt でユーザーに指示した';
  const res = generalizeContent(raw);
  assert.match(res, /管理者/);
  assert.match(res, /user/);
  assert.match(res, /\[path\]/);
  assert.ok(!res.includes('C:\\Users'));
});

test('updateMetadataCount increments count and flags PROMOTE when count >= 3', () => {
  const content = `---
type: feedback
count: 2
---
# Test Rule
Rule text
`;
  const { content: updated, count, isPromote } = updateMetadataCount(content, 1);
  assert.equal(count, 3);
  assert.equal(isPromote, true);
  assert.match(updated, /count: 3/);
  assert.match(updated, /status: PROMOTE/);
});

test('runKnowledgeMerge processes inbox files, quarantines secrets, and merges master', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
  try {
    const uploaded = [];
    const mockFindOrCreateFolder = async (token, name) => ({ id: `folder_${name}` });
    const mockListFiles = async (token, folderId) => {
      if (folderId === '1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2') {
        return [{ id: 'pc1_folder', name: 'PC01-test@orgiast.jp', mimeType: 'application/vnd.google-apps.folder' }];
      }
      if (folderId === 'pc1_folder') {
        return [
          { id: 'file_valid', name: '20261107-valid_rule.md' },
          { id: 'file_secret', name: '20261107-secret_rule.md' },
        ];
      }
      if (folderId === 'folder_knowledge') {
        return [];
      }
      return [];
    };

    const mockDownload = async (token, fileId) => {
      if (fileId === 'file_valid') {
        return Buffer.from('---\ntype: feedback\n---\n# Valid Rule\nAlways verify before handoff.');
      }
      if (fileId === 'file_secret') {
        return Buffer.from('---\ntype: feedback\n---\nORGIAST_SHARED_SECRET = my_secret_token');
      }
      return Buffer.from('');
    };

    const mockUpload = async (token, opts) => {
      uploaded.push(opts);
      return { id: `master_${opts.name}` };
    };

    const mockAskLlm = async () => ({ synonym: false });

    const res = await runKnowledgeMerge({
      home: tmpDir,
      force: true,
      getDriveTokenFn: async () => 'mock_token',
      findOrCreateFolderFn: mockFindOrCreateFolder,
      listFilesFn: mockListFiles,
      downloadFileContentFn: mockDownload,
      uploadFileContentFn: mockUpload,
      askLlmFn: mockAskLlm,
      emit: () => {},
    });

    assert.equal(res.processed, 2);
    assert.equal(res.merged, 1);
    assert.equal(res.quarantined, 1);
    assert.equal(uploaded.length, 2); // 1 quarantined, 1 master merged
    assert.ok(uploaded.some(u => u.name.includes('quarantined')));
    assert.ok(uploaded.some(u => u.name === 'valid_rule.md'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('register-knowledge-merge-task.ps1 uses -RepetitionInterval parameter and verifies read-back', () => {
  const script = fs.readFileSync(new URL('./register-knowledge-merge-task.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\.RepetitionInterval\s*=/);
  assert.match(script, /-RepetitionInterval \(New-TimeSpan -Hours 1\)/);
  assert.match(script, /Get-ScheduledTask -TaskName \$taskName/);
  assert.match(script, /Repetition\.Interval/);
});
