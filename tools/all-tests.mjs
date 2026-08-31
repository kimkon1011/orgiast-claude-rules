import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter(x => x.endsWith('.test.mjs')).sort().map(x => path.join(dir, x));
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: childEnv });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
