import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { checkOne, childEnv, exitCodeFor, neuterSource } from './control-group-check.mjs';

// 検定対象はすべてこの合成ソースから作り、既存の検出器は読まない。
const detector = `
export function inspect(input) {
  return { decision: input.includes('NG') ? 'block' : 'pass' };
}
`;

function syntheticTest(includeNegative) {
  return `
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from './sample-gate.mjs';
test('正常入力', () => {
  assert.equal(inspect('OK').decision, 'pass');
});
${includeNegative ? `
test('異常入力', () => {
  assert.equal(inspect('NG').decision, 'block');
});` : ''}
`;
}

function fixture(t, source = detector, testSource = syntheticTest(true)) {
  const root = mkdtempSync(path.join(tmpdir(), 'control-group-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const toolsDir = path.join(root, 'tools');
  mkdirSync(toolsDir);
  const gatePath = path.join(toolsDir, 'sample-gate.mjs');
  const testPath = path.join(toolsDir, 'sample-gate.test.mjs');
  const ledgerPath = path.join(root, '.claude', 'control-group-ledger.jsonl');
  writeFileSync(gatePath, source, 'utf8');
  writeFileSync(testPath, testSource, 'utf8');
  // rootDir は渡さず、checkOne の既定値を使用する。
  // 全テストで台帳も一時ディレクトリに隔離し、実ユーザーの台帳を汚さない。
  return { toolsDir, gatePath, testPath, ledgerPath };
}

function response(ok = true, timedOut = false) {
  return { ok, status: timedOut ? null : ok ? 0 : 1, stdout: '', stderr: '', timedOut };
}

test('verdict-string: 完全一致とクォートを保持する', () => {
  const source = `const values = ['block', "warn", \`block\`, 'deny', "deny", \`warn\`];`;
  const result = neuterSource(source);
  assert.equal(result.source, `const values = ['pass', "pass", \`pass\`, 'allow', "allow", \`pass\`];`);
  assert.deepEqual(result.mutations, [{ rule: 'verdict-string', count: 6 }]);
  assert.equal(result.total, 6);
});

test('exit-code: 非ゼロ整数だけを置換する', () => {
  const result = neuterSource(
    'process.exit(2); process.exit( 12 ); process.exit(-3); process.exit(0); process.exit(code); process.exit(1.5);',
  );
  assert.equal(result.source,
    'process.exit(0); process.exit( 0 ); process.exit(0); process.exit(0); process.exit(code); process.exit(1.5);');
  assert.deepEqual(result.mutations, [{ rule: 'exit-code', count: 3 }]);
  assert.equal(result.total, 3);
});

test('bool-verdict: 空白なしも拾い、別名のプロパティは保持する', () => {
  const result = neuterSource(
    'const x = {ok:false, blocked: true, violated :true, notok:false, unblocked:true, okAlready:false};',
  );
  assert.equal(result.source,
    'const x = {ok:true, blocked: false, violated :false, notok:false, unblocked:true, okAlready:false};');
  assert.deepEqual(result.mutations, [{ rule: 'bool-verdict', count: 3 }]);
  assert.equal(result.total, 3);
});

test('accumulate: 3種類を無効化し二重に付けない', () => {
  const source =
    'findings.push(1); missing.add(2); violations.push(3); false && findings.push(4);';
  const result = neuterSource(source);
  assert.equal(result.source,
    'false && findings.push(1); false && missing.add(2); false && violations.push(3); false && findings.push(4);');
  assert.deepEqual(result.mutations, [{ rule: 'accumulate', count: 3 }]);
  assert.equal(result.total, 3);
  assert.equal(neuterSource(result.source).total, 0);
});

test('ルールの記録順と合計が一致する', () => {
  const result = neuterSource(
    `findings.push({ok:false, decision:'warn'}); process.exit(2);`,
  );
  assert.deepEqual(result.mutations, [
    { rule: 'verdict-string', count: 1 },
    { rule: 'exit-code', count: 1 },
    { rule: 'bool-verdict', count: 1 },
    { rule: 'accumulate', count: 1 },
  ]);
  assert.equal(result.total, 4);
});

test('識別子と部分一致する文字列は壊さない', () => {
  const source = `const blocked = true; const blocking = 'blocking'; const passblock = "passblock";`;
  const result = neuterSource(source);
  assert.equal(result.source, source);
  assert.deepEqual(result.mutations, []);
  assert.equal(result.total, 0);
});

test('判定語彙がなければ変異ゼロ', () => {
  const source = 'export const double = value => value * 2;';
  assert.deepEqual(neuterSource(source), { source, mutations: [], total: 0 });
});

test('変異体の構文は妥当で、蓄積が無効になる', () => {
  const source = `
    const findings = [], missing = new Set(), violations = [];
    if (true) findings.push({ok:false, decision:'block'});
    else violations.push('warn');
    missing.add('deny');
    process.exit(2);
  `;
  const mutant = neuterSource(source);
  assert.doesNotThrow(() => new Script(mutant.source));
  let exitCode = null;
  new Script(`${mutant.source}
    globalThis.sizes = [findings.length, missing.size, violations.length];
  `).runInNewContext({
    process: { exit: (code) => { exitCode = code; } },
    get sizes() { return undefined; },
    set sizes(value) { assert.deepEqual(Array.from(value), [0, 0, 0]); },
  });
  assert.equal(exitCode, 0);
});

test('両側を検証する実テストは killed、原本のハッシュは不変', { timeout: 60000 }, async (t) => {
  const files = fixture(t);
  const hash = () => createHash('sha256').update(readFileSync(files.gatePath)).digest('hex');
  const before = hash();
  const result = await checkOne({ ...files, timeoutMs: 20000 });
  assert.equal(result.verdict, 'killed');
  assert.equal(result.name, 'sample-gate');
  assert.equal(result.total, 1);
  assert.ok(result.baselineMs >= 0);
  assert.ok(result.mutantMs >= 0);
  assert.equal(hash(), before);
});

test('対照群: 正常側だけの実テストは survived', { timeout: 60000 }, async (t) => {
  const files = fixture(t, detector, syntheticTest(false));
  const result = await checkOne({ ...files, timeoutMs: 20000 });
  assert.equal(result.verdict, 'survived');
  assert.equal(result.total, 1);
  assert.match(result.detail, /verdict-string=1/);
});

test('rootDir の既定は toolsDir の親で、コピー先の相対パスを保つ', async (t) => {
  const files = fixture(t);
  const root = path.dirname(files.toolsDir);
  const marker = JSON.stringify({ repository: 'synthetic-root' });
  writeFileSync(path.join(root, 'root-marker.json'), marker, 'utf8');
  let calls = 0;
  const result = await checkOne({
    ...files,
    toolsDir: path.relative(process.cwd(), files.toolsDir),
    runTest: (testPath, { cwd }) => {
      calls += 1;
      assert.notEqual(cwd, root);
      assert.equal(testPath, path.join(cwd, 'tools', 'sample-gate.test.mjs'));
      assert.equal(readFileSync(path.join(cwd, 'root-marker.json'), 'utf8'), marker);
      assert.equal(existsSync(path.join(cwd, 'tools', 'sample-gate.mjs')), true);
      return response(calls === 1);
    },
  });
  assert.equal(result.verdict, 'killed');
  assert.equal(calls, 2);
});

test('対照群: root JSON 依存は tools のみで baseline_failing、既定で killed', { timeout: 90000 }, async (t) => {
  const source = `
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(path.join(root, 'policy.json'), 'utf8'));
export function inspect(input) {
  return { decision: config.blockedInputs.includes(input) ? 'block' : 'pass' };
}
`;
  // 既存の合成テストを再利用し、JSON に応じた pass/block の両側を検証する。
  const files = fixture(t, source, syntheticTest(true));
  const configPath = path.join(path.dirname(files.toolsDir), 'policy.json');
  const config = JSON.stringify({ blockedInputs: ['NG'] });
  writeFileSync(configPath, config, 'utf8');

  const toolsOnly = await checkOne({
    ...files,
    rootDir: files.toolsDir,
    timeoutMs: 20000,
  });
  assert.equal(toolsOnly.verdict, 'baseline_failing');
  assert.equal(toolsOnly.total, 0);
  assert.equal(toolsOnly.mutantMs, null);

  const wholeRoot = await checkOne({ ...files, timeoutMs: 20000 });
  assert.equal(wholeRoot.verdict, 'killed');
  assert.equal(wholeRoot.total, 1);
  assert.deepEqual(wholeRoot.mutations, [{ rule: 'verdict-string', count: 1 }]);
  assert.ok(wholeRoot.baselineMs >= 0);
  assert.ok(wholeRoot.mutantMs >= 0);
  assert.equal(readFileSync(files.gatePath, 'utf8'), source);
  assert.equal(readFileSync(configPath, 'utf8'), config);
});

test('rootDir の外の検出器とテストは実行前に明確なエラーになる', async (t) => {
  const files = fixture(t);
  const outside = fixture(t);
  let calls = 0;
  const runTest = () => { calls += 1; return response(); };
  await assert.rejects(checkOne({
    ...files,
    gatePath: outside.gatePath,
    runTest,
  }), /rootDir 内のファイルを指定してください/);
  await assert.rejects(checkOne({
    ...files,
    testPath: outside.testPath,
    runTest,
  }), /rootDir 内のファイルを指定してください/);
  assert.equal(calls, 0);
});

test('変異不能なら baseline のみを実行する', async (t) => {
  const files = fixture(t, 'export const value = 42;', `
import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from './sample-gate.mjs';
test('値', () => assert.equal(value, 42));
`);
  let calls = 0;
  const result = await checkOne({
    ...files,
    runTest: () => { calls += 1; return response(); },
  });
  assert.equal(result.verdict, 'unmutatable');
  assert.equal(calls, 1);
  assert.equal(result.total, 0);
  assert.deepEqual(result.mutations, []);
  assert.equal(result.mutantMs, null);
});

test('baseline が失敗したら変異体を実行しない', async (t) => {
  const files = fixture(t, detector, `
import test from 'node:test';
import assert from 'node:assert/strict';
test('必ず失敗', () => assert.fail('合成された失敗'));
`);
  let calls = 0;
  const result = await checkOne({
    ...files,
    runTest: () => { calls += 1; return response(false); },
  });
  assert.equal(result.verdict, 'baseline_failing');
  assert.equal(calls, 1);
  assert.equal(result.total, 0);
  assert.deepEqual(result.mutations, []);
  assert.equal(result.mutantMs, null);
});

test('両段階のタイムアウトは専用 verdict になる', async (t) => {
  for (const timedOutCall of [1, 2]) {
    const files = fixture(t);
    let calls = 0;
    let copiedDir;
    const result = await checkOne({
      ...files,
      runTest: (testPath, { cwd }) => {
        copiedDir = cwd;
        calls += 1;
        // ok が true でもタイムアウト判定が優先する。
        return response(true, calls === timedOutCall);
      },
    });
    assert.equal(result.verdict, 'timeout');
    assert.equal(calls, timedOutCall);
    assert.match(result.detail, timedOutCall === 1 ? /baseline/ : /mutant/);
    assert.equal(result.mutantMs === null, timedOutCall === 1);
    assert.equal(existsSync(copiedDir), false);
  }
});

test('終了コードは survived を優先し、検定不能を成功扱いしない', () => {
  const results = (...verdicts) => verdicts.map((verdict) => ({ verdict }));
  assert.equal(exitCodeFor(results('killed', 'survived')), 2);
  assert.equal(exitCodeFor(results('timeout', 'survived')), 2);
  assert.equal(exitCodeFor(results('unmutatable')), 1);
  assert.equal(exitCodeFor(results('baseline_failing')), 1);
  assert.equal(exitCodeFor(results('timeout')), 1);
  assert.equal(exitCodeFor(results('killed', 'killed')), 0);
});

test('コピーの除外、実行順、既定時間、例外時の削除を確認する', async (t) => {
  const files = fixture(t);
  const root = path.dirname(files.toolsDir);
  const nested = path.join(files.toolsDir, 'nested');
  mkdirSync(nested);
  writeFileSync(path.join(nested, 'helper.mjs'), 'export const value = 1;', 'utf8');
  const parentRelatives = ['', 'tools', path.join('tools', 'nested')];
  for (const relative of parentRelatives) {
    for (const excluded of ['node_modules', '.git']) {
      const directory = path.join(root, relative, excluded);
      mkdirSync(directory);
      writeFileSync(path.join(directory, 'marker'), '除外対象', 'utf8');
    }
  }
  let calls = 0;
  let copiedDir;
  const result = await checkOne({
    ...files,
    runTest: (testPath, options) => {
      calls += 1;
      copiedDir = options.cwd;
      const copiedTools = path.join(copiedDir, 'tools');
      assert.ok(path.isAbsolute(testPath));
      assert.notEqual(copiedDir, root);
      assert.equal(testPath, path.join(copiedTools, 'sample-gate.test.mjs'));
      assert.equal(options.timeoutMs, 120000);
      assert.equal(existsSync(path.join(copiedTools, 'nested', 'helper.mjs')), true);
      for (const relative of parentRelatives) {
        for (const excluded of ['node_modules', '.git']) {
          assert.equal(existsSync(path.join(copiedDir, relative, excluded)), false);
        }
      }
      const copiedSource = readFileSync(path.join(copiedTools, 'sample-gate.mjs'), 'utf8');
      assert.equal(copiedSource, calls === 1 ? detector : neuterSource(detector).source);
      return response(calls === 1);
    },
  });
  assert.equal(result.verdict, 'killed');
  assert.equal(calls, 2);
  assert.equal(existsSync(copiedDir), false);
  assert.equal(readFileSync(files.gatePath, 'utf8'), detector);
  for (const relative of parentRelatives) {
    for (const excluded of ['node_modules', '.git']) {
      assert.equal(readFileSync(path.join(root, relative, excluded, 'marker'), 'utf8'), '除外対象');
    }
  }

  const injectedError = new Error('合成された起動失敗');
  await assert.rejects(checkOne({
    ...files,
    runTest: (testPath, { cwd }) => {
      copiedDir = cwd;
      throw injectedError;
    },
  }), (error) => error === injectedError);
  assert.equal(existsSync(copiedDir), false);
});

// 2026-09-23: 親が node --test の中でこのツールを呼ぶと、子が NODE_TEST_CONTEXT を継承して
// 失敗しても exit 0 を返し、変異体が常に生き残っていた(実測: 通常起動 exit 1 / 継承時 exit 0)。
// 対照群テスト「両側を検証する実テストは killed」がこれを摘発した。
test('childEnv: NODE_TEST_CONTEXT を落とし、他の環境変数は保つ', () => {
  const source = { NODE_TEST_CONTEXT: 'child-v8', PATH: '/usr/bin', ORGIAST_HOME: 'C:/tmp' };
  const result = childEnv(source);
  assert.equal('NODE_TEST_CONTEXT' in result, false);
  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.ORGIAST_HOME, '/usr/bin' === source.ORGIAST_HOME ? '/usr/bin' : 'C:/tmp');
  // 引数のオブジェクトを破壊しない。
  assert.equal(source.NODE_TEST_CONTEXT, 'child-v8');
});

test('childEnv: NODE_TEST_CONTEXT が無い環境でも壊れない', () => {
  assert.deepEqual(childEnv({ PATH: '/usr/bin' }), { PATH: '/usr/bin' });
});

test('台帳は各判定で1行増え、sha256 は変異前の原本に一致する', async (t) => {
  const cases = [
    { verdict: 'killed', source: detector, outcomes: [response(), response(false)] },
    { verdict: 'survived', source: detector, outcomes: [response(), response()] },
    { verdict: 'unmutatable', source: 'export const value = 42;', outcomes: [response()] },
    { verdict: 'baseline_failing', source: detector, outcomes: [response(false)] },
    { verdict: 'timeout', source: detector, outcomes: [response(true, true)] },
    { verdict: 'timeout', source: detector, outcomes: [response(), response(true, true)] },
  ];

  for (const scenario of cases) {
    const files = fixture(t, scenario.source);
    const originalSource = readFileSync(files.gatePath, 'utf8');
    const expectedHash = createHash('sha256').update(originalSource, 'utf8').digest('hex');
    const started = Date.now();
    const outcomes = [...scenario.outcomes];
    const result = await checkOne({
      ...files,
      runTest: () => outcomes.shift(),
    });
    const firstText = readFileSync(files.ledgerPath, 'utf8');
    const firstLines = firstText.trimEnd().split('\n');
    assert.equal(result.verdict, scenario.verdict);
    assert.equal(firstLines.length, 1);
    assert.equal(outcomes.length, 0);

    const record = JSON.parse(firstLines[0]);
    assert.deepEqual(Object.keys(record).sort(), ['at', 'name', 'sha256', 'total', 'verdict']);
    assert.equal(record.name, result.name);
    assert.equal(record.sha256, expectedHash);
    assert.equal(record.verdict, result.verdict);
    assert.equal(record.total, result.total);
    assert.equal(new Date(record.at).toISOString(), record.at);
    assert.ok(Date.parse(record.at) >= started);
    assert.ok(Date.parse(record.at) <= Date.now());

    if (result.total > 0) {
      const mutantHash = createHash('sha256')
        .update(neuterSource(originalSource).source, 'utf8').digest('hex');
      assert.notEqual(record.sha256, mutantHash);
    }
    assert.equal(readFileSync(files.gatePath, 'utf8'), originalSource);

    // 2回目も既存行を上書きせず、ちょうど1行だけ追記する。
    const secondOutcomes = [...scenario.outcomes];
    await checkOne({
      ...files,
      runTest: () => secondOutcomes.shift(),
    });
    const secondText = readFileSync(files.ledgerPath, 'utf8');
    assert.ok(secondText.startsWith(firstText));
    assert.equal(secondText.trimEnd().split('\n').length, 2);
  }
});

test('台帳に書けない場合も判定を返し、stderr に警告する', async (t) => {
  const files = fixture(t);
  // 権限設定に依存せず、通常ファイルを親にして書き込みを失敗させる。
  const parentFile = path.join(path.dirname(files.toolsDir), 'not-a-directory');
  writeFileSync(parentFile, 'synthetic file', 'utf8');
  const ledgerPath = path.join(parentFile, 'ledger.jsonl');
  const warnings = [];
  const stderr = t.mock.method(process.stderr, 'write', (chunk) => {
    warnings.push(String(chunk));
    return true;
  });
  let calls = 0;
  const result = await checkOne({
    ...files,
    ledgerPath,
    runTest: () => {
      calls += 1;
      return response(calls === 1);
    },
  });
  stderr.mock.restore();

  assert.equal(result.verdict, 'killed');
  assert.equal(result.total, 1);
  assert.equal(calls, 2);
  assert.equal(existsSync(ledgerPath), false);
  assert.match(warnings.join(''), /台帳への追記に失敗/);
  assert.equal(readFileSync(parentFile, 'utf8'), 'synthetic file');
});
