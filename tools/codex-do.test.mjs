import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tool = fileURLToPath(new URL('./codex-do.mjs', import.meta.url));
const { needsWorktreeRepair, detectQuotaLimit, buildQwenArgs, buildQwenEnv, buildGeminiArgs, buildGeminiEnv, loadDeepseekKey, loadGeminiKey, loadEnvKey, resolveFallbackBackends, resolveQwenBackends, isBackendExhausted } = await import('./codex-do.mjs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ORGIAST_HOME: options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-home-')),
      ...options.env
    },
  });
}

function writePrompt(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-')), 'prompt.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('--prompt-file の中身をそのまま指示として使う', () => {
  const file = writePrompt('# 見出し\n新規ファイルを作る\n');
  const result = run(['--dry-run', '--prompt-file', file]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /新規ファイルを作る/);
});

test('バッククォート・$()・改行を含む指示が欠落せず原文のまま届く', () => {
  // argv で渡すとシェルがコマンド置換として実行し、仕様の一部が消えたプロンプトが
  // Codex に届く(2026-08-26 実害)。ファイル経路ではそれが起きないことを固定する。
  const body = 'ファイル `scripts/import-x.mjs` を作る\nテーブルは `booth_customer_aliases`\n$(rm -rf /) は文字列のまま\n';
  const result = run(['--dry-run', '--prompt-file', writePrompt(body)]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /`scripts\/import-x\.mjs`/);
  assert.match(result.stdout, /`booth_customer_aliases`/);
  assert.match(result.stdout, /\$\(rm -rf \/\)/);
});

test('--prompt-file が読めなければ実行せず終了する', () => {
  const result = run(['--dry-run', '--prompt-file', path.join(os.tmpdir(), 'codexdo-missing-prompt.md')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--prompt-file を読めません/);
});

test('--prompt-file にパスが無ければ使い方を出す', () => {
  const result = run(['--dry-run', '--prompt-file']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--prompt-file/);
});

test('--timeout が数値でなければ実行しない', () => {
  const result = run(['--dry-run', '--timeout', 'abc', 'なにか実装する']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--timeout は正の秒数/);
});

test('--timeout と --cwd を付けても指示文が引数として食われない', () => {
  const result = run(['--dry-run', '--timeout', '60', '--cwd', os.tmpdir(), 'これは指示文です']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /これは指示文です/);
  assert.doesNotMatch(result.stdout, /--timeout|--cwd|60/);
});

test('指示が空なら使い方を出して終了する', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /使い方/);
});

test('Windows 絶対パスの gitdir だけ worktree repair 対象にする', () => {
  assert.equal(needsWorktreeRepair('gitdir: C:/Users/example/repo/.git/worktrees/linked\n'), true);
  assert.equal(needsWorktreeRepair('gitdir: ../../../.git/worktrees/linked\n'), false);
});

test('detectQuotaLimit: 枠切れメッセージ (You\'ve hit your usage limit) を検出する', () => {
  const stdout = 'ERROR: You\'ve hit your usage limit. Upgrade to Pro...';
  const check = detectQuotaLimit(stdout, '');
  assert.equal(check.matched, true);
  assert.equal(check.pattern, "You've hit your usage limit");
  assert.match(check.snippet, /You've hit your usage limit/);
});

test('detectQuotaLimit: 枠切れメッセージ (Upgrade to Pro) を検出する', () => {
  const stderr = 'Please visit chatgpt.com/explore/pro to Upgrade to Pro';
  const check = detectQuotaLimit('', stderr);
  assert.equal(check.matched, true);
  assert.equal(check.pattern, "Upgrade to Pro");
});

test('detectQuotaLimit: 枠切れメッセージ (rate limit / 429) を検出する', () => {
  const checkStderr = detectQuotaLimit('', 'Error: rate limit exceeded (429)');
  assert.equal(checkStderr.matched, true);
  assert.equal(checkStderr.pattern, "rate limit");

  const check429 = detectQuotaLimit('', 'HTTP 429 Too Many Requests');
  assert.equal(check429.matched, true);
  assert.equal(check429.pattern, "429");
});

test('detectQuotaLimit: 通常のエラー出力やテスト失敗では検出しない', () => {
  const stderr = 'Error: AssertionError [ERR_ASSERTION]: Expected true but got false\nReferenceError: x is not defined';
  const check = detectQuotaLimit('', stderr);
  assert.equal(check.matched, false);
});

test('--no-fallback が指定されても指示文が引数として食われず、正しく除外される', () => {
  const result = run(['--dry-run', '--no-fallback', 'これは指示文です']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /これは指示文です/);
  assert.doesNotMatch(result.stdout, /--no-fallback/);
});

test('枠切れ発生時に --no-fallback を指定した場合はフォールバックせず非ゼロ終了する', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: "" }
  ];
  const result = run(['--no-fallback', '指示内容'], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults) }
  });
  // フォールバックしないため非ゼロ終了
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex usage limit detected/);
  assert.match(result.stderr, /--no-fallback is specified/);
  assert.match(result.stdout, /executor=codex/);
});

test('枠切れ発生時にフォールバックが成功した場合は 0 で終了しヘッダ・フッタを出力する', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: "" },
    { status: 0, output: "Qwen Code CLI has successfully edited files.", stderr: "" }
  ];
  const result = run(['指示内容'], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults), GEMINI_API_KEY: '', DEEPSEEK_API_KEY: 'sk-test' }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /executor=fallback:deepseek/);
  assert.match(result.stderr, /Falling back to an agentic CLI/);
});

test('Codex もフォールバック(Qwen Code) も失敗した場合は非ゼロで終了する', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: "" },
    { status: 12, output: "", stderr: "Qwen Code execution error" }
  ];
  const result = run(['指示内容'], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults), GEMINI_API_KEY: '', DEEPSEEK_API_KEY: 'sk-test' }
  });
  assert.equal(result.status, 12);
  assert.match(result.stdout, /executor=fallback:deepseek/);
});

test('枠切れ発生時に DEEPSEEK_API_KEY が無ければフォールバックせず非ゼロで終了する', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: "" }
  ];
  const prev = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = run(['指示内容'], {
      env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults), GEMINI_API_KEY: '', OPENROUTER_API_KEY: '' }
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /executor=fallback:unknown/);
    assert.match(result.stderr, /GEMINI_API_KEY、DEEPSEEK_API_KEY、OPENROUTER_API_KEY が無いため/);
  } finally {
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('buildQwenArgs は -y と --exclude-tools run_shell_command を必ず両方含む', () => {
  const args = buildQwenArgs();
  assert.ok(args.includes('-y'));
  const excludeIndex = args.indexOf('--exclude-tools');
  assert.ok(excludeIndex >= 0);
  assert.equal(args[excludeIndex + 1], 'run_shell_command');
});

test('buildQwenArgs は --approval-mode を含まない', () => {
  const args = buildQwenArgs();
  assert.ok(!args.includes('--approval-mode'));
});

test('buildQwenArgs の最後は [-p, marker] で終わる', () => {
  const args = buildQwenArgs();
  assert.deepEqual(args.slice(-2), ['-p', 'Follow-the-instructions-provided-on-stdin.']);
});

test('buildQwenArgs の戻り値のどの要素にも空白文字(半角スペース・タブ・改行)が含まれない', () => {
  // shell:true の Windows では引数がエスケープされず連結されるため、空白を含む引数は
  // qwen が位置引数と誤認して即死する(2026-09-03 実測)。既定値とカスタム marker の両方で検証する。
  const cases = [buildQwenArgs(), buildQwenArgs({ marker: 'Custom-marker-without-spaces.' })];
  for (const args of cases) {
    for (const arg of args) {
      assert.ok(!/[\s]/.test(arg), `argv 要素に空白が含まれる: ${JSON.stringify(arg)}`);
    }
  }
});

test('buildQwenArgs は timeoutSecs を --max-wall-time の次に置く', () => {
  const args = buildQwenArgs({ timeoutSecs: 42 });
  const wallIndex = args.indexOf('--max-wall-time');
  assert.ok(wallIndex >= 0);
  assert.equal(args[wallIndex + 1], '42');
});

test('buildQwenArgs は既定値と上書き値の両方で正しい引数を返す', () => {
  const defaults = buildQwenArgs();
  assert.deepEqual(defaults, [
    '--auth-type', 'openai',
    '-m', 'deepseek-chat',
    '-y',
    '--exclude-tools', 'run_shell_command',
    '--max-wall-time', '1800',
    '--max-tool-calls', '80',
    '-p', 'Follow-the-instructions-provided-on-stdin.'
  ]);
  const custom = buildQwenArgs({ model: 'deepseek-reasoner', timeoutSecs: 300, maxToolCalls: 40 });
  assert.deepEqual(custom, [
    '--auth-type', 'openai',
    '-m', 'deepseek-reasoner',
    '-y',
    '--exclude-tools', 'run_shell_command',
    '--max-wall-time', '300',
    '--max-tool-calls', '40',
    '-p', 'Follow-the-instructions-provided-on-stdin.'
  ]);
});

test('buildQwenEnv は OPENAI_* を設定し GEMINI/GOOGLE キーを削除し baseEnv を変えない', () => {
  const base = { PATH: '/usr/bin', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'gg', OPENAI_API_KEY: 'old' };
  const snapshot = { ...base };
  const env = buildQwenEnv(base, 'deepseek-key');
  assert.equal(env.OPENAI_API_KEY, 'deepseek-key');
  assert.equal(env.OPENAI_BASE_URL, 'https://api.deepseek.com/v1');
  assert.equal(env.OPENAI_MODEL, 'deepseek-chat');
  assert.equal(env.QWEN_CODE_SUPPRESS_YOLO_WARNING, '1');
  assert.ok(!('GEMINI_API_KEY' in env));
  assert.ok(!('GOOGLE_API_KEY' in env));
  assert.deepEqual(base, snapshot);
});

test('buildQwenEnv は model と baseUrl を上書きできる', () => {
  const env = buildQwenEnv({}, 'key', { model: 'deepseek-reasoner', baseUrl: 'https://example.com/v1' });
  assert.equal(env.OPENAI_MODEL, 'deepseek-reasoner');
  assert.equal(env.OPENAI_BASE_URL, 'https://example.com/v1');
});

test('buildGeminiArgs は auto_edit を使い -y を含めず、末尾に空白なし marker を置く', () => {
  const marker = 'Custom-marker-without-spaces.';
  const args = buildGeminiArgs({ marker });
  const approvalIndex = args.indexOf('--approval-mode');
  assert.ok(approvalIndex >= 0);
  assert.equal(args[approvalIndex + 1], 'auto_edit');
  assert.ok(!args.includes('-y'));
  assert.deepEqual(args.slice(-2), ['-p', marker]);
  for (const arg of args) assert.ok(!/\s/.test(arg), `argv 要素に空白が含まれる: ${JSON.stringify(arg)}`);
});

test('buildGeminiEnv は Gemini キーと trust を設定し、OPENAI_* と baseEnv を変えない', () => {
  const base = { PATH: '/usr/bin', GEMINI_API_KEY: 'old', OPENAI_API_KEY: 'openai-key', OPENAI_BASE_URL: 'https://example.test' };
  const snapshot = { ...base };
  const env = buildGeminiEnv(base, 'gemini-key');
  assert.equal(env.GEMINI_API_KEY, 'gemini-key');
  assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
  assert.equal(env.OPENAI_API_KEY, 'openai-key');
  assert.equal(env.OPENAI_BASE_URL, 'https://example.test');
  assert.deepEqual(base, snapshot);
});

test('loadDeepseekKey は process.env を最優先する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-ds-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'deepseek.env'), 'DEEPSEEK_API_KEY=from-file\n', 'utf8');
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'from-env';
  try {
    assert.equal(loadDeepseekKey(dir), 'from-env');
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('loadDeepseekKey はファイルから export DEEPSEEK_API_KEY="..." 形式を読める', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-ds-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'deepseek.env'), [
    '# コメント行は無視',
    'export DEEPSEEK_API_KEY="sk-abc-123"',
    'OTHER=ignored'
  ].join('\n'), 'utf8');
  const prev = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal(loadDeepseekKey(dir), 'sk-abc-123');
  } finally {
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('loadDeepseekKey はキーが無ければ null を返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-ds-'));
  const prev = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal(loadDeepseekKey(dir), null);
  } finally {
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
  }
});

// ---- fallback backend resolution / key loading / exhaustion detection ----

function makeHomeWithEnv(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-home-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = name === '.gemini/.env' ? path.join(dir, name) : path.join(dir, '.claude', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  return dir;
}

// process.env の影響を受けないよう、テスト中は両キーを退避・削除・復元する。
function withEnvKeysCleared(fn) {
  const prevOR = process.env.OPENROUTER_API_KEY;
  const prevDS = process.env.DEEPSEEK_API_KEY;
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevModel = process.env.CODEX_DO_FREE_MODEL;
  const prevGeminiModel = process.env.CODEX_DO_GEMINI_MODEL;
  const prevPreferFree = process.env.CODEX_DO_PREFER_FREE;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.CODEX_DO_FREE_MODEL;
  delete process.env.CODEX_DO_GEMINI_MODEL;
  delete process.env.CODEX_DO_PREFER_FREE;
  try {
    return fn();
  } finally {
    if (prevOR === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOR;
    if (prevDS === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevDS;
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGemini;
    if (prevModel === undefined) delete process.env.CODEX_DO_FREE_MODEL;
    else process.env.CODEX_DO_FREE_MODEL = prevModel;
    if (prevGeminiModel === undefined) delete process.env.CODEX_DO_GEMINI_MODEL;
    else process.env.CODEX_DO_GEMINI_MODEL = prevGeminiModel;
    if (prevPreferFree === undefined) delete process.env.CODEX_DO_PREFER_FREE;
    else process.env.CODEX_DO_PREFER_FREE = prevPreferFree;
  }
}

test('resolveFallbackBackends は既定で gemini-cli → deepseek → openrouter-free の順に置く', () => {
  withEnvKeysCleared(() => {
    const dir = makeHomeWithEnv({
      'openrouter.env': 'OPENROUTER_API_KEY=sk-or-1\n',
      'deepseek.env': 'DEEPSEEK_API_KEY=sk-ds-1\n',
      'gemini.env': 'GEMINI_API_KEY=sk-gemini-1\n'
    });
    const backends = resolveFallbackBackends(dir);
    assert.deepEqual(backends.map(({ name }) => name), ['gemini-cli', 'deepseek', 'openrouter-free']);
    assert.deepEqual(backends.map(({ kind }) => kind), ['gemini', 'qwen', 'qwen']);
    assert.equal(backends[0].model, 'gemini-3.7-flash');
    assert.equal(backends[0].apiKey, 'sk-gemini-1');
    assert.equal(backends[1].baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(backends[2].baseUrl, 'https://openrouter.ai/api/v1');
  });
});

test('resolveFallbackBackends は prefer-free でも残りを gemini-cli → deepseek の順に保つ', () => {
  withEnvKeysCleared(() => {
    const prev = process.env.CODEX_DO_PREFER_FREE;
    process.env.CODEX_DO_PREFER_FREE = '1';
    try {
      const dir = makeHomeWithEnv({
        'openrouter.env': 'OPENROUTER_API_KEY=sk-or-1\n',
        'deepseek.env': 'DEEPSEEK_API_KEY=sk-ds-1\n',
        'gemini.env': 'GEMINI_API_KEY=sk-gemini-1\n'
      });
      const backends = resolveFallbackBackends(dir);
      assert.deepEqual(backends.map(({ name }) => name), ['openrouter-free', 'gemini-cli', 'deepseek']);
    } finally {
      if (prev === undefined) delete process.env.CODEX_DO_PREFER_FREE;
      else process.env.CODEX_DO_PREFER_FREE = prev;
    }
  });
});

test('resolveFallbackBackends はキーが一部だけなら存在する分だけを順序どおり返す', () => {
  withEnvKeysCleared(() => {
    const onlyOR = resolveFallbackBackends(makeHomeWithEnv({ 'openrouter.env': 'OPENROUTER_API_KEY=sk-or-1\n' }));
    assert.equal(onlyOR.length, 1);
    assert.equal(onlyOR[0].name, 'openrouter-free');

    const onlyDS = resolveFallbackBackends(makeHomeWithEnv({ 'deepseek.env': 'DEEPSEEK_API_KEY=sk-ds-1\n' }));
    assert.equal(onlyDS.length, 1);
    assert.equal(onlyDS[0].name, 'deepseek');

    const geminiAndOR = resolveFallbackBackends(makeHomeWithEnv({
      'gemini.env': 'GEMINI_API_KEY=sk-gemini-1\n',
      'openrouter.env': 'OPENROUTER_API_KEY=sk-or-1\n'
    }));
    assert.deepEqual(geminiAndOR.map(({ name }) => name), ['gemini-cli', 'openrouter-free']);
  });
});

test('resolveFallbackBackends はどのキーも無ければ空配列を返す', () => {
  withEnvKeysCleared(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-home-'));
    assert.deepEqual(resolveFallbackBackends(dir), []);
  });
});

test('resolveQwenBackends は CODEX_DO_FREE_MODEL で openrouter-free の model を上書きできる', () => {
  withEnvKeysCleared(() => {
    process.env.CODEX_DO_FREE_MODEL = 'z-ai/glm-5.2:free';
    const dir = makeHomeWithEnv({ 'openrouter.env': 'OPENROUTER_API_KEY=sk-or-1\n' });
    const backends = resolveQwenBackends(dir);
    assert.equal(backends[0].name, 'openrouter-free');
    assert.equal(backends[0].model, 'z-ai/glm-5.2:free');
  });
});

test('resolveQwenBackends は resolveFallbackBackends の後方互換別名である', () => {
  withEnvKeysCleared(() => {
    const dir = makeHomeWithEnv({
      'gemini.env': 'GEMINI_API_KEY=sk-gemini-1\n',
      'deepseek.env': 'DEEPSEEK_API_KEY=sk-ds-1\n'
    });
    assert.deepEqual(resolveQwenBackends(dir), resolveFallbackBackends(dir));
  });
});

test('loadGeminiKey は process.env、.claude/gemini.env、~/.gemini/.env の順で読む', () => {
  withEnvKeysCleared(() => {
    const dir = makeHomeWithEnv({
      'gemini.env': 'GEMINI_API_KEY=from-claude\n',
      '.gemini/.env': 'GEMINI_API_KEY=from-gemini-home\n'
    });
    assert.equal(loadGeminiKey(dir), 'from-claude');
    process.env.GEMINI_API_KEY = 'from-process';
    assert.equal(loadGeminiKey(dir), 'from-process');

    delete process.env.GEMINI_API_KEY;
    const fallbackDir = makeHomeWithEnv({ '.gemini/.env': 'export GEMINI_API_KEY="from-gemini-home"\n' });
    assert.equal(loadGeminiKey(fallbackDir), 'from-gemini-home');
  });
});

test('isBackendExhausted は上限系メッセージで true を返す', () => {
  assert.equal(isBackendExhausted('HTTP 429 Too Many Requests', ''), true);
  assert.equal(isBackendExhausted('', 'Error: rate limit exceeded'), true);
  assert.equal(isBackendExhausted('', 'rate-limited'), true);
  assert.equal(isBackendExhausted('Request too large for model', ''), true);
  assert.equal(isBackendExhausted('', 'HTTP 413 Payload Too Large'), true);
  assert.equal(isBackendExhausted('quota exceeded', ''), true);
  assert.equal(isBackendExhausted('', 'insufficient_quota'), true);
});

test('isBackendExhausted は通常の成功出力で false を返す', () => {
  assert.equal(isBackendExhausted('Qwen Code CLI has successfully edited files.', ''), false);
  assert.equal(isBackendExhausted('', 'All tests passed'), false);
});

test('loadEnvKey は process.env を最優先し、ファイルの export VAR="..." 形式も読める', () => {
  const dir = makeHomeWithEnv({ 'openrouter.env': 'export OPENROUTER_API_KEY="sk-or-file"\n' });
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-env';
  try {
    assert.equal(loadEnvKey(dir, 'openrouter.env', 'OPENROUTER_API_KEY'), 'sk-or-env');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }

  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.equal(loadEnvKey(dir, 'openrouter.env', 'OPENROUTER_API_KEY'), 'sk-or-file');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('loadEnvKey はキーが無ければ null を返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-home-'));
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.equal(loadEnvKey(dir, 'openrouter.env', 'OPENROUTER_API_KEY'), null);
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
  }
});

test('loadDeepseekKey は loadEnvKey の薄いラッパとして振る舞いが変わらない', () => {
  const dir = makeHomeWithEnv({ 'deepseek.env': 'export DEEPSEEK_API_KEY="sk-ds-1"\n' });
  const prev = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal(loadDeepseekKey(dir), 'sk-ds-1');
    assert.equal(loadEnvKey(dir, 'deepseek.env', 'DEEPSEEK_API_KEY'), 'sk-ds-1');
  } finally {
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
  }
});
