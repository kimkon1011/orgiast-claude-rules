#!/usr/bin/env node
/**
 * booth-data-extract.mjs — 展示会ブースデータから必要なフィールドだけを抽出するCLI
 *
 * X-0093: Code Modeで入力を削る の中核ツール。
 * 過去展示会資料の検索結果から寸法・部材・金額だけを抜き出し、
 * LLMへ渡す入力を1/10以下に削減する。
 *
 * 使用例:
 *   node tools/booth-data-extract.mjs --input search-results.json --schema booth
 *   node tools/booth-data-extract.mjs --input search-results.json --fields boothId,width,depth,cost
 *   cat data.json | node tools/booth-data-extract.mjs --schema booth_minimal
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');

/** 内蔵スキーマ定義 */
function loadBuiltinSchemas() {
  const schemaPath = path.join(SCHEMA_DIR, 'booth-data-schema.json');
  try {
    return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch {
    return { schemas: {} };
  }
}

/** 引数パース */
export function parseArgs(argv) {
  const options = {
    input: '',
    fields: '',
    schema: '',
    filter: '',
    out: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--input': options.input = argv[++i] ?? ''; break;
      case '--fields': options.fields = argv[++i] ?? ''; break;
      case '--schema': options.schema = argv[++i] ?? ''; break;
      case '--filter': options.filter = argv[++i] ?? ''; break;
      case '--out': options.out = argv[++i] ?? ''; break;
      case '--help': case '-h': options.help = true; break;
      default: if (!options.input && !argv[i].startsWith('-')) options.input = argv[i]; break;
    }
  }
  return options;
}

/** スキーマからフィールド名一覧を取得 */
export function getFieldNamesFromSchema(schemaName, schemas) {
  const schema = schemas.schemas?.[schemaName];
  if (!schema) return [];
  return Object.entries(schema.fields)
    .filter(([_, def]) => !def.optional || true)
    .map(([name]) => name);
}

/** 文字列条件を評価（簡易パーサー） */
export function evaluateFilter(record, filterExpr) {
  if (!filterExpr) return true;
  // 対応形式: field=="値" / field!=="値" / field>数値 / field<数値
  const matchEq = filterExpr.match(/^(\w+)\s*==\s*"([^"]*)"$/);
  if (matchEq) {
    const val = String(record[matchEq[1]] ?? '');
    return val === matchEq[2];
  }
  const matchNeq = filterExpr.match(/^(\w+)\s*!==\s*"([^"]*)"$/);
  if (matchNeq) {
    const val = String(record[matchNeq[1]] ?? '');
    return val !== matchNeq[2];
  }
  const matchGt = filterExpr.match(/^(\w+)\s*>\s*(\d+\.?\d*)$/);
  if (matchGt) {
    const val = Number(record[matchGt[1]] ?? NaN);
    return !Number.isNaN(val) && val > Number(matchGt[2]);
  }
  const matchLt = filterExpr.match(/^(\w+)\s*<\s*(\d+\.?\d*)$/);
  if (matchLt) {
    const val = Number(record[matchLt[1]] ?? NaN);
    return !Number.isNaN(val) && val < Number(matchLt[2]);
  }
  return true; // 不明な形式は通過
}

/** レコードから指定フィールドだけ抽出 */
export function extractFields(record, fieldNames) {
  const result = {};
  for (const name of fieldNames) {
    if (name in record) {
      result[name] = record[name];
    }
  }
  return result;
}

/** 入力データをパース（JSON配列/オブジェクトの配列/改行区切りJSON） */
export function parseInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'object' && parsed !== null) {
      // オブジェクトの場合は values や data キーを探す
      for (const key of ['values', 'data', 'records', 'items', 'results', 'booths']) {
        if (Array.isArray(parsed[key])) return parsed[key];
      }
      // 単一レコードとして扱う
      return [parsed];
    }
  } catch {
    // JSONパース失敗→改行区切りJSONを試す
    const lines = trimmed.split('\n').filter(l => l.trim());
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { /* 非JSON行はスキップ */ }
    }
    if (records.length > 0) return records;
  }
  return [];
}

/** CLIメイン */
export async function runCli(argv, deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr, fsRead = (p) => fs.readFileSync(p, 'utf8') } = deps;
  const options = parseArgs(argv);

  if (options.help) {
    stdout.write(`使い方: node tools/booth-data-extract.mjs [options]

オプション:
  --input <file>     入力JSONファイル（省略時はstdin）
  --fields <list>    抽出フィールド（カンマ区切り、例: boothId,width,depth,cost）
  --schema <name>    スキーマ名（booth / booth_minimal）--fieldsより優先
  --filter <expr>    フィルター条件（例: boothType=="島ブース" / cost>500000）
  --out <file>       出力ファイル（省略時はstdout）
  --help, -h         このヘルプ

スキーマ定義: config/booth-data-schema.json
`);
    return 0;
  }

  // 入力読み込み
  let inputText;
  if (options.input && options.input !== '/dev/stdin') {
    try {
      inputText = fsRead(options.input);
    } catch (e) {
      stderr.write(`入力ファイルが読めません: ${options.input} (${e.message})\n`);
      return 1;
    }
  } else {
    // stdin（Node.js 24: chunkはBuffer(Uint8Array)）
    const decoder = new TextDecoder();
    const bufs = [];
    try {
      for await (const chunk of process.stdin) {
        bufs.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
      }
      bufs.push(decoder.decode()); // フラッシュ
      inputText = bufs.join('');
    } catch (e) {
      stderr.write(`stdinの読み込みに失敗しました: ${e.message}\n`);
      return 1;
    }
  }

  if (!inputText || !inputText.trim()) {
    stderr.write('入力が空です\n');
    return 1;
  }

  // レコードパース
  const records = parseInput(inputText);
  if (records.length === 0) {
    stderr.write('有効なレコードが見つかりませんでした\n');
    return 1;
  }

  // フィールド名解決
  let fieldNames;
  if (options.schema) {
    const schemas = loadBuiltinSchemas();
    fieldNames = getFieldNamesFromSchema(options.schema, schemas);
    if (fieldNames.length === 0) {
      stderr.write(`不明なスキーマです: ${options.schema}\n`);
      return 1;
    }
  } else if (options.fields) {
    fieldNames = options.fields.split(',').map(f => f.trim()).filter(Boolean);
  } else {
    // デフォルト: 全フィールドのうち主要なものだけ
    fieldNames = ['boothId', 'company', 'eventName', 'width', 'depth', 'materials', 'cost'];
  }

  // フィルター適用 + 抽出
  const extracted = [];
  let filteredCount = 0;
  for (const record of records) {
    if (evaluateFilter(record, options.filter)) {
      extracted.push(extractFields(record, fieldNames));
    } else {
      filteredCount++;
    }
  }

  const output = JSON.stringify(extracted, null, 2);

  if (options.out) {
    fs.writeFileSync(options.out, output, 'utf8');
    stdout.write(`出力: ${options.out} (${extracted.length} records, ${filteredCount} filtered out)\n`);
  } else {
    stdout.write(output + '\n');
  }

  if (extracted.length === 0) {
    stderr.write('警告: 条件に一致するレコードが1件もありませんでした\n');
    return filteredCount > 0 ? 0 : 2;
  }

  return 0;
}

// 直接実行（importされたときは起動しない）
if (import.meta.filename && import.meta.main) {
  // process.argv = [node, script.mjs, ...args] → 先頭2つ(node, script)は除去
  const skipCount = process.argv.length >= 2 ? Math.min(2, process.argv.length - 1) : 0;
  runCli(process.argv.slice(skipCount))
    .then(code => { if (code) process.exit(code); })
    .catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}