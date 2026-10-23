#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutopilot } from '../../tools/autopilot-tick.mjs';
const setup = path.dirname(fileURLToPath(import.meta.url));
const home = path.join(setup, 'verification/preview-home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
for (const name of ['autopilot-owner.json', 'waiting-on-user.json']) fs.copyFileSync(path.join(setup, name), path.join(home, '.claude', name));
const options = { home, dir: path.join(home, '.claude/autopilot'), now: new Date('2026-10-23T03:00:00+09:00'), token: '' };
// A synthetic objective keeps private production state out of the review artifact.
const started = await runAutopilot('start', { objective: 'autopilot 定時報告の確認' }, options);
if (started.error && started.error !== 'already_running') throw new Error(started.error);
const result = await runAutopilot('digest', { 'dry-run': true }, options);
if (!result.dryRun) throw new Error(JSON.stringify(result));
fs.writeFileSync(path.join(setup, 'verification/digest-sample.md'), result.text + '\n', 'utf8');
console.log(result.text);
