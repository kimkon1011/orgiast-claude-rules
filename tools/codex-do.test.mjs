import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tool = fileURLToPath(new URL('./codex-do.mjs', import.meta.url));
const { needsWorktreeRepair, detectQuotaLimit, shouldFlagEmptyFallbackDiff, buildQwenArgs, buildQwenEnv, buildGeminiArgs, buildGeminiEnv, fallbackBackendTimeoutSecs, loadDeepseekKey, loadGeminiKey, loadEnvKey, resolveFallbackBackends, resolveQwenBackends, isBackendExhausted, wslCodexLaunchPlan, WSL_PROBE_TIMEOUT_MS } = await import('./codex-do.mjs');

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

test('fallbackBackendTimeoutSecs は全体枠・既定値・環境変数・下限を反映する', () => {
  assert.equal(fallbackBackendTimeoutSecs(1800, {}), 600);
  assert.equal(fallbackBackendTimeoutSecs(300, {}), 300);
  assert.equal(fallbackBackendTimeoutSecs(1800, { CODEX_DO_FALLBACK_BACKEND_TIMEOUT_SECS: '900' }), 900);
  assert.equal(fallbackBackendTimeoutSecs(1800, { CODEX_DO_FALLBACK_BACKEND_TIMEOUT_SECS: 'garbage' }), 600);
  assert.equal(fallbackBackendTimeoutSecs(10, {}), 60);
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
  const stderr = 'WARN: Upgrade to Pro to continue';
  const check = detectQuotaLimit('', stderr);
  assert.equal(check.matched, true);
  assert.equal(check.pattern, "Upgrade to Pro");
});

test('detectQuotaLimit: 枠切れメッセージ (rate limit / 429) を検出する', () => {
  const checkStderr = detectQuotaLimit('', 'Error: Rate limit exceeded (429)');
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

test('detectQuotaLimit: exit 0 の stdout でも Codex の上限エラー行を検出する', () => {
  const stdout = "work completed\nERROR: You've hit your usage limit. Try again at Sep 9th 10:08 AM";
  assert.equal(detectQuotaLimit(stdout, '', 0).matched, true);
});

test('detectQuotaLimit: テストランナー、コード、行番号の疑似一致を除外する', () => {
  assert.equal(detectQuotaLimit("✔ detectQuotaLimit: 枠切れメッセージ (You've hit your usage limit) を検出する (1.2ms)", '', 0).matched, false);
  assert.equal(detectQuotaLimit('return json({ ok:false, error:"rate limit exceeded" }, 429)', '', 0).matched, false);
  assert.equal(detectQuotaLimit('src/CaseList.js:429:function foo()', '', 0).matched, false);
});

test('detectQuotaLimit: 2026-09-08 に実発生した偽陽性ラインを弾く（回帰）', () => {
  const lines = [
    'if (m) { src/BulkImportFromTaskMgmt.js:429: trailing whitespace. +    const y = m[',
    'src/CaseList.js:429:function CaseList_touchUpdatedAt(caseId',
    'rovider_unhealthy は failRate 0.20 / http429 50 の境界で発火し codex は除外される (0.6032ms) ✔ 27',
    '登録 seed だけを返し、title の前後空白と全角空白を同一視する (0.4297ms) ✔ 役割を固定優先順にし、それ以外は出現順を保つ (0.3027ms)',
    '  80 63 319.4251888363211 100 56 333.4470429659536 120 48 347.85853020441544 150 42 ',
    'ookへPOSTするときUser-Agentを明示しないとCloudflareが429/error code 1015で弾く。送信結果は必ずレスポンスコードで検証する',
    'ides の modifiedTime に更新 - *   - partial（429 残あり）→ 時刻更新せず、次回 trigger で同じ判定が走り resume',
  ];
  for (const line of lines) {
    assert.equal(detectQuotaLimit(line, '', 0, '').matched, false, `偽陽性ライン: ${line}`);
  }
});

test('detectQuotaLimit: 行頭429の直後にコロン（grep -h 行番号）は弾く', () => {
  for (const line of [
    '429:rate limit 対策のメモ',
    '429:## Rate Limit の扱い',
    '429:quota exceeded と書かれたドキュメント行',
  ]) {
    assert.equal(detectQuotaLimit(line, '', 0, '').matched, false, `行番号形式: ${line}`);
  }

  for (const line of [
    '429 Too Many Requests',
    'HTTP 429 Too Many Requests',
    'ERROR: 429 too many requests, retry later',
  ]) {
    const check = detectQuotaLimit(line, '', 0, '');
    assert.equal(check.matched, true, `真陽性: ${line}`);
    assert.equal(check.pattern, '429', `検出パターン: ${line}`);
  }

  const rateLimit = detectQuotaLimit('Error: Rate limit exceeded (429)', '', 0, '');
  assert.equal(rateLimit.matched, true);
  assert.equal(rateLimit.pattern, 'rate limit');
});

test('detectQuotaLimit: promptText に含まれる指示文エコーを除外する', () => {
  const echoed = '「Usage limit」を検知したら…';
  assert.equal(detectQuotaLimit(echoed, '', 1, echoed).matched, false);
});

test('detectQuotaLimit: stderr の上限行は終了コードに関係なく検出する', () => {
  for (const status of [0, 1, null]) {
    assert.equal(detectQuotaLimit('', "ERROR: You've hit your usage limit.", status).matched, true);
  }
  assert.equal(detectQuotaLimit('', '[2026-09-09T00:00:00] error: Rate limit reached for requests', 0).matched, true);
});

test('fallback の実装系指示で空 diff なら失敗扱いにする', () => {
  assert.equal(shouldFlagEmptyFallbackDiff({
    executorName: 'fallback',
    wantedEdit: true,
    timedOut: false,
    diffText: '  \n',
  }), true);
});

test('fallback の読み取り専用指示なら空 diff でも失敗扱いにしない', () => {
  assert.equal(shouldFlagEmptyFallbackDiff({
    executorName: 'fallback',
    wantedEdit: false,
    timedOut: false,
    diffText: '',
  }), false);
});

test('--no-fallback が指定されても指示文が引数として食われず、正しく除外される', () => {
  const result = run(['--dry-run', '--no-fallback', 'これは指示文です']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /これは指示文です/);
  assert.doesNotMatch(result.stdout, /--no-fallback/);
});

test('枠切れ発生時に --no-fallback を指定した場合はフォールバックせず非ゼロ終了する', () => {
  const mockResults = [
    { status: 1, output: "You've hit your usage limit. Please try again later.", stderr: "" }
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
    { status: 1, output: "You've hit your usage limit. Please try again later.", stderr: "" },
    { status: 0, output: "Qwen Code CLI has successfully edited files.", stderr: "" }
  ];
  const result = run(['指示内容'], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults), GEMINI_API_KEY: '', DEEPSEEK_API_KEY: 'sk-test' }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /executor=fallback:deepseek/);
  assert.match(result.stderr, /Falling back to an agentic CLI/);
});

test('第1フォールバックがタイムアウトしたら第2バックエンドへ進み成功する', () => {
  const mockResults = [
    { status: 1, output: "You've hit your usage limit. Please try again later.", stderr: '' },
    { status: 124, output: '', stderr: '', timedOut: true },
    { status: 0, output: 'Qwen Code CLI has successfully completed.', stderr: '' }
  ];
  const result = run(['指示内容'], {
    env: {
      CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults),
      GEMINI_API_KEY: 'gemini-test',
      DEEPSEEK_API_KEY: 'deepseek-test'
    }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /executor=fallback:deepseek/);
  assert.match(result.stderr, /タイムアウトしたため次のバックエンドへ/);
});

test('Codex もフォールバック(Qwen Code) も失敗した場合は非ゼロで終了する', () => {
  const mockResults = [
    { status: 1, output: "You've hit your usage limit. Please try again later.", stderr: "" },
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
    { status: 1, output: "You've hit your usage limit. Please try again later.", stderr: "" }
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

test('resolveFallbackBackends は codex-fallback-order.json があればその順を尊重する', () => {
  withEnvKeysCleared(() => {
    const dir = makeHomeWithEnv({
      'openrouter.env': 'OPENROUTER_API_KEY=sk-or-1\n',
      'deepseek.env': 'DEEPSEEK_API_KEY=sk-ds-1\n',
      'gemini.env': 'GEMINI_API_KEY=sk-gemini-1\n'
    });
    fs.writeFileSync(path.join(dir, '.claude', 'codex-fallback-order.json'), JSON.stringify(['qwen', 'openrouter-free', 'gemini-cli']));
    const backends = resolveFallbackBackends(dir);
    assert.deepEqual(backends.map(({ name }) => name), ['deepseek', 'openrouter-free', 'gemini-cli']);
    // cheap-code:glm は ZAI キーが無いとスキップされ、残りだけが返る
    fs.writeFileSync(path.join(dir, '.claude', 'codex-fallback-order.json'), JSON.stringify(['gemini-cli', 'cheap-code:glm']));
    const withCheap = resolveFallbackBackends(dir);
    assert.deepEqual(withCheap.map(({ name }) => name), ['gemini-cli']);
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

test('isBackendExhausted は 429/413 がファイル行番号(コロン隣接)なら誤検出しない', () => {
  assert.equal(isBackendExhausted('tools/codex-do.mjs:429:12', ''), false);
  assert.equal(isBackendExhausted('', 'Applied edit in tools/codex-do.mjs:429: added helper function'), false);
  assert.equal(isBackendExhausted('src/CaseList.js:413:function foo()', ''), false);
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

test('codex-fallback: cheap-code:glm が usage_limit クールダウン中なら deepseek へ差し替える', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-cooldown-'));
  const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'zai.env'), 'ZAI_API_KEY=zai-test\n', 'utf8');
  fs.writeFileSync(path.join(claude, 'deepseek.env'), 'DEEPSEEK_API_KEY=ds-test\n', 'utf8');
  fs.writeFileSync(path.join(claude, 'provider-cooldown.json'), JSON.stringify({ glm: { until: Date.now() + 5 * 60 * 60 * 1000, reason: 'usage_limit', at: new Date().toISOString() } }));
  fs.writeFileSync(path.join(claude, 'codex-fallback-order.json'), JSON.stringify(['cheap-code:glm', 'gemini-cli']));
  const backends = resolveFallbackBackends(home);
  assert.ok(backends.length >= 1);
  assert.equal(backends[0].provider, 'deepseek');
  assert.equal(backends[0].name, 'cheap-code:deepseek');
});

test('codex-fallback: クールダウン無しなら glm を維持する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-normal-'));
  const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'zai.env'), 'ZAI_API_KEY=zai-test\n', 'utf8');
  fs.writeFileSync(path.join(claude, 'deepseek.env'), 'DEEPSEEK_API_KEY=ds-test\n', 'utf8');
  fs.writeFileSync(path.join(claude, 'codex-fallback-order.json'), JSON.stringify(['cheap-code:glm']));
  const backends = resolveFallbackBackends(home);
  assert.equal(backends[0].provider, 'glm');
  assert.equal(backends[0].name, 'cheap-code:glm');
});

test('wslCodexLaunchPlan: 起動確認成功ならそのまま WSL codex を使う', () => {
  assert.equal(wslCodexLaunchPlan({ distroFound: true, codexPresent: true, versionOk: true, installAttempted: false, retried: false }), 'wsl');
});

test('wslCodexLaunchPlan: codex が在るのに --version だけ失敗したら再インストールでなく再試行する(2026-09-08 out=0 空出力の根本原因)', () => {
  // 旧実装は --version 失敗を「codex が無い」と誤認し npm i -g(非root の WSL では EACCES で必ず失敗)へ
  // 進み、22秒を消費した末にネイティブ(非git では trust エラーで空出力・即終了)へ落ちて out=0 行を残した。
  assert.equal(wslCodexLaunchPlan({ distroFound: true, codexPresent: true, versionOk: false, installAttempted: false, retried: false }), 'retry');
  // 再試行も失敗したら、再インストールや暗黙のネイティブ移行はせず中断する。
  assert.equal(wslCodexLaunchPlan({ distroFound: true, codexPresent: true, versionOk: false, installAttempted: false, retried: true }), 'abort');
});

test('wslCodexLaunchPlan: 本当に codex が無いときだけ1回インストールし、それも失敗なら中断する', () => {
  assert.equal(wslCodexLaunchPlan({ distroFound: true, codexPresent: false, versionOk: false, installAttempted: false, retried: false }), 'install');
  assert.equal(wslCodexLaunchPlan({ distroFound: true, codexPresent: false, versionOk: false, installAttempted: true, retried: false }), 'abort');
});

test('wslCodexLaunchPlan: ディストリが見つからなければ中断する', () => {
  assert.equal(wslCodexLaunchPlan({ distroFound: false, codexPresent: false, versionOk: false, installAttempted: false, retried: false }), 'abort');
  // distro が無いのに codex だけ在る、という矛盾した入力でも 'retry'(=再試行)へ進めない。
  assert.equal(wslCodexLaunchPlan({ distroFound: false, codexPresent: true, versionOk: false, installAttempted: false, retried: false }), 'abort');
});

test('wslCodexLaunchPlan: allowNative を明示したときだけネイティブへ移行する', () => {
  assert.equal(wslCodexLaunchPlan({ distroFound: false, codexPresent: false, versionOk: false, installAttempted: false, retried: false, allowNative: true }), 'native');
  assert.equal(wslCodexLaunchPlan({ distroFound: true, codexPresent: true, versionOk: false, installAttempted: false, retried: true, allowNative: true }), 'native');
  assert.equal(wslCodexLaunchPlan({ distroFound: true, codexPresent: false, versionOk: false, installAttempted: true, retried: false, allowNative: true }), 'native');
});

test('WSL codex のプローブはコールドスタートを待てる', () => {
  assert.ok(WSL_PROBE_TIMEOUT_MS >= 60000);
});

const { decideCodexLane, buildCodexExecArgs, normalizeCodexModel } = await import('./codex-do.mjs');
const ASTRA = 'gpt-6-astra', SOL = 'gpt-5.6-sol';
for (const [name, input, slug, reason] of [
  ['explicit model wins', { model: 'sol', lane: 'astra' }, SOL, 'explicit_model'],
  ['explicit Astra ignores cooldown', { model: ASTRA, astraCooldownMs: 1 }, ASTRA, 'explicit_model'],
  ['alias ignores cooldown', { model: 'astra', astraCooldownMs: 1 }, ASTRA, 'explicit_model'],
  ['unknown model passes through', { model: 'custom-model' }, 'custom-model', 'explicit_model'],
  ['astra lane', { lane: 'astra' }, ASTRA, 'lane_astra'],
  ['sol lane wins over header', { lane: 'sol', promptText: '<!-- lane: astra -->' }, SOL, 'lane_sol'],
  ['HTML Astra header wins over review', { promptText: '<!-- lane: astra -->', review: true }, ASTRA, 'header_astra'],
  ['text Astra header', { promptText: '# Task\nLane: astra' }, ASTRA, 'header_astra'],
  ['Sol header wins over timeout', { promptText: '<!-- lane: sol -->', timeoutSecs: 3000 }, SOL, 'header_sol'],
  ['line 40 included', { promptText: '\n'.repeat(39) + '<!-- lane: astra -->' }, ASTRA, 'header_astra'],
  ['line 41 excluded', { promptText: '\n'.repeat(40) + '<!-- lane: astra -->' }, SOL, 'default_sol'],
  ['inline Lane text excluded', { promptText: 'Example Lane: astra' }, SOL, 'default_sol'],
  ['review conserves quota', { review: true, timeoutSecs: 3000, promptText: 'E2E Playwright' }, SOL, 'review_sol'],
  ['long timeout boundary', { timeoutSecs: 2700 }, ASTRA, 'long_timeout'],
  ['short timeout boundary', { timeoutSecs: 2699 }, SOL, 'default_sol'],
  ['two keywords', { promptText: 'migration と根本原因' }, ASTRA, 'complex_task'],
  ['case insensitive keywords', { promptText: 'e2e PLAYWRIGHT' }, ASTRA, 'complex_task'],
  ['duplicate keyword counts once', { promptText: 'E2E e2e E2E' }, SOL, 'default_sol'],
  ['default Sol', {}, SOL, 'default_sol'],
  ['auto cooldown', { timeoutSecs: 2700, astraCooldownMs: 1 }, SOL, 'astra_cooldown:long_timeout'],
  ['astra lane cooldown', { lane: 'astra', astraCooldownMs: 1 }, SOL, 'astra_cooldown:lane_astra'],
]) {
  test(`decideCodexLane: ${name}`, () => {
    assert.deepEqual(decideCodexLane(input), { slug, effort: slug === ASTRA ? 'high' : undefined, reason });
  });
}

test('normalizeCodexModel: aliases and unknown slugs', () => {
  assert.equal(normalizeCodexModel('astra'), ASTRA);
  assert.equal(normalizeCodexModel('sol'), SOL);
  assert.equal(normalizeCodexModel('future-slug'), 'future-slug');
});

test('buildCodexExecArgs: model, effort, sandbox and stdin without spaces', () => {
  const args = buildCodexExecArgs({ slug: ASTRA, effort: 'high' });
  assert.deepEqual(args, ['exec', '-m', ASTRA, '-c', 'model_reasoning_effort="high"', '-s', 'workspace-write', '-']);
  assert.ok(args.every((arg) => !/\s/.test(arg)));
  assert.deepEqual(buildCodexExecArgs({ slug: SOL, review: true }), ['exec', '-m', SOL, '-s', 'read-only', '-']);
});

test('CLI validates routing options and dry-run reports model/effort', () => {
  for (const args of [['--effort', 'ultra'], ['--lane', 'invalid'], ['--model'], ['--effort'], ['--lane']]) {
    assert.equal(run(['--dry-run', '指示', ...args]).status, 2);
  }
  const result = run(['--dry-run', '--lane', 'astra', '--effort', 'max', '--no-escalate', '指示']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executor=codex model=gpt-6-astra effort=max lane=lane_astra/);
  assert.doesNotMatch(result.stdout, /--lane|--effort|--no-escalate/);
});

function runRouting(t, args, mocks, cooldown = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-routing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude);
  if (cooldown) fs.writeFileSync(path.join(claude, 'provider-cooldown.json'), JSON.stringify(cooldown));
  fs.writeFileSync(path.join(claude, 'codex-fallback-order.json'), JSON.stringify(['cheap-code:deepseek']));
  const result = run(['--force-native', '--cwd', home, ...args], {
    home, env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mocks), DEEPSEEK_API_KEY: 'test-key' },
  });
  const read = (name) => {
    try { return fs.readFileSync(path.join(claude, name), 'utf8'); } catch { return ''; }
  };
  return { ...result, ledger: read('executor-usage.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse),
    cooldown: JSON.parse(read('provider-cooldown.json') || '{}'),
    history: read('codex-limit-history.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse) };
}
const quotaResult = { status: 1, stderr: "ERROR: You've hit your usage limit. Try again in 2 hours" };

test('Astra quota retreats to Sol, writes isolated cooldown/history and both ledger rows', (t) => {
  const result = runRouting(t, ['--model', 'astra', '--no-fallback', '説明して'], [quotaResult, { output: 'done' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /astra usage limit → sol へ退避/);
  assert.deepEqual(result.ledger.map((r) => r.model), [`codex-cli/${ASTRA}`, `codex-cli/${SOL}`]);
  assert.ok(result.ledger.every((r) => r.escalated === false && r.lane));
  assert.ok(result.cooldown['codex-astra'].until > Date.now());
  assert.equal(result.cooldown.codex, undefined);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].model, ASTRA);
  assert.equal(result.history[0].pattern, "You've hit your usage limit");
});

test('Astra and Sol quota proceed to cheap-code once', (t) => {
  const result = runRouting(t, ['--lane', 'astra', '説明して'], [quotaResult, quotaResult, { output: 'done' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executor=fallback:cheap-code:deepseek/);
  assert.ok(result.cooldown.codex.until > Date.now());
  assert.equal(result.ledger.length, 3);
  assert.deepEqual(result.ledger.map((r) => [r.timedOut, r.status]), [[false, 1], [false, 1], [false, 0]]);
});

for (const [name, first, prompt] of [
  ['nonzero', { status: 9 }, '説明して'],
  ['timeout', { status: 124, timedOut: true }, '説明して'],
  ['empty diff', { output: 'done' }, '実装して'],
]) {
  test(`auto Sol escalates once on ${name}`, (t) => {
    const result = runRouting(t, ['--no-fallback', prompt], [first, { output: 'done' }]);
    assert.equal(result.status, name === 'empty diff' ? 1 : 0, result.stderr);
    assert.match(result.stdout, /sol 失敗 → astra へ昇格/);
    assert.deepEqual(result.ledger.map((r) => [r.model, r.escalated]), [[`codex-cli/${SOL}`, false], [`codex-cli/${ASTRA}`, true]]);
    assert.deepEqual(result.ledger.map((r) => [r.timedOut, r.status]), [[first.timedOut === true, first.status ?? 0], [false, 0]]);
  });
}

test('failed escalation goes to existing fallback without quota cooldown', (t) => {
  const result = runRouting(t, ['説明して'], [{ status: 9 }, { status: 9 }, { output: 'done' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /executor=fallback:cheap-code:deepseek/);
  assert.deepEqual(result.cooldown, {});
});

test('quota after escalation retreats without escalating again', (t) => {
  const result = runRouting(t, ['説明して'], [{ status: 9 }, quotaResult, { output: 'done' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.map((r) => r.model), [`codex-cli/${SOL}`, `codex-cli/${ASTRA}`, `codex-cli/${SOL}`]);
});

for (const flags of [['--no-escalate'], ['--model', 'sol'], ['--lane', 'sol']]) {
  test(`escalation disabled by ${flags.join(' ')}`, (t) => {
    const result = runRouting(t, [...flags, '説明して'], [{ status: 9 }]);
    assert.equal(result.status, 9, result.stderr);
    assert.equal(result.ledger.length, 1);
  });
}

test('Astra cooldown downgrades and suppresses escalation but explicit model bypasses it', (t) => {
  const cooldown = { 'codex-astra': { until: Date.now() + 3600000 } };
  const result = runRouting(t, ['--lane', 'astra', '説明して'], [{ status: 9 }], cooldown);
  assert.equal(result.status, 9, result.stderr);
  assert.match(result.stderr, /astra_cooldown/);
  assert.equal(result.ledger[0].model, `codex-cli/${SOL}`);
  const automatic = runRouting(t, ['説明して'], [{ status: 9 }], cooldown);
  assert.equal(automatic.ledger.length, 1);
  const explicit = runRouting(t, ['--model', 'astra', '説明して'], [{ output: 'done' }], cooldown);
  assert.equal(explicit.ledger[0].model, `codex-cli/${ASTRA}`);
});

test('successful auto Sol does not escalate', (t) => {
  const result = runRouting(t, ['説明して'], [{ output: 'done' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.ledger.length, 1);
  assert.equal(result.ledger[0].model, `codex-cli/${SOL}`);
});

test('review is read-only even when an edit keyword occurs in the prompt', (t) => {
  const result = runRouting(t, ['--review', '実装をレビューして'], [{ output: 'implemented code reviewed' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.ledger.length, 1);
});

test('CLI header boundary counts leading blank lines', () => {
  const result = run(['--dry-run', '--prompt-file', writePrompt('\n'.repeat(40) + '<!-- lane: astra -->\n説明して')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model=gpt-5\.6-sol/);
});

test('native retry preserves stdin and passes model/effort as separate argv', { skip: process.platform === 'win32' }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const capture = path.join(home, 'capture.jsonl');
  const executable = path.join(home, 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
if (process.argv.includes('gpt-6-astra')) { console.error("ERROR: You've hit your usage limit. Try again in 1 hour"); process.exit(1); }
console.log('done');
`, { mode: 0o755 });
  const instruction = '説明して: `literal` $(literal)\n次の行';
  const result = run(['--cwd', home, '--force-native', '--model', 'astra', '--prompt-file', writePrompt(instruction)], {
    home, env: { PATH: `${home}${path.delimiter}${process.env.PATH}`, CAPTURE: capture, CODEX_DO_MOCK_RESULTS: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  const expectedArgs = (options) => {
    const args = buildCodexExecArgs(options);
    args.splice(-1, 0, '--skip-git-repo-check');
    return args;
  };
  assert.deepEqual(calls[0].args, expectedArgs({ slug: ASTRA, effort: 'high' }));
  assert.deepEqual(calls[1].args, expectedArgs({ slug: SOL }));
  assert.equal(calls[0].input, calls[1].input);
  assert.ok(calls[0].input.endsWith(instruction));
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes('literal'))));
});
