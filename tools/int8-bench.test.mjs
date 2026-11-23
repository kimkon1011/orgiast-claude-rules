import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateImage, generateVideo } from './image-gen.mjs';
import { appendCsv, parseArgs, readVramMb, runBenchmark } from './int8-bench.mjs';

test('既定値と全オプションを解析する', () => {
  const defaults = parseArgs([], new Date('2026-11-24T00:00:00Z'));
  assert.deepEqual(defaults, {
    precision: 'auto', model: 'nano-banana-2-flash-lite', prompt: defaults.prompt,
    video: false, count: 3, json: false,
    outPath: path.join('outputs', 'P-0417', 'benchmark-results-2026-11-24.csv'),
  });
  assert.ok(defaults.prompt.trim());
  assert.deepEqual(parseArgs([
    '--precision', 'int8', '--model', 'kling/v3', '--prompt', '動く展示台',
    '--video', '--count', '2', '--json', '--out', 'some folder/results.csv',
  ]), {
    precision: 'int8', model: 'kling/v3', prompt: '動く展示台', video: true,
    count: 2, json: true, outPath: 'some folder/results.csv',
  });
  assert.equal(parseArgs(['--precision', 'fp16']).precision, 'fp16');
});

test('空プロンプトを拒否する', () => {
  assert.throws(() => parseArgs(['--prompt', '']), /空/);
  assert.throws(() => parseArgs(['--prompt', '   ']), /空/);
});

test('不明な精度、値の欠落、不正な回数を拒否する', () => {
  assert.throws(() => parseArgs(['--precision', 'fp32']), /precision/);
  assert.throws(() => parseArgs(['--out', '--json']), /値がありません/);
  assert.throws(() => parseArgs(['--count', '0']), /正の整数/);
  assert.throws(() => parseArgs(['--count', '1.5']), /正の整数/);
});

test('CSV は引用符と改行をエスケープし、ヘッダーを一度だけ書く', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'int8-bench-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const file = path.join(tmpDir, 'nested', 'results.csv');
  const row = {
    timestamp: '2026-11-24T00:00:00Z', model: 'model', precision: 'int8', mode: 'image',
    prompt: 'a,"b"\nc', run: 1, source: 'mock', ttft_seconds: 2.8, total_seconds: 2.8,
    local_vram_delta_mb: null, error: false,
  };
  appendCsv(file, [row]);
  appendCsv(file, [{ ...row, run: 2, source: 'gsk', error: true, error_message: 'failed, retry' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), [
    'timestamp,model,precision,mode,prompt,run,source,ttft_seconds,total_seconds,local_vram_delta_mb,error,error_message',
    '2026-11-24T00:00:00Z,model,int8,image,"a,""b""\nc",1,mock,2.8,2.8,,false,',
    '2026-11-24T00:00:00Z,model,int8,image,"a,""b""\nc",2,gsk,2.8,2.8,,true,"failed, retry"',
    '',
  ].join('\r\n'));
});

test('VRAM は複数 GPU の合計を返し、取得できなければ null を返す', () => {
  assert.equal(readVramMb(() => { throw new Error('ENOENT'); }), null);
  assert.equal(readVramMb(() => '12\n[N/A]\n'), null);
  assert.equal(readVramMb(() => '12\r\n20\r\n'), 32);
});

test('キーなしと CLI 不在は模擬結果にする', async () => {
  const options = parseArgs(['--count', '2', '--precision', 'int8']);
  const results = await runBenchmark(options, { apiKey: '' });
  let calls = 0;
  const missingCli = await runBenchmark(options, {
    apiKey: 'test', vram: () => null,
    image: async () => { calls += 1; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.equal(calls, 1);
  for (const rows of [results, missingCli]) {
    assert.deepEqual(rows.map((row) => [row.source, row.error, row.total_seconds, row.local_vram_delta_mb]),
      [['mock', false, 2.8, null], ['mock', false, 2.9, null]]);
  }
});

test('動画を選択して時間とローカル VRAM 差分を計測し、API エラーを保持する', async () => {
  const options = parseArgs(['--video', '--model', 'kling/v3', '--precision', 'fp16', '--count', '2']);
  const timings = [100, 1300, 2000, 2900];
  const samples = [100, 110, null, 100];
  let calls = 0;
  const [first, second] = await runBenchmark(options, {
    apiKey: 'test', now: () => timings.shift(), vram: () => samples.shift(),
    video: async (args) => {
      assert.deepEqual(args, { prompt: options.prompt, model: 'kling/v3', precision: 'fp16', apiKey: 'test' });
      if (++calls === 2) throw new Error('API failed');
    },
  });
  assert.deepEqual([first.mode, first.source, first.ttft_seconds, first.total_seconds, first.local_vram_delta_mb],
    ['video', 'gsk', 1.2, 1.2, 10]);
  assert.deepEqual([second.error, second.error_message, second.ttft_seconds, second.total_seconds, second.local_vram_delta_mb],
    [true, 'API failed', null, 0.9, null]);
});

test('Genspark への精度指定と動画コマンドを確認し、精度未確認の結果を拒否する', async () => {
  function spawnWith(command, precision, data) {
    return (_cmd, args) => {
      assert.equal(args[0], command);
      const params = JSON.parse(fs.readFileSync(args[2].replace(/^"|"$/g, ''), 'utf8'));
      assert.equal(params.precision, precision);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ data }));
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    };
  }
  const options = { prompt: 'booth', apiKey: 'test' };
  await assert.rejects(generateImage({
    ...options, precision: 'int8', spawnImpl: spawnWith('img', 'int8', { generated_images: [{ status: 'SUCCESS' }] }),
  }), /適用を確認できません/);
  const result = await generateVideo({
    ...options, model: 'kling/v3', precision: 'fp16',
    spawnImpl: spawnWith('video', 'fp16', { generated_videos: [
      { status: 'SUCCESS', video_url: 'https://example.com/clip.mp4', precision: 'fp16' },
    ] }),
  });
  assert.equal(result.videoUrl, 'https://example.com/clip.mp4');
});
