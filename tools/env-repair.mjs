#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function envFiles(home = process.env.ORGIAST_HOME || os.homedir()) {
  let files = [];
  const claude = path.join(home, '.claude');
  try { files = fs.readdirSync(claude).filter((name) => name.endsWith('.env')).map((name) => path.join(claude, name)); } catch {}
  files.push(path.join(home, '.gemini', '.env'));
  return files;
}

export function repairEnvBom({ home = process.env.ORGIAST_HOME || os.homedir(), check = false } = {}) {
  const found = [];
  for (const file of envFiles(home)) {
    let data; try { data = fs.readFileSync(file); } catch { continue; }
    if (data.length < 3 || data[0] !== 0xef || data[1] !== 0xbb || data[2] !== 0xbf) continue;
    found.push(file);
    if (check) continue;
    const backup = `${file}.bak.${new Date().toISOString().slice(0, 10)}-bom`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, data.subarray(3));
  }
  return found;
}

const isMain = isEntry(import.meta.url);
if (isMain) {
  const found = repairEnvBom({ check: process.argv.includes('--check') });
  if (found.length) console.log(`${process.argv.includes('--check') ? 'BOM検出' : 'BOM修復'}: ${found.length}件`);
}
