#!/usr/bin/env node
// 互換ラッパー: 正本は tools/feedback-kit/widget/install.mjs（tools/ は全PCへ配布される。packages/ は配布されない）。
// 旧パスで呼ばれても同じ引数で委譲する。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const target = fileURLToPath(new URL('../../tools/feedback-kit/widget/install.mjs', import.meta.url));
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
