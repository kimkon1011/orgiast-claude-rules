import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export function defaultLedgerPath() {
  return path.join(process.env.ORGIAST_HOME || homedir(), '.claude', 'control-group-ledger.jsonl');
}

function appendLedger(ledgerPath, result, sha256) {
  try {
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({
      name: result.name,
      sha256,
      verdict: result.verdict,
      total: result.total,
      at: new Date().toISOString(),
    }) + '\n', 'utf8');
  } catch (error) {
    // 警告の出力失敗も含め、台帳の都合で検定結果を失わない。
    try {
      process.stderr.write(
        `control-group-check: 台帳への追記に失敗: ${String(error.message).replace(/[\r\n]+/g, ' ')}\n`,
      );
    } catch {}
  }
}

export function neuterSource(source) {
  const mutations = [];
  let current = source;

  // ルールは定義順で適用し、実際に変更した数だけ記録する。
  function apply(rule, pattern, replace) {
    let count = 0;
    current = current.replace(pattern, (...args) => {
      const replacement = replace(...args);
      if (replacement !== args[0]) count += 1;
      return replacement;
    });
    if (count > 0) mutations.push({ rule, count });
  }

  apply('verdict-string', /(['"`])(block|warn|deny)\1/g,
    (_, quote, verdict) => `${quote}${verdict === 'deny' ? 'allow' : 'pass'}${quote}`);

  apply('exit-code',
    /(?<![\w$.])process\.exit\(\s*([+-]?\d+)\s*\)/g,
    (match, number) => Number(number) === 0
      ? match
      : match.replace(number, '0'));

  apply('bool-verdict',
    /(?<![\w$.])(ok|blocked|violated)(\s*:\s*)(false|true)\b/g,
    (match, key, separator, value) => {
      if (key === 'ok' && value === 'false') return `${key}${separator}true`;
      if (key !== 'ok' && value === 'true') return `${key}${separator}false`;
      return match;
    });

  apply('accumulate',
    /(?<![\w$.])(?:findings\.push|missing\.add|violations\.push)\(/g,
    (match, offset, input) => {
      // すでに無効化された呼び出しは再度変更しない。
      if (/\bfalse\s*&&\s*$/.test(input.slice(0, offset))) return match;
      return `false && ${match}`;
    });

  return {
    source: current,
    mutations,
    total: mutations.reduce((sum, mutation) => sum + mutation.count, 0),
  };
}

// 注入する関数も runTest(testPath, { timeoutMs, cwd }) の形で呼び出す。
// node:test の子プロセスは NODE_TEST_CONTEXT を継承すると、テストが落ちても exit 0 を返す。
// このツール自身をテストから呼んだ場合に失敗信号が丸ごと消え、変異体が常に生き残る
// (= 対照群を持たない検出器と同じ状態)。継承を断ち切ってから起動する。
export function childEnv(env = process.env) {
  const copy = { ...env };
  delete copy.NODE_TEST_CONTEXT;
  return copy;
}

function defaultRunTest(testPath, { timeoutMs, cwd }) {
  const result = spawnSync(process.execPath, ['--test', testPath], {
    cwd,
    env: childEnv(),
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  // 起動失敗や出力上限超過を検出成功と誤認しない。
  if (result.error && !timedOut) throw result.error;
  return {
    ok: !timedOut && result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut,
  };
}

function relativeFile(root, filename) {
  const absolute = path.resolve(filename);
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`rootDir 内のファイルを指定してください: ${filename}`);
  }
  if (!statSync(absolute).isFile()) {
    throw new Error(`通常ファイルではありません: ${filename}`);
  }
  return relative;
}

export async function checkOne({
  gatePath,
  testPath,
  toolsDir,
  rootDir = path.dirname(path.resolve(toolsDir)),
  timeoutMs = 120000,
  runTest = defaultRunTest,
  ledgerPath = defaultLedgerPath(),
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs は正の整数で指定してください');
  }
  const root = path.resolve(rootDir);
  const gateRelative = relativeFile(root, gatePath);
  const testRelative = relativeFile(root, testPath);
  // ハッシュ、baseline、変異体を同じ原本スナップショットから作る。
  const originalSource = readFileSync(gatePath, 'utf8');
  const sha256 = createHash('sha256').update(originalSource, 'utf8').digest('hex');
  const result = {
    name: path.basename(gatePath, path.extname(gatePath)),
    verdict: null,
    mutations: [],
    total: 0,
    baselineMs: null,
    mutantMs: null,
    detail: '',
  };
  const temporary = mkdtempSync(path.join(tmpdir(), 'control-group-check-'));

  try {
    const copiedRoot = path.join(temporary, 'root');
    cpSync(root, copiedRoot, {
      recursive: true,
      // シンボリックリンクも実体をコピーし、原本への書き込みを防ぐ。
      dereference: true,
      filter: (source) => {
        const parts = path.relative(root, source).split(path.sep);
        return !parts.includes('node_modules') && !parts.includes('.git');
      },
    });
    const copiedGate = path.join(copiedRoot, gateRelative);
    const copiedTest = path.join(copiedRoot, testRelative);
    writeFileSync(copiedGate, originalSource, 'utf8');

    async function execute(field) {
      const started = performance.now();
      try {
        return await runTest(copiedTest, { timeoutMs, cwd: copiedRoot });
      } finally {
        result[field] = performance.now() - started;
      }
    }

    const baseline = await execute('baselineMs');
    if (baseline.timedOut) {
      result.verdict = 'timeout';
      result.detail = 'baseline がタイムアウト';
      return result;
    }
    if (!baseline.ok) {
      result.verdict = 'baseline_failing';
      result.detail = '変異前のテストが失敗';
      return result;
    }

    const mutant = neuterSource(originalSource);
    result.mutations = mutant.mutations;
    result.total = mutant.total;
    if (mutant.total === 0) {
      result.verdict = 'unmutatable';
      result.detail = '対象の判定語彙がなく検定不能';
      return result;
    }
    writeFileSync(copiedGate, mutant.source, 'utf8');

    const tested = await execute('mutantMs');
    if (tested.timedOut) {
      result.verdict = 'timeout';
      result.detail = 'mutant がタイムアウト';
      return result;
    }
    result.verdict = tested.ok ? 'survived' : 'killed';
    result.detail = tested.ok
      ? `無害化しても全テストが通る（${mutant.mutations
        .map(({ rule, count }) => `${rule}=${count}`).join(', ')}）`
      : '無害化した検出器をテストが検出';
    return result;
  } finally {
    // baseline の失敗やタイムアウト、変異不能も1回につき1行記録する。
    // 起動例外など判定自体を得られなかった場合は証跡を作らない。
    if (result.verdict !== null) appendLedger(ledgerPath, result, sha256);
    // 後片付けの失敗で本来の検定結果を失わない。
    try {
      rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // 削除できない場合でも結果を返す。
    }
  }
}

export function exitCodeFor(results) {
  if (results.some(({ verdict }) => verdict === 'survived')) return 2;
  if (results.some(({ verdict }) => verdict !== 'killed')) return 1;
  return 0;
}

async function main(args) {
  let toolsDir = path.dirname(fileURLToPath(import.meta.url));
  let rootDir;
  let timeoutMs = 120000;
  let ledgerPath = defaultLedgerPath();
  let json = false;
  let all = false;
  const gates = [];

  function valueAfter(index) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${args[index]} の値が必要です`);
    }
    return value;
  }

  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--gate': {
        const name = valueAfter(index++);
        if (!/^[\w-]+$/.test(name)) {
          throw new Error(`拡張子なしの検出器名を指定してください: ${name}`);
        }
        gates.push(name);
        break;
      }
      case '--all':
        all = true;
        break;
      case '--json':
        json = true;
        break;
      case '--tools-dir':
        toolsDir = path.resolve(valueAfter(index++));
        break;
      case '--root-dir':
        rootDir = path.resolve(valueAfter(index++));
        break;
      case '--ledger-path':
        ledgerPath = path.resolve(valueAfter(index++));
        break;
      case '--timeout':
        timeoutMs = Number(valueAfter(index++));
        break;
      default:
        throw new Error(`未知のオプション: ${args[index]}`);
    }
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout は正の整数で指定してください');
  }

  const names = new Set(gates);
  if (all || gates.length === 0) {
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/-(gate|guard|check)\.mjs$/.test(entry.name)) continue;
      const name = entry.name.slice(0, -4);
      const testPath = path.join(toolsDir, `${name}.test.mjs`);
      if (existsSync(testPath) && statSync(testPath).isFile()) names.add(name);
    }
  }

  const results = [];
  for (const name of [...names].sort()) {
    results.push(await checkOne({
      gatePath: path.join(toolsDir, `${name}.mjs`),
      testPath: path.join(toolsDir, `${name}.test.mjs`),
      toolsDir,
      rootDir,
      timeoutMs,
      ledgerPath,
    }));
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    const width = Math.max(24, ...results.map(({ name }) => name.length));
    const seconds = (ms) => ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`;
    for (const result of results) {
      process.stdout.write(
        `${result.verdict.padEnd(16)} ${result.name.padEnd(width)} ` +
        `${`mutations=${result.total}`.padEnd(15)} ` +
        `${`baseline=${seconds(result.baselineMs)}`.padEnd(16)} ` +
        `${`mutant=${seconds(result.mutantMs)}`.padEnd(14)} ${result.detail}\n`,
      );
    }
    const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
    process.stdout.write(
      `合計 ${results.length}件 / killed ${count('killed')} / survived ${count('survived')}` +
      ` / unmutatable ${count('unmutatable')} / baseline_failing ${count('baseline_failing')}` +
      ` / timeout ${count('timeout')}\n`,
    );
  }
  process.exitCode = exitCodeFor(results);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`control-group-check: ${String(error.message).replace(/[\r\n]+/g, ' ')}\n`);
    process.exitCode = 1;
  });
}
