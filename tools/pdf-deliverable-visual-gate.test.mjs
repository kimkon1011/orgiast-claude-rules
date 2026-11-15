import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge } from './pdf-deliverable-visual-gate.mjs';
import { rolloutMode } from './gate-runtime.mjs';

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t, name = 'customer-proposal.pdf', pages = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pdf = path.join(root, name); fs.writeFileSync(pdf, '%PDF-1.4\nfixture');
  const evidenceDir = path.join(root, 'pdf-evidence'); fs.mkdirSync(evidenceDir);
  const pngs = Array.from({ length: pages }, (_, i) => path.join(root, `page-${i + 1}.png`));
  pngs.forEach(file => fs.writeFileSync(file, 'png'));
  const transcript = path.join(root, 'transcript.jsonl');
  const renderedAt = Date.now();
  fs.utimesSync(pdf, new Date(renderedAt - 2000), new Date(renderedAt - 2000));
  return { root, pdf, evidenceDir, pngs, transcript, sha256: digest(pdf), renderedAt };
}
function writeEvidence(f, overrides = {}) {
  const evidence = { sha256: f.sha256, pdf: path.resolve(f.pdf).replaceAll('\\', '/'), pages: f.pngs.length, renderedAt: f.renderedAt, pngs: f.pngs.map(file => path.resolve(file).replaceAll('\\', '/')), warnings: [], fatal: false, ...overrides };
  fs.writeFileSync(path.join(f.evidenceDir, `${f.sha256}.json`), JSON.stringify(evidence));
  return evidence;
}
function writeTranscript(f, pngs = f.pngs, text = '', extra = {}) {
  const rows = [];
  if (text) rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  // Same JSONL envelope as live-artifact-read-gate and deliverable-drive-link-gate.
  for (const file of pngs) rows.push({ type: 'assistant', timestamp: new Date(f.renderedAt + 1000).toISOString(), sessionId: 'pdf-session', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] }, ...extra });
  fs.writeFileSync(f.transcript, rows.map(JSON.stringify).join('\n'));
}
const send = f => ({ session_id: 'pdf-session', cwd: f.root, tool_name: 'SendUserFile', tool_input: { files: [f.pdf] }, transcript_path: f.transcript });

test('全席の初回配布でもdenyで、matcherとsetup登録が整合する', t => {
  const f = fixture(t);
  assert.equal(rolloutMode('pdf-deliverable-visual-gate', { home: f.root, hostname: 'fresh-seat' }), 'deny');
  const dispatch = JSON.parse(fs.readFileSync(new URL('./hook-dispatch-manifest.json', import.meta.url)));
  const hook = dispatch.events.PreToolUse.find(h => h.command.includes('/pdf-deliverable-visual-gate.mjs'));
  assert.ok(hook.command.includes('gate-hook-runner.mjs')); assert.equal(hook.async, undefined);
  for (const name of ['SendUserFile', 'Bash', 'PowerShell', 'mcp__claude_ai_Google_Drive__create_file', 'mcp__claude_ai_Google_Drive_2__create_file']) assert.match(name, new RegExp(hook.matcher));
  const manifest = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url)));
  const render = manifest.items.find(i => i.id === 'tool:pdf-render');
  assert.deepEqual(render.repair, ['pdf-page-check.mjs', '--install']);
  assert.deepEqual(render.spec.paths, ['.claude/pdf-render/node_modules/mupdf/package.json']);
  const gate = manifest.items.find(i => i.id === 'settings:pdf-deliverable-visual-gate');
  assert.equal(gate.spec.hookEvent, 'PreToolUse'); assert.equal(gate.severity, 'required');
});

test('証跡なしはdeny', t => { const f = fixture(t); assert.equal(judge(send(f), f).decision, 'block'); });
test('証跡と全ページReadでallow', t => { const f = fixture(t); writeEvidence(f); writeTranscript(f); assert.equal(judge(send(f), f).decision, 'pass'); });
test('一部ページ未Readはdeny', t => { const f = fixture(t); writeEvidence(f); writeTranscript(f, [f.pngs[0]]); assert.match(judge(send(f), f).reason, /未 Read/); });
test('社内向け語fatalはdeny', t => { const f = fixture(t); writeEvidence(f, { fatal: true, warnings: [{ detail: 'draft' }] }); writeTranscript(f); assert.match(judge(send(f), f).reason, /社内向け語/); });
test('直前assistantの20文字以上のescape hatchでallow', t => { const f = fixture(t); writeTranscript(f, [], '[PDF-VISUAL-OK: 描画ツールを導入できず代替手段で全ページを目視確認しました]'); assert.equal(judge(send(f), f).decision, 'pass'); });
test('assistant_text入力だけのescape hatchは信用しない', t => { const f = fixture(t); fs.writeFileSync(f.transcript, ''); assert.equal(judge({ ...send(f), assistant_text: '[PDF-VISUAL-OK: これは偽の入力なので通してはいけませんでした]' }, f).decision, 'block'); });
test('領収書.pdfは対象外、三共精機様_Reブースご提案書_v7.pdfは対象', t => { const receipt = fixture(t, '領収書.pdf'); assert.equal(judge(send(receipt), receipt).decision, 'pass'); const proposal = fixture(t, '三共精機様_Reブースご提案書_v7.pdf'); assert.equal(judge(send(proposal), proposal).decision, 'block'); });
test('Drive create_fileのsha参照を判定し不一致でも素通りしない', t => { const f = fixture(t, '提案資料.pdf'); const input = { tool_name: 'mcp__claude_ai_Google_Drive__create_file', tool_input: { title: '提案資料.pdf', contentMimeType: 'application/pdf', base64Content: `sha256:${f.sha256}:${f.pdf}` }, transcript_path: f.transcript }; assert.equal(judge(input, f).decision, 'block'); assert.equal(judge({ ...input, tool_input: { ...input.tool_input, base64Content: `sha256:${'0'.repeat(64)}:${f.pdf}` } }, f).decision, 'block'); writeEvidence(f); writeTranscript(f); assert.equal(judge(input, f).decision, 'pass'); });
test('Bash/PowerShellのdrive-upload --fileを判定', t => { for (const tool_name of ['Bash', 'PowerShell']) { const f = fixture(t, `${tool_name}-proposal.pdf`); const input = { tool_name, tool_input: { command: `node tools/drive-upload.mjs --file "${f.pdf}" --folder x` }, transcript_path: f.transcript }; assert.equal(judge(input, f).decision, 'block'); } });
test('CLIは非同期stdinを待ちPreToolUse deny形式を返す', t => { const f = fixture(t); const script = fileURLToPath(new URL('./pdf-deliverable-visual-gate.mjs', import.meta.url)); const result = spawnSync(process.execPath, [script], { input: JSON.stringify(send(f)), encoding: 'utf8' }); assert.equal(result.status, 0); const output = JSON.parse(result.stdout.trim()); assert.equal(output.hookSpecificOutput.permissionDecision, 'deny'); assert.match(result.stderr, /PDF-VISUAL-GATE/); });

test('描画前・時刻なし・別セッション・sidechainのReadは証拠にしない', t => {
  const f = fixture(t); writeEvidence(f);
  for (const extra of [{ timestamp: new Date(f.renderedAt - 1).toISOString() }, { timestamp: new Date(f.renderedAt).toISOString() }, { timestamp: undefined }, { sessionId: 'other-session' }, { isSidechain: true }]) {
    writeTranscript(f, f.pngs, '', extra); assert.match(judge(send(f), f).reason, /未 Read/);
  }
});

test('古い・欠損・重複・機械チェック不明の証跡を拒否', t => {
  const f = fixture(t); writeTranscript(f);
  for (const override of [{ renderedAt: f.renderedAt - 3000 }, { renderedAt: fs.statSync(f.pdf).mtimeMs }, { renderedAt: undefined }, { renderedAt: 'invalid' }, { sha256: '0'.repeat(64) }, { pages: 0 }, { pngs: [f.pngs[0], f.pngs[0]] }, { pngs: [f.pngs[0], path.join(f.root, 'missing.png')] }, { fatal: undefined }, { warnings: undefined }, { fatal: false, warnings: [{ type: 'internal-word', detail: 'draft' }] }]) {
    writeEvidence(f, override); assert.equal(judge(send(f), f).decision, 'block', JSON.stringify(override));
  }
  fs.writeFileSync(path.join(f.evidenceDir, `${f.sha256}.json`), 'null');
  assert.equal(judge(send(f), f).decision, 'block');
});

test('escapeは空白で文字数を水増しできず直前メッセージだけ有効', t => {
  const f = fixture(t);
  writeTranscript(f, [], '[PDF-VISUAL-OK:                      短い]'); assert.equal(judge(send(f), f).decision, 'block');
  writeTranscript(f, [], '[PDF-VISUAL-OK: 描画ツールの導入失敗を調査し別経路で全ページを確認しました]');
  fs.appendFileSync(f.transcript, '\n' + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '別の資料です' }] } }));
  assert.equal(judge(send(f), f).decision, 'block');
});

test('SendUserFile各形式・複数添付・cwd相対パスを判定', t => {
  const f = fixture(t); writeEvidence(f); writeTranscript(f);
  for (const entry of [f.pdf, { path: f.pdf }, { file_path: f.pdf }, { file: path.basename(f.pdf) }]) {
    assert.equal(judge({ ...send(f), tool_input: { files: [entry] } }, f).decision, 'pass');
  }
  const other = path.join(f.root, '企画書.pdf'); fs.writeFileSync(other, 'another PDF');
  assert.equal(judge({ ...send(f), tool_input: { files: [f.pdf, other] } }, f).decision, 'block');
});

test('メール添付・引用符・等号・相対パスと対象外コマンド', t => {
  const f = fixture(t, 'customer proposal.pdf');
  for (const script of ['drive-upload', 'gmail-draft', 'seisaku-mail']) {
    for (const arg of [`--file "${f.pdf}"`, `--attach '${f.pdf}'`, `--attach="${path.basename(f.pdf)}"`]) {
      const input = { ...send(f), tool_name: 'Bash', tool_input: { command: `node tools/${script}.mjs ${arg}` } };
      assert.equal(judge(input, f).decision, 'block');
      writeEvidence(f); writeTranscript(f); assert.equal(judge(input, f).decision, 'pass');
      writeTranscript(f, []);
    }
  }
  for (const command of [`node other.mjs --file "${f.pdf}"`, 'node tools/drive-upload.mjs --file "$FILE"']) {
    assert.equal(judge({ ...send(f), tool_name: 'Bash', tool_input: { command } }, f).decision, 'pass');
  }
});

test('Driveのタイトルが対象なら汎用名のローカルPDFも確認する', t => {
  const f = fixture(t, 'output.pdf');
  const input = { ...send(f), tool_name: 'mcp__claude_ai_Google_Drive_2__create_file', tool_input: { title: '提案資料.pdf', base64Content: `sha256:${f.sha256}:${f.pdf}` } };
  assert.equal(judge(input, f).decision, 'block'); writeEvidence(f); writeTranscript(f); assert.equal(judge(input, f).decision, 'pass');
});
