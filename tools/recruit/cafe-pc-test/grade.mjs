import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export function normalize(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value.text !== undefined) value = value.text;
  return String(value)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/〜/g, '～')
    .trim();
}

function expectedText(expected) {
  if (expected && typeof expected === 'object' && expected.type === 'nonempty') return '空欄でないこと';
  return (Array.isArray(expected) ? expected : [expected]).join(' または ');
}

function matches(actual, expected) {
  const a = normalize(actual);
  if (expected && typeof expected === 'object' && expected.type === 'nonempty') return a.length > 0;
  return (Array.isArray(expected) ? expected : [expected]).some(e => a === normalize(e));
}

export async function gradeWorkbook(submissionPath, { pass = 0.85, keyPath = path.join(here, 'answer-key.json') } = {}) {
  const key = JSON.parse(await fs.readFile(keyPath, 'utf8'));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(submissionPath);
  const ws = wb.getWorksheet(key.sheet);
  if (!ws) throw new Error(`シート「${key.sheet}」がありません`);
  const errors = []; let score = 0; let maximum = 0;
  for (let r = 0; r < key.rows.length; r++) {
    for (let c = 0; c < key.columns.length; c++) {
      const points = key.points[c]; maximum += points;
      const actual = ws.getCell(key.firstDataRow + r, c + 1).value;
      const expected = key.rows[r][c];
      if (matches(actual, expected)) score += points;
      else errors.push({
        cell: ws.getCell(key.firstDataRow + r, c + 1).address,
        item: key.columns[c], pointsLost: points, expected: expectedText(expected),
        actual: normalize(actual), rule: key.rules[c]
      });
    }
  }
  const ratio = maximum ? score / maximum : 0;
  return { score, maximum, ratio, passLine: pass, passed: ratio >= pass, errors };
}

function parseArgs(argv) {
  let file; let json = false; let pass = 0.85;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--pass') {
      pass = Number(argv[++i]);
      if (!Number.isFinite(pass) || pass < 0 || pass > 1) throw new Error('--pass は0～1で指定してください');
    } else if (argv[i].startsWith('--')) throw new Error(`不明なオプション: ${argv[i]}`);
    else if (!file) file = argv[i]; else throw new Error('提出ファイルは1つだけ指定してください');
  }
  if (!file) throw new Error('使い方: node grade.mjs <提出xlsxのパス> [--json] [--pass 0.85]');
  return { file: path.resolve(file), json, pass };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2)); const result = await gradeWorkbook(args.file, { pass: args.pass });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`合計点: ${result.score}/${result.maximum} (${(result.ratio * 100).toFixed(1)}%)`);
      console.log(`判定: ${result.passed ? '合格' : '不合格'}（合格ライン ${(result.passLine * 100).toFixed(1)}%）`);
      if (result.errors.length) {
        console.log('\n誤り一覧:');
        for (const e of result.errors) console.log(`- ${e.cell} ${e.item}: 期待「${e.expected}」/ 入力「${e.actual || '(空欄)'}」/ -${e.pointsLost}点 / ルール: ${e.rule}`);
      } else console.log('誤りはありません。');
    }
  } catch (error) { console.error(`採点できませんでした: ${error.message}`); process.exitCode = 1; }
}
