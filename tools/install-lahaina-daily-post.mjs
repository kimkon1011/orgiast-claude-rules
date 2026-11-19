// Install reviewed runtime copies outside the nightly job's mutable checkout.
// Existing task/calendar are preserved. Install only kim's explicitly authorized policy.
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
  const localModules = new Set(['daily-beeper-approval.mjs', 'lahaina-standing-send.mjs', 'lahaina-standing-policy.mjs', 'lahaina-daily-message.mjs', 'beeper-send.mjs']);
  const rewriteImports = body => body.replace(/from '(\.\/[^']+)'/g, (original, relative) => {
    if (localModules.has(relative.slice(2))) return original;
    const dep = path.join(toolsDir, relative);
    if (!fs.existsSync(dep)) throw new Error(`依存ツールがありません: ${relative}`);
    return `from '${pathToFileURL(dep).href}'`;
  });
  let helper = fs.readFileSync(path.join(sourceRepo, 'tools', 'daily-beeper-approval.mjs'), 'utf8');
  helper = rewriteImports(helper).replace('const toolsDir = path.dirname(fileURLToPath(import.meta.url));', `const toolsDir = ${JSON.stringify(toolsDir)};`)
    .replace("const beeperSendTool = path.join(toolsDir, 'beeper-send.mjs');", "const beeperSendTool = fileURLToPath(new URL('./beeper-send.mjs', import.meta.url));");
  let runtime = fs.readFileSync(path.join(sourceRepo, 'tools', 'lahaina-daily-post.mjs'), 'utf8');
  runtime = runtime.replace("export const NIGHTLY_REPO = fileURLToPath(new URL('..', import.meta.url));", `export const NIGHTLY_REPO = ${JSON.stringify(dependencyRepo)};`);
  const wrapper = `// Installed from tools/install-lahaina-daily-post.mjs. Runtime survives checkout switches.
export * from './runtime/lahaina-daily-post.mjs';
import { main } from './runtime/lahaina-daily-post.mjs';
import { isEntry } from '${pathToFileURL(path.join(toolsDir, 'is-entry.mjs')).href}';
if (isEntry(import.meta.url)) await main();
`;
  const files = new Map([
    [path.join(dir, 'runtime', 'daily-beeper-approval.mjs'), helper],
    [path.join(dir, 'runtime', 'lahaina-daily-post.mjs'), rewriteImports(runtime)],
  ]);
  for (const name of localModules) {
    if (name !== 'daily-beeper-approval.mjs') files.set(path.join(dir, 'runtime', name), rewriteImports(fs.readFileSync(path.join(sourceRepo, 'tools', name), 'utf8')));
  }
  // Reinstalling must never re-enable a revoked policy or approve an edited calendar.
  const policy = path.join(dir, 'standing-approval.json');
  if (!fs.existsSync(policy)) files.set(policy, fs.readFileSync(path.join(sourceRepo, 'config', 'lahaina-standing-approval.json'), 'utf8'));
  files.set(entry, wrapper);
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
