#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportMemories } from './memory-share.mjs';
import { keyserveAuthHeaders, requireKeyservePcId, keyserveSecret } from './keyserve-auth.mjs';
import { isEntry } from './is-entry.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

function argValue(argv, name) { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const serialize = bundle => '// 自動生成。編集しない。コミットしない。\nmodule.exports = ' + JSON.stringify(bundle, null, 2) + ';\n';

export function vercelCommand(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return { file: 'vercel', args: [] };
  const run = options.spawnSyncImpl || spawnSync;
  const found = run('where.exe', ['vercel.cmd'], { encoding: 'utf8', shell: false, windowsHide: true });
  const shim = String(found.stdout || '').trim().split(/\r?\n/)[0];
  if (found.status !== 0 || !shim) throw new Error('NG:vercel.cmd が PATH にありません');
  // .cmd cannot be executed with shell:false on Windows. Resolve the npm shim's
  // JS entry and run Node directly, without constructing a shell command.
  const cli = path.join(path.dirname(shim), 'node_modules', 'vercel', 'dist', 'vc.js');
  if (!fs.existsSync(cli)) throw new Error('NG:vercel.cmd の Node エントリがありません');
  return { file: process.execPath, args: [cli] };
}

export async function publishMemories(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const env = options.env || process.env;
  const repo = options.keyserveRepo || env.ORGIAST_MEMORYSERVE_REPO || path.join(home, 'Downloads', 'orgiast-memoryserve');
  const emit = options.emit || console.log;
  const dryRun = Boolean(options.dryRun);
  // Collect entirely in memory: dry-run must not create even a temporary export.
  const exported = exportMemories({ home, dryRun: true, channel: 'private', includeContents: true, emit: line => { if (line.startsWith('除外')) emit(line); } });
  const files = exported.contents || {};
  const source = { pc: requireKeyservePcId(home, env), account: readJson(path.join(home, '.claude.json'))?.oauthAccount?.emailAddress || '' };
  const statePath = path.join(home, '.claude', 'memory-publish-state.json');
  const state = readJson(statePath);
  const bundle = { version: 2, generatedAt: state?.generatedAt || (options.now || new Date()).toISOString(), source, files };
  // Hash the actual bundle, reusing the last deployed timestamp to detect changes.
  let content = serialize(bundle);
  const unchanged = Boolean(state?.sha256 && hash(content) === state.sha256);
  if (!unchanged) { bundle.generatedAt = (options.now || new Date()).toISOString(); content = serialize(bundle); }
  const result = { exported: exported.exported, files: Object.keys(files).length, bytes: Buffer.byteLength(content), deploy: 'skip', removedLegacyDirectory: false, removedLegacyPath: false };
  if (dryRun) { emit(`dry-run: memory bundle: files=${result.files} bytes=${result.bytes}`); return result; }
  for (const [name, field] of [['memory-bundle', 'removedLegacyDirectory'], ['memory-bundle.generated.js', 'removedLegacyPath']]) {
    const legacy = path.join(repo, name);
    if (fs.existsSync(legacy)) { fs.rmSync(legacy, { recursive: true }); result[field] = true; emit(`旧 ${name}${field === 'removedLegacyDirectory' ? '/ ディレクトリを削除' : ' を削除'}: ${legacy}`); }
  }
  const destination = path.join(repo, 'api', '_memory-bundle.generated.js');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) fs.writeFileSync(destination, content);
  // 夜間の Vercel デプロイ/取得は一時的なタイムアウトで落ちる（2026-10 に4夜 ETIMEDOUT）。1回の失敗で丸1日配布を止めない。
  const attempts = Math.max(1, options.attempts ?? 3);
  const retry = async (label, step) => {
    for (let attempt = 1; ; attempt++) {
      try { return await step(); } catch (error) {
        if (attempt >= attempts) throw error;
        emit(`${label} 再試行 ${attempt}/${attempts - 1}: ${String(error.message || error).split(/\r?\n/)[0]}`);
        await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 30000));
      }
    }
  };
  let deploymentUrl = state?.deploymentUrl || '';
  if (options.deploy && !unchanged) {
    const command = vercelCommand(options);
    deploymentUrl = await retry('deploy', () => {
      const deployed = (options.spawnSyncImpl || spawnSync)(command.file, [...command.args, 'deploy', '--prod', '--yes'], {
        cwd: repo, shell: false, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 10 * 1024 * 1024,
      });
      if (deployed.error || deployed.status !== 0) throw new Error(`NG:vercel deploy failed (${deployed.error?.code || deployed.status})`);
      // vercel CLI は非TTYだと末尾に JSON を出すことがあるので、出力中の最後の https URL を採る。
      const found = (String(deployed.stdout || '').match(/https:\/\/[^\s"']+/g) || []).at(-1) || '';
      if (!/^https:\/\/[^\s]+$/.test(found)) throw new Error('NG:deployment URL missing');
      return found;
    });
    result.deploy = 'yes';
  } else if (options.deploy && unchanged) emit('unchanged: deploy skip');
  if (options.verify) {
    const url = new URL(options.memoryUrl || env.ORGIAST_MEMORY_URL || 'https://orgiast-memoryserve.vercel.app/api/memory');
    url.search = 'manifest=1';
    await retry('verify', async () => {
      const response = await (options.fetchImpl || fetch)(url.toString(), {
        headers: keyserveAuthHeaders(keyserveSecret(home, env), options.nowMs ?? Date.now(), source.pc), signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`NG:verify HTTP ${response.status}`);
      const manifest = await response.json();
      if (manifest.version !== 2 || manifest.generatedAt !== bundle.generatedAt) throw new Error('NG:verify generatedAt mismatch');
    });
    emit('verify: ok');
  }
  // A failed verification must not mark a deployment as successfully published.
  if (result.deploy === 'yes') {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ sha256: hash(content), generatedAt: bundle.generatedAt, deployedAt: new Date().toISOString(), deploymentUrl }, null, 2) + '\n');
  }
  emit(`memory-publish: files=${result.files} deploy=${result.deploy}`);
  return result;
}

export function run(argv = process.argv.slice(2), options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  if (argv.includes('--deploy') && (options.fleetLabel ?? resolveFleetLabel(home)) !== 'kim-PC') {
    (options.emit || console.log)('memory-publish: files=0 deploy=skip (発信元 kim-PC 以外)');
    return { files: 0, deploy: 'skip', skipped: 'not-kim-pc' };
  }
  return publishMemories({ ...options, keyserveRepo: argValue(argv, '--keyserve-repo'), dryRun: argv.includes('--dry-run'), deploy: argv.includes('--deploy'), verify: argv.includes('--verify') });
}
if (isEntry(import.meta.url)) {
  await Promise.resolve().then(() => run()).catch(error => { console.error(`memory-publish 失敗: ${String(error.message || error).split(/\r?\n/)[0]}`); process.exitCode = 1; });
}
