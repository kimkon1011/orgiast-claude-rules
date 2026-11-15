import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge } from './pdf-deliverable-visual-gate.mjs';

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t, name = 'customer-proposal.pdf', pages = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pdf = path.join(root, name); fs.writeFileSync(pdf, '%PDF-1.4\nfixture');
  const evidenceDir = path.join(root, 'evidence'); fs.mkdirSync(evidenceDir);
  const pngs = Array.from({ length: pages }, (_, i) => path.join(root, `page-${i + 1}.png`));
  pngs.forEach(file => fs.writeFileSync(file, 'png'));
  const transcript = path.join(root, 'transcript.jsonl');
  return { root, pdf, evidenceDir, pngs, transcript, sha256: digest(pdf) };
}
function writeEvidence(f, overrides = {}) {
  const evidence = { sha256: f.sha256, pdf: path.resolve(f.pdf).replaceAll('\\', '/'), pages: f.pngs.length, renderedAt: Date.now() + 1000, pngs: f.pngs.map(file => path.resolve(file).replaceAll('\\', '/')), warnings: [], fatal: false, ...overrides };
  fs.writeFileSync(path.join(f.evidenceDir, `${f.sha256}.json`), JSON.stringify(evidence));
  return evidence;
}
function writeTranscript(f, pngs = f.pngs, text = '') {
  const rows = [];
  if (text) rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  for (const file of pngs) rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] } });
  fs.writeFileSync(f.transcript, rows.map(JSON.stringify).join('\n'));
}
const send = f => ({ tool_name: 'SendUserFile', tool_input: { files: [f.pdf] }, transcript_path: f.transcript });

test('証跡なしはdeny', t => { const f = fixture(t); assert.equal(judge(send(f), f).decision, 'block'); });
test('証跡と全ページReadでallow', t => { const f = fixture(t); writeEvidence(f); writeTranscript(f); assert.equal(judge(send(f), f).decision, 'pass'); });
test('一部ページ未Readはdeny', t => { const f = fixture(t); writeEvidence(f); writeTranscript(f, [f.pngs[0]]); assert.match(judge(send(f), f).reason, /未 Read/); });
test('社内向け語fatalはdeny', t => { const f = fixture(t); writeEvidence(f, { fatal: true, warnings: [{ detail: 'draft' }] }); writeTranscript(f); assert.match(judge(send(f), f).reason, /社内向け語/); });
test('直前assistantの20文字以上のescape hatchでallow', t => { const f = fixture(t); writeTranscript(f, [], '[PDF-VISUAL-OK: 描画ツールを導入できず代替手段で全ページを目視確認しました]'); assert.equal(judge(send(f), f).decision, 'pass'); });
test('assistant_text入力だけのescape hatchは信用しない', t => { const f = fixture(t); fs.writeFileSync(f.transcript, ''); assert.equal(judge({ ...send(f), assistant_text: '[PDF-VISUAL-OK: これは偽の入力なので通してはいけませんでした]' }, f).decision, 'block'); });
test('領収書.pdfは対象外、三共精機様_Reブースご提案書_v7.pdfは対象', t => { const receipt = fixture(t, '領収書.pdf'); assert.equal(judge(send(receipt), receipt).decision, 'pass'); const proposal = fixture(t, '三共精機様_Reブースご提案書_v7.pdf'); assert.equal(judge(send(proposal), proposal).decision, 'block'); });
test('Drive create_fileの実形式を判定しsha不一致参照は曖昧として対象外', t => { const f = fixture(t, '提案資料.pdf'); const input = { tool_name: 'mcp__claude_ai_Google_Drive__create_file', tool_input: { title: '提案資料.pdf', contentMimeType: 'application/pdf', base64Content: `sha256:${f.sha256}:${f.pdf}` }, transcript_path: f.transcript }; assert.equal(judge(input, f).decision, 'block'); assert.equal(judge({ ...input, tool_input: { ...input.tool_input, base64Content: `sha256:${'0'.repeat(64)}:${f.pdf}` } }, f).decision, 'pass'); });
test('Bash/PowerShellのdrive-upload --fileを判定', t => { for (const tool_name of ['Bash', 'PowerShell']) { const f = fixture(t, `${tool_name}-proposal.pdf`); const input = { tool_name, tool_input: { command: `node tools/drive-upload.mjs --file "${f.pdf}" --folder x` }, transcript_path: f.transcript }; assert.equal(judge(input, f).decision, 'block'); } });
test('CLIは非同期stdinを待ちPreToolUse deny形式を返す', t => { const f = fixture(t); const script = fileURLToPath(new URL('./pdf-deliverable-visual-gate.mjs', import.meta.url)); const result = spawnSync(process.execPath, [script], { input: JSON.stringify(send(f)), encoding: 'utf8' }); assert.equal(result.status, 0); const output = JSON.parse(result.stdout.trim()); assert.equal(output.hookSpecificOutput.permissionDecision, 'deny'); assert.match(result.stderr, /PDF-VISUAL-GATE/); });
