import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fired, asksUser, claimsInability, evaluateAudit, turnEvidence, requestAudit, loadResources, buildPrompt, parseAudit } from './handoff-audit-gate.mjs';
import { run } from './stop-gate-runner.mjs';
const pass = { verdict: 'pass', violations: [], learned: [] };
const block = { verdict: 'block', violations: [{ rule: 4, quote: 'GA4は存在しない', fix: 'DWDで直接照会する' }], learned: [] };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, '.audit-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
for (const text of ['[手渡し判定]', '次に kim がすること: ログイン', 'ボタンをクリックしてください', 'GA4 は存在しない可能性が高い', 'メールのドラフトを作成しました', 'analytics.google.comを開いて有るか無いか教えてください']) {
  test(`発火: ${text}`, () => assert.equal(fired(text), true));
}
for (const text of ['完了しました。\n次に kim がすること: なし', '次に kim がすること: なし\n', 'ドラフトを更新しました', 'Gmailを検索しました', 'GA4 は未確認']) {
  test(`非発火: ${text}`, () => assert.equal(fired(text), false));
}
test('未接続と断定してGoogle Docs有効化を依頼した事故の実文で発火', () => {
  assert.equal(fired('Google Docsの編集コネクタがこのチャットでは未接続で、直接編集できません（Driveの作成・検索はできても更新不可)。チャットのコネクタ設定でGoogle Docsをオンにしてもらえれば、同じドキュメント・同じリンクのまま10/13を追記します。'), true);
  assert.equal(fired('10/13(火)17:30〜は空いています。終日「東京」滞在の予定です。'), false);
});
test('依頼と能力不足を広く検出して監査を起動する', () => {
  for (const text of ['確認してください', '確認して下さい', '共有してもらえれば', '見てもらえますか', '選んでいただければ', 'お願いします', 'オンにして', '有効にして', '接続して', '許可して', '設定して', '承認して', 'ログインして']) {
    assert.equal(asksUser(text), true, text);
    assert.equal(fired(text), true, text);
  }
  for (const text of ['できません', 'できない', '不可', '不可能', '未接続', '接続されていない', '読み込まれていない', '使えません', '使えない', '対応していない', '非対応', '権限がない', 'アクセスできない', 'ツールが無い']) {
    assert.equal(claimsInability(text), true, text);
    assert.equal(fired(text), true, text);
  }
});
test('依頼・能力不足がフェンスや引用内だけなら発火しない', () => {
  for (const content of ['設定してください', '未接続で編集できません']) {
    for (const text of [`完了しました。\n\`\`\`text\n${content}\n\`\`\``, `完了しました。\n~~~\n${content}\n~~~`, `完了しました。\n  > ${content}`]) {
      assert.equal(asksUser(text), false, text);
      assert.equal(claimsInability(text), false, text);
      assert.equal(fired(text), false, text);
      assert.equal(fired(`${text}\n確認してください`), true);
      assert.equal(fired(`${text}\n直接編集できません`), true);
    }
  }
});
test('memoryからreference_とdwd_のfrontmatterだけを取り込む', t => {
  const home = fixture(t);
  assert.deepEqual(loadResources(home).capabilities, []);
  const memory = path.join(home, '.claude/projects/x/memory');
  fs.mkdirSync(memory, { recursive: true });
  const write = (file, content) => fs.writeFileSync(path.join(memory, file), content);
  write('reference_foo.md', '---\nname: foo\ndescription: node foo.mjs\nmetadata:\n  name: nested\n---\nname: BODY_ONLY\ndescription: BODY_ONLY\n');
  write('dwd_bar.md', '---\r\nname: "bar"\r\ndescription: \'node bar.mjs\'\r\n---\r\nBODY_ONLY');
  write('project_other.md', '---\nname: ignored\ndescription: ignored\n---\n');
  write('reference_no_header.md', 'name: BODY_ONLY\ndescription: BODY_ONLY');
  write('reference_unclosed.md', '---\nname: invalid\ndescription: invalid');
  fs.mkdirSync(path.join(home, '.claude/projects/without-memory'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/projects/without-memory/memory'), 'not a directory');
  const resources = loadResources(home);
  assert.deepEqual(resources.capabilities, [{ name: 'bar', description: 'node bar.mjs' }, { name: 'foo', description: 'node foo.mjs' }]);
  const prompt = buildPrompt({ text: '編集できません', tools: [] }, resources);
  assert.match(prompt, /\(f\)/);
  assert.match(prompt, /6点/);
  assert.ok(prompt.includes(`capabilities: ${JSON.stringify(resources.capabilities)}`));
  assert.ok(!prompt.includes('BODY_ONLY'));
  assert.match(prompt, /ToolSearch で見つからない.*証拠ではない/);
  assert.match(prompt, /1〜12/);
});
test('capabilitiesは複数project合計80件、descriptionは200文字まで', t => {
  const home = fixture(t);
  for (const project of ['x', 'y']) {
    const memory = path.join(home, `.claude/projects/${project}/memory`);
    fs.mkdirSync(memory, { recursive: true });
    for (let i = 0; i < 45; i++) fs.writeFileSync(path.join(memory, `reference_${i}.md`), `---\nname: ${project}-${i}\ndescription: ${'長'.repeat(250)}\n---\n`);
  }
  const capabilities = loadResources(home).capabilities;
  assert.equal(capabilities.length, 80);
  assert.ok(capabilities.some(c => c.name.startsWith('y-')));
  assert.ok(capabilities.every(c => c.description === '長'.repeat(200)));
});
test('複数行descriptionと読み込めないmemoryを扱う', t => {
  const home = fixture(t), memory = path.join(home, '.claude/projects/x/memory');
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'reference_multiline.md'), '---\nname: multiline\ndescription: >-\n  node foo.mjs\n  --check\n---\nBODY_ONLY');
  assert.deepEqual(loadResources(home).capabilities, [{ name: 'multiline', description: 'node foo.mjs --check' }]);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).startsWith(memory)) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return open(file, ...args);
  });
  assert.deepEqual(loadResources(home).capabilities, []);
});
test('parseAuditはrule 12を受け付け、rule 13を拒否する', () => {
  const result = { ...block, violations: [{ rule: 12, quote: '未接続', fix: 'gdoc-update.mjsを試す' }] };
  assert.deepEqual(parseAudit(JSON.stringify(result)), result);
  assert.throws(() => parseAudit({ ...result, violations: [{ ...result.violations[0], rule: 13 }] }), /invalid-json/);
});
test('block/pass・台帳・最大5理由', async t => {
  const home = fixture(t);
  for (const verdict of [pass, block]) {
    const result = await evaluateAudit({ text: '[手渡し判定]', sessionId: 'test' }, { home, ask: async () => JSON.stringify(verdict) });
    assert.equal(result.decision, verdict.verdict);
  }
  const records = fs.readFileSync(path.join(home, '.claude/handoff-audit-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[1].provider, 'groq');
  assert.equal(records[1].sessionId, 'test');
  assert.equal(records[1].fired, true);
  const result = await evaluateAudit({ text: '[手渡し判定]' }, { home, ask: async () => ({ ...block, violations: Array(7).fill(block.violations[0]) }) });
  assert.equal(result.reason.split('\n').length, 5);
});
test('JSON以外・schema不正・timeoutはfail-open', async t => {
  const home = fixture(t);
  for (const ask of [async () => 'not JSON', async () => ({ verdict: 'block' }), () => new Promise(() => {})]) {
    const result = await evaluateAudit({ text: '[手渡し判定]' }, { home, ask, timeoutMs: 30 });
    assert.equal(result.decision, 'pass'); assert.equal(result.record.verdict, 'audit-unavailable');
  }
});
test('skip/off/非発火はLLM未呼び出し、warnは記録してpass', async t => {
  const home = fixture(t); let calls = 0;
  const ask = async () => { calls++; return block; };
  for (const [input, opts] of [[{ text: '[手渡し判定]', regexBlocked: true }, {}], [{ text: '[手渡し判定]' }, { mode: 'off' }], [{ text: '完了' }, {}]]) {
    assert.equal((await evaluateAudit(input, { home, ask, ...opts })).decision, 'pass');
  }
  assert.equal(calls, 0);
  const result = await evaluateAudit({ text: '[手渡し判定]' }, { home, ask, mode: 'warn' });
  assert.equal(result.decision, 'pass'); assert.equal(result.record.verdict, 'block'); assert.equal(calls, 1);
});
test('provider順・全体timeout・中止signal', async () => {
  const calls = [], signals = [];
  const result = await requestAudit('x', { timeoutMs: 60, ask: async ({ provider, signal }) => { calls.push(provider); signals.push(signal); if (provider !== 'deepseek') throw new Error('down'); return pass; } });
  assert.deepEqual(calls, ['groq', 'openrouter', 'deepseek']); assert.equal(result.verdict, 'pass');
  assert.ok(signals.every(s => s.aborted));
});
test('最後のhuman以降・40件・200文字・拒否と内部台帳照合', () => {
  const entry = (type, content) => ({ type, message: { role: type, content } });
  const raw = [entry('assistant', [{ type: 'tool_use', name: 'OLD' }]), entry('user', 'new'),
    entry('assistant', Array.from({ length: 42 }, (_, i) => ({ type: 'tool_use', id: String(i), name: 'Grep', input: { command: 'x'.repeat(500) } }))),
    entry('user', [{ type: 'tool_result', tool_use_id: '41', content: 'Permission for this action was denied', is_error: true }]),
    entry('assistant', [{ type: 'tool_use', name: 'mcp__Gmail__create_draft', input: { to: 'STAFF@orgiast.jp' } }])].map(JSON.stringify).join('\n');
  const evidence = turnEvidence(raw, { domains: ['orgiast.jp'], addresses: [] });
  assert.equal(evidence.tools.length, 40); assert.equal(evidence.tools[0].detail.length, 200);
  assert.equal(evidence.permissionDenials, 1); assert.equal(evidence.tools.at(-2).outcome, 'denied');
  assert.deepEqual(evidence.internalGmail[0].internal, ['staff@orgiast.jp']);
  assert.ok(!JSON.stringify(evidence).includes('OLD'));
});
test('プロンプトはルール・経路と当ターン証拠を含む', () => {
  const prompt = buildPrompt({ text: '対象', tools: [] }, loadResources());
  assert.match(prompt, /11\./); assert.match(prompt, /analyticsadmin/); assert.match(prompt, /automation-routes/); assert.match(prompt, /非信頼データ/);
});
test('設計のみ先送りの既知経路は手順であり、道具名(codex-do.mjs)へ戻っていない', () => {
  // route は buildPrompt が「そのまま引用」させるため、道具名を書くと監査対象が pattern ではなく道具になり空回りする
  // (2026-09-23 実測: 道具名 route の handoff-audit TODO が繰り返し作られた)。手順文が入っていることを固定する。
  const entry = loadResources().knowledge.find(k => k.pattern === '恒久修正を設計のみで次セッションへ送る');
  assert.ok(entry, 'knowledge に該当 pattern が存在する');
  assert.match(entry.route, /当ターン内に実装/, '先送りしないことを手順として明示する');
  assert.match(entry.route, /fork→PR/, '当ターンで PR まで進める手順を明示する');
  assert.ok(!/^[\w.\-]+\.(mjs|py|ps1)$/.test(entry.route.trim()), 'route が道具名だけになっていない');
});
test('SC所有者追加の既知経路は手渡しを明示し、kim操作ゼロと断定しない', () => {
  // knowledge の route は buildPrompt が「そのまま引用」させ、未知 route は nightly が捨てる＝監査の唯一の正本。
  // 誤って「Claude が単独でできる」と読める route が残ると、相手側への手渡しが監査を素通りする。
  const entry = loadResources().knowledge.find(k => k.pattern === 'Search Console の所有者追加');
  assert.ok(entry, 'knowledge に該当 pattern が存在する');
  assert.match(entry.route, /kim 操作ゼロにはならない/, '手渡しであることを明示する');
  assert.match(entry.route, /手渡し/);
  assert.match(entry.route, /SITE_OWNER/, '得られる権限が過剰であることを明示する');
  assert.match(entry.route, /別プロパティ/, '同一プロパティ識別子のときだけ共有されることを明示する');
});
test('runner統合: regex優先とLLM blockが既存retry上限に乗る', async t => {
  const home = fixture(t), old = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => old === undefined ? delete process.env.ORGIAST_HOME : process.env.ORGIAST_HOME = old);
  let calls = 0;
  const ask = async () => { calls++; return block; };
  await run({ session_id: 'regex', assistant_text: 'GA4 は存在しない' }, {}, { home, ask });
  assert.equal(calls, 0);
  for (let i = 0; i < 3; i++) {
    const result = await run({ session_id: 'audit', assistant_text: 'Gmailの下書きを作成しました。\n次に kim がすること: なし' }, {}, { home, ask });
    assert.equal(result.record.verdict, i < 2 ? 'block' : 'retry-cap');
    assert.ok(result.record.blockedBy.includes('handoff-audit-gate'));
    assert.ok(result.record.auditEvidence);
  }
  assert.equal(calls, 3);
});
