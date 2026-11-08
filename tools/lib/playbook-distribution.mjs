import fs from 'node:fs';
import path from 'node:path';
// 各PCで追記した実測を守るため、既存ファイルは内容にかかわらず保持する。
export function distributePlaybooks(repo, home) {
  const source = path.join(repo, 'playbooks'), target = path.join(home, '.claude', 'playbooks');
  if (!fs.existsSync(source)) return 0;
  fs.mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try { fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name), fs.constants.COPYFILE_EXCL); copied++; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return copied;
}
