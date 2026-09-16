import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredMode, evaluateExternalStateClaimFromRaw as evaluate, findExternalStateClaim, findOutsourcedVerification, hasDirectQueryEvidenceFromRaw, hasPermissionDenialFromRaw } from './external-state-claim-gate.mjs';

const human = { type: 'user', message: { role: 'user', content: '確認して' } };
const use = (name, input = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
const result = content => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content }] } });
const raw = (...entries) => entries.map(entry => JSON.stringify(entry)).join('\n');
const query = use('mcp__claude_ai_Google_Drive__search_files');
const denied = result('Permission for this action was denied');
const claim = 'kim@orgiast.jp には TETSUKO の GA4 は存在しない可能性が高い';
const outsourced = 'そこに「TETSUKO」を含む名前が有るか無いかだけ教えてください。';

for (const text of [
  'この PC の全 Claude セッション履歴を横断検索した結果、TETSUKO に紐づく測定ID はゼロです。', claim,
  'GTM-KBC4TFM は 2013 年頃の旧 EC-CUBE サイト由来で、kim 側で所有している痕跡はありません。',
  'Vercel の環境変数に NEXT_PUBLIC_GA_ID は設定されていないと思われます。',
  'GA4 は未確認ですが、おそらく存在しません。', 'GA4 は紐づいていない。', 'GA4 は紐づかれていない。',
]) test(`A block: ${text}`, () => {
  assert.equal(findExternalStateClaim(text), text);
  assert.equal(evaluate({ text, transcriptRaw: raw(human) }).code, 'EXTERNAL-STATE');
  assert.equal(evaluate({ text, transcriptRaw: '' }).decision, 'block');
});

for (const text of [
  'GA4 と GTM はまだ不明です。', 'GA4: kim 側では未確認',
  '私の暫定回答「存在しない可能性が高い」は誤りでした。',
  'Search Console API v3 にはユーザー追加のエンドポイントが存在しない',
  '| プロパティ | 存在しない |', '| 説明。GA4 は存在しない。 |',
  '> 引用です。GA4 は存在しない。', 'GA4 は存在しないという検出パターンです。',
  'GA4 が存在しないかはまだ確認できていない。',
]) test(`A pass: ${text}`, () => {
  assert.equal(findExternalStateClaim(text), '');
  assert.equal(evaluate({ text, transcriptRaw: '' }).decision, 'pass');
});

test('最初の該当文を返し、否定ごとに製品能力との距離を判定する', () => {
  assert.equal(findExternalStateClaim(`報告です！${claim}。\nDrive のファイルはない`), `${claim}。`);
  assert.equal(findExternalStateClaim(`API${'あ'.repeat(31)}GA4 はない`), `API${'あ'.repeat(31)}GA4 はない`);
  assert.ok(findExternalStateClaim(`GA4 API は存在しないが、${'あ'.repeat(31)}プロパティはない`));
});

for (const tool of [query, use('Bash', { command: 'gcloud projects list' }),
  use('PowerShell', { command: 'gh api user/repos' }), use('Bash', { command: 'npx vercel env ls' }),
  use('Bash', { command: 'curl https://analyticsadmin.googleapis.com/v1beta/accounts' }),
  use('WebFetch', { url: 'https://api.github.com/user/repos' })]) {
  test(`直接照会: ${JSON.stringify(tool)}`, () => {
    const transcriptRaw = raw(human, tool);
    assert.equal(hasDirectQueryEvidenceFromRaw(transcriptRaw), true);
    assert.equal(evaluate({ text: claim, transcriptRaw }).decision, 'pass');
  });
}

for (const tool of [use('Grep', { path: '~/.claude/projects', pattern: 'gcloud' }),
  use('Read', { file_path: 'https://api.github.com' }), use('Glob', { pattern: '*gh*' }),
  use('Bash', { command: 'rg "G-" ~/.claude/projects' }),
  use('Bash', { command: 'rg "gcloud" ~/.claude/projects' }),
  use('Bash', { command: 'grep "https://api.github.com" memory/index.md' }),
  use('Bash', { command: 'curl https://github.com.evil.example/api' }),
  use('WebFetch', { url: 'https://google.com.evil.example' }),
  use('WebFetch', { url: 'https://google.com@evil.example' }),
  use('WebFetch', { url: 'file://google.com/path' }),
  result('gcloud projects list'), { type: 'assistant', message: { content: 'mcp__vendor__query 実行済み' } },
]) test(`偽の証拠: ${JSON.stringify(tool)}`, () => {
  const transcriptRaw = raw(human, tool);
  assert.equal(hasDirectQueryEvidenceFromRaw(transcriptRaw), false);
  assert.equal(evaluate({ text: claim, transcriptRaw }).decision, 'block');
});

test('最後の human 以前・sidechain の証拠を数えず tool_result ではリセットしない', () => {
  assert.equal(hasDirectQueryEvidenceFromRaw(raw(query, human)), false);
  assert.equal(hasPermissionDenialFromRaw(raw(denied, human)), false);
  assert.equal(hasDirectQueryEvidenceFromRaw(raw(human, { ...query, isSidechain: true })), false);
  assert.equal(hasDirectQueryEvidenceFromRaw(raw(human, query, result('ok'))), true);
  assert.equal(evaluate({ text: claim, transcriptRaw: raw(query, human) }).decision, 'block');
  assert.equal(hasDirectQueryEvidenceFromRaw(`broken\nnull\n${raw(human, query)}\n{`), true);
});

test('B は通常の UI 依頼と、UI 操作を省いた必須例文を検出する', () => {
  for (const text of [outsourced, '画面で確認してください。', '一覧に存在するか見てください。']) {
    assert.equal(findOutsourcedVerification(text), text);
    assert.equal(evaluate({ text, transcriptRaw: '' }).code, 'OUTSOURCED-VERIFY');
    assert.equal(evaluate({ text, transcriptRaw: '' }).decision, 'block');
  }
  assert.equal(findOutsourcedVerification('画面で操作しました。\n教えてください。'), '');
});

test('B の免除は直接試行・拒否記録・手渡し判定のすべてが必要', () => {
  for (const direct of [false, true]) for (const permission of [false, true]) for (const marker of [false, true]) {
    const transcriptRaw = raw(human, ...(direct ? [query] : []), ...(permission ? [denied] : []));
    const text = outsourced + (marker ? '\n[手渡し判定]' : '');
    assert.equal(evaluate({ text, transcriptRaw }).decision, direct && permission && marker ? 'pass' : 'block');
  }
});

test('拒否文言は tool_result 内の文字列または text ブロックだけから読む', () => {
  assert.equal(hasPermissionDenialFromRaw(raw(human, result([{ type: 'text', text: 'denied by the Claude Code auto mode classifier' }]))), true);
  assert.equal(hasPermissionDenialFromRaw(raw(human, use('Bash', { command: 'Permission for this action was denied' }))), false);
  assert.equal(hasPermissionDenialFromRaw(raw(human, result('Missing Access'))), false);
});

for (const text of [`> ${outsourced}`, `| ${outsourced} |`, `前回は${outsourced}と書いた。`, `検出例: ${outsourced}`]) {
  test(`B 文脈免除: ${text}`, () => assert.equal(findOutsourcedVerification(text), ''));
}

test('mode は既定 block、不正値も block、warn は理由を保って pass', () => {
  const previous = process.env.ORGIAST_EXTERNAL_STATE_GATE;
  try {
    delete process.env.ORGIAST_EXTERNAL_STATE_GATE;
    assert.equal(configuredMode(), 'block');
    process.env.ORGIAST_EXTERNAL_STATE_GATE = 'invalid';
    assert.equal(configuredMode(), 'block');
    process.env.ORGIAST_EXTERNAL_STATE_GATE = 'warn';
    assert.equal(configuredMode(), 'warn');
    for (const text of [claim, outsourced]) {
      const verdict = evaluate({ text, transcriptRaw: '' });
      assert.equal(verdict.decision, 'pass');
      assert.ok(verdict.code);
      assert.ok(verdict.reason.includes(text));
    }
  } finally {
    if (previous === undefined) delete process.env.ORGIAST_EXTERNAL_STATE_GATE;
    else process.env.ORGIAST_EXTERNAL_STATE_GATE = previous;
  }
});
