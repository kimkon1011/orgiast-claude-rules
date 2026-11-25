import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, runPricingBrief } from './pricing-brief.mjs';

const questions = [
  { id: 'official', label: '公式項目', query: '公式' },
  { id: 'unofficial', label: '非公式項目', query: '非公式' },
  { id: 'no-url', label: 'URLなし項目', query: 'URLなし' },
];

function tempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-brief-test-')); }
function sink() { let value = ''; return { stream: { write(chunk) { value += chunk; } }, read: () => value }; }
function file(home) { return path.join(home, '.claude', 'pricing-brief.md'); }

test('公式・非公式・URLなしを高・中・低に分類し、注意書きを含める', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const searchImpl = async (query) => {
    if (query.startsWith('公式\n')) return { answer: '公式の説明です。詳細です。余分です。', urls: [{ url: 'https://blog.example/a' }, { url: 'https://help.openai.com/a' }] };
    if (query.startsWith('非公式')) return { answer: '非公式の説明。', urls: ['https://example.com/a'] };
    return { answer: 'URLなしの説明。', urls: [] };
  };
  const result = await runPricingBrief({ home, now: new Date('2026-09-05T00:00:00Z'), searchImpl, questions });
  assert.deepEqual(result.rows.map((row) => row.confidence), ['高', '中', '低']);
  assert.equal(result.rows[0].source, 'https://help.openai.com/a');
  assert.equal(result.rows[2].source, '出典なし');
  assert.match(fs.readFileSync(file(home), 'utf8'), /> これは夜間の自動収集です。金額の判断に使う前に出典URLを必ず開いて確認すること。/);
  assert.doesNotMatch(result.rows[0].understanding, /余分/);
});

test('一部失敗時は前回値と取得日を保持して更新不能を付記する', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(file(home)), { recursive: true });
  fs.writeFileSync(file(home), `前文\n<!-- PRICING-BRIEF:BEGIN -->\n| 項目 | 現時点の理解 | 出典 | 取得日 | 確度 |\n| --- | --- | --- | --- | --- |\n| 公式項目 | 前回の値 | https://openai.com/old | 2026-08-01 | 高 |\n| 非公式項目 | 古い値 | https://example.com | 2026-08-02 | 中 |\n<!-- PRICING-BRIEF:END -->\n後文\n`);
  const result = await runPricingBrief({ home, now: new Date('2026-09-05'), questions: questions.slice(0, 2), searchImpl: async (query) => {
    if (query.startsWith('公式\n')) return { answer: '新しい値。', urls: ['https://openai.com/new'] };
    throw new Error('down');
  } });
  const stale = result.rows.find((row) => row.label === '非公式項目');
  assert.equal(stale.date, '2026-08-02');
  assert.equal(stale.understanding, '古い値（今回更新できず）');
});

test('全項目失敗時は1バイトも書き換えない', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(file(home)), { recursive: true });
  const before = Buffer.from('保持する本文\n'); fs.writeFileSync(file(home), before);
  const result = await runPricingBrief({ home, questions, searchImpl: async () => { throw new Error('down'); } });
  assert.equal(result.allFailed, true);
  assert.deepEqual(fs.readFileSync(file(home)), before);
});

test('検索失敗のIDと理由を stderr に出す', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stderr = sink();
  const code = await runCli(['--dry-run'], {
    home, questions: questions.slice(0, 1), searchImpl: async () => { throw new Error('APIキーなし'); },
    stdout: sink().stream, stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stderr.read(), /official: APIキーなし/);
  assert.match(stderr.read(), /既存ファイルを更新しませんでした/);
});

test('マーカー区間だけを置換して区間外を保持する', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(file(home)), { recursive: true });
  fs.writeFileSync(file(home), `先頭の本文\n<!-- PRICING-BRIEF:BEGIN -->\n古い区間\n<!-- PRICING-BRIEF:END -->\n末尾の本文`);
  await runPricingBrief({ home, questions: questions.slice(0, 1), searchImpl: async () => ({ answer: '更新。', urls: [] }) });
  const content = fs.readFileSync(file(home), 'utf8');
  assert.match(content, /^先頭の本文\n/); assert.match(content, /\n末尾の本文$/); assert.doesNotMatch(content, /古い区間/);
});

test('--limit 2 は検索を2回だけ呼ぶ', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  await runPricingBrief({ home, questions, limit: 2, searchImpl: async () => { calls += 1; return { answer: '値。', urls: [] }; } });
  assert.equal(calls, 2);
});

test('--only は指定IDだけ更新し、それ以外の前回行を保つ', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(file(home)), { recursive: true });
  fs.writeFileSync(file(home), `<!-- PRICING-BRIEF:BEGIN -->\n| 項目 | 現時点の理解 | 出典 | 取得日 | 確度 |\n| --- | --- | --- | --- | --- |\n| 公式項目 | 旧公式 | 出典なし | 2026-01-01 | 低 |\n| 非公式項目 | 旧非公式 | 出典なし | 2026-01-01 | 低 |\n<!-- PRICING-BRIEF:END -->\n`);
  let calls = 0;
  const result = await runPricingBrief({ home, questions, only: ['official'], searchImpl: async () => { calls += 1; return { answer: '新公式。', urls: [] }; } });
  assert.equal(calls, 1);
  assert.equal(result.rows.find((row) => row.label === '公式項目').understanding, '新公式。');
  assert.equal(result.rows.find((row) => row.label === '非公式項目').understanding, '旧非公式');
});

test('--dry-run はファイルを書かず本文とサマリを出す', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stdout = sink();
  const code = await runCli(['--dry-run', '--limit', '2'], { home, questions, searchImpl: async () => ({ answer: '値。', urls: ['https://openai.com/a'] }), stdout: stdout.stream, stderr: sink().stream });
  assert.equal(code, 0); assert.equal(fs.existsSync(file(home)), false);
  assert.match(stdout.read(), /PRICING-BRIEF:BEGIN/); assert.match(stdout.read(), /ok:更新2件\/失敗0件 provider=gemini\n$/);
});

test('grounding URLを公式URLへ解決して高確度にする', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token';
  const result = await runPricingBrief({ home, questions: questions.slice(0, 1), searchImpl: async () => ({ answer: '値。', urls: [redirect] }), fetchImpl: async () => ({ status: 302, headers: new Headers({ location: 'https://help.openai.com/en/articles/1' }) }) });
  assert.equal(result.rows[0].source, 'https://help.openai.com/en/articles/1');
  assert.equal(result.rows[0].confidence, '高');
});

test('grounding URL解決の例外時は元URL・低確度・未解決注記にする', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token';
  const result = await runPricingBrief({ home, questions: questions.slice(0, 1), searchImpl: async () => ({ answer: '値。', urls: [redirect] }), fetchImpl: async () => { throw new Error('timeout'); } });
  assert.equal(result.rows[0].source, redirect);
  assert.equal(result.rows[0].confidence, '低');
  assert.match(result.rows[0].understanding, /（出典URL未解決）$/);
});

test('grounding URLが非公式ドメインへ解決されたら中確度にする', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await runPricingBrief({ home, questions: questions.slice(0, 1), searchImpl: async () => ({ answer: '値。', urls: ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/token'] }), fetchImpl: async () => ({ status: 302, headers: new Headers({ location: 'https://example.com/pricing' }) }) });
  assert.equal(result.rows[0].source, 'https://example.com/pricing');
  assert.equal(result.rows[0].confidence, '中');
});

test('grounding URLは2段まで追い、3段目は未解決扱いにする', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';
  let calls = 0;
  const resolved = await runPricingBrief({ home, questions: questions.slice(0, 1), searchImpl: async () => ({ answer: '値。', urls: [`${base}one`] }), fetchImpl: async () => {
    calls += 1;
    return { status: 302, headers: new Headers({ location: calls === 1 ? `${base}two` : 'https://openai.com/pricing' }) };
  } });
  assert.equal(calls, 2);
  assert.equal(resolved.rows[0].source, 'https://openai.com/pricing');
  assert.equal(resolved.rows[0].confidence, '高');

  calls = 0;
  const unresolved = await runPricingBrief({ home, questions: questions.slice(0, 1), searchImpl: async () => ({ answer: '値。', urls: [`${base}one`] }), fetchImpl: async () => {
    calls += 1;
    return { status: 302, headers: new Headers({ location: `${base}${calls === 1 ? 'two' : 'three'}` }) };
  } });
  assert.equal(calls, 2);
  assert.equal(unresolved.rows[0].source, `${base}one`);
  assert.equal(unresolved.rows[0].confidence, '低');
  assert.match(unresolved.rows[0].understanding, /（出典URL未解決）$/);
});

test('紛らわしい別ドメインは公式扱いせず、通常URLではfetchしない', async (t) => {
  const home = tempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const result = await runPricingBrief({ home, questions: questions.slice(0, 1), searchImpl: async () => ({ answer: '値。', urls: ['https://notopenai.com/pricing'] }), fetchImpl: async () => { calls += 1; throw new Error('呼ばれてはいけない'); } });
  assert.equal(calls, 0);
  assert.equal(result.rows[0].confidence, '中');
});

test('support.claude.com は Anthropic 公式として確度 高 になる', async (t) => {
  const { isOfficialUrl } = await import('./pricing-brief.mjs');
  if (typeof isOfficialUrl !== 'function') return t.skip('isOfficialUrl が未エクスポート');
  assert.equal(isOfficialUrl('https://support.claude.com/en/articles/123'), true);
  assert.equal(isOfficialUrl('https://docs.claude.com/ja/docs'), true);
  assert.equal(isOfficialUrl('https://help.openai.com/en/articles/1'), true);
  assert.equal(isOfficialUrl('https://fyve.co.jp/blog/claude'), false);
  assert.equal(isOfficialUrl('https://notclaude.com/x'), false);
});
