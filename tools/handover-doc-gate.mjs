#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "handover-doc-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "handover-doc-gate"}, {"kind": "repo-file", "ref": "rules-extracted/project-launch-playbook.md"}]};
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTargetDir } from './feedback-form-gate.mjs';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';

export const SHELL_TOOLS = 'Bash|PowerShell';
export const SHELL_TOOL = new RegExp(`^(?:${SHELL_TOOLS})$`);
export const HOOK_MATCHER = SHELL_TOOLS;

// 全社ルール §1.12.1: 本番反映の直前に HANDOVER.md（移管前提の引き継ぎ書）を要求する。
const DEPLOY_PATTERNS = [
  /wrangler\s+deploy\b/i,
  /wrangler\s+pages\s+deploy\b/i,
  /vercel\s+deploy\b/i,
  /vercel\s+--prod\b/i,
  /clasp\s+push\b/i,
  /npm\s+run\s+deploy\b/i,
];

export function isDeployCommand(command) {
  const text = String(command ?? '');
  return DEPLOY_PATTERNS.some((pattern) => pattern.test(text));
}

const ROOT_MARKERS = ['package.json', '.clasp.json', 'wrangler.jsonc', 'wrangler.toml'];

export function findProjectRoot(dir) {
  let current = path.resolve(dir || process.cwd());
  for (let depth = 0; depth < 12; depth += 1) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function hasHandover(root) {
  return Boolean(root) && fs.existsSync(path.join(root, 'HANDOVER.md'));
}

function buildReason(root) {
  return `[HANDOVER-DOC] §1.12.1: すべてのプロジェクトは「後で別アカウント（例: cr@orgiast.jp）へ管理を移す」前提で作る決まりです。${root} にはリポジトリ直下の HANDOVER.md が無いため、本番反映を止めました。
HANDOVER.md を置く（ひな形: rules-extracted/project-launch-playbook.md §1.12.1。リソース一覧・env の所在・再デプロイ手順・ローカル起動・定期ジョブ・移管チェックリスト）。README に「引き継ぎは HANDOVER.md」と1行足してから、元のコマンドを再実行してください。
緊急時のみ環境変数 HANDOVER_GATE_SKIP=1 で素通しできます（理由は stderr に記録されます）。`;
}

export function judge({ command, cwd }, { env = process.env } = {}) {
  if (!isDeployCommand(command)) return { deny: false };
  if (env.HANDOVER_GATE_SKIP === '1') {
    process.stderr.write('[HANDOVER-DOC] HANDOVER_GATE_SKIP=1 により HANDOVER.md の確認を省略しました（緊急用）。後で HANDOVER.md を追加してください。\n');
    return { deny: false, skipped: true };
  }
  const root = findProjectRoot(resolveTargetDir(command, cwd));
  if (!root) return { deny: false };
  if (hasHandover(root)) return { deny: false };
  return { deny: true, reason: buildReason(root) };
}

export function selftest() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-gate-'));
  const failures = [];
  const check = (name, actual, expected) => { if (actual !== expected) failures.push(`${name}: expected ${expected} got ${actual}`); };
  try {
    const withDoc = path.join(base, 'with-doc');
    const withoutDoc = path.join(base, 'without-doc');
    const sub = path.join(withoutDoc, 'src', 'deep');
    fs.mkdirSync(withDoc, { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(withDoc, 'package.json'), '{}');
    fs.writeFileSync(path.join(withDoc, 'HANDOVER.md'), '# HANDOVER\n');
    fs.writeFileSync(path.join(withoutDoc, 'wrangler.toml'), 'name = "x"\n');
    check('deny: wrangler deploy without doc', judge({ command: 'npx wrangler deploy', cwd: withoutDoc }, { env: {} }).deny, true);
    check('deny: from subdir', judge({ command: 'npm run deploy', cwd: sub }, { env: {} }).deny, true);
    check('deny: --cwd option', judge({ command: `clasp push --cwd "${withoutDoc}"`, cwd: withDoc }, { env: {} }).deny, true);
    check('allow: with HANDOVER.md', judge({ command: 'wrangler deploy', cwd: withDoc }, { env: {} }).deny, false);
    check('allow: non-deploy command', judge({ command: 'npm run build', cwd: withoutDoc }, { env: {} }).deny, false);
    check('allow: no project root', judge({ command: 'vercel --prod', cwd: base }, { env: {} }).deny, false);
    check('allow: SKIP=1', judge({ command: 'wrangler deploy', cwd: withoutDoc }, { env: { HANDOVER_GATE_SKIP: '1' } }).deny, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  return failures;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (!SHELL_TOOL.test(input?.tool_name || '')) return;
    const command = String(input?.tool_input?.command ?? '');
    const cwd = input?.cwd || process.cwd();
    const result = judge({ command, cwd });
    if (result.deny) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
        },
      }));
    }
  } catch {
    // fail-open: 例外・JSON パース失敗はすべて通す
  }
}

if (process.argv.includes('--selftest') && isEntry(import.meta.url)) {
  const failures = selftest();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('handover-doc-gate selftest ok');
} else if (isEntry(import.meta.url)) {
  await main();
}
