import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { defaultLedgerPath } from './control-group-check.mjs';

// -z で空白・日本語・改行を含むパスを Git の引用表現なしで取得する。
// --untracked-files=all により、新規ディレクトリ内の未追跡ファイルも列挙する。
export function listGitChangedFiles(cwd, runGit = spawnSync) {
  const result = runGit('git', [
    '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('git status を取得できません');

  const records = result.stdout.split('\0');
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    // porcelain -z の rename/copy は変更先、変更元の順で並ぶ。
    const filename = record.slice(3);
    if (/[RC]/.test(status)) index += 1;
    // 削除済みの検出器は検定できない。
    if (status.includes('D')) continue;
    if (filename) files.push(filename);
  }
  return files;
}

function parseLedger(ledgerLines) {
  const lines = Array.isArray(ledgerLines)
    ? ledgerLines
    : typeof ledgerLines === 'string' ? ledgerLines.split(/\r?\n/) : [];
  const records = [];
  for (const line of lines) {
    // 途中で切れた1行があっても、ほかの正常な証跡は利用する。
    try {
      const record = typeof line === 'string' ? JSON.parse(line) : line;
      if (
        record &&
        typeof record.name === 'string' &&
        typeof record.sha256 === 'string' &&
        typeof record.verdict === 'string'
      ) records.push(record);
    } catch {}
  }
  return records;
}

// ファイル操作と変更一覧の取得は、呼び出し元から注入する。
// 同じ入力と注入結果に対して同じ判定を返し、台帳などへの書き込みはしない。
export function evaluateControlGroup({
  cwd,
  ledgerLines = [],
  listChangedFiles,
  readFile,
  existsFile,
} = {}) {
  try {
    if (typeof cwd !== 'string' || !cwd) return { decision: 'pass' };
    const changed = listChangedFiles(cwd);
    if (!Array.isArray(changed)) return { decision: 'pass' };
    const ledger = parseLedger(ledgerLines);
    const missing = [];

    for (const filename of new Set(changed)) {
      if (typeof filename !== 'string') continue;
      if (!/-(gate|guard|check)\.mjs$/.test(path.basename(filename))) continue;
      const gatePath = path.resolve(cwd, filename);
      const testPath = gatePath.replace(/\.mjs$/, '.test.mjs');
      if (!existsFile(testPath)) continue;

      const name = path.basename(gatePath, '.mjs');
      const source = readFile(gatePath, 'utf8');
      const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
      const matching = ledger.filter((record) =>
        record.name === name && record.sha256 === sha256);
      if (matching.some((record) => record.verdict === 'killed')) continue;

      let detail = '現在のソースに一致する killed の記録がなく、未検定';
      if (matching.some((record) => record.verdict === 'survived')) {
        detail = '検定したがテストに検出力が無い。落ちるべき入力で落ちることを1件足せ';
      } else if (matching.some((record) => record.verdict === 'unmutatable')) {
        detail = '検定したが現在の変異ルールでは検定できない（unmutatable）';
      } else if (matching.some((record) => record.verdict === 'baseline_failing')) {
        detail = '変異前のテストが失敗しており、検定できない（baseline_failing）';
      } else if (matching.some((record) => record.verdict === 'timeout')) {
        detail = 'タイムアウトにより検定できない（timeout）';
      }
      missing.push(
        `${name}: ${detail}。実行すべきコマンド: node tools/control-group-check.mjs --gate ${name}`,
      );
    }

    return missing.length
      ? { decision: 'block', reason: `[CONTROL-GROUP] ${missing.join('\n')}` }
      : { decision: 'pass' };
  } catch {
    // Git やファイルの読み取り異常で Stop 全体を壊さない。
    return { decision: 'pass' };
  }
}

// Stop ランナー用の I/O 境界。テストでは各副作用を差し替えられる。
export function runControlGroup({
  cwd,
  ledgerPath = defaultLedgerPath(),
  listChangedFiles = listGitChangedFiles,
  readFile = readFileSync,
  existsFile = existsSync,
} = {}) {
  try {
    if (typeof cwd !== 'string' || !cwd) return { decision: 'pass' };
    const ledgerLines = existsFile(ledgerPath) ? readFile(ledgerPath, 'utf8') : [];
    return evaluateControlGroup({
      cwd,
      ledgerLines,
      listChangedFiles,
      readFile,
      existsFile,
    });
  } catch {
    return { decision: 'pass' };
  }
}
