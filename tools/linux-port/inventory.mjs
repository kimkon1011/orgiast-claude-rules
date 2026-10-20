import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const excludedDirectories = new Set(['.git', 'node_modules', '.cache']);
const generated = /^linux-port-(?:inventory\.(?:json|md|baseline\.json)|tasks\.(?:json|md))$/;
const callPatterns = {
  taskkill: /\btaskkill\b/gi,
  schtasks: /\bschtasks\b/gi,
  'reg query': /\breg\s+query\b/gi,
  'Get-ItemProperty': /\bGet-ItemProperty\b/gi,
  'Start-Process': /\bStart-Process\b/gi,
};
export function collectInventory(root = defaultRoot) {
  const result = { ps1Total: 0, registerPs1Total: 0, hooksTotal: 0, pwshHooksTotal: 0, hardcodedPathFiles: 0, hardcodedPathLines: 0, windowsOnlyCalls: Object.fromEntries(Object.keys(callPatterns).map(key => [key, 0])) };
  function hooks(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.hooks)) {
      for (const hook of value.hooks) {
        if (hook && typeof hook === 'object' && ('type' in hook || 'command' in hook)) {
          result.hooksTotal++;
          if (typeof hook.command === 'string' && /pwsh|powershell/i.test(hook.command)) result.pwshHooksTotal++;
        }
      }
    }
    for (const child of Object.values(value)) hooks(child);
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filename = path.join(directory, entry.name);
      // Never follow symlinks out of the requested tree (or into cycles).
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) walk(filename);
        continue;
      }
      if (!entry.isFile() || entry.name === '.git' || (path.relative(root, directory) === 'reports' && generated.test(entry.name))) continue;
      // 移植ツール自身は Windows 依存の語を計測用に含むため対象外（自己計測を避ける）。
      if (path.relative(root, filename).split(path.sep).join('/').startsWith('tools/linux-port/')) continue;
      if (/\.ps1$/i.test(entry.name)) {
        result.ps1Total++;
        if (/^register-.*\.ps1$/i.test(entry.name)) result.registerPs1Total++;
      }
      const bytes = fs.readFileSync(filename);
      // PowerShell exports may be UTF-16LE; other binary files are excluded.
      const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.includes(0) ? null : bytes.toString('utf8').replace(/^\uFEFF/, '');
      if (text === null) continue;
      const lines = text.split(/\r?\n/).filter(line => /C:(?:\\+Users\\+|\/Users\/)|H:\\+/i.test(line)).length;
      if (lines) { result.hardcodedPathFiles++; result.hardcodedPathLines += lines; }
      for (const [name, regex] of Object.entries(callPatterns)) result.windowsOnlyCalls[name] += [...text.matchAll(regex)].length;
      if (/\.json$/i.test(entry.name)) {
        let value;
        try { value = JSON.parse(text); }
        catch (error) { throw new Error(`Invalid JSON: ${path.relative(root, filename)}: ${error.message}`); }
        hooks(value);
      }
    }
  }
  walk(path.resolve(root));
  // hooks の正本は register-hooks.mjs が生成する配布集合（repo 内の JSON だけでは数えられない）。
  const registerHooks = path.join(root, 'tools', 'register-hooks.mjs');
  if (fs.existsSync(registerHooks)) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-hooks-'));
    try {
      const settings = JSON.parse(execFileSync(process.execPath, [registerHooks, '--expected-json'], {
        encoding: 'utf8',
        env: { ...process.env, ORGIAST_REPO: path.resolve(root), ORGIAST_HOME: home, ORGIAST_PLATFORM: 'linux' },
        windowsHide: true,
      }));
      result.distributionHooksTotal = 0;
      result.distributionPwshHooksTotal = 0;
      for (const groups of Object.values(settings.hooks || {})) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) for (const hook of (Array.isArray(group?.hooks) ? group.hooks : [])) {
          result.distributionHooksTotal++;
          if (/\b(?:pwsh|powershell)(?:\.exe)?\b|\.ps1\b/i.test(String(hook?.command || ''))) result.distributionPwshHooksTotal++;
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  return result;
}
export function increases(current, baseline) {
  const changes = [];
  for (const [key, value] of Object.entries(current)) {
    if (typeof value === 'number') {
      if (!Number.isFinite(baseline[key])) throw new Error(`Invalid baseline: ${key}`);
      if (value > baseline[key]) changes.push(`${key}: ${baseline[key]} -> ${value}`);
    } else {
      for (const [call, count] of Object.entries(value)) {
        if (!Number.isFinite(baseline[key]?.[call])) throw new Error(`Invalid baseline: ${key}.${call}`);
        if (count > baseline[key][call]) changes.push(`${key}.${call}: ${baseline[key][call]} -> ${count}`);
      }
    }
  }
  return changes;
}
export function markdown(result) {
  const reference = { ps1Total: 78, hooksTotal: 71, pwshHooksTotal: 19, hardcodedPathFiles: 55, hardcodedPathLines: 336 };
  const rows = Object.entries(reference).map(([key, old]) => `| ${key} | ${result[key]} | ${old} | ${result[key] - old >= 0 ? '+' : ''}${result[key] - old} |`);
  if (Number.isFinite(result.distributionHooksTotal)) {
    rows.push(`| distributionHooksTotal | ${result.distributionHooksTotal} | - | - |`);
    rows.push(`| distributionPwshHooksTotal | ${result.distributionPwshHooksTotal} | 19 (実PC) | - |`);
  }
  return `# Linux 移植 棚卸し\n\n| 項目 | 今回 | 事前調査 | 差分 |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n\n事前調査は ~/.claude 配布ツリーも含む範囲、本ツールはリポジトリ root（または --root）を走査するため一致しません。\n直書きは C:\\Users\\・C:/Users/・H:\\ のいずれかを含む行を数え、文書・テストも含めます（事前調査は C:\\Users が対象）。\n\nregister-*.ps1: ${result.registerPs1Total}\n\n| Windows 固有呼出し | 出現数 |\n| --- | ---: |\n${Object.entries(result.windowsOnlyCalls).map(([key, count]) => `| ${key} | ${count} |`).join('\n')}\n\n集計方法: hooks 配下の実行定義を JSON 構造で数えます。呼出しはコメント・文書内も含む文字列出現数です。\n.git、node_modules、.cache、シンボリックリンク、バイナリ、本ツールの生成レポートとベースラインは除外します。日時・絶対ルートは記録しません。\n`;
}
function cli(argv) {
  let root = defaultRoot;
  let json = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1] && !argv[i + 1].startsWith('--')) root = path.resolve(argv[++i]);
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--check') check = true;
    else throw new Error(`Unknown option or missing value: ${argv[i]}`);
  }
  if (json && check) throw new Error('--json and --check cannot be combined');
  const result = collectInventory(root);
  const serialized = JSON.stringify(result, null, 2) + '\n';
  if (json) { process.stdout.write(serialized); return; }
  const reports = path.join(root, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  if (check) {
    const baseline = path.join(reports, 'linux-port-inventory.baseline.json');
    if (!fs.existsSync(baseline)) { fs.writeFileSync(baseline, serialized); console.log('Baseline created'); return; }
    const changes = increases(result, JSON.parse(fs.readFileSync(baseline, 'utf8')));
    if (changes.length) { console.error(changes.join('\n')); process.exitCode = 1; }
    else console.log('Inventory ratchet passed');
    return;
  }
  fs.writeFileSync(path.join(reports, 'linux-port-inventory.json'), serialized);
  fs.writeFileSync(path.join(reports, 'linux-port-inventory.md'), markdown(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
