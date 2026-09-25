// 着手: Codex / 2026-09-26 — AIツール市況マップの生成器と検証。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const reportPath = path.resolve(path.dirname(scriptPath), '../docs/ai-tool-market-map.md');
const levelKeys = ['hobby', 'prosumer', 'business'];

export function loadCatalog() {
  return JSON.parse(fs.readFileSync(new URL('./ai-tool-market-catalog.json', import.meta.url), 'utf8'));
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '&#124;').replace(/\r\n|\r|\n/g, '<br>');
}

function table(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows]
    .map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n');
}

function link(url) {
  return `[${url}](<${url}>)`;
}

function priceBand([min, max]) {
  if (min === null && max === null) return '従量/要見積';
  if (min === 0 && max === 0) return '無料';
  if (max === null) return `$${min}〜`;
  return `$${min}〜$${max}`;
}

function tierPrice(tier) {
  if (typeof tier.usdMonthly === 'number') return `$${tier.usdMonthly}/月`;
  if (typeof tier.jpyMonthly === 'number') return `${tier.jpyMonthly}円/月`;
  if (typeof tier.usdPerMegapixel === 'number') return `$${tier.usdPerMegapixel}/メガピクセル`;
  return '要見積';
}

export function summarize(catalog) {
  return table(['カテゴリ', ...levelKeys], catalog.categories.map((category) => [
    category.name,
    ...levelKeys.map((level) => category.tools.filter((tool) => tool.levels.includes(level)).length),
  ])) + '\n';
}

export function renderMarkdown(catalog) {
  const sections = [
    '<!-- このファイルは tools/ai-tool-market-map.mjs --write が生成する。手で編集しない。 -->',
    '# AIツール市況マップ（商用/趣味レベル）',
    catalog.purpose,
    `調査日: ${catalog.researchedAt}`,
    catalog.caveat,
    '## 調査方法',
    catalog.method,
    '## レベル定義',
    table(['レベル', '定義'], levelKeys.map((key) => [key, catalog.levels[key]])),
    '## 商用利用の区分',
    table(['区分', '説明'], Object.entries(catalog.commercialUseValues)),
    '## 市況の全体像',
    table(['metric', 'value', 'source'], catalog.marketStats.map((stat) => [stat.metric, stat.value, link(stat.source)])),
    '## カテゴリ別マッピング',
  ];
  for (const category of catalog.categories) {
    sections.push(
      `### ${category.name}`,
      `役割: ${category.role}`,
      `ビジネス移行の条件: ${category.businessTrigger}`,
      table(['ツール', 'ベンダー', '価格帯(USD/月)', '課金単位', '商用利用', '確度'], category.tools.map((tool) => [
        tool.name, tool.vendor, priceBand(tool.priceBandUsdMonthly),
        catalog.pricingModels[tool.pricingModel], catalog.commercialUseValues[tool.commercialUse], tool.confidence,
      ])),
    );
    for (const tool of category.tools) {
      sections.push(
        `#### ${tool.name}`,
        tool.tiers.map((tier) => `- **${tier.name}**: ${tierPrice(tier)}${tier.note ? ` — ${tier.note}` : ''}`).join('\n'),
        `- 趣味レベル: ${tool.hobbyLimit}\n- ビジネスレベル: ${tool.businessNote}`,
        `出典: ${tool.sources.map(link).join(' / ')}`,
      );
    }
  }
  const sources = [...new Set(catalog.categories.flatMap((category) => category.tools.flatMap((tool) => tool.sources)))];
  sections.push(
    '## 我々の用途への示唆',
    table(['用途', '現状', '市況の最安入口', 'ギャップ'], catalog.orgLenses.map((lens) => [lens.capability, lens.current, lens.marketEntry, lens.gap])),
    '## 出典',
    sources.map((source, index) => `${index + 1}. ${link(source)}`).join('\n'),
  );
  return sections.join('\n\n') + '\n';
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && !['--summary', '--write', '--check'].includes(args[0]))) {
    console.error('使い方: node tools/ai-tool-market-map.mjs [--summary|--write|--check]');
    return 2;
  }
  const catalog = loadCatalog();
  if (args.length === 0 || args[0] === '--summary') {
    process.stdout.write(summarize(catalog));
    return 0;
  }
  const expected = renderMarkdown(catalog);
  if (args[0] === '--write') {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, expected, 'utf8');
    console.log(`${reportPath} に保存 (${expected.split('\n').length - 1}行)`);
    return 0;
  }
  let actual;
  try {
    actual = fs.readFileSync(reportPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error(`drift している: ファイルがありません: ${reportPath}\n最初の差分: 1行目\n期待値: ${JSON.stringify(expected.split('\n')[0])}\n実値: <ファイルなし>`);
    return 1;
  }
  // 改行コードだけの差は drift とみなさない。.gitattributes で LF 固定にしているが、
  // 属性追加前に checkout 済みのWindows作業ツリーには CRLF が残り得るため、
  // そこで偽の drift を出さないようにする。中身の差は従来どおり検出する。
  actual = actual.replace(/\r\n/g, '\n');
  if (actual === expected) return 0;
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  let index = 0;
  while (expectedLines[index] === actualLines[index]) index += 1;
  const display = (line) => line === undefined ? '<EOF>' : JSON.stringify(line);
  console.error(`drift している: ${reportPath}\n最初の差分: ${index + 1}行目\n期待値: ${display(expectedLines[index])}\n実値: ${display(actualLines[index])}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
