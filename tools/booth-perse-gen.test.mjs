import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, loadKey, buildPrompt, generate, runAll, buildRetryCommand } from './booth-perse-gen.mjs';

const tempDir = (t, prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('OpenAI Image API preserves reference order and records requested model when response omits it', async (t) => {
  const dir = tempDir(t, 'perse-image-');
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

test('HTTP failure retains full error and never falls back to another provider', async (t) => {
  const out = path.join(tempDir(t, 'perse-fail-'), 'result.png');
  const errorBody = JSON.stringify({ error: { message: `Complexity 'none' is not supported ${'detail '.repeat(60)}` } });
  let calls = 0;
  await assert.rejects(generate({ key: 'test', text: 'test', refs: [], out, model: 'openai/gpt-5.4-image-2', fetchImpl: async () => {
    calls += 1;
    return new Response(errorBody, { status: 502 });
  } }), error => error.message === `HTTP 502 ${errorBody}`);
  assert.equal(calls, 1);
  assert.equal(existsSync(out), false);
});

test('explicit non-OpenAI model keeps chat image response compatibility', async (t) => {
  const out = path.join(tempDir(t, 'perse-chat-'), 'result.png');
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
  assert.equal(defaults.model, undefined);
  assert.deepEqual(defaults.providers, ['openai', 'gemini']);
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--model', 'google/gemini-2.5-flash-image']);
  assert.equal(o.model, 'google/gemini-2.5-flash-image');
  assert.equal(o.providers, undefined);
});

test('parseArgs: --providers を検証し重複を除く', () => {
  assert.deepEqual(parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--providers', 'openai']).providers, ['openai']);
  assert.deepEqual(parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--providers', 'gemini,openai,gemini']).providers, ['gemini', 'openai']);
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--providers', '']), /使い方/);
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--providers', 'claude']), /使い方/);
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--model', 'x', '--providers', 'openai']), /同時に指定/);
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--model']), /--model は空/);
});

const imageResponse = () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('openai').toString('base64') }] }));
const chatResponse = () => new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${Buffer.from('gemini').toString('base64')}` } }] } }] }));

test('runAll: 3案を両プロバイダへ送り6個のプロバイダ別ファイルを作る', async (t) => {
  const outDir = tempDir(t, 'perse-all-');
  const plans = ['ume', 'take', 'matsu'].map((id) => ({ id, label: id, add: id }));
  const calls = [];
  const results = await runAll({ plans, key: 'test', common: 'brief', outDir, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, model: body.model });
    return url.endsWith('/images') ? imageResponse() : chatResponse();
  } });
  assert.equal(results.length, 6);
  assert.equal(calls.filter((c) => c.url.endsWith('/images')).length, 3);
  assert.equal(calls.filter((c) => c.url.endsWith('/chat/completions')).length, 3);
  assert.deepEqual(results.map((r) => path.basename(r.out)), plans.flatMap((p) => [`perse-${p.id}-openai.png`, `perse-${p.id}-gemini.png`]));
  results.forEach((r) => assert.equal(existsSync(r.out), true));
});

test('runAll: OpenAI失敗をGeminiで代替せず本文を保持する', async (t) => {
  const outDir = tempDir(t, 'perse-no-fallback-');
  const models = [];
  const results = await runAll({ plans: [{ id: 'ume', label: '梅', add: 'plan' }], key: 'test', common: 'brief', outDir,
    fetchImpl: async (url, options) => {
      const model = JSON.parse(options.body).model;
      models.push(model);
      return url.endsWith('/images') ? new Response('complete failure body', { status: 500 }) : chatResponse();
    } });
  assert.deepEqual(models, ['openai/gpt-5.4-image-2', 'google/gemini-3-pro-image']);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /complete failure body/);
  assert.equal(results[1].ok, true);
});

test('runAll: --only相当の1案とGeminiだけなら1回、明示modelなら従来名で1回', async (t) => {
  const outDir = tempDir(t, 'perse-single-');
  const plan = { id: 'take', label: '竹', add: 'plan' };
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; return url.endsWith('/images') ? imageResponse() : chatResponse(); };
  const gemini = await runAll({ plans: [plan], providers: ['gemini'], key: 'test', common: 'brief', outDir, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(path.basename(gemini[0].out), 'perse-take-gemini.png');
  const legacy = await runAll({ plans: [plan], model: 'openai/gpt-5.4-image-2', key: 'test', common: 'brief', outDir, fetchImpl });
  assert.equal(calls, 2);
  assert.equal(legacy[0].provider, null);
  assert.equal(path.basename(legacy[0].out), 'perse-take.png');
});

test('buildRetryCommand: 元の全入力と失敗providerを保持しbaseをrefとして重複させない', () => {
  const opts = parseArgs([
    '--brief', 'brief files/common brief.txt',
    '--plans', 'plans.json',
    '--out', 'render output',
    '--base', 'base files/underlay.png',
    '--blender-out', 'blender output',
    '--text', 'DEMO',
    '--text', 'Fine Steel',
    '--ref', 'refs/logo one.png',
    '--ref', 'refs/product.png',
    '--max-height', '4',
  ]);
  const command = buildRetryCommand(opts, { id: 'take', provider: 'gemini', model: 'google/gemini-3-pro-image' });
  assert.equal(command, 'node tools/booth-perse-gen.mjs --brief "brief files/common brief.txt" --plans plans.json --out "render output" --base "base files/underlay.png" --blender-out "blender output" --text DEMO --text "Fine Steel" --ref "refs/logo one.png" --ref refs/product.png --max-height 4 --only take --providers gemini');
  assert.equal(command.match(/base files\/underlay\.png/g)?.length, 1);
});

test('buildRetryCommand: provider null の失敗は --model で再生成する', () => {
  const opts = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--model', 'custom/image-model']);
  assert.equal(
    buildRetryCommand(opts, { id: 'ume', provider: null, model: 'custom/image-model' }),
    'node tools/booth-perse-gen.mjs --brief b --plans p --out o --only ume --model custom/image-model',
  );
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
  assert.match(t, /only readable text allowed is the text explicitly quoted in the brief above/);
  assert.match(t, /Do not invent brand names or logos/);
  const formerBrand = ['Grid', 'Beyond'].join('');
  assert.doesNotMatch(t, new RegExp(formerBrand));
});

test('parseArgs/buildPrompt: 複数の --text だけを許可文字として列挙する', () => {
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--text', 'DEMO', '--text', 'Fine Steel']);
  assert.deepEqual(o.texts, ['DEMO', 'Fine Steel']);
  const prompt = buildPrompt('BRIEF', { add: 'PLAN' }, o.maxHeight, o.texts);
  assert.match(prompt, /The only readable text allowed anywhere is: "DEMO", "Fine Steel"\./);
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

test('loadKey: openrouter.env の OPENROUTER_API_KEY を読む', (t) => {
  const home = tempDir(t, 'perse-');
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'export OPENROUTER_API_KEY="sk-test"\n');
  assert.equal(loadKey(home), 'sk-test');
});

test('loadKey: キーが無ければ止まる', (t) => {
  const home = tempDir(t, 'perse-');
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'OTHER=1\n');
  assert.throws(() => loadKey(home), /OPENROUTER_API_KEY/);
});
