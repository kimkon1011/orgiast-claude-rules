import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectChanges, normalizeModels, selectCandidates, selectFrontierCandidates, FRONTIER_VENDORS, frontierLimit, proposeEvaluated, proposeSavedEvaluations, runScout, formatDm, main } from './model-scout.mjs';
import { notifyKim } from './notify-kim.mjs';
import { evaluationCost, readConfig } from './eval-harness.mjs';
import { runModelScoutStep } from './cost-weekly-improve.mjs';

const now = new Date('2026-10-09T00:00:00Z');
const model = (id, days = 1, prompt = 0.000001, completion = 0.000002) => ({ id, name: id, created: now.getTime() / 1000 - days * 86400, pricing: { prompt, completion }, context_length: 128000, modality: 'text->text' });
const catalog = (models) => ({ data: models.map((m) => ({ ...m, architecture: { modality: m.modality } })) });
const state = (models) => ({ models: Object.fromEntries(models.map((m) => [m.id, { pricing: m.pricing }])) });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-scout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const routingFile = path.join(home, 'routing-table.json'), configFile = path.join(dir, 'eval', 'providers.local.json');
  const baseline = model('vendor/current', 30, 0.00001, 0.00002), candidate = model('vendor/new');
  fs.writeFileSync(routingFile, JSON.stringify({ categories: { summarize: { provider: 'openrouter', model: baseline.id } } }));
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify([{ provider: 'openrouter', model: baseline.id, params: { temperature: 0 } }]));
  const notifications = [], output = [];
  return { home, dir, routingFile, configFile, baseline, candidate, notifications, output,
    options: { home, routingFile, now, log: (s) => output.push(s),
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
  assert.match(posts[1].body.content, /^本日の新AI候補 0 件\n新規なし（監視 1 モデル）/);
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
  assert.deepEqual(fs.readdirSync(f.dir), ['eval']);
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
  assert.match(result.dm, /eval 追加は手動（~\/\.claude\/eval\/providers\.local\.json/);
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
  assert.match(dm, /^本日の新AI候補 100 件/);
  assert.match(dm, /残りの候補は model-scout-latest.md/);
});
test('eval は設定モデルの単価を利用し、別モデルへのCLI上書きには流用しない', () => {
  const cfg = { model: 'new', costPerMillion: [0.1, 0.2] }, usage = { inTok: 1e6, outTok: 1e6 };
  assert.ok(Math.abs(evaluationCost('openrouter', 'new', usage, cfg) - 0.3) < 1e-10);
  assert.equal(evaluationCost('openrouter', 'other', usage, cfg), null);
  assert.equal(evaluationCost('openrouter', 'new', usage, { ...cfg, costPerMillion: [0, 0] }), 0);
});
test('週次からは偵察を起動せず日次へ移管する', () => {
  for (const args of [[], ['--dry-run'], ['--no-notify'], ['--approve', 'id']]) {
    assert.equal(runModelScoutStep(args, () => assert.fail('二重起動')).skipped, 'daily-scout');
  }
});
test('未知のCLI引数もexit 0、APIを呼ばない', async () => {
  assert.equal(await main(['--unknown'], { log: () => {}, fetchImpl: () => assert.fail('called') }), 0);
});

test('scout creates the default user overlay and leaves repository JSON unchanged', async (t) => {
  const f = fixture(t), repoFile = new URL('eval-providers.json', import.meta.url);
  const before = fs.readFileSync(repoFile, 'utf8');
  fs.rmSync(path.join(f.dir, 'eval'), { recursive: true });
  const result = await runScout(f.options);
  assert.match(result.action, /eval に投入済み/);
  const expected = { provider: 'openrouter', model: f.candidate.id, costPerMillion: [1, 2] };
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)), [expected]);
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before);
  assert.deepEqual(readConfig({ overlayFile: f.configFile }).find((x) => x.model === f.candidate.id), expected);
});

test('missing overlay stays absent on dry-run', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.dir, 'eval'), { recursive: true });
  const result = await runScout({ ...f.options, dryRun: true });
  assert.match(result.action, /eval 投入予定/);
  assert.equal(fs.existsSync(path.join(f.dir, 'eval')), false);
});

test('overlay write failure reports the local path instead of claiming successful enqueue', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.dir, 'eval'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'eval'), 'not a directory');
  const result = await runScout(f.options);
  assert.match(result.action, /providers\.local\.json: 読込・更新不可/);
  assert.doesNotMatch(result.dm, /eval に投入済み/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'eval'), 'utf8'), 'not a directory');
});

test('既知のoverlay候補はeval完了後に提案し、skip上書きとdry-run無変更を守る', async (t) => {
  const f = fixture(t), proposals = [];
  fs.writeFileSync(f.routingFile, JSON.stringify({ categories: { summarize: { provider: 'openrouter', model: f.baseline.id, rate: 1 } } }));
  fs.writeFileSync(path.join(f.dir, 'model-scout-state.json'), JSON.stringify(state([f.baseline, f.candidate])));
  const candidateConfig = { provider: 'openrouter', model: f.candidate.id };
  fs.writeFileSync(f.configFile, JSON.stringify([candidateConfig]));
  fs.writeFileSync(path.join(f.dir, 'eval-results.jsonl'), JSON.stringify({
    t: now.toISOString(), provider: 'openrouter', model: f.candidate.id,
    byCategory: { summarize: { n: 3, graded: 3, pass: 3, errors: 0, truncated: 0 } }
  }) + '\n');
  const before = fs.readFileSync(f.configFile, 'utf8');
  const options = { ...f.options, dryRun: true, submit: async (proposal, opts) => {
    assert.equal(opts.dryRun, true); proposals.push(proposal); return { ok: true };
  } };
  const result = await runScout(options);
  assert.equal(result.ok, true);
  assert.equal(result.changes.length, 0);
  assert.equal(result.proposed, 1);
  assert.match(proposals[0].proposal.changes[0].before, /summarize: openrouter\/vendor\/current/);
  assert.match(proposals[0].proposal.changes[0].after, /summarize: openrouter\/vendor\/new/);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
  assert.equal(f.notifications.length, 0);
  fs.writeFileSync(f.configFile, JSON.stringify([{ ...candidateConfig, skip: true }]));
  assert.equal((await runScout(options)).proposed, 0);
  assert.equal(proposals.length, 1);
});

test('フロンティアは価格に依存せず新規textモデルを新しい順に上限まで選ぶ', () => {
  assert.deepEqual(FRONTIER_VENDORS, ['anthropic','openai','google','meta','meta-llama','x-ai','deepseek','moonshotai','qwen','mistralai','z-ai','xiaomi','minimax','stepfun','bytedance-seed','tencent','inclusionai','meituan']);
  const wonder = { ...model('meta/muse-wonder', 1, 4e-6, 20e-6), reason: '新規モデル' };
  const excluded = ['meta/muse-wonder:batch', 'meta/muse-wonder:free', '~meta/muse-wonder', 'other/new']
    .map(id => ({ ...wonder, id }));
  excluded.push({ ...wonder, pricing: { prompt: -1000000, completion: 1 } },
    { ...wonder, pricing: { prompt: 1, completion: Infinity } },
    { ...wonder, modality: 'text->image' }, { ...wonder, modality: 'image->text' }, { ...wonder, reason: '値下げ（20%以上）' });
  const selected = selectFrontierCandidates([wonder, ...excluded]);
  assert.deepEqual(selected.map(x => x.id), [wonder.id]);
  assert.equal(selected[0].tier, 'frontier');
  assert.deepEqual(selected[0].costPerMillion, [4, 20]);
  const many = Array.from({ length: 8 }, (_, i) => ({ ...wonder, id: `meta/new-${i}`, created: wonder.created + i }));
  assert.deepEqual(selectFrontierCandidates(many, { max: 2 }).map(x => x.id), ['meta/new-7', 'meta/new-6']);
  assert.equal(selectFrontierCandidates(many, { max: 5 }).length, 5);
  assert.equal(frontierLimit({ env: { MODEL_SCOUT_MAX_FRONTIER: '2' } }), 2);
  assert.equal(frontierLimit({ env: { MODEL_SCOUT_MAX_FRONTIER: '-1' } }), 5);
});

for (const [gain, cheap, expected] of [[5, false, 1], [4, false, 0], [5, true, 1], [-3, true, 1], [-4, true, 0]]) {
  test(`品質提案: ${gain}pt / 安価=${cheap} / 提案${expected}件`, async t => {
    const f = fixture(t), proposals = [];
    const candidate = { ...model('meta/muse-wonder', 1, cheap ? 0.1e-6 : 4e-6, cheap ? 0.2e-6 : 20e-6),
      replacements: [{ category: 'summarize', route: { provider: 'openrouter', model: 'base', rate: 0.8 }, price: [1, 2] }] };
    fs.writeFileSync(path.join(f.dir, 'eval-results.jsonl'), JSON.stringify({ t: now.toISOString(), provider: 'openrouter', model: candidate.id,
      byCategory: { summarize: { n: 100, graded: 100, pass: 80 + gain, errors: 0, truncated: 0 } } }) + '\n');
    const count = await proposeEvaluated([candidate], { home: f.home, log: () => {}, submit: async p => { proposals.push(p); return { ok: true }; } });
    assert.equal(count, expected);
    if (expected) {
      assert.match(proposals[0].proposal.costImpact.basis, /\$1\/2 →/);
      if (!cheap) { assert.match(proposals[0].title, /格上げ（品質 \+5pt）/); assert.match(proposals[0].proposal.risks.join(), /単価上昇/); }
      else assert.doesNotMatch(proposals[0].title, /格上げ/);
    }
  });
}

test('高価なフロンティアを保存し、eval後に再提案。後からのskipも尊重する', async t => {
  const f = fixture(t), wonder = model('meta/muse-wonder', 1, 4e-6, 20e-6), base = model('vendor/base', 30, 1e-6, 2e-6);
  fs.writeFileSync(f.routingFile, JSON.stringify({ categories: { summarize: { provider: 'openrouter', model: base.id, rate: 0.8 } } }));
  const options = { ...f.options, fetchImpl: async () => ({ ok: true, json: async () => catalog([wonder, base]) }) };
  const result = await runScout(options);
  assert.equal(result.ok, true);
  assert.equal(result.frontierCandidates.length, 1);
  assert.match(result.dm, /高性能の新モデル/);
  assert.match(result.dm, /2026-10-08/);
  assert.match(result.report, /## 高性能の新モデル/);
  const entry = JSON.parse(fs.readFileSync(f.configFile)).find(x => x.model === wonder.id);
  assert.deepEqual(entry, { provider: 'openrouter', model: wonder.id, tier: 'frontier', costPerMillion: [4, 20] });
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'model-scout-state.json')));
  assert.equal(saved.pendingCandidates.find(x => x.id === wonder.id).replacements.length, 1);
  fs.writeFileSync(path.join(f.dir, 'eval-results.jsonl'), JSON.stringify({ t: now.toISOString(), provider: 'openrouter', model: wonder.id,
    byCategory: { summarize: { n: 100, graded: 100, pass: 85, errors: 0, truncated: 0 } } }) + '\n');
  const proposals = [], submit = async p => { proposals.push(p); return { ok: true }; };
  assert.equal(await proposeSavedEvaluations({ home: f.home, routingFile: f.routingFile, submit, log: () => {} }), 1);
  const next = await runScout({ ...options, submit });
  assert.equal(next.candidates.length, 0);
  assert.equal(next.proposed, 1);
  fs.writeFileSync(f.configFile, JSON.stringify([{ ...entry, skip: true }]));
  assert.equal(await proposeSavedEvaluations({ home: f.home, routingFile: f.routingFile, submit, log: () => {} }), 0);
  assert.equal((await runScout({ ...options, submit })).proposed, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile))[0].skip, true);
});


test('品質軸は現行の文脈長不明でも単価とカテゴリ品質を比較できる', () => {
  const wonder = model('meta/muse-wonder', 1, 4e-6, 20e-6);
  const routing = { categories: { summarize: { provider: 'deepseek', model: 'not-in-catalog', rate: 0.8 } } };
  assert.equal(selectCandidates([wonder], [], routing).candidates.length, 0);
  const result = selectCandidates([wonder], [], routing, { includeQuality: true });
  assert.equal(result.candidates[0].replacements[0].category, 'summarize');
});
