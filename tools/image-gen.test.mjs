import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateImage } from './image-gen.mjs';

function fakeSpawnWith(body, code = 0, capture = () => {}, { close = true } = {}) {
  return (cmd, args, options) => {
    capture(cmd, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (body.stdout) child.stdout.write(body.stdout);
      if (body.stderr) child.stderr.write(body.stderr);
      child.stdout.end();
      child.stderr.end();
      if (close) child.emit('close', code);
    });
    return child;
  };
}

function response(status = 'SUCCESS', failureReason = null) {
  return JSON.stringify({
    version: 1, status: 'ok', message: 'success', data: { generated_images: [{
      model: 'nano-banana-2-flash-lite', task_id: '3edba7ce-a3b5-4890-9455-a615da0815f6',
      width: 1024, height: 1024, status, failure_reason: failureReason,
      image_urls: ['https://www.genspark.ai/api/files/s/watermarked'],
      image_urls_nowatermark: ['https://www.genspark.ai/api/files/s/clean'],
    }], local_path: 'C:\\Temp\\generated.png' },
  });
}

test('args-file に全サーバーパラメータを渡し、成功 JSON をパースする', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-test-'));
  let invocation;
  try {
    const result = await generateImage({
      prompt: 'A 日本語 prompt; special', aspectRatio: '16:9', imageSize: '2K',
      refUrls: ['https://example.com/ref.png'], outPath: 'result.png', apiKey: 'test-key', tmpDir: temp,
      spawnImpl: fakeSpawnWith({ stdout: response() }, 0, (cmd, args, options) => {
        invocation = { cmd, args, options, body: JSON.parse(fs.readFileSync(args[2], 'utf8')) };
      }),
    });
    assert.deepEqual(invocation.body, {
      query: 'A 日本語 prompt; special', model: 'nano-banana-2-flash-lite',
      aspect_ratio: '16:9', image_size: '2K', image_urls: ['https://example.com/ref.png'],
    });
    assert.ok(!invocation.args.includes('A 日本語 prompt; special'));
    assert.deepEqual(invocation.args.slice(0, 2), ['img', '--args-file']);
    assert.deepEqual(result, {
      provider: 'gsk', model: 'nano-banana-2-flash-lite', taskId: '3edba7ce-a3b5-4890-9455-a615da0815f6',
      imageUrl: 'https://www.genspark.ai/api/files/s/watermarked', imageUrlNoWatermark: 'https://www.genspark.ai/api/files/s/clean',
      localPath: 'C:\\Temp\\generated.png', width: 1024, height: 1024,
    });
    assert.equal(fs.readdirSync(temp).length, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('空の refUrls は image_urls を args-file に含めない', async () => {
  let body;
  await generateImage({ prompt: 'prompt', apiKey: 'key', spawnImpl: fakeSpawnWith({ stdout: response() }, 0, (_cmd, args) => { body = JSON.parse(fs.readFileSync(args[2], 'utf8')); }) });
  assert.equal('image_urls' in body, false);
});

test('生成 status が失敗なら failure_reason を含む例外にする', async () => {
  await assert.rejects(generateImage({ prompt: 'prompt', apiKey: 'key', spawnImpl: fakeSpawnWith({ stdout: response('FAILED', 'policy rejected') }) }), /policy rejected/);
});

test('タイムアウトは AbortError にする', async () => {
  await assert.rejects(generateImage({ prompt: 'prompt', apiKey: 'key', timeoutSeconds: 0.001, spawnImpl: fakeSpawnWith({}, 0, () => {}, { close: false }) }), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.match(error.message, /Genspark CLI timed out after 0\.001 seconds/);
    return true;
  });
});

test('prompt 未指定なら例外にする', async () => {
  await assert.rejects(generateImage({ apiKey: 'key' }), /prompt が必要です/);
});
