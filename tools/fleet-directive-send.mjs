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
  if (!['status', 'prompt', 'enable-auto-session'].includes(kind)) throw new Error('--kind は status / prompt / enable-auto-session のいずれかです');
  const bodyFile = valueAfter(argv, '--body-file');
  if (kind === 'prompt' && !bodyFile) throw new Error('prompt は --body-file で本文ファイルを指定してください');
  const createdAt = new Date();
  const directive = { id: directiveId(kind, createdAt, options.randomInt), kind, targets, why };
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
    const result = (options.spawnSync || spawnSync)('git', ['add', 'fleet-directives.json', '&&', 'git', 'commit', '-m', `fleet: add directive ${directive.id}`, '&&', 'git', 'push'], { cwd: repo, encoding: 'utf8', shell: true, windowsHide: true });
    if (result.status !== 0) throw new Error(`git push failed: ${result.stderr || result.stdout}`);
  }
  console.log(directive.id);
  return directive;
}

if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
