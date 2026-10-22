// rescue/* ブランチのうち「本当に人間のレビューが必要なもの」だけを列挙する読み取り専用スキャナ。
// main に取り込み済み(covered)・他枝と同一変更(duplicate)を除外し、unique だけを残す。
// git cherry で、枝を切った後に main へ取り込まれた変更も covered と判定する。
// ネットワークアクセスなし・ファイル書き込みなし(git の読み取りのみ)。
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// spawnSync の既定 maxBuffer(1MB)を超える差分でも ENOBUFS で分類を落とさないための上限。
// 実測: origin の sync-orgiast-main-* は origin/main との three-dot 差分が約 90MB。
// 枝は順次処理するのでピークは1枝分に収まる。
const MAX_GIT_STDOUT_BYTES = 256 * 1024 * 1024;

// git の既定実装。dir で git を実行し stdout を返す。失敗時は例外を投げる。
function defaultGit(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: MAX_GIT_STDOUT_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const firstLine = (result.stderr || result.stdout || '').trim().split('\n')[0];
    throw new Error(firstLine || `git ${args.join(' ')} failed (status ${result.status})`);
  }
  return result.stdout;
}

function fingerprintOf(patch) {
  return crypto.createHash('sha256').update(patch).digest('hex');
}

// --numstat 出力から files/added/deleted を集計。binary 行("-" "-")は files にのみ数える。
function sumNumstat(text) {
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    files += 1;
    const [a, d] = line.split('\t');
    if (/^\d+$/.test(a)) added += Number(a);
    if (/^\d+$/.test(d)) deleted += Number(d);
  }
  return { files, added, deleted };
}

// 差分の全ファイルが main 側の .gitignore 対象なら、その一覧を返す。
// check-ignore は一致なしを exit 1 で返すため、失敗時は判定不能として null にする。
function ignoredOnlyFiles({ git, dir, main, branch }) {
  let names;
  let ignored;
  try {
    names = git(dir, ['diff', '--name-only', `${main}...${branch}`])
      .split(/\r?\n/)
      .map(name => name.trim())
      .filter(Boolean);
    if (names.length === 0) return null;
    ignored = new Set(git(dir, ['check-ignore', '--', ...names])
      .split(/\r?\n/)
      .map(name => name.trim())
      .filter(Boolean));
  } catch {
    return null;
  }
  return names.every(name => ignored.has(name)) ? { names } : null;
}

// rescue ブランチ名を昇順で列挙する。
function listBranches(git, repo, includeRemote) {
  const patterns = ['refs/heads/rescue/'];
  if (includeRemote) patterns.push('refs/remotes/origin/rescue/');
  const seen = new Set();
  const names = [];
  for (const pattern of patterns) {
    const out = git(repo, ['for-each-ref', '--format=%(refname:short)', pattern]);
    for (const line of String(out).split('\n')) {
      const name = line.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names.sort();
}

// rescue 枝かどうか(ローカル名 rescue/x と origin/rescue/x の両方を拾う)。
function isRescueName(name) {
  return /(^|\/)rescue\//.test(name);
}

// 照合先(非 rescue)の ref 名を昇順で列挙する。main 自身は差分が空になるので実質除外される。
function listCompareRefs(git, repo, patterns) {
  const seen = new Set();
  const names = [];
  for (const pattern of patterns) {
    const out = git(repo, ['for-each-ref', '--format=%(refname:short)', pattern]);
    for (const line of String(out).split('\n')) {
      const name = line.trim();
      if (!name || seen.has(name) || isRescueName(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names.sort();
}

// 照合先 ref の three-dot 差分を指紋化し「指紋 → 先頭 ref」の対応を作る。
// 空差分(main の祖先など)は載せない。1 本の diff 失敗はその ref を飛ばすだけに留める。
function fingerprintMapForRefs({ git, dir, main, refs }) {
  const map = new Map();
  for (const ref of refs) {
    let patch;
    try {
      patch = git(dir, ['diff', `${main}...${ref}`]);
    } catch {
      continue;
    }
    if (patch === '') continue;
    const fingerprint = fingerprintOf(patch);
    if (!map.has(fingerprint)) map.set(fingerprint, ref);
  }
  return map;
}

// パッチを再利用し、全変更ファイルの追加・削除行を main と逐語比較する。
function coverageInMain({ git, dir, main, patch, files }) {
  const changes = [];
  let current;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ b/')) {
      current = { file: line.slice(6), added: [], deleted: [] };
      changes.push(current);
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (inHunk && current && (line[0] === '+' || line[0] === '-')) {
      const text = line.slice(1).trim();
      if (text) current[line[0] === '+' ? 'added' : 'deleted'].push(text);
    }
  }
  // 削除ファイルや binary 等、全ファイルを照合できなければ判定しない。
  if (changes.length !== files) return null;
  let addedLines = 0;
  let addedInMain = 0;
  let deletedLines = 0;
  let deletedStillInMain = 0;
  for (const change of changes) {
    let lines;
    try {
      lines = new Set(git(dir, ['show', `${main}:${change.file}`]).split('\n').map(line => line.trim()));
    } catch {
      return null;
    }
    addedLines += change.added.length;
    addedInMain += change.added.filter(line => lines.has(line)).length;
    deletedLines += change.deleted.length;
    deletedStillInMain += change.deleted.filter(line => lines.has(line)).length;
  }
  if (!addedLines) return null;
  const addedRatio = addedInMain / addedLines;
  const deletedStillInMainRatio = deletedLines ? deletedStillInMain / deletedLines : 0;
  return addedRatio >= 0.8 && deletedStillInMainRatio <= 0.2
    ? { addedRatio, deletedStillInMainRatio, addedLines, addedInMain, deletedLines, deletedStillInMain }
    : null;
}

export function scanRescueBranches({
  repo,
  main = 'origin/main',
  includeRemote = false,
  compareRefs = ['refs/heads/', 'refs/remotes/origin/'],
  ignoreCheck = true,
  git = defaultGit,
} = {}) {
  const dir = repo || '.';
  // 重複判定はブランチ名昇順で「先に出現した方」を正とする。
  const branches = listBranches(git, dir, includeRemote);
  // 別名の枝(feat/*, fix/* 等)に同一の変更が保全されている rescue 枝は、人間が独立に
  // レビューすべき対象ではないので covered-by-branch に落とす。
  let coveredByFingerprint = new Map();
  if (compareRefs && compareRefs.length > 0) {
    try {
      coveredByFingerprint = fingerprintMapForRefs({ git, dir, main, refs: listCompareRefs(git, dir, compareRefs) });
    } catch {
      coveredByFingerprint = new Map();
    }
  }
  const firstByFingerprint = new Map();
  const results = [];
  for (const branch of branches) {
    let patch;
    let numstat;
    try {
      // three-dot で branch 自身の変更のみを取る。
      patch = git(dir, ['diff', `${main}...${branch}`]);
      numstat = git(dir, ['diff', '--numstat', `${main}...${branch}`]);
    } catch (err) {
      const message = String(err && err.message ? err.message : err).split('\n')[0];
      results.push({ branch, files: 0, added: 0, deleted: 0, fingerprint: null, status: 'error', error: message });
      continue;
    }
    const { files, added, deleted } = sumNumstat(numstat);
    const fingerprint = fingerprintOf(patch);
    if (patch === '') {
      results.push({ branch, files, added, deleted, fingerprint, status: 'covered', reason: 'no-commits' });
      continue;
    }
    let alreadyUpstream = false;
    try {
      const lines = git(dir, ['cherry', main, branch]).split(/\r?\n/).filter(line => line.trim() !== '');
      alreadyUpstream = lines.length > 0 && lines.every(line => line.startsWith('- '));
    } catch {
      // 判定不能なら既存の分類にフォールバックし、レビュー対象を残す。
    }
    if (alreadyUpstream) {
      results.push({ branch, files, added, deleted, fingerprint, status: 'covered', reason: 'already-upstream' });
      continue;
    }
    if (ignoreCheck) {
      const ignored = ignoredOnlyFiles({ git, dir, main, branch });
      if (ignored) {
        results.push({ branch, files, added, deleted, fingerprint, status: 'ignored-only', ignoredFiles: ignored.names });
        continue;
      }
    }
    if (firstByFingerprint.has(fingerprint)) {
      results.push({ branch, files, added, deleted, fingerprint, status: 'duplicate', duplicateOf: firstByFingerprint.get(fingerprint) });
      continue;
    }
    firstByFingerprint.set(fingerprint, branch);
    const coveredBy = coveredByFingerprint.get(fingerprint);
    if (coveredBy) {
      results.push({ branch, files, added, deleted, fingerprint, status: 'covered-by-branch', coveredBy });
    } else {
      const coveredInMain = coverageInMain({ git, dir, main, patch, files });
      results.push({ branch, files, added, deleted, fingerprint, status: coveredInMain ? 'covered-in-main' : 'unique', ...(coveredInMain ? { coveredInMain } : {}) });
    }
  }
  results.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
  return results;
}

function summarize(branches) {
  const summary = { unique: 0, duplicate: 0, covered: 0, coveredByBranch: 0, coveredInMain: 0, error: 0, ignoredOnly: 0, total: branches.length };
  for (const b of branches) {
    if (b.status === 'covered-in-main') summary.coveredInMain += 1;
    else if (b.status === 'covered-by-branch') summary.coveredByBranch += 1;
    else if (b.status === 'ignored-only') summary.ignoredOnly += 1;
    else if (Object.prototype.hasOwnProperty.call(summary, b.status)) summary[b.status] += 1;
  }
  return summary;
}

function parseArgs(argv) {
  const opts = {
    repo: '.',
    main: 'origin/main',
    includeRemote: false,
    json: false,
    compareRefs: ['refs/heads/', 'refs/remotes/origin/'],
    ignoreCheck: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[i + 1];
    else if (a === '--main') opts.main = argv[i + 1];
    else if (a === '--include-remote') opts.includeRemote = true;
    else if (a === '--compare-refs') opts.compareRefs.push(argv[i + 1]);
    else if (a === '--no-compare-refs') opts.compareRefs = [];
    else if (a === '--no-ignore-check') opts.ignoreCheck = false;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function formatLine(b) {
  const base = `${b.status}\t${b.branch}\t${b.files}\t${b.added}+/${b.deleted}-`;
  if (b.status === 'duplicate' && b.duplicateOf) return `${base}\t(duplicate of ${b.duplicateOf})`;
  if (b.status === 'covered-by-branch' && b.coveredBy) return `${base}\t(covered by ${b.coveredBy})`;
  if (b.status === 'ignored-only') return `${base}\t(all ${b.ignoredFiles.length} file(s) gitignored)`;
  if (b.status === 'covered-in-main') {
    const c = b.coveredInMain;
    return `${base}\t(added ${c.addedInMain}/${c.addedLines} in main, deleted ${c.deletedStillInMain}/${c.deletedLines} still in main)`;
  }
  if (b.status === 'error' && b.error) return `${base}\t(${b.error})`;
  return base;
}

function run(argv) {
  const opts = parseArgs(argv);
  let branches;
  try {
    branches = scanRescueBranches({
      repo: opts.repo,
      main: opts.main,
      includeRemote: opts.includeRemote,
      compareRefs: opts.compareRefs,
      ignoreCheck: opts.ignoreCheck,
    });
  } catch (err) {
    process.stderr.write(`rescue-review-scan: ${err && err.message ? err.message : err}\n`);
    return;
  }
  const summary = summarize(branches);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ repo: opts.repo, main: opts.main, summary, branches }, null, 2)}\n`);
    return;
  }
  const lines = [
    `unique: ${summary.unique} / duplicate: ${summary.duplicate} / covered: ${summary.covered} / covered-by-branch: ${summary.coveredByBranch} / covered-in-main: ${summary.coveredInMain} / error: ${summary.error} / ignored-only: ${summary.ignoredOnly}`,
  ];
  for (const b of branches) lines.push(formatLine(b));
  process.stdout.write(`${lines.join('\n')}\n`);
}

// CLI 直接実行時のみ run する。
// 手組みの file:// 剥がしは POSIX で先頭スラッシュまで削れて path.resolve が cwd 相対になり、
// 常に「メインモジュールでない」と誤判定して無言で何も出力しなくなる。
function isMainModule() {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? self.toLowerCase() === invoked.toLowerCase()
    : self === invoked;
}

if (isMainModule()) {
  run(process.argv.slice(2));
  process.exitCode = 0;
}
