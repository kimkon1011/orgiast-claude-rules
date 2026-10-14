import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// fleet 配布スコープの単一定義 tools/fleet-scope.json を検査する。
// 「~/.claude の設定を触るもの」と「PC に定時タスクを登録するもの」は
// そのPC固有の状態を作るので、配布先PCごとに converge が必要か(kim-PC だけで足りるか)を
// 明示しておかないと、片方のPCにだけ適用されて静かに壊れる。
// 検出条件は tools/fleet-scope.json の生成時と同一のものを使う（detectScopeTargets）。

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(toolsDir);
const scopePath = path.join(toolsDir, 'fleet-scope.json');

// --- 検出条件（生成側と同一） -------------------------------------------------
// (1) packages/ 直下の各ディレクトリ
// (2) tools/ 配下（再帰なし）のファイルで ~/.claude 直下の設定ファイルを読むもの
//     = 内容に '.claude' と、設定ファイル名のどれかが両方現れるもの
// (3) tools/ 配下で Register-ScheduledTask か schtasks を含むファイル
// *.test.mjs は除外する。
// 誤検出（設定名に言及しただけのドキュメント等）は許容し、その場合は
// fleet-scope.json 側で kim-only + 理由を書いて明示する。
const CLAUDE_CONFIG_NAMES = ['settings.json', 'settings.local.json', '.claude.json', 'CLAUDE.md', 'keybindings.json'];

export function readsClaudeConfig(source) {
  return source.includes('.claude') && CLAUDE_CONFIG_NAMES.some((name) => source.includes(name));
}

export function registersScheduledTask(source) {
  return /Register-ScheduledTask|schtasks/.test(source);
}

export function isExcluded(name) {
  return name.endsWith('.test.mjs');
}

export function detectScopeTargets(root = repoRoot) {
  const tools = path.join(root, 'tools');
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(`packages/${entry.name}`);
  }
  for (const entry of fs.readdirSync(tools, { withFileTypes: true })) {
    if (!entry.isFile() || isExcluded(entry.name)) continue;
    const source = fs.readFileSync(path.join(tools, entry.name), 'utf8');
    if (readsClaudeConfig(source) || registersScheduledTask(source)) found.push(`tools/${entry.name}`);
  }
  return found.sort();
}

// --- converge ステップ id の抽出 ---------------------------------------------
// setup.mjs の converge ステップ id は
//   a) setup.mjs 中の `{ id: '...' }` リテラル（classifier-settings / mobile-standby 等）
//   b) setup.mjs が loadManifest() で読む tools/setup-manifest.json の items[].id
// の 2 系統。setup.mjs 側の定義形式に合わせて両方を抽出する。
export function convergeStepIds(root = repoRoot) {
  const tools = path.join(root, 'tools');
  const source = fs.readFileSync(path.join(tools, 'setup.mjs'), 'utf8');
  const ids = new Set();
  for (const match of source.matchAll(/id:\s*'([^']+)'/g)) ids.add(match[1]);
  const manifest = JSON.parse(fs.readFileSync(path.join(tools, 'setup-manifest.json'), 'utf8'));
  for (const item of manifest.items ?? []) ids.add(item.id);
  return ids;
}

const readScope = () => JSON.parse(fs.readFileSync(scopePath, 'utf8'));

test('(a) fleet-scope.json は version 1 と entries 配列を持ち、各項目の形が正しい', () => {
  const scope = readScope();
  assert.equal(scope.version, 1, 'version は 1');
  assert.ok(Array.isArray(scope.entries) && scope.entries.length > 0, 'entries は非空配列');
  for (const entry of scope.entries) {
    assert.equal(typeof entry.path, 'string', `path は文字列: ${JSON.stringify(entry)}`);
    assert.ok(['fleet', 'kim-only'].includes(entry.scope), `scope は fleet|kim-only: ${entry.path}`);
    if (entry.scope === 'fleet') {
      assert.equal(typeof entry.step, 'string', `fleet は step 必須: ${entry.path}`);
      assert.ok(entry.step.length > 0, `fleet の step は非空: ${entry.path}`);
    } else {
      assert.equal(typeof entry.reason, 'string', `kim-only は reason 必須: ${entry.path}`);
      assert.ok(entry.reason.length > 0, `kim-only の reason は非空: ${entry.path}`);
    }
  }
});

test('(b) path は一意で、リポジトリ内に実在する', () => {
  const entries = readScope().entries;
  const paths = entries.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, `path が重複している: ${paths.join(', ')}`);
  const missing = paths.filter((p) => !fs.existsSync(path.join(repoRoot, p)));
  assert.deepEqual(missing, [], `実在しない path:\n${missing.join('\n')}`);
});

test('(c) 検出したファイルが漏れなく fleet-scope.json に載っている', () => {
  const listed = new Set(readScope().entries.map((e) => e.path));
  const undecided = detectScopeTargets().filter((p) => !listed.has(p));
  assert.deepEqual(
    undecided,
    [],
    `fleet-scope.json に未登録の検出対象:\n${undecided.join('\n')}\n` +
      'tools/fleet-scope.json に scope(fleet|kim-only) を明示してください（判別不能なら kim-only + reason "要確認"）',
  );
});

test('(d) fleet の step は tools/setup.mjs の converge ステップに実在する', () => {
  const steps = convergeStepIds();
  assert.ok(steps.size > 0, 'converge ステップ id を 1 件も抽出できていない（抽出方法が壊れている）');
  const bad = readScope()
    .entries.filter((e) => e.scope === 'fleet' && !steps.has(e.step))
    .map((e) => `${e.path} -> ${e.step}`);
  assert.deepEqual(bad, [], `setup.mjs に実在しない step:\n${bad.join('\n')}`);
});

test('(e) kim-only には理由が書かれている（判別不能は "要確認"）', () => {
  const noReason = readScope()
    .entries.filter((e) => e.scope === 'kim-only' && !String(e.reason ?? '').trim())
    .map((e) => e.path);
  assert.deepEqual(noReason, [], `reason が空の kim-only:\n${noReason.join('\n')}`);
});

test('(f) 指定されたスコープ: vscode-next-session は fleet/mobile-standby', () => {
  const entry = readScope().entries.find((e) => e.path === 'packages/vscode-next-session');
  assert.ok(entry, 'packages/vscode-next-session が fleet-scope.json に無い');
  assert.equal(entry.scope, 'fleet');
  assert.equal(entry.step, 'mobile-standby');
  assert.ok(convergeStepIds().has('mobile-standby'), 'setup.mjs に mobile-standby ステップが無い');
});

for (const entrypoint of ['tools/fleet-question-relay.mjs', 'tools/lib/fleet-mail-discord.mjs', 'tools/fleet-inbox-context.mjs', 'tools/fleet-mail-watchdog.mjs']) {
  test(`D8 fleet scope covers the complete import graph of ${entrypoint}`, () => {
    const scope = new Map(readScope().entries.map(entry => [entry.path, entry]));
    const visited = new Set();
    function visit(file) {
      if (visited.has(file)) return;
      visited.add(file);
      assert.equal(scope.get(file)?.scope, 'fleet', `runtime dependency: ${file}`);
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      // Includes static imports/re-exports, side-effect imports and literal dynamic imports.
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        assert.ok(fs.existsSync(path.join(repoRoot, dependency)), `missing dependency: ${dependency}`);
        visit(dependency);
      }
    }
    visit(entrypoint);
    assert.ok(visited.size > 1);
  });
}
