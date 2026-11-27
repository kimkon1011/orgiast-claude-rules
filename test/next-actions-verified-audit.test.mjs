import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  filterLandedAndSuppressed,
  filterVerifiedAuditTodoLines,
  loadVerifiedAuditIds,
  runNextActions,
} from '../tools/next-actions.mjs';

const candidate = (title, extra = {}) => ({
  title,
  why: '確認が必要',
  first_step: '確認する',
  source: 'TODO',
  ...extra,
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

test('検証済み handoff-audit ID を含む候補は理由付きで除外する', () => {
  const verified = candidate('[TODO|handoff-audit:66ccee4c8a36e545|P3] 再発検証');
  const current = candidate('別の継続作業');
  const result = filterLandedAndSuppressed([verified, current], {
    landedPrNumbers: new Set(),
    suppressRules: [],
    verifiedAuditIds: new Set(['66ccee4c8a36e545']),
    verifiedAtById: new Map([['66ccee4c8a36e545', '2026-11-26']]),
  });
  assert.deepEqual(result.actions, [current]);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].action, verified);
  assert.equal(result.excluded[0].reason, 'handoff-audit:66ccee4c8a36e545 は再発検証済み（2026-11-26）');
});

test('検証済み ID を含まない候補は残る', () => {
  const current = candidate('handoff-audit:aaaaaaaaaaaaaaaa の再発を検証');
  const result = filterLandedAndSuppressed([current], {
    verifiedAuditIds: new Set(['66ccee4c8a36e545']),
    verifiedAtById: new Map([['66ccee4c8a36e545', '2026-11-26']]),
  });
  assert.deepEqual(result, { actions: [current], excluded: [] });
});

test('tags 配列に handoff-audit ID があっても除外する', () => {
  const tagged = candidate('再発検証', { tags: ['TODO', 'handoff-audit:4ba3303f0e4def3c'] });
  const result = filterLandedAndSuppressed([tagged], {
    verifiedAuditIds: new Set(['4ba3303f0e4def3c']),
    verifiedAtById: new Map([['4ba3303f0e4def3c', '2026-11-26']]),
  });
  assert.deepEqual(result.actions, []);
  assert.equal(result.excluded[0].reason, 'handoff-audit:4ba3303f0e4def3c は再発検証済み（2026-11-26）');
});

test('台帳ファイルが無くても空集合で落ちない', () => {
  const missing = path.join(os.tmpdir(), `missing-verified-${Date.now()}.json`);
  const result = loadVerifiedAuditIds({ repoFile: missing, homeFile: `${missing}.home` });
  assert.equal(result.ids.size, 0);
  assert.equal(result.verifiedAtById.size, 0);
});

test('壊れた JSON でも空集合で落ちない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-audit-bad-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not-json');
  const result = loadVerifiedAuditIds({ repoFile: bad, homeFile: path.join(dir, 'also-missing.json') });
  assert.equal(result.ids.size, 0);
});

test('リポジトリ台帳とホーム台帳を和集合で読む', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-audit-merge-'));
  const repoFile = path.join(dir, 'repo.json');
  const homeFile = path.join(dir, 'home.json');
  writeJson(repoFile, {
    verified: [{ id: '21f68fd8247b0b0a', verifiedAt: '2026-11-26', evidence: 'repo' }],
  });
  writeJson(homeFile, {
    verified: [{ id: '35fbb5f534e55c24', verifiedAt: '2026-11-25', evidence: 'home' }],
  });
  const result = loadVerifiedAuditIds({ repoFile, homeFile });
  assert.equal(result.ids.size, 2);
  assert.ok(result.ids.has('21f68fd8247b0b0a'));
  assert.ok(result.ids.has('35fbb5f534e55c24'));
  assert.equal(result.verifiedAtById.get('35fbb5f534e55c24'), '2026-11-25');
});

test('残TODO入力から検証済み handoff-audit 行を除く', () => {
  const todo = [
    '- [TODO|handoff-audit:66ccee4c8a36e545|P3] 検証済み',
    '- 継続作業を進める',
    '- [handoff-audit:aaaaaaaaaaaaaaaa] 未検証',
  ].join('\n');
  const filtered = filterVerifiedAuditTodoLines(todo, new Set(['66ccee4c8a36e545']));
  assert.doesNotMatch(filtered, /66ccee4c8a36e545/);
  assert.match(filtered, /継続作業を進める/);
  assert.match(filtered, /aaaaaaaaaaaaaaaa/);
});

test('除外した検証済み候補をnext-actions本文の末尾に残す', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'next-actions-verified-'));
  const result = await runNextActions({
    home,
    now: new Date('2026-11-26T00:00:00+09:00'),
    args: ['--dry-run'],
    verifiedAudits: {
      ids: new Set(['66ccee4c8a36e545']),
      verifiedAtById: new Map([['66ccee4c8a36e545', '2026-11-26']]),
    },
    llm: async () => ({
      text: JSON.stringify({
        actions: [
          candidate('[TODO|handoff-audit:66ccee4c8a36e545|P3] 再発検証'),
          candidate('継続作業'),
        ],
      }),
    }),
    execImpl: (file, args, _options, callback) => {
      if (file === 'git') return callback(null, '');
      if (file === 'gh' && args[1] === 'list') return callback(null, '[]');
      callback(new Error(`unexpected command: ${file} ${args.join(' ')}`));
    },
    suppressFile: path.join(home, 'missing-suppress.json'),
    listLedger: async () => ({ ok: true, rows: [] }),
    log() {},
    error() {},
  });
  assert.match(result.body, /1\. 継続作業/);
  // parseLlmActions が title を40字に切るため、除外節も切り詰め後の題名になる
  assert.match(
    result.body,
    /## 除外した候補（着地済み・決定済み）\n- \[TODO\|handoff-audit:66ccee4c8a36e545\|P3\] — handoff-audit:66ccee4c8a36e545 は再発検証済み（2026-11-26）$/,
  );
});
