import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getSyncedRepoRoot, resolveRegisterRepoRoot, resolveRegisterToolsDir } from './resolve-synced-repo.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));

function fakeSyncedRepo(name, files) {
  const root = mkdtempSync(join(tmpdir(), `synced-repo-mjs-${name}-`));
  for (const relative of files) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '# fixture\n', 'utf8');
  }
  return root;
}

function collectWarnings() {
  const warnings = [];
  return { warn: (message) => warnings.push(message), warnings };
}

test('ORGIAST_NIGHTLY_REPO が最優先で、無ければ nightly-bootstrap の同期先を返す', () => {
  const override = resolve(tmpdir(), 'explicit-nightly-repo');
  assert.equal(getSyncedRepoRoot({ env: { ORGIAST_NIGHTLY_REPO: override } }), override);
  assert.equal(
    getSyncedRepoRoot({ env: { USERPROFILE: 'C:\\Users\\someone' } }),
    resolve('C:\\Users\\someone', '.claude', 'nightly-repo'),
  );
});

test('タスクが実行するファイルが揃っていれば同期先を返す', () => {
  const synced = fakeSyncedRepo('present', [join('tools', 'process-hygiene.mjs')]);
  const { warn, warnings } = collectWarnings();
  const root = resolveRegisterRepoRoot({
    fallback: 'C:\\stale\\repo',
    requiredPaths: [join('tools', 'process-hygiene.mjs')],
    env: { ORGIAST_NIGHTLY_REPO: synced },
    warn,
  });
  assert.equal(root, resolve(synced));
  assert.deepEqual(warnings, []);
});

test('同期先にスクリプトが無ければ、警告してから実行ツリーへ戻る', () => {
  const synced = fakeSyncedRepo('missing', [join('tools', 'other.mjs')]);
  const { warn, warnings } = collectWarnings();
  const root = resolveRegisterRepoRoot({
    fallback: 'C:\\stale\\repo',
    requiredPaths: [join('tools', 'process-hygiene.mjs')],
    env: { ORGIAST_NIGHTLY_REPO: synced },
    warn,
  });
  assert.equal(root, resolve('C:\\stale\\repo'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /にありません/);
});

test('同期先そのものが無ければ、警告してから実行ツリーへ戻る', () => {
  const { warn, warnings } = collectWarnings();
  const root = resolveRegisterRepoRoot({
    fallback: 'C:\\stale\\repo',
    env: { ORGIAST_NIGHTLY_REPO: join(tmpdir(), 'synced-repo-that-does-not-exist') },
    warn,
  });
  assert.equal(root, resolve('C:\\stale\\repo'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /見つかりません/);
});

test('同期先と実行ツリーが同一なら、存在確認も警告もせずそのまま返す', () => {
  const { warn, warnings } = collectWarnings();
  const root = resolveRegisterRepoRoot({
    fallback: 'C:\\Users\\someone\\.claude\\nightly-repo',
    requiredPaths: [join('tools', 'never-checked.mjs')],
    env: { ORGIAST_NIGHTLY_REPO: 'C:\\Users\\someone\\.claude\\nightly-repo' },
    warn,
  });
  assert.equal(root, resolve('C:\\Users\\someone\\.claude\\nightly-repo'));
  assert.deepEqual(warnings, []);
});

test('tools ディレクトリ版は同期先の tools を指し、fallback 時は呼び出し元の tools を保つ', () => {
  const synced = fakeSyncedRepo('toolsdir', [join('tools', 'process-hygiene.mjs')]);
  assert.equal(
    resolveRegisterToolsDir({
      fallback: 'C:\\stale\\repo\\tools',
      requiredLeaves: ['process-hygiene.mjs'],
      env: { ORGIAST_NIGHTLY_REPO: synced },
      warn: () => {},
    }),
    join(resolve(synced), 'tools'),
  );
  assert.equal(
    resolveRegisterToolsDir({
      fallback: 'C:\\stale\\repo\\tools',
      requiredLeaves: ['not-synced-yet.mjs'],
      env: { ORGIAST_NIGHTLY_REPO: synced },
      warn: () => {},
    }),
    resolve('C:\\stale\\repo\\tools'),
  );
});

// 静的な半分。resolve-synced-repo.test.mjs の同種の検査は register-*.ps1 しか走査しないので、
// .mjs 側の新しい register スクリプトがヘルパーを忘れるとここで落とす。忘れても実行時には
// 何も言わないまま「誰も同期しないツリー」に固定されるのが、この不具合の本体だった。
function registerScripts() {
  return readdirSync(toolsDir)
    .filter((name) => /^register-.*\.mjs$/.test(name) && !name.endsWith('.test.mjs'))
    .map((name) => ({ name, source: readFileSync(join(toolsDir, name), 'utf8') }))
    .filter(({ source }) => /registerHourlyTask|Register-ScheduledTask|schtasks/.test(source));
}

test('定時タスクを登録する .mjs は必ずヘルパー経由でリポジトリを解決する', () => {
  const scripts = registerScripts();
  assert.ok(scripts.length >= 1, `register-*.mjs が見つかりません (${scripts.length})`);
  for (const { name, source } of scripts) {
    assert.match(source, /resolve-synced-repo\.mjs/, `${name} がリゾルバを import していません`);
    assert.match(source, /resolveRegister(RepoRoot|ToolsDir)/, `${name} がリゾルバを呼んでいません`);
  }
});

test('定時タスクを登録する .mjs は自分の置き場所を repo に焼き込まない', () => {
  for (const { name, source } of registerScripts()) {
    assert.doesNotMatch(
      source,
      /(?:const|let|var)\s+repo\s*=\s*[^\n]*import\.meta\.url/,
      `${name} が自分の位置から repo を決めています`,
    );
  }
});
