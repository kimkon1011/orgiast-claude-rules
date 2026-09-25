import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMirror } from './drive-hub-mirror.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper to set up a temporary test repository directory structure
function setupTestRepo(name) {
  const repoPath = join(__dirname, `drive_mirror_test_repo_${name}`);
  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(join(repoPath, 'rules'), { recursive: true });
  mkdirSync(join(repoPath, 'skills', 'gas-project-setup'), { recursive: true });

  const testManifest = {
    version: 42,
    hubFolderId: 'drive_hub_id',
    folders: {
      rules: 'drive_rules_id',
      skills: 'drive_skills_id',
      knowledgeInbox: 'drive_inbox_id',
    },
    files: [
      { title: 'ONBOARDING.md', in: 'hub' },
      { title: 'gas.md', in: 'rules' },
      { title: 'gas-project-setup.md', in: 'skills' },
    ],
  };

  writeFileSync(join(repoPath, 'manifest.json'), JSON.stringify(testManifest, null, 2), 'utf8');
  writeFileSync(join(repoPath, 'ONBOARDING.md'), 'hub content', 'utf8');
  writeFileSync(join(repoPath, 'rules', 'gas.md'), 'rules content', 'utf8');
  writeFileSync(join(repoPath, 'skills', 'gas-project-setup', 'SKILL.md'), 'skills content', 'utf8');

  return {
    repoPath,
    cleanup: () => {
      try {
        rmSync(repoPath, { recursive: true, force: true });
      } catch {}
    },
  };
}

test('drive-hub-mirror: resolve paths correctly and sync successfully when Drive is older', async () => {
  const { repoPath, cleanup } = setupTestRepo('success');

  const uploadCalls = [];
  const downloadCalls = [];
  const listCalls = [];
  let lastJsonWritten = null;

  const mockGetDriveToken = async () => 'mock-token';
  const mockGitCommitTime = async (filePath) => new Date('2026-09-20T12:00:00Z');
  const mockGitHead = () => 'test-commit-hash';

  const mockListFiles = async (token, parentId) => {
    listCalls.push(parentId);
    // Return some mock drive files that are older than our git commit time
    if (parentId === 'drive_hub_id') {
      return [
        { id: 'drive_onboarding_id', name: 'ONBOARDING.md', modifiedTime: '2026-09-19T12:00:00Z' },
        { id: 'drive_manifest_id', name: 'manifest.json', modifiedTime: '2026-09-19T12:00:00Z' },
      ];
    }
    if (parentId === 'drive_rules_id') {
      return [
        { id: 'drive_gas_id', name: 'gas.md', modifiedTime: '2026-09-19T12:00:00Z' },
      ];
    }
    if (parentId === 'drive_skills_id') {
      return [
        { id: 'drive_skill_id', name: 'gas-project-setup.md', modifiedTime: '2026-09-19T12:00:00Z' },
      ];
    }
    return [];
  };

  // Stateful in-memory Drive backing store, keyed by fileId. The real
  // uploadFileContent (tools/lib/drive-files.mjs) performs a PATCH
  // uploadType=media that preserves fileId and always resolves to
  // `{ id: fileId }` on update (it never mints a new id for an existing
  // file). The implementation under test relies on that: it re-downloads by
  // the *same* fileId for readback verification. A stateless mock that
  // returns fixed "old" content for drive_*_id and only returns "new"
  // content for a differently-named uploaded_*_id can never let a
  // spec-compliant (fileId-preserving) implementation pass, because it would
  // never see its own write reflected. This store actually persists what
  // gets uploaded, the way real Drive would.
  const driveStore = {
    drive_onboarding_id: 'old hub content',
    drive_gas_id: 'old rules content',
    drive_skill_id: 'old skills content',
    drive_manifest_id: 'old manifest content',
  };

  const mockDownloadFileContent = async (token, fileId) => {
    downloadCalls.push(fileId);
    return Buffer.from(driveStore[fileId] ?? '');
  };

  const mockUploadFileContent = async (token, { fileId, name, parentId, content }) => {
    uploadCalls.push({ fileId, name, parentId, content: content.toString() });
    if (fileId) {
      driveStore[fileId] = content.toString();
      return { id: fileId };
    }
    const newId = `uploaded_${name.replace('.md', '')}_id`;
    driveStore[newId] = content.toString();
    return { id: newId };
  };

  const mockWriteLastJson = (report) => {
    lastJsonWritten = report;
  };

  const code = await runMirror({
    repoPath,
    dryRun: false,
    getDriveTokenFn: mockGetDriveToken,
    gitCommitTimeFn: mockGitCommitTime,
    gitHeadFn: mockGitHead,
    listFilesFn: mockListFiles,
    downloadFileContentFn: mockDownloadFileContent,
    uploadFileContentFn: mockUploadFileContent,
    writeLastJsonFn: mockWriteLastJson,
  });

  cleanup();

  // Asserts
  assert.strictEqual(code, 0, 'Exit code should be 0 for successful sync');

  // We expect three files + manifest.json to be uploaded
  assert.strictEqual(uploadCalls.length, 4, 'Should upload 4 files (3 regular + 1 manifest)');
  assert.ok(uploadCalls.some(c => c.fileId === 'drive_onboarding_id' && c.content === 'hub content'), 'ONBOARDING.md uploaded');
  assert.ok(uploadCalls.some(c => c.fileId === 'drive_gas_id' && c.content === 'rules content'), 'gas.md uploaded');
  assert.ok(uploadCalls.some(c => c.fileId === 'drive_skill_id' && c.content === 'skills content'), 'gas-project-setup.md uploaded');
  assert.ok(uploadCalls.some(c => c.fileId === 'drive_manifest_id'), 'manifest.json uploaded');

  // Verify counts in report
  assert.ok(lastJsonWritten, 'JSON report should be written');
  assert.strictEqual(lastJsonWritten.counts.pushed, 4, 'pushed count should be 4');
  assert.strictEqual(lastJsonWritten.counts.unchanged, 0, 'unchanged count should be 0');
  assert.strictEqual(lastJsonWritten.counts.conflict, 0, 'conflict count should be 0');
});

test('drive-hub-mirror: unchanged files do not trigger upload', async () => {
  const { repoPath, cleanup } = setupTestRepo('unchanged');

  const uploadCalls = [];
  const mockGetDriveToken = async () => 'mock-token';
  const mockGitCommitTime = async () => new Date('2026-09-20T12:00:00Z');
  const mockGitHead = () => 'test-commit-hash';

  const mockListFiles = async (token, parentId) => {
    if (parentId === 'drive_hub_id') {
      return [
        { id: 'drive_onboarding_id', name: 'ONBOARDING.md', modifiedTime: '2026-09-19T12:00:00Z' },
        { id: 'drive_manifest_id', name: 'manifest.json', modifiedTime: '2026-09-19T12:00:00Z' },
      ];
    }
    if (parentId === 'drive_rules_id') {
      return [
        { id: 'drive_gas_id', name: 'gas.md', modifiedTime: '2026-09-19T12:00:00Z' },
      ];
    }
    if (parentId === 'drive_skills_id') {
      return [
        { id: 'drive_skill_id', name: 'gas-project-setup.md', modifiedTime: '2026-09-19T12:00:00Z' },
      ];
    }
    return [];
  };

  const mockDownloadFileContent = async (token, fileId) => {
    // Return identical contents
    if (fileId === 'drive_onboarding_id') return Buffer.from('hub content');
    if (fileId === 'drive_gas_id') return Buffer.from('rules content');
    if (fileId === 'drive_skill_id') return Buffer.from('skills content');
    if (fileId === 'drive_manifest_id') return readFileSync(join(repoPath, 'manifest.json'));
    return Buffer.from('');
  };

  const mockUploadFileContent = async (token, req) => {
    uploadCalls.push(req);
    return { id: 'some-id' };
  };

  let lastJsonWritten = null;
  const mockWriteLastJson = (report) => {
    lastJsonWritten = report;
  };

  const code = await runMirror({
    repoPath,
    dryRun: false,
    getDriveTokenFn: mockGetDriveToken,
    gitCommitTimeFn: mockGitCommitTime,
    gitHeadFn: mockGitHead,
    listFilesFn: mockListFiles,
    downloadFileContentFn: mockDownloadFileContent,
    uploadFileContentFn: mockUploadFileContent,
    writeLastJsonFn: mockWriteLastJson,
  });

  cleanup();

  assert.strictEqual(code, 0, 'Exit code should be 0');
  assert.strictEqual(uploadCalls.length, 0, 'No uploads should happen when files are unchanged');
  assert.strictEqual(lastJsonWritten.counts.unchanged, 4, 'unchanged count should be 4 (3 files + 1 manifest)');
});

test('drive-hub-mirror: missing file results in failure, and blocks manifest update', async () => {
  const { repoPath, cleanup } = setupTestRepo('missing');

  // Delete gas.md to simulate missing file
  rmSync(join(repoPath, 'rules', 'gas.md'));

  const uploadCalls = [];
  const mockGetDriveToken = async () => 'mock-token';
  const mockGitCommitTime = async () => new Date('2026-09-20T12:00:00Z');
  const mockGitHead = () => 'test-commit-hash';

  const mockListFiles = async () => [];
  const mockDownloadFileContent = async () => Buffer.from('');
  const mockUploadFileContent = async (token, req) => {
    uploadCalls.push(req);
    return { id: 'new-id' };
  };

  let lastJsonWritten = null;
  const mockWriteLastJson = (report) => {
    lastJsonWritten = report;
  };

  const code = await runMirror({
    repoPath,
    dryRun: false,
    getDriveTokenFn: mockGetDriveToken,
    gitCommitTimeFn: mockGitCommitTime,
    gitHeadFn: mockGitHead,
    listFilesFn: mockListFiles,
    downloadFileContentFn: mockDownloadFileContent,
    uploadFileContentFn: mockUploadFileContent,
    writeLastJsonFn: mockWriteLastJson,
  });

  cleanup();

  assert.strictEqual(code, 1, 'Exit code should be 1 when files are missing');
  // manifest.json should NOT be uploaded because gas.md was missing
  assert.ok(!uploadCalls.some(c => c.name === 'manifest.json'), 'manifest.json must not be uploaded when a file failed/missing');
  assert.strictEqual(lastJsonWritten.counts.missing, 1, 'missing count should be 1');
  assert.strictEqual(lastJsonWritten.counts.blocked, 1, 'manifest.json should be blocked');
});

test('drive-hub-mirror: conflict guard triggers when Drive is newer, blocks manifest', async () => {
  const { repoPath, cleanup } = setupTestRepo('conflict');

  const uploadCalls = [];
  const mockGetDriveToken = async () => 'mock-token';
  // Git commit is older than Drive modifiedTime
  const mockGitCommitTime = async () => new Date('2026-09-18T12:00:00Z');
  const mockGitHead = () => 'test-commit-hash';

  const mockListFiles = async (token, parentId) => {
    if (parentId === 'drive_hub_id') {
      return [
        { id: 'drive_onboarding_id', name: 'ONBOARDING.md', modifiedTime: '2026-09-19T12:00:00Z' },
      ];
    }
    return [];
  };

  const mockDownloadFileContent = async () => Buffer.from('different drive content');
  const mockUploadFileContent = async (token, req) => {
    uploadCalls.push(req);
    return { id: 'new-id' };
  };

  let lastJsonWritten = null;
  const mockWriteLastJson = (report) => {
    lastJsonWritten = report;
  };

  const code = await runMirror({
    repoPath,
    dryRun: false,
    getDriveTokenFn: mockGetDriveToken,
    gitCommitTimeFn: mockGitCommitTime,
    gitHeadFn: mockGitHead,
    listFilesFn: mockListFiles,
    downloadFileContentFn: mockDownloadFileContent,
    uploadFileContentFn: mockUploadFileContent,
    writeLastJsonFn: mockWriteLastJson,
  });

  cleanup();

  assert.strictEqual(code, 1, 'Exit code should be 1 due to conflict');
  assert.strictEqual(uploadCalls.length, 0, 'No files uploaded due to conflict and blocked manifest');
  assert.strictEqual(lastJsonWritten.counts.conflict, 1, 'conflict count should be 1 for ONBOARDING.md');
});

test('drive-hub-mirror: security guard avoids writing to folders.knowledgeInbox', async () => {
  const { repoPath, cleanup } = setupTestRepo('security');

  // Change parentId in manifest to match knowledgeInbox
  const manifestData = JSON.parse(readFileSync(join(repoPath, 'manifest.json'), 'utf8'));
  manifestData.files[0].in = 'rules';
  manifestData.folders.rules = 'drive_inbox_id'; // Matches folders.knowledgeInbox!
  writeFileSync(join(repoPath, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf8');

  const uploadCalls = [];
  const mockGetDriveToken = async () => 'mock-token';
  const mockGitCommitTime = async () => new Date('2026-09-20T12:00:00Z');
  const mockGitHead = () => 'test-commit';
  const mockListFiles = async () => [];
  const mockDownloadFileContent = async () => Buffer.from('');
  const mockUploadFileContent = async (token, req) => {
    uploadCalls.push(req);
    return { id: 'id' };
  };

  let lastJsonWritten = null;
  const mockWriteLastJson = (report) => {
    lastJsonWritten = report;
  };

  const code = await runMirror({
    repoPath,
    dryRun: false,
    getDriveTokenFn: mockGetDriveToken,
    gitCommitTimeFn: mockGitCommitTime,
    gitHeadFn: mockGitHead,
    listFilesFn: mockListFiles,
    downloadFileContentFn: mockDownloadFileContent,
    uploadFileContentFn: mockUploadFileContent,
    writeLastJsonFn: mockWriteLastJson,
  });

  cleanup();

  assert.strictEqual(code, 1, 'Should exit 1 due to security violation');
  assert.strictEqual(uploadCalls.length, 0, 'Should not upload anything');
  assert.strictEqual(lastJsonWritten.counts.blocked, 2, 'Should be blocked (1 file blocked + 1 manifest blocked)');
});
