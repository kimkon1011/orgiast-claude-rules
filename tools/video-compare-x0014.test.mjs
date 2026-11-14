import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { estimateCost, planRun, sha256File } from './video-compare-x0014.mjs';

const execFileAsync = promisify(execFile);

test('同一画像 hash と prompt を全4モデルに渡す', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'x0014-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = join(directory, 'input.png');
  await writeFile(image, 'fictional-image');
  const hash = await sha256File(image);
  const plan = planRun({ prompt: 'same prompt', imagePath: image, imageSha256: hash });
  assert.equal(plan.models.length, 4);
  assert.deepEqual(new Set(plan.models.map((row) => row.imageSha256)), new Set([hash]));
  assert.deepEqual(new Set(plan.models.map((row) => row.prompt)), new Set(['same prompt']));
});

test('見積合計が予算を超過すると失敗する', () => {
  assert.throws(() => planRun({ duration: 10, budget: 0.1 }), /予算.*超過/);
});

test('unreachable は理由付きで費用 null になる', () => {
  for (const model of ['kling-4.0', 'muse', 'stardream-2.5']) {
    const estimate = estimateCost(model, 10);
    assert.equal(estimate.costUsd, null);
    assert.ok(estimate.reason);
  }
  assert.equal(estimateCost('gemini-omni-1.2-flash', 10).costUsd, 0.69504);
});

test('デフォルト画像指定の dry-run CLI は exit 0 で JSON を出す', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['tools/video-compare-x0014.mjs', '--dry-run']);
  const output = JSON.parse(stdout);
  assert.equal(output.imageSha256, 'f3d08cd590f67cd194c8f28a8f7335b7891c490b65997dd3075bcfb991572ce4');
  assert.equal(output.models.length, 4);
});
