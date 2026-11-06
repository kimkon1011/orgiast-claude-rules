import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, loadKey, buildPrompt, generate } from './booth-perse-gen.mjs';

test('OpenAI Image API preserves reference order and records requested model when response omits it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'perse-image-'));
  const refs = ['base.png', 'previous.png'].map((name) => path.join(dir, name));
  refs.forEach((file, i) => writeFileSync(file, `reference-${i}`));
  const out = path.join(dir, 'result.png');
  const result = await generate({ key: 'test', text: 'keep geometry', refs, out, model: 'openai/gpt-5.4-image-2',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/images');
      const body = JSON.parse(options.body);
      assert.equal(body.prompt, 'keep geometry');
      assert.equal(body.output_format, 'png');
      assert.equal(body.messages, undefined);
      assert.deepEqual(body.input_references.map(r => Buffer.from(r.image_url.url.split(',')[1], 'base64').toString()), ['reference-0', 'reference-1']);
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image bytes').toString('base64') }], usage: { cost: .15 } }));
    } });
  assert.equal(readFileSync(out, 'utf8'), 'image bytes');
  assert.deepEqual(result, { model: 'openai/gpt-5.4-image-2', cost: .15, endpoint: 'images' });
});

test('HTTP failure retains full error and never falls back to another provider', async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'perse-fail-')), 'result.png');
  const errorBody = JSON.stringify({ error: { message: `Complexity 'none' is not supported ${'detail '.repeat(60)}` } });
  let calls = 0;
  await assert.rejects(generate({ key: 'test', text: 'test', refs: [], out, model: 'openai/gpt-5.4-image-2', fetchImpl: async () => {
    calls += 1;
    return new Response(errorBody, { status: 502 });
  } }), error => error.message === `HTTP 502 ${errorBody}`);
  assert.equal(calls, 1);
  assert.equal(existsSync(out), false);
});

test('explicit non-OpenAI model keeps chat image response compatibility', async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'perse-chat-')), 'result.png');
  await generate({ key: 'test', text: 'test', refs: [], out, model: 'google/gemini-2.5-flash-image', fetchImpl: async (url) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    return new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] } }] }));
  } });
  assert.equal(readFileSync(out, 'utf8'), 'image');
});

test('buildPrompt: どの案にも高さ3.6mと明るさの指示が必ず入る', () => {
  const t = buildPrompt('BRIEF', { add: 'PLAN SIMPLE: white panels about 2.7 m high' });
  assert.match(t, /MUST NOT exceed 3\.6 m/);
  assert.doesNotMatch(t, /taller than neighbouring/);
  assert.match(t, /BRIGHT/);
  assert.match(t, /multiple people about 1\.7 m tall/);
  assert.match(t, /only about twice a person's height \(3\.6 m\)/);
  assert.match(t, /6 m width is about 1\.7 times its 3\.6 m height/);
  assert.match(t, /wider than tall/);
  assert.match(t, /hall ceiling is more than 10 m high/);
  assert.match(t, /Adjacent exhibition booths are only about 2\.7-3\.6 m high/);
  assert.ok(t.indexOf('MANDATORY HEIGHT') > t.indexOf('PLAN SIMPLE'), '案の記述より後ろに置き、低い高さの記述を上書きする');
});

test('parseArgs: --model で OpenRouter の画像モデルを切り替えられる', () => {
  const defaults = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o']);
  assert.equal(defaults.model, 'openai/gpt-5.4-image-2');
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--model', 'google/gemini-2.5-flash-image']);
  assert.equal(o.model, 'google/gemini-2.5-flash-image');
});

test('parseArgs: --base を寸法下絵として読む', () => {
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--base', 'underlay.png', '--ref', 'logo.png']);
  assert.equal(o.base, 'underlay.png');
  assert.deepEqual(o.refs, ['logo.png']);
});

test('parseArgs: --only で再生成する案を1件に絞れる', () => {
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--only', 'premium']);
  assert.equal(o.only, 'premium');
});

test('buildPrompt: 下絵の外形と人物スケールを固定し日本語文字を禁止する', () => {
  const t = buildPrompt('BRIEF', { add: 'PLAN' });
  assert.match(t, /FIRST reference image is a dimensionally accurate 3D underlay/);
  assert.match(t, /all four column positions/);
  assert.match(t, /person's size and position EXACTLY/);
  assert.match(t, /Do not draw Japanese text/);
  assert.match(t, /only readable text allowed anywhere is "GridBeyond"/);
});

test('parseArgs: --max-height で会場の上限に合わせられ、既定は3.6', () => {
  assert.equal(parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o']).maxHeight, 3.6);
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--max-height', '4.5']);
  assert.equal(o.maxHeight, 4.5);
  assert.match(buildPrompt('B', { add: 'P' }, o.maxHeight), /MUST NOT exceed 4\.5 m/);
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--max-height', 'x']), /--max-height/);
});

test('parseArgs: 必須3項目と複数の --ref を読む', () => {
  const o = parseArgs(['--brief', 'b.txt', '--plans', 'p.json', '--out', 'out', '--ref', 'logo.png', '--ref', 'photo.jpg']);
  assert.equal(o.brief, 'b.txt');
  assert.equal(o.plans, 'p.json');
  assert.equal(o.out, 'out');
  assert.deepEqual(o.refs, ['logo.png', 'photo.jpg']);
});

test('parseArgs: --blender-out を読み、refs は初期状態で空', () => {
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--blender-out', 'blender-out']);
  assert.equal(o.blenderOut, 'blender-out');
  assert.deepEqual(o.refs, []);
});

test('parseArgs: 必須項目が欠けたら使い方付きで止まる', () => {
  assert.throws(() => parseArgs(['--brief', 'b.txt', '--out', 'out']), /--plans is required/);
});

test('parseArgs: 知らないオプションは止まる', () => {
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--unknown', 'x']), /unknown option/);
});

test('loadKey: openrouter.env の OPENROUTER_API_KEY を読む', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'perse-'));
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'export OPENROUTER_API_KEY="sk-test"\n');
  assert.equal(loadKey(home), 'sk-test');
});

test('loadKey: キーが無ければ止まる', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'perse-'));
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'OTHER=1\n');
  assert.throws(() => loadKey(home), /OPENROUTER_API_KEY/);
});
