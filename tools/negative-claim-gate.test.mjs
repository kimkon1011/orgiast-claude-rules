import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findNegativeClaim } from './negative-claim-gate.mjs';

const gate = fileURLToPath(new URL('./negative-claim-gate.mjs', import.meta.url));
const regressionFixtures = JSON.parse(fs.readFileSync(new URL('./negative-claim-gate.fixtures.json', import.meta.url), 'utf8'));
function transcript(dir, blocks = []) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'assistant', message: { content: blocks } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Genspark には公開 API が無い。' }] } }),
  ].join('\n'));
  return file;
}
function run({ text, blocks, session = 's1', raw, enforcement = 'block' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'negative-claim-'));
  if (enforcement) {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'rule-enforcement.json'), JSON.stringify({ 'negative-claim-primary-source': { mode: enforcement } }));
  }
  const file = transcript(home, blocks);
  const input = raw ?? JSON.stringify({ session_id: session, transcript_path: file, ...(text === undefined ? {} : { assistant_text: text }) });
  return { home, result: spawnSync(process.execPath, [gate], { input, encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } }) };
}

test('一次ソースなしの否定断定をblock', () => {
  const { result } = run({ text: 'Genspark には公開 API が無い。' });
  assert.equal(result.status, 0); const output = JSON.parse(result.stdout); assert.equal(output.decision, 'block');
  assert.match(output.reason, /registry\.npmjs\.org/); assert.doesNotMatch(output.reason, /<製品名>/); assert.match(output.reason, /Genspark/);
});
test('registry.npmjs.org のBash呼び出しがあればpass', () => {
  const { result } = run({ blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s https://registry.npmjs.org/@genspark%2fcli' } }] });
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
});
test('別製品のregistry照会後でも当該製品の否定断定はblock', () => {
  const { result } = run({ blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s https://registry.npmjs.org/react' } }] });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).decision, 'block');
});
test('当該製品のregistry照会後ならpass', () => {
  const { result } = run({ blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s https://registry.npmjs.org/@genspark%2fcli' } }] });
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
});
test('当該製品をregistry検索クエリで照会後ならpass', () => {
  const { result } = run({ blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s "https://registry.npmjs.org/-/v1/search?text=genspark"' } }] });
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
});
test('gh search reposで当該製品を照会後ならpass', () => {
  const { result } = run({ blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh search repos genspark --limit 10' } }] });
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
});
test('製品名を推定できない場合は一次ソース照会があればpass', () => {
  const { result } = run({ text: '公開 API が無い。', blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s https://registry.npmjs.org/react' } }] });
  assert.equal(result.status, 0); assert.equal(result.stdout, '');
});
test('assistant本文に一次ソースURLを書いただけではblock', () => {
  const { result } = run({ text: 'Genspark には公開 API が無い。registry.npmjs.org は未照会です。' });
  assert.equal(JSON.parse(result.stdout).decision, 'block');
});
test('留保表現はpass', () => assert.equal(run({ text: 'API があるかまだ確認できていない。' }).result.stdout, ''));
test('通常応答はpass', () => assert.equal(run({ text: '調査結果をまとめました。' }).result.stdout, ''));
for (const [index, { text, shouldDetect }] of regressionFixtures.entries()) {
  test(`実データの否定断定回帰fixture ${index + 1}を期待どおり判定`, () => {
    assert.equal(Boolean(findNegativeClaim(text)), shouldDetect, text);
  });
}
test('同一セッション・同一クレームの2回目はwarnで通す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'negative-repeat-')); const file = transcript(home);
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'rule-enforcement.json'), JSON.stringify({ 'negative-claim-primary-source': { mode: 'block' } }));
  const input = JSON.stringify({ session_id: 'same', transcript_path: file }); const env = { ...process.env, ORGIAST_HOME: home };
  const first = spawnSync(process.execPath, [gate], { input, encoding: 'utf8', env });
  const second = spawnSync(process.execPath, [gate], { input, encoding: 'utf8', env });
  assert.equal(JSON.parse(first.stdout).decision, 'block'); assert.equal(second.stdout, ''); assert.match(second.stderr, /2回目/);
});
test('空stdinと壊れたJSONはexit 0', () => {
  for (const input of ['', '{broken']) { const p = spawnSync(process.execPath, [gate], { input, encoding: 'utf8' }); assert.equal(p.status, 0); assert.equal(p.stdout, ''); }
});
test('blockを既存台帳へrule付きで追記', () => {
  const { home } = run({ text: 'Genspark の CLI は存在しない。' });
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'handoff-ledger.jsonl'), 'utf8'));
  assert.equal(record.rule, 'negative-claim-primary-source'); assert.equal(record.verdict, 'blocked');
});
test('enforcement=warn はstdoutを空にして警告し、台帳へwarnedを記録', () => {
  const { home, result } = run({ text: 'Genspark には公開 API が無い。', enforcement: 'warn' });
  assert.equal(result.stdout, ''); assert.match(result.stderr, /一次ソース未照会/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'handoff-ledger.jsonl'), 'utf8'));
  assert.equal(record.verdict, 'warned');
});
test('ユーザー設定ファイルが無い場合はregistry既定のwarn', () => {
  const { home, result } = run({ text: 'Genspark には公開 API が無い。', enforcement: null });
  assert.equal(result.stdout, ''); assert.match(result.stderr, /一次ソース未照会/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'handoff-ledger.jsonl'), 'utf8'));
  assert.equal(record.verdict, 'warned');
});
test('末尾がtool_useだけでも手前の本文で判定する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'negative-tool-tail-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'rule-enforcement.json'), JSON.stringify({ 'negative-claim-primary-source': { mode: 'block' } }));
  const file = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Genspark には公開 API が無い。' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } }),
  ].join('\n'));
  const result = spawnSync(process.execPath, [gate], { input: JSON.stringify({ session_id: 'tool-tail', transcript_path: file }), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
});
