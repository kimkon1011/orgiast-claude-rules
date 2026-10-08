#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

export function directiveId(kind, date = new Date(), randomInt = (max) => crypto.randomInt(max)) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${kind}-${stamp}-${String(randomInt(10_000)).padStart(4, '0')}`;
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function pruneDirectives(directives, now = Date.now()) {
  return directives.filter((item) => !item.processed && !item.processedAt && (!item.expiresAt || Date.parse(item.expiresAt) >= now));
}

export function main(argv = process.argv.slice(2), options = {}) {
  const repo = options.repo || path.resolve(import.meta.dirname, '..');
  const file = path.join(repo, 'fleet-directives.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  parsed.directives = pruneDirectives(Array.isArray(parsed.directives) ? parsed.directives : []);
  if (argv.includes('--prune') && !valueAfter(argv, '--kind')) {
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
    return { pruned: true };
  }
  const kind = valueAfter(argv, '--kind');
  const targets = valueAfter(argv, '--targets') ?? 'all';
  const why = valueAfter(argv, '--why');
  if (!why) throw new Error('--why は必須です（遠隔指示の理由を指定してください）');
  if (!['status', 'prompt', 'enable-auto-session', 'run'].includes(kind)) throw new Error('--kind は status / prompt / enable-auto-session / run のいずれかです');
  const task = valueAfter(argv, '--task');
  if (kind === 'run' && !['fleet-sheet-report', 'cost-self-heal'].includes(task)) throw new Error('run の --task は fleet-sheet-report / cost-self-heal のいずれかです');
  const bodyFile = valueAfter(argv, '--body-file');
  if (kind === 'prompt' && !bodyFile) throw new Error('prompt は --body-file で本文ファイルを指定してください');
  const createdAt = new Date();
  const directive = { id: directiveId(kind, createdAt, options.randomInt), kind, targets, why };
  if (kind === 'run') directive.task = task;
  if (bodyFile) directive.body = fs.readFileSync(path.resolve(bodyFile), 'utf8').replace(/^\uFEFF/, '');
  const cwd = valueAfter(argv, '--cwd');
  if (cwd) directive.cwd = cwd;
  directive.createdBy = valueAfter(argv, '--created-by') || process.env.USER || process.env.USERNAME || 'unknown';
  directive.createdAt = createdAt.toISOString();
  const expiresHours = Number(valueAfter(argv, '--expires-hours'));
  if (Number.isFinite(expiresHours) && expiresHours > 0) directive.expiresAt = new Date(createdAt.getTime() + expiresHours * 3_600_000).toISOString();
  const timeoutSeconds = Number(valueAfter(argv, '--timeout-seconds'));
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) directive.timeoutSeconds = timeoutSeconds;
  parsed.directives.push(directive);
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  if (argv.includes('--push')) {
    // shell:true + 引数結合はメッセージの引用符が消えて DEP0190 警告も出るため、
    // 1コマンドずつ引数配列で実行する。
    const run = (args) => (options.spawnSync || spawnSync)('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    const add = run(['add', 'fleet-directives.json']);
    const commit = run(['commit', '-m', `fleet: add directive ${directive.id}`]);
    if (add.status !== 0 || commit.status !== 0) throw new Error(`git commit failed: ${(commit.stderr || commit.stdout || add.stderr || '').slice(0, 400)}`);
    // 夜間実行ツリー(nightly-repo)は bootstrap が意図的に detach させるため、refspec 無しの
    // `git push` は「not currently on a branch」で必ず落ちる。detached のときは HEAD:main を明示する。
    const onBranch = run(['symbolic-ref', '--quiet', 'HEAD']);
    const push = onBranch.status === 0 ? run(['push']) : run(['push', 'origin', 'HEAD:main']);
    if (push.status !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).slice(0, 400)}`);
  }
  console.log(directive.id);
  return directive;
}

if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
