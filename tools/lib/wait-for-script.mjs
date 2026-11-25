import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// リポジトリ更新中だけ起動対象が消える場合に、最大5回待機する。
export async function runWhenPresent(script, args = [], {
  exists = fs.existsSync, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  spawn = spawnSync,
} = {}) {
  for (let retry = 0; !exists(script); retry++) {
    if (retry === 5) throw new Error(`Script not found after 5 retries: ${script}`);
    await wait(30_000);
  }
  const result = spawn(process.execPath, [script, ...args], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runWhenPresent(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
