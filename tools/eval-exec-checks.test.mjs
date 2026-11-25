import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, runCheck } from './eval-exec-checks.mjs';

const passing = [
`function retry(fn) {
  const delays = [100, 200];
  let attempt = 0;
  return new Promise((resolve, reject) => {
    const tryCall = () => {
      fn().then(resolve).catch(err => {
        if (attempt < delays.length) { const d = delays[attempt]; attempt++; setTimeout(tryCall, d); }
        else reject(err);
      });
    };
    tryCall();
  });
}`,
`function retry(fn) {
  return fn().catch(() => delay(100).then(fn)).catch(() => delay(200).then(fn));
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }`,
`function retry(fn) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  return fn().catch(() => wait(100).then(() => fn().catch(() => wait(200).then(() => fn()))));
}`
];

const failing = [
`function retry(fn, maxAttempts = 3, delay = 100) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const go = () => { fn().then(resolve).catch((e) => { attempts++; if (attempts >= maxAttempts) reject(e); else setTimeout(go, delay); }); };
    go();
  });
}`,
`function retry(fn) { return fn().catch(() => new Promise(r => setTimeout(r, 100)).then(fn)); }`,
`function foo(){}`,
`function retry(fn) {`,
`while(true){}`
];

test('正しい3種類の retry 実装を合格にする', async () => {
  for (const code of passing) {
    const result = await runCheck('retry-3x-100-200', code);
    assert.equal(result.pass, true, result.detail);
    assert.equal(typeof result.detail, 'string');
  }
});

test('誤った5種類の実装は例外を投げず不合格にする', { timeout: 5000 }, async () => {
  const started = Date.now();
  for (const code of failing) {
    const result = await runCheck('retry-3x-100-200', code);
    assert.equal(result.pass, false, code);
    assert.equal(typeof result.detail, 'string');
  }
  assert.ok(Date.now() - started < 5000);
});

// 2026-08-27 の実物(anthropic/claude-haiku-4-5)。retry 自体は正しいが末尾の test() が読み込み時に自走し、
// その待機がこちらの計測に混ざって「待機が[100,100,200,200]」という誤った理由で落ちていた。
test('自走するテストコード付きの回答は、混入した待機ではなく自走を理由に落とす', async () => {
  const withSelfTest = `
function retry(fn) {
  const delays = [100, 200];
  async function attempt(attemptNum) {
    try { return await fn(); }
    catch (error) {
      if (attemptNum < 3) {
        await new Promise(resolve => setTimeout(resolve, delays[attemptNum - 1]));
        return attempt(attemptNum + 1);
      }
      throw error;
    }
  }
  return attempt(1);
}
async function test() {
  let callCount = 0;
  const testFn = async () => { callCount++; if (callCount < 3) throw new Error('x'); return 'Success'; };
  try { await retry(testFn); } catch (e) {}
}
test();`;
  const result = await runCheck('retry-3x-100-200', withSelfTest);
  assert.equal(result.pass, false);
  assert.match(result.detail, /自走/);
});

// 採点対象はモデルが書いたコードなので、実行はサンドボックスから出られてはいけない。
// ホストの組み込みをコンテキストへ渡すと `Promise.constructor("return process")()` で
// 実マシンの process(fs/child_process) に届く。届いたらホスト側の env に痕跡が残るので、それを検出する。
test('サンドボックスからホストの process へ到達できない', async () => {
  delete process.env.__EVAL_SANDBOX_ESCAPE;
  const attempts = ['Promise', 'Object', 'Array', 'Error', 'JSON'].map((name) =>
    `try { ${name}.constructor('return process')().env.__EVAL_SANDBOX_ESCAPE = '1'; } catch (e) {}`).join('\n');
  const result = await runCheck('retry-3x-100-200', `${attempts}\nfunction retry(fn) { return fn(); }`);
  assert.equal(process.env.__EVAL_SANDBOX_ESCAPE, undefined, 'vm からホストの process に到達できてしまった');
  assert.equal(result.pass, false);
});

test('未知の check は不合格を返す', async () => {
  assert.deepEqual(await runCheck('missing', 'function retry() {}'), { pass: false, detail: '未知のcheck: missing' });
});

test('extractCode はフェンス内を取り出す', () => {
  assert.equal(extractCode('前置き\n```js\nconst x = 1;\n```\n後置き'), 'const x = 1;\n');
  assert.equal(extractCode('```javascript\nconst y = 2;\n```'), 'const y = 2;\n');
  assert.equal(extractCode('```\nconst z = 3;\n```'), 'const z = 3;\n');
});

test('extractCode はフェンスなしなら全文、複数なら最長を返す', () => {
  assert.equal(extractCode('function retry() {}'), 'function retry() {}');
  assert.equal(extractCode('```js\nx\n```\n```javascript\nconst longest = true;\n```'), 'const longest = true;\n');
});
