#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SPECS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/booth-specs');
const REQUIRED_FIELDS = ['projectId', 'title', 'client', 'industry', 'event.name', 'booth.size', 'period', 'services', 'description'];

export function getSpecsDir(env = process.env) {
  return path.resolve(env.BOOTH_SPECS_DIR || DEFAULT_SPECS_DIR);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { command, positional, options };
}

async function jsonFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
}

export async function loadSpecs(dir = getSpecsDir()) {
  const specs = [];
  for (const filename of await jsonFiles(dir)) {
    const content = await readFile(path.join(dir, filename), 'utf8');
    specs.push({ filename, data: JSON.parse(content) });
  }
  return specs;
}

function nestedValue(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

export function validateSpec(data, filename) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [`${filename}: ルートはオブジェクトである必要があります`];
  for (const field of REQUIRED_FIELDS) {
    const value = nestedValue(data, field);
    if (value === undefined || value === null || value === '') errors.push(`${filename}: 必須フィールド ${field} がありません`);
  }
  if (data.services !== undefined && (!Array.isArray(data.services) || data.services.length === 0)) {
    errors.push(`${filename}: services は空でない配列である必要があります`);
  }
  if (data.projectId && filename !== `${data.projectId}.json`) {
    errors.push(`${filename}: ファイル名は ${data.projectId}.json である必要があります`);
  }
  return errors;
}

export async function validateDirectory(dir = getSpecsDir()) {
  const errors = [];
  const ids = new Map();
  for (const filename of await jsonFiles(dir)) {
    let data;
    try {
      data = JSON.parse(await readFile(path.join(dir, filename), 'utf8'));
    } catch (error) {
      errors.push(`${filename}: JSONを読み込めません (${error.message})`);
      continue;
    }
    errors.push(...validateSpec(data, filename));
    if (data?.projectId) {
      if (ids.has(data.projectId)) errors.push(`${filename}: projectId ${data.projectId} は ${ids.get(data.projectId)} と重複しています`);
      else ids.set(data.projectId, filename);
    }
  }
  return errors;
}

function scalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.includes('\n') ? JSON.stringify(value) : value;
  return String(value);
}

export function toYamlLike(value, indent = 0) {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') return `${prefix}-\n${toYamlLike(item, indent + 2)}`;
      return `${prefix}- ${scalar(item)}`;
    }).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => {
      if (item !== null && typeof item === 'object') return `${prefix}${key}:\n${toYamlLike(item, indent + 2)}`;
      return `${prefix}${key}: ${scalar(item)}`;
    }).join('\n');
  }
  return `${prefix}${scalar(value)}`;
}

function table(specs) {
  const rows = [['ID', 'タイトル', 'イベント', 'クライアント'], ...specs.map(({ data }) => [data.projectId, data.title, data.event?.name, data.client])];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column] ?? '').length)));
  return rows.map((row) => row.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}

export async function main(argv = process.argv.slice(2), context = {}) {
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const dir = context.specsDir || getSpecsDir(context.env || process.env);
  const out = (message) => stdout.write(`${message}\n`);
  const fail = (message) => { stderr.write(`エラー: ${message}\n`); return 1; };
  const { command, positional, options } = parseArgs(argv);

  try {
    if (command === 'list') {
      let specs = await loadSpecs(dir);
      if (options.industry) specs = specs.filter(({ data }) => data.industry === options.industry);
      out(table(specs));
      return 0;
    }
    if (command === 'get') {
      const projectId = positional[0];
      if (!projectId) return fail('projectId を指定してください');
      const spec = (await loadSpecs(dir)).find(({ data }) => data.projectId === projectId);
      if (!spec) return fail(`projectId ${projectId} は見つかりません`);
      if (options.format && options.format !== 'json') return fail(`未対応の形式です: ${options.format}`);
      out(options.format === 'json' ? JSON.stringify(spec.data, null, 2) : toYamlLike(spec.data));
      return 0;
    }
    if (command === 'validate') {
      const errors = await validateDirectory(dir);
      if (errors.length) {
        for (const error of errors) stderr.write(`${error}\n`);
        stderr.write(`バリデーションエラー: ${errors.length}件\n`);
        return 1;
      }
      out('バリデーション成功: エラー0件');
      return 0;
    }
    if (command === 'add') {
      if (!options.file || options.file === true) return fail('--file <path> を指定してください');
      const data = JSON.parse(await readFile(path.resolve(options.file), 'utf8'));
      if (!data?.projectId || typeof data.projectId !== 'string') return fail('projectId がありません');
      const filename = `${data.projectId}.json`;
      const validationErrors = validateSpec(data, filename);
      if (validationErrors.length) return fail(validationErrors.join('\n'));
      const destination = path.join(dir, filename);
      let exists = false;
      try { await readFile(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await writeFile(destination, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      out(exists ? `${data.projectId} を上書きしました` : `${data.projectId} を追加しました`);
      return 0;
    }
    if (command === 'export') {
      if (positional[0] !== 'json') return fail('export の形式には json を指定してください');
      const data = (await loadSpecs(dir)).map((spec) => spec.data);
      out(JSON.stringify(data, null, options.pretty ? 2 : 0));
      return 0;
    }
    return fail('コマンドを指定してください: list | get | validate | add | export');
  } catch (error) {
    return fail(error.message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
