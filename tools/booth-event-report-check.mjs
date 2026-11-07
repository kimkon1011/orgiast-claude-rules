#!/usr/bin/env node
// Read-only PostToolUse check. No shell, writes, network, or recursive invocation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!event || typeof event !== 'object' || Array.isArray(event)) process.exit(0);
  if (event.hook_event_name !== 'PostToolUse' || !['Write', 'Edit'].includes(event.tool_name)) process.exit(0);
  const file = event.tool_input?.file_path;
  if (typeof file !== 'string') process.exit(0);
  // A relative path needs a usable base before its target can be identified.
  if (!path.isAbsolute(file) && event.cwd != null && typeof event.cwd !== 'string') process.exit(0);
  const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(event.cwd || root, file);
  const dir = path.join(root, 'samples', 'booth-event', 'reports');
  if (path.dirname(target) !== dir || !target.endsWith('.json')) process.exit(0);
  // A symlink must not make this reader inspect files outside the target directory.
  if (fs.realpathSync(target) !== target) throw new Error('symlinkは対象にできません');
  // Nonblocking open also prevents a concurrent replacement with a FIFO from hanging.
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  let report;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('通常ファイルのJSONが必要です');
    report = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (report.sample !== 'sample-v1') throw new Error('sample-v1専用です');
  if (!Array.isArray(report.findings) || !report.findings.length) throw new Error('findingsが必要です');
  for (const finding of report.findings) {
    if (!finding || !['layout', 'event'].includes(finding.area) ||
        !['observation', 'unconfirmed', 'proposal'].includes(finding.status) ||
        !['claim', 'source', 'next'].every(key => text(finding[key]))) {
      throw new Error('各指摘にarea/status/claim/source/nextが必要です');
    }
  }
  if (!Array.isArray(report.unconfirmed) || !report.unconfirmed.every(text)) throw new Error('unconfirmedは文字列配列が必要です');
} catch (error) {
  console.log(JSON.stringify({ decision: 'block', reason: `匿名確認レポートを修正してください: ${error.message}` }));
}
