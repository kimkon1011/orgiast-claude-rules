import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, loadKey, buildPrompt, resolveModels, extractImageUrl, evaluateImageResponse } from './booth-perse-gen.mjs';

test('buildPrompt: どの案にも高さ3.6mと明るさの指示が必ず入る', () => {
  const t = buildPrompt('BRIEF', { add: 'PLAN SIMPLE: white panels about 2.7 m high' });
  assert.match(t, /MUST NOT exceed 3\.6 m/);
  assert.doesNotMatch(t, /taller than neighbouring/);
  assert.match(t, /BRIGHT/);
  assert.ok(t.indexOf('MANDATORY HEIGHT') > t.indexOf('PLAN SIMPLE'), '案の記述より後ろに置き、低い高さの記述を上書きする');
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
  assert.throws(() => parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--nonexistent']), /unknown option/);
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

test('resolveModels: --model なし --models なし → 既定の3候補', () => {
  const m = resolveModels(undefined, undefined);
  assert.equal(m.length, 3);
  assert.equal(m[0], 'openai/gpt-5.4-image-2');
  assert.equal(m[1], 'openai/gpt-5-image');
  assert.equal(m[2], 'google/gemini-3-pro-image');
});

test('resolveModels: --model で先頭に追加（重複除去）', () => {
  const m = resolveModels('my/custom-model', undefined);
  assert.equal(m.length, 4);
  assert.equal(m[0], 'my/custom-model');
  assert.equal(m[1], 'openai/gpt-5.4-image-2');
});

test('resolveModels: --models で全上書き', () => {
  const m = resolveModels(undefined, 'a/x,b/y');
  assert.equal(m.length, 2);
  assert.equal(m[0], 'a/x');
  assert.equal(m[1], 'b/y');
});

test('resolveModels: --model + --models で先頭追加＋上書き', () => {
  const m = resolveModels('z/override', 'a/x,b/y');
  assert.equal(m.length, 3);
  assert.equal(m[0], 'z/override');
  assert.equal(m[1], 'a/x');
  assert.equal(m[2], 'b/y');
});

test('resolveModels: --model が --models 候補と重複 → 先頭に移動し重複除去', () => {
  const m = resolveModels('a/x', 'a/x,b/y');
  assert.equal(m.length, 2);
  assert.equal(m[0], 'a/x');
  assert.equal(m[1], 'b/y');
});

test('resolveModels: --models 空文字列 → 既定に戻る', () => {
  const m = resolveModels(undefined, '');
  assert.equal(m.length, 3);
  assert.equal(m[0], 'openai/gpt-5.4-image-2');
});

test('extractImageUrl: 正常な画像URLを抽出', () => {
  const j = { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,abc' } }] } }] };
  assert.equal(extractImageUrl(j), 'data:image/png;base64,abc');
});

test('extractImageUrl: images が空 → null', () => {
  assert.equal(extractImageUrl({ choices: [{ message: { images: [] } }] }), null);
});

test('extractImageUrl: choices なし → null', () => {
  assert.equal(extractImageUrl({}), null);
});

test('evaluateImageResponse: HTTP200 でも画像なしは失敗、画像ありは cost 付きで採用', () => {
  assert.equal(evaluateImageResponse(true, 200, { choices: [{ message: { images: [] } }] }).ok, false);
  assert.deepEqual(evaluateImageResponse(true, 200, {
    choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,abc' } }] } }],
    usage: { cost: 0.137 },
  }), { ok: true, imageUrl: 'data:image/png;base64,abc', cost: 0.137 });
});

test('parseArgs: --model と --models のパース', () => {
  const o = parseArgs(['--brief', 'b', '--plans', 'p', '--out', 'o', '--model', 'foo/bar', '--models', 'x,y,z']);
  assert.equal(o.model, 'foo/bar');
  assert.equal(o.models, 'x,y,z');
  const models = resolveModels(o.model, o.models);
  assert.equal(models[0], 'foo/bar');
  assert.equal(models[1], 'x');
});
