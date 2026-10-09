import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectChanges, normalizeModels, selectCandidates, runScout, formatDm, main } from './model-scout.mjs';
import { notifyKim } from './notify-kim.mjs';
import { evaluationCost } from './eval-harness.mjs';
import { runModelScoutStep } from './cost-weekly-improve.mjs';

const now = new Date('2026-10-09T00:00:00Z');
const model = (id, days = 1, prompt = 0.000001, completion = 0.000002) => ({ id, name: id, created: now.getTime() / 1000 - days * 86400, pricing: { prompt, completion }, context_length: 128000, modality: 'text->text' });
const catalog = (models) => ({ data: models.map((m) => ({ ...m, architecture: { modality: m.modality } })) });
const state = (models) => ({ models: Object.fromEntries(models.map((m) => [m.id, { pricing: m.pricing }])) });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-scout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const routingFile = path.join(home, 'routing-table.json'), configFile = path.join(home, 'eval-providers.json');
  const baseline = model('vendor/current', 30, 0.00001, 0.00002), candidate = model('vendor/new');
  fs.writeFileSync(routingFile, JSON.stringify({ categories: { summarize: { provider: 'openrouter', model: baseline.id } } }));
  fs.writeFileSync(configFile, JSON.stringify([{ provider: 'openrouter', model: baseline.id, params: { temperature: 0 } }]));
  const notifications = [], output = [];
  return { home, dir, routingFile, configFile, baseline, candidate, notifications, output,
    options: { home, routingFile, configFile, now, log: (s) => output.push(s),
      fetchImpl: async (url) => { assert.equal(url, 'https://openrouter.ai/api/v1/models'); return { ok: true, json: async () => catalog([baseline, candidate]) }; },
      notify: async (text) => { notifications.push(text); return { delivered: 'dm' }; } } };
}

test('新規は前回集合との差分。再登場した既知モデルは新規にしない', () => {
  const old = model('old', 30), added = model('added', 90);
  assert.deepEqual(detectChanges([old, added], state([old]), now).map((m) => m.id), ['added']);
  assert.equal(detectChanges([old], state([old]), now).length, 0);
});
test('値下げは入力または出力が20%以上。ゼロ価格も検出', () => {
  for (const key of ['prompt', 'completion']) {
    const old = model('old', 30), changed = structuredClone(old);
    changed.pricing[key] *= 0.8;
    assert.match(detectChanges([changed], state([old]), now)[0].reason, /値下げ/);
    changed.pricing[key] = old.pricing[key] * 0.81;
    assert.equal(detectChanges([changed], state([old]), now).length, 0);
    changed.pricing[key] = 0;
    assert.equal(detectChanges([changed], state([old]), now).length, 1);
  }
  assert.equal(detectChanges([model('free', 30, 0, 0)], state([model('free', 30, 0, 0)]), now).length, 0);
});
test('初回14日窓は境界を含み、未来の日付を除く', () => {
  assert.deepEqual(detectChanges([model('today', 0), model('boundary', 14), model('old', 14.01), model('future', -1)], null, now).map((m) => m.id), ['today', 'boundary']);
});
test('API の価格文字列を正規化し、不正価格と空カタログを拒否', () => {
  const payload = catalog([model('ok'), model('invalid', 0, -1)]);
  payload.data[0].pricing.prompt = '0.000001';
  assert.equal(normalizeModels(payload)[0].pricing.prompt, 0.000001);
  assert.equal(normalizeModels(payload).length, 1);
  assert.throws(() => normalizeModels({ data: [] }));
});
test('両単価が同額以下かつ片方が安く、文脈が同等以上のtext候補だけ評価', () => {
  const base = model('base', 30), cheap = model('cheap', 1, 0.0000005, 0.000001);
  const costlyOutput = { ...cheap, id: 'costly', pricing: { prompt: 0, completion: 1 } };
  const small = { ...cheap, id: 'small', context_length: 100 };
  const image = { ...cheap, id: 'image', modality: 'text->image' };
  const routing = { categories: { code: { provider: 'openrouter', model: 'base' }, missing: { provider: 'none', model: 'unknown' } } };
  const result = selectCandidates([cheap, costlyOutput, small, image, base], [base], routing);
  assert.deepEqual(result.candidates.map((m) => m.id), ['cheap']);
  assert.equal(result.warnings.length, 1);
});
test('候補ゼロでも notifyKim 経由で DM を1通送る（fetchモック）', async (t) => {
  const f = fixture(t), posts = [];
  const result = await runScout({ ...f.options, fetchImpl: async () => ({ ok: true, json: async () => catalog([f.baseline]) }),
    notify: (text) => notifyKim(text, { home: f.home, token: 'fake', userId: 'kim', webhookFallback: false,
      fetchImpl: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ id: 'channel' }) }; } }) });
  assert.equal(result.ok, true);
  assert.equal(posts.filter((p) => p.url.endsWith('/messages')).length, 1);
  assert.match(posts[1].body.content, /^今週の新AI候補 0 件\n新規なし（監視 1 モデル）/);
});
test('状態・Markdownを更新し、eval設定へ追加。再実行で重複しない', async (t) => {
  const f = fixture(t), first = await runScout(f.options);
  assert.equal(first.ok, true);
  assert.equal(first.candidates.length, 1);
  assert.match(first.dm, /eval に投入済み/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'model-scout-state.json')));
  assert.deepEqual(saved.models[f.candidate.id].pricing, f.candidate.pricing);
  assert.match(fs.readFileSync(path.join(f.dir, 'model-scout-latest.md'), 'utf8'), /参考情報/);
  const config = JSON.parse(fs.readFileSync(f.configFile));
  assert.deepEqual(config[0].params, { temperature: 0 });
  assert.deepEqual(config[1], { provider: 'openrouter', model: f.candidate.id, costPerMillion: [1, 2] });
  const second = await runScout(f.options);
  assert.equal(second.candidates.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).length, 2);
});
test('dry-run は stdout のみ、DM・状態・Markdown・eval設定を変更しない', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.configFile, 'utf8');
  assert.equal(await main(['--once', '--dry-run'], f.options), 0);
  assert.equal(f.notifications.length, 0);
  assert.deepEqual(fs.readdirSync(f.dir), []);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
  assert.match(f.output.join('\n'), /eval 投入予定/);
});
test('取得失敗は状態維持・失敗通知1通・秘密値を出さずexit 0', async (t) => {
  const f = fixture(t), file = path.join(f.dir, 'model-scout-state.json'), before = JSON.stringify(state([f.baseline]));
  fs.writeFileSync(file, before);
  assert.equal(await main(['--once'], { ...f.options, fetchImpl: async () => { throw new Error('SECRET_TOKEN'); } }), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /偵察失敗/);
  assert.doesNotMatch(f.output.join('\n'), /SECRET_TOKEN/);
});
test('DM失敗時は差分を消費しない。次回のeval追加は冪等', async (t) => {
  const f = fixture(t);
  const failed = await runScout({ ...f.options, notify: async () => ({ delivered: 'none' }) });
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'model-scout-state.json')), false);
  const retry = await runScout(f.options);
  assert.equal(retry.candidates.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).length, 2);
});
test('設定の破損は上書きせず、ファイル名付きの手動投入通知', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.configFile, 'broken');
  const result = await runScout(f.options);
  assert.match(result.dm, /eval 追加は手動（tools\/eval-providers.json/);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), 'broken');
});
test('skip済み候補を勝手に再開しない', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.configFile, JSON.stringify([{ provider: 'openrouter', model: f.candidate.id, skip: true }]));
  const result = await runScout(f.options);
  assert.match(result.dm, /skip 指定あり/);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile))[0].skip, true);
});
test('1800字制限と全候補のMarkdown参照', () => {
  const candidates = Array.from({ length: 100 }, (_, i) => ({ ...model(`model-${i}`), replacements: [{ category: 'code', route: { provider: 'openrouter', model: 'current' } }] }));
  const dm = formatDm(candidates, 1000, 'eval に投入済み');
  assert.ok(dm.length <= 1800);
  assert.match(dm, /^今週の新AI候補 100 件/);
  assert.match(dm, /残りの候補は model-scout-latest.md/);
});
test('eval は設定モデルの単価を利用し、別モデルへのCLI上書きには流用しない', () => {
  const cfg = { model: 'new', costPerMillion: [0.1, 0.2] }, usage = { inTok: 1e6, outTok: 1e6 };
  assert.ok(Math.abs(evaluationCost('openrouter', 'new', usage, cfg) - 0.3) < 1e-10);
  assert.equal(evaluationCost('openrouter', 'other', usage, cfg), 1.38);
  assert.equal(evaluationCost('openrouter', 'new', usage, { ...cfg, costPerMillion: [0, 0] }), 0);
});
test('週次の偵察ステップは--once、dry-run伝播、承認時skip、失敗隔離', () => {
  const calls = [], spawn = (...args) => { calls.push(args); return { status: 0 }; };
  runModelScoutStep([], spawn);
  assert.equal(calls[0][1].at(-1), '--once');
  for (const flag of ['--dry-run', '--no-notify']) { runModelScoutStep([flag], spawn); assert.equal(calls.at(-1)[1].at(-1), '--dry-run'); }
  runModelScoutStep(['--approve', 'id'], spawn);
  assert.equal(calls.length, 3);
  assert.doesNotThrow(() => runModelScoutStep([], () => { throw new Error('failure'); }));
});
test('未知のCLI引数もexit 0、APIを呼ばない', async () => {
  assert.equal(await main(['--unknown'], { log: () => {}, fetchImpl: () => assert.fail('called') }), 0);
});
