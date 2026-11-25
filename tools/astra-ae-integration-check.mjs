#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const fsp = fs.promises;

export const PREREQS = [
  { id: 'after-effects-installed', label: 'Adobe After Effects', required: true, howToFix: 'Adobe Creative Cloud から After Effects をインストールしてください。' },
  { id: 'higgsfield-plugin', label: 'Higgsfield AI Motion Designer', required: true, howToFix: 'ChatGPT の @Higgsfield /use-after-effects、または After Effects パネルを導入してアカウント側でも有効化してください。' },
  { id: 'astra-lane-available', label: 'Astra レーン', required: false, howToFix: '表示された cooldown 終了時刻まで待つか、利用枠を確認してください。' },
  { id: 'node-runtime', label: 'Node.js 実行環境', required: false, howToFix: 'Node.js を利用できるシェルから再実行してください。' },
];

function windowsHome() {
  if (process.platform === 'win32') return process.env.USERPROFILE || os.homedir();
  const name = process.env.USER || path.basename(os.homedir());
  const current = process.cwd().match(/^\/mnt\/c\/Users\/([^/]+)/i)?.[1];
  return `/mnt/c/Users/${current || name}`;
}

function hostPlatform() {
  return process.platform === 'linux' && fs.existsSync('/mnt/c/Users') ? 'win32' : process.platform;
}

async function directoriesAt(root) {
  try { return (await fsp.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function findNamed(root, pattern, depth = 4) {
  if (depth < 0) return [];
  const entries = await directoriesAt(root);
  const found = [];
  for (const entry of entries) {
    const fullPath = path.resolve(root, entry.name);
    if (pattern.test(entry.name)) found.push(fullPath);
    if (depth > 0) found.push(...await findNamed(fullPath, pattern, depth - 1));
  }
  return found;
}

function windowsPath(...parts) {
  return process.platform === 'win32' ? path.join(...parts) : path.join('/mnt/c', ...parts);
}

async function probeAfterEffects() {
  const platform = hostPlatform();
  let root;
  if (platform === 'win32') root = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe')
    : windowsPath('Program Files', 'Adobe');
  else if (platform === 'darwin') root = '/Applications';
  else return { status: 'unknown', evidence: `${process.platform} は After Effects の対応インストール先を判定できません` };
  const matches = (await directoriesAt(root)).filter((entry) => /^Adobe After Effects/i.test(entry.name));
  if (!matches.length) return { status: 'fail', evidence: `${path.resolve(root)} に Adobe After Effects ディレクトリなし` };
  const installPath = path.resolve(root, matches[0].name);
  const scripts = path.join(installPath, 'Support Files', 'Scripts');
  const scriptsExists = await fsp.stat(scripts).then((stat) => stat.isDirectory()).catch(() => false);
  return { status: 'pass', evidence: `${installPath}; Support Files/Scripts: ${scriptsExists ? 'あり' : 'なし'}` };
}

async function probeHiggsfield() {
  const platform = hostPlatform();
  let roots = [];
  if (platform === 'win32') {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(windowsHome(), 'AppData', 'Roaming');
      roots = [path.join(appData, 'Adobe', 'CEP', 'extensions'), path.join(appData, 'ChatGPT')];
    } else {
      const home = windowsHome();
      roots = [path.join(home, 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions'), path.join(home, 'AppData', 'Roaming', 'ChatGPT')];
    }
  } else if (platform === 'darwin') {
    roots = [path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions'), path.join(os.homedir(), 'Library', 'Application Support', 'ChatGPT')];
  }
  const matches = (await Promise.all(roots.map((root) => findNamed(root, /higgsfield/i)))).flat();
  if (matches.length) return { status: 'pass', evidence: `Higgsfield のローカル痕跡: ${matches[0]}` };
  return { status: 'unknown', evidence: `Higgsfield のローカル痕跡なし（探索先: ${roots.map((root) => path.resolve(root)).join(', ') || '対応外OS'}）。ChatGPT アカウント側の導入状態はローカルFSからは判定不能` };
}

export async function defaultCooldown() {
  const candidates = [
    path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'provider-cooldown.json'),
    hostPlatform() === 'win32' && process.platform !== 'win32' ? path.join(windowsHome(), '.claude', 'provider-cooldown.json') : null,
  ].filter(Boolean);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`provider-cooldown.json がありません（探索先: ${candidates.join(', ')}）`);
  return { file: path.resolve(file), state: JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) };
}

async function probeAstraLane(cooldown) {
  const { file, state } = await cooldown();
  const entries = Object.entries(state || {}).filter(([key, value]) => key === 'codex-astra'
    || (key.startsWith('codex') && /astra/i.test(String(value?.account || value?.accountName || value?.name || ''))));
  const active = entries.find(([, value]) => Number(value?.until) > Date.now());
  if (active) {
    const [key, value] = active;
    return { status: 'fail', evidence: `${key} は ${new Date(Number(value.until)).toISOString()} まで cooldown${value.reason ? `（reason: ${value.reason}）` : ''}; ${file}` };
  }
  return { status: 'pass', evidence: `Astra 対象の有効な cooldown なし; ${file}` };
}

async function probeNodeRuntime() {
  return { status: 'pass', evidence: `${process.version}; process.platform=${process.platform}` };
}

export const defaultProbe = {
  'after-effects-installed': probeAfterEffects,
  'higgsfield-plugin': probeHiggsfield,
  'astra-lane-available': ({ cooldown }) => probeAstraLane(cooldown),
  'node-runtime': probeNodeRuntime,
};

function unknown(error) {
  return { status: 'unknown', evidence: `検査エラー: ${error?.message || String(error)}` };
}

export async function runAstraAeCheck({ probe = defaultProbe, cooldown = defaultCooldown } = {}) {
  const tasks = PREREQS.map(async (prereq) => {
    try {
      const fn = typeof probe === 'function' ? probe : probe?.[prereq.id];
      if (typeof fn !== 'function') throw new Error(`probe ${prereq.id} がありません`);
      const result = await fn({ prereq, cooldown });
      if (!['pass', 'fail', 'unknown'].includes(result?.status)) throw new Error(`不正な status: ${result?.status}`);
      return { id: prereq.id, label: prereq.label, required: prereq.required, status: result.status, evidence: String(result.evidence || '根拠なし') };
    } catch (error) {
      return { id: prereq.id, label: prereq.label, required: prereq.required, ...unknown(error) };
    }
  });
  const results = await Promise.all(tasks);
  const blockers = results.filter((result) => result.required && result.status === 'fail').map((result) => result.id);
  const unknowns = results.filter((result) => result.status === 'unknown').map((result) => result.id);
  const verdict = blockers.length ? 'blocked' : results.some((result) => result.required && result.status === 'unknown') ? 'unknown' : 'ready';
  return { checkedAt: new Date().toISOString(), platform: process.platform, verdict, results, blockers, unknowns };
}

export function formatAstraAeCheck(report) {
  const icons = { pass: '✅', fail: '❌', unknown: '❓' };
  const lines = [`Astra × After Effects readiness: ${report.verdict}`];
  for (const result of report.results) {
    const fix = result.status === 'pass' ? '' : `\n   直し方: ${PREREQS.find((item) => item.id === result.id).howToFix}`;
    lines.push(`${icons[result.status]} ${result.label}: ${result.evidence}${fix}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const report = await runAstraAeCheck(options);
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatAstraAeCheck(report));
  if (argv.includes('--strict') && report.verdict === 'blocked') process.exitCode = 1;
  return report;
}

if (isEntry(import.meta.url)) await main();
