import test from 'node:test'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process'; import { classifyRequest } from './cost-routing-gate.mjs';
const cases = [
 ['どう思う？','consult'],['なぜですか','consult'],['教えて','consult'],
 ['実装して','implement'],['バグをfixして','implement'],['どう直して実装する？','implement'],
 ['1行だけ変えて','edit-small'],['typo','edit-small'],['名前を変えて','edit-small'],
 ['テストして','verify'],['レビューして','verify'],['通るか見て','verify'],
 ['10件分類','bulk'],['全件要約','bulk'],['消費者向け文章を作成','bulk'],
 ['Driveを確認','mcp'],['Discord bot を実装して','implement'],['Drive連携のhook作って','implement'],['DiscordへDM','mcp'],['メール送信','mcp'],
 ['アーキテクチャの方針','design'],['複数案のトレードオフ','design'],['設計してから実装して','design'],
 ['Driveの20件を修正','mcp'],['全件を実装','bulk'],['[レーン固定: verify] 実装して','verify'],
];
for (const [prompt, lane] of cases) test(`${prompt} => ${lane}`, () => assert.equal(classifyRequest(prompt).lane, lane));
test('hook先頭行と状態保存', () => { const input = JSON.stringify({ prompt:'実装して', session_id:'s1' }); const run=spawnSync(process.execPath,['tools/cost-routing-gate.mjs'],{input,encoding:'utf8',env:{...process.env,ORGIAST_HOME:'/tmp/cost-routing-gate-test'}}); const out=JSON.parse(run.stdout); assert.match(out.hookSpecificOutput.additionalContext,/^\[実行レーン\]/); });
