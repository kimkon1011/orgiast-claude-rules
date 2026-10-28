import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatDoneLine, formatDoneMessage, formatDoneBacklogMessages, gatherEvidence, deterministicVerdict, judge, evidenceSummary } from './auto-progress-watch.mjs';

test('共有ファイルが新しくてもセッションの会話・実行が25時間前ならstalled', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const old = now - 25 * 3600000;
  const row = { promise: '次のメッセージで仕上げる', ts: new Date(old - 3600000).toISOString() };
  const evidence = gatherEvidence(row, '/unused', {
    transcriptEvidence: () => ({ count: 1, lastAt: old, snippets: [] }),
    recentFiles: () => ({ lastAt: now, names: ['shared.md'] }),
    autoSessionRuns: () => ({ lastAt: old, names: ['session.json'] }),
  });
  assert.equal(evidence.lastEvidenceAt, old);
  assert.equal(deterministicVerdict(evidence, now).verdict, 'stalled');
  assert.equal(deterministicVerdict({ ...evidence, lastEvidenceAt: now }, now).verdict, 'stalled');
  assert.equal(judge(row, evidence, now, { askLlm: () => null }).verdict, 'stalled');
  assert.match(evidenceSummary(row, evidence, now), /shared\.md/);
  for (const source of ['transcript', 'runs']) {
    assert.equal(deterministicVerdict({ ...evidence, [source]: { ...evidence[source], lastAt: now } }, now).verdict, 'in_progress');
  }
});

test('完了通知はresumeの結果を使い、予告文を出さない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-notice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'auto-progress-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const row = { sessionId: 'd14902f9-example', cwd: 'C:\\projects\\event-shop', doneAt: '2026-10-25T16:30:00Z',
    promise: 'Claude が DB 列の確認、ビルドとコミット、本番デプロイを行います。https://event-shop.jp' };
  const resume = path.join(home, '.claude', 'auto-progress-resume-d14902f9.json');
  fs.writeFileSync(resume, JSON.stringify({ state: 'done', evidence: 'DB列確認・ビルド・本番デプロイ完了。', artifact: 'https://event-shop.jp' }));
  const expected = '✅ 完了: event-shop — DB列確認・ビルド・本番デプロイ完了。（成果物: https://event-shop.jp）（2026/10/26 JST）';
  assert.equal(formatDoneLine(row, { home }), expected);
  for (const message of [formatDoneMessage(row, { home }), formatDoneBacklogMessages([row], { home })[0].text]) {
    assert.ok(message.includes(expected));
    assert.doesNotMatch(message, /行います|宣言文/);
  }
  fs.writeFileSync(resume, '{broken');
  fs.writeFileSync(path.join(dir, `${row.sessionId}.jsonl`), [
    '{broken', JSON.stringify({ state: 'done', evidence: '旧結果' }),
    JSON.stringify({ state: 'done', evidence: '検証済み' + 'あ'.repeat(150), artifact: 'out/report' }),
    JSON.stringify({ state: 'blocked', evidence: '承認待ち' }),
  ].join('\n'));
  const inbox = formatDoneLine(row, { home });
  assert.ok(inbox.includes('検証済み' + 'あ'.repeat(116) + '（成果物: out/report）'));
  assert.doesNotMatch(inbox, /旧結果|承認待ち|行います/);
  fs.rmSync(path.join(dir, `${row.sessionId}.jsonl`));
  assert.ok(formatDoneLine(row, { home }).includes('（結果記録なし・宣言文）' + row.promise));
});
