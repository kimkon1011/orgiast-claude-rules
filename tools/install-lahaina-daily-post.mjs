// Install reviewed runtime copies outside the nightly job's mutable checkout.
// Existing task, calendar and approval policies are preserved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function install({ home = os.homedir(), sourceRepo = fileURLToPath(new URL('..', import.meta.url)),
  dependencyRepo = path.join(home, '.claude', 'nightly-repo'), dryRun = false } = {}) {
  const dir = path.join(home, '.claude', 'lahaina-daily-post');
  const entry = path.join(dir, 'send-today.mjs');
  if (!fs.existsSync(entry) || !fs.existsSync(path.join(dir, 'calendar.json'))) throw new Error('既存の日次タスク配置が必要です');
  const toolsDir = path.join(dependencyRepo, 'tools');
  let helper = fs.readFileSync(path.join(sourceRepo, 'tools', 'daily-beeper-approval.mjs'), 'utf8');
  helper = helper.replace(/from '(\.\/[^']+)'/g, (_, relative) => {
    const dep = path.join(toolsDir, relative);
    if (!fs.existsSync(dep)) throw new Error(`依存ツールがありません: ${relative}`);
    return `from '${pathToFileURL(dep).href}'`;
  }).replace('const toolsDir = path.dirname(fileURLToPath(import.meta.url));', `const toolsDir = ${JSON.stringify(toolsDir)};`);
  let runtime = fs.readFileSync(path.join(sourceRepo, 'tools', 'lahaina-daily-post.mjs'), 'utf8');
  runtime = runtime.replace("export const NIGHTLY_REPO = fileURLToPath(new URL('..', import.meta.url));", `export const NIGHTLY_REPO = ${JSON.stringify(dependencyRepo)};`);
  const wrapper = `// Installed from tools/install-lahaina-daily-post.mjs. Runtime survives checkout switches.
export * from './runtime/lahaina-daily-post.mjs';
import { main } from './runtime/lahaina-daily-post.mjs';
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
`;
  const files = new Map([
    [path.join(dir, 'runtime', 'daily-beeper-approval.mjs'), helper],
    [path.join(dir, 'runtime', 'lahaina-daily-post.mjs'), runtime],
    [entry, wrapper],
  ]);
  const backup = `${entry}.before-free-route`;
  if (!dryRun) {
    if (!fs.existsSync(backup)) fs.copyFileSync(entry, backup, fs.constants.COPYFILE_EXCL);
    // Replace the entry last, once both runtime modules are in place.
    for (const [file, body] of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, body, 'utf8'); fs.renameSync(temp, file);
    }
  }
  return { dryRun, files: [...files.keys()], backup };
}
if (isEntry(import.meta.url)) console.log(JSON.stringify(install({ dryRun: process.argv.includes('--dry-run') })));
