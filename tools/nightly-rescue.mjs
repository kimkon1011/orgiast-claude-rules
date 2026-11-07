import { rescueTree, WORK_DIRECTORY_EXCLUDES } from './rescue-policy.mjs';
import { isEntry } from './is-entry.mjs';
export { dirtyStatus, rescueTree } from './rescue-policy.mjs';

if (isEntry(import.meta.url)) {
  const [tree, home] = process.argv.slice(2);
  if (tree === '--clean-excludes') console.log(JSON.stringify(WORK_DIRECTORY_EXCLUDES));
  else if (!tree || !home) process.exitCode = 1;
  else console.log(JSON.stringify(await rescueTree(tree, home)));
}
