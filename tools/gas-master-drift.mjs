import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOOTH_SCRIPT, BOOTH_REPO, checked, gasFiles, spawnCommand } from './gas-master-sync.mjs';
import { claspRunner } from './gas-overlay-push.mjs';

export async function checkGasMasterDrift({ home, now = new Date(), dryRun = false,
  project = path.join(home, 'Downloads', 'ブース制作アプリ'),
  spawn = spawnCommand, pull = claspRunner, notify,
} = {}) {
  const configPath = path.join(project, '.clasp.json');
  if (!fs.existsSync(configPath)) return { status: 'skipped', reason: '制作アプリ未配置' };
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.scriptId !== BOOTH_SCRIPT) return { status: 'skipped', reason: '別 GAS' };
  const statePath = path.join(home, '.claude', '.gas-master-drift.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  if (now - new Date(state.checkedAt) < 7 * 86400_000) return { status: 'skipped', reason: '週次チェック済み' };
  if (dryRun) return { status: 'dry-run' };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-master-drift-'));
  try {
    const live = path.join(temp, 'live'), repo = path.join(temp, 'repo');
    fs.mkdirSync(live);
    // Root-only config prevents writing into the user's source tree.
    fs.writeFileSync(path.join(live, '.clasp.json'), JSON.stringify({ ...config, rootDir: '.' }));
    const pulled = pull(['pull'], { cwd: live });
    if (pulled.error || pulled.status !== 0) throw new Error(`clasp pull 失敗: ${pulled.error?.message || pulled.stderr || pulled.status}`);
    checked(spawn, 'git', ['clone', '--depth', '1', '--branch', 'master', `https://github.com/${BOOTH_REPO}.git`, repo], temp);
    const dirs = [path.join(temp, 'master-src'), path.join(temp, 'production-src')];
    for (const [i, root] of [path.join(repo, 'src'), live].entries()) {
      const files = gasFiles(root);
      if (!files.has('appsscript.json')) throw new Error('GAS manifest がありません');
      fs.mkdirSync(dirs[i]);
      for (const [key, file] of files) {
        const dest = path.join(dirs[i], key);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.text);
      }
    }
    const diff = spawn('git', ['diff', '--no-index', '--stat', '-w', '--exit-code', ...dirs], { cwd: temp });
    if (diff.error || ![0, 1].includes(diff.status)) throw new Error(`GAS diff 失敗: ${diff.error?.message || diff.stderr || diff.status}`);
    const drift = diff.status === 1;
    const summary = String(diff.stdout || '').trim().split('\n').at(-1)?.trim();
    if (drift) {
      const text = `ブース制作アプリ: GAS 本番と GitHub master に差分（${summary || '差分あり'}）。https://github.com/${BOOTH_REPO}`;
      if (!notify) throw new Error('DM notifier がありません');
      await notify(text, { home });
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ checkedAt: now.toISOString(), drift, summary }) + '\n');
    return { status: drift ? 'drift' : 'ok', summary };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
