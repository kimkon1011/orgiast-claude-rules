import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runKnowledgeUpstream, scanUpstreamCandidates, sourcePcIdentity } from './knowledge-upstream.mjs';

function createMockEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-test-'));
  const projectsDir = path.join(tmpDir, '.claude', 'projects', 'proj1', 'memory');
  fs.mkdirSync(projectsDir, { recursive: true });

  // 1. Valid feedback memory
  fs.writeFileSync(path.join(projectsDir, 'feedback_rule1.md'), `---
type: feedback
---
# Rule 1
Always verify before handoff.
`);

  // 2. User memory (should be excluded)
  fs.writeFileSync(path.join(projectsDir, 'user_pref.md'), `---
type: user
---
# User Preference
I like dark mode.
`);

  // 3. Opt-out memory (share: false)
  fs.writeFileSync(path.join(projectsDir, 'feedback_private.md'), `---
type: feedback
share: false
---
# Private note
Do not share this.
`);

  // 4. Credential secret memory (ORGIAST_SHARED_SECRET)
  fs.writeFileSync(path.join(projectsDir, 'feedback_secret.md'), `---
type: feedback
---
# Secret key
ORGIAST_SHARED_SECRET = super_secret_pass
`);

  // 5. Customer info memory (株式会社 / C0123)
  fs.writeFileSync(path.join(projectsDir, 'feedback_customer.md'), `---
type: feedback
---
# Customer note
株式会社サンプル商事 案件 ID C01234
`);

  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

test('scanUpstreamCandidates filters user, share:false, secrets, and customer info', () => {
  const { tmpDir, cleanup } = createMockEnv();
  try {
    const candidates = scanUpstreamCandidates({ home: tmpDir, repoPath: tmpDir });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, 'memory:feedback_rule1.md');
    assert.match(candidates[0].content, /Always verify before handoff/);
  } finally {
    cleanup();
  }
});

test('sourcePcIdentity formats pcId and account into folderName', () => {
  const env = { ORGIAST_KEYSERVE_PC: 'PC02' };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'test@orgiast.jp' } }));
    const id = sourcePcIdentity(tmpDir, env);
    assert.equal(id.pcId, 'PC02');
    assert.equal(id.account, 'test@orgiast.jp');
    assert.equal(id.folderName, 'PC02-test@orgiast.jp');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runKnowledgeUpstream uploads candidates and handles Drive failure retries', async () => {
  const { tmpDir, cleanup } = createMockEnv();
  try {
    const uploaded = [];
    const mockFindOrCreateFolder = async (token, name, parentId) => ({ id: 'folder_123', name });
    const mockUpload = async (token, opts) => {
      if (opts.name.includes('fail')) throw new Error('network timeout');
      uploaded.push(opts);
      return { id: 'file_456' };
    };
    const mockFindByTitle = async () => [];

    const res = await runKnowledgeUpstream({
      home: tmpDir,
      repoPath: tmpDir,
      getDriveTokenFn: async () => 'mock_token',
      findOrCreateFolderFn: mockFindOrCreateFolder,
      uploadFileContentFn: mockUpload,
      findByTitleFn: mockFindByTitle,
      now: new Date('2026-11-07T10:00:00Z'),
    });

    assert.equal(res.sent, 1);
    assert.equal(res.queued, 0);
    assert.equal(uploaded.length, 1);

    // Re-run should skip already sent items
    const res2 = await runKnowledgeUpstream({
      home: tmpDir,
      repoPath: tmpDir,
      getDriveTokenFn: async () => 'mock_token',
      findOrCreateFolderFn: mockFindOrCreateFolder,
      uploadFileContentFn: mockUpload,
      findByTitleFn: mockFindByTitle,
      now: new Date('2026-11-07T11:00:00Z'),
    });

    assert.equal(res2.toSend, 0);
    assert.equal(res2.sent, 0);

    // Test failure queue retry
    let attemptCount = 0;
    const mockFailingUpload = async (token, opts) => {
      attemptCount++;
      if (attemptCount === 1) throw new Error('Drive API 500 error');
      uploaded.push(opts);
      return { id: 'file_789' };
    };

    // Add a new memory file
    const projectsDir = path.join(tmpDir, '.claude', 'projects', 'proj1', 'memory');
    fs.writeFileSync(path.join(projectsDir, 'feedback_rule2.md'), `---
type: feedback
---
# Rule 2
Be extra careful with database migrations.
`);

    // First attempt fails
    const resFail = await runKnowledgeUpstream({
      home: tmpDir,
      repoPath: tmpDir,
      getDriveTokenFn: async () => 'mock_token',
      findOrCreateFolderFn: mockFindOrCreateFolder,
      uploadFileContentFn: mockFailingUpload,
      findByTitleFn: mockFindByTitle,
      now: new Date('2026-11-07T12:00:00Z'),
    });

    assert.equal(resFail.sent, 0);
    assert.equal(resFail.queued, 1);

    // Second attempt succeeds and flushes queue
    const resRetry = await runKnowledgeUpstream({
      home: tmpDir,
      repoPath: tmpDir,
      getDriveTokenFn: async () => 'mock_token',
      findOrCreateFolderFn: mockFindOrCreateFolder,
      uploadFileContentFn: mockFailingUpload,
      findByTitleFn: mockFindByTitle,
      now: new Date('2026-11-07T13:00:00Z'),
    });

    assert.equal(resRetry.sent, 1);
    assert.equal(resRetry.queued, 0);
  } finally {
    cleanup();
  }
});
