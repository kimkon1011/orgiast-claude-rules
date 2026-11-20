import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DISTRIBUTION, deployAgents, loadDistribution } from './onboarding-sync.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('新規 home に Haiku 4.5 の Explore を配布する', t => {
  const home = tempDir(t);
  assert.deepEqual(deployAgents(repo, home, { quiet: true }), ['Explore.md']);
  const deployed = fs.readFileSync(path.join(home, '.claude', 'agents', 'Explore.md'), 'utf8');
  assert.match(deployed, /^model: claude-haiku-4-5\r?$/m);
});

test('許可リスト外のエージェントを配布せず既存ファイルを保持する', t => {
  const home = tempDir(t);
  const source = path.join(tempDir(t), 'agents');
  const target = path.join(home, '.claude', 'agents');
  fs.mkdirSync(source);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(repo, 'agents', 'Explore.md'), path.join(source, 'Explore.md'));
  fs.writeFileSync(path.join(source, 'Implementer.md'), 'implementer');
  fs.writeFileSync(path.join(source, 'biz-reader.md'), 'distributed biz-reader');
  fs.writeFileSync(path.join(target, 'biz-reader.md'), 'local biz-reader');

  assert.deepEqual(deployAgents(path.dirname(source), home, { quiet: true }), ['Explore.md']);
  assert.deepEqual(fs.readdirSync(target).sort(), ['Explore.md', 'biz-reader.md']);
  assert.equal(fs.readFileSync(path.join(target, 'biz-reader.md'), 'utf8'), 'local biz-reader');
});

test('同じ内容なら書き込まず、変更時は旧版をバックアップする', t => {
  const home = tempDir(t);
  const target = path.join(home, '.claude', 'agents');
  const explore = path.join(target, 'Explore.md');
  const options = { now: new Date('2026-11-20T01:02:03Z'), quiet: true };
  const original = 'local Explore';
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(explore, original);
  assert.deepEqual(deployAgents(repo, home, options), ['Explore.md']);
  const backup = 'Explore.md.bak.20261120-010203';
  assert.equal(fs.readFileSync(path.join(target, backup), 'utf8'), original);
  assert.deepEqual(fs.readFileSync(explore), fs.readFileSync(path.join(repo, 'agents', 'Explore.md')));

  fs.utimesSync(explore, options.now, options.now);
  const mtime = fs.statSync(explore).mtimeMs;
  assert.deepEqual(deployAgents(repo, home, options), []);
  assert.equal(fs.statSync(explore).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(target).sort(), ['Explore.md', backup]);
  assert.equal(fs.readFileSync(path.join(target, backup), 'utf8'), original);

  fs.writeFileSync(explore, 'second local version');
  assert.deepEqual(deployAgents(repo, home, options), ['Explore.md']);
  assert.equal(fs.readFileSync(path.join(target, backup), 'utf8'), original);
  const secondBackup = fs.readdirSync(target).find(name => name.startsWith(`${backup}.`));
  assert.ok(secondBackup);
  assert.equal(fs.readFileSync(path.join(target, secondBackup), 'utf8'), 'second local version');
});

test('配布用とリポジトリ内の Explore 定義が一致する', () => {
  assert.deepEqual(fs.readFileSync(path.join(repo, 'agents', 'Explore.md')),
    fs.readFileSync(path.join(repo, '.claude', 'agents', 'Explore.md')));
});

test('zip 配布のマニフェストと組み込み既定に agents が含まれる', () => {
  assert.ok(loadDistribution(repo).dirs.includes('agents'));
  assert.ok(DEFAULT_DISTRIBUTION.dirs.includes('agents'));
});

test('配布後も cost-enforce の block モードでは model 未指定の Explore を拒否する', t => {
  const home = tempDir(t);
  assert.deepEqual(deployAgents(repo, home, { quiet: true }), ['Explore.md']);
  fs.writeFileSync(path.join(home, '.claude', 'cost-enforce.json'), JSON.stringify({ mode: 'block' }));
  const result = spawnSync(process.execPath, [path.join(repo, 'tools', 'model-agent-guard.mjs')], {
    input: JSON.stringify({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: '設定を調査して' },
    }),
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home },
    cwd: repo,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
