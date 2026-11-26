import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { copyToRclone } from './rclone-copy.mjs';
import { isDriveWriteBlocked, uploadKnowledgeWithRclone } from './knowledge-rclone.mjs';

test('only HTTP 403/413 select fallback, including wrapped errors', () => {
  for (const error of [new Error('403 forbidden'), new Error('channel gws: HTTP 413 too large'),
    { status: 403 }, { cause: { status: 413 } }]) assert.equal(isDriveWriteBlocked(error), true);
  for (const error of [new Error('file 403.md failed'), new Error('500 error'), { status: 401 }]) {
    assert.equal(isDriveWriteBlocked(error), false);
  }
});

test('backup copyto keeps file names and arguments intact without a shell', async () => {
  let args;
  await copyToRclone({ source: 'C:\\space dir\\backup.zip', destination: 'claude-backup:Claude-Backups/019/backup.zip',
    extraArgs: ['--dry-run'], run: async value => { args = value; } });
  assert.deepEqual(args, ['copyto', 'C:\\space dir\\backup.zip', 'claude-backup:Claude-Backups/019/backup.zip', '--dry-run']);
});

test('missing claude-backup never uses readonly aujust or attempts authentication', async () => {
  const calls = [];
  await assert.rejects(uploadKnowledgeWithRclone({ items: [], folderName: '019', inboxFolderId: 'inbox',
    run: async args => { calls.push(args); return 'aujust:\n'; },
  }), /claude-backup is unavailable/);
  assert.deepEqual(calls, [['listremotes']]);
});

for (const mode of ['success', 'partial-copy', 'wrong-hash', 'missing', 'duplicate', 'read-failed']) {
  test(`rclone ${mode}: requires matching Drive size and hash before acknowledgement`, async () => {
    const name = '20261122-日本語 note.md';
    const content = '共有するナレッジ\n';
    const md5 = crypto.createHash('md5').update(content).digest('hex');
    const calls = [];
    const operation = uploadKnowledgeWithRclone({ items: [{ name, content }], folderName: '019-test@example.com', inboxFolderId: 'inbox-id',
      run: async args => {
        calls.push(args);
        if (args[0] === 'listremotes') return 'aujust:\nclaude-backup:\n';
        assert.equal(args[2], args[0] === 'copy' ? 'claude-backup:019-test@example.com' : '--files-only');
        assert.equal(args[args.indexOf('--drive-root-folder-id') + 1], 'inbox-id');
        if (args[0] === 'copy') {
          assert.equal(fs.readFileSync(path.join(args[1], name), 'utf8'), content);
          assert.ok(args.includes('--checksum'));
          if (mode === 'partial-copy') throw new Error('copy exited nonzero');
          return '';
        }
        assert.equal(args[0], 'lsjson');
        assert.ok(args.includes('MD5'));
        if (mode === 'read-failed') throw new Error('read failed');
        const entry = { Path: name, Size: Buffer.byteLength(content), Hashes: { md5: mode === 'wrong-hash' ? 'wrong' : md5 } };
        return JSON.stringify(mode === 'missing' ? [] : mode === 'duplicate' ? [entry, entry] : [entry]);
      },
    });
    if (mode === 'read-failed') await assert.rejects(operation, /read failed/);
    else {
      const result = await operation;
      assert.equal(result.verified.has(name), ['success', 'partial-copy'].includes(mode));
      assert.equal(result.errors.size, ['success', 'partial-copy'].includes(mode) ? 0 : 1);
    }
    assert.deepEqual(calls.map(args => args[0]), ['listremotes', 'copy', 'lsjson']);
  });
}

test('path traversal is rejected before staging or upload', async () => {
  await assert.rejects(uploadKnowledgeWithRclone({ items: [{ name: '../escape.md', content: 'note' }],
    folderName: '019', inboxFolderId: 'inbox', run: async args => {
      assert.deepEqual(args, ['listremotes']);
      return 'claude-backup:\n';
    },
  }), /Invalid knowledge destination/);
});
