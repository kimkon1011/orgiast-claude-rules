import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--registry' || argv[i] === '--out-dir') args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.registry || !args['out-dir']) throw new Error('Usage: node tools/mistake-to-rule.mjs --registry <registry.json> --out-dir <directory>');
  return args;
}

export async function loadRegistry(file) {
  const registry = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(registry.mistakes)) throw new Error('registry.mistakes must be an array');
  return registry;
}

function ruleText(mistake) {
  return `---\ndescription: ${mistake.id} ${mistake.description}\nsource: mistake-registry\nseverity: ${mistake.severity}\n---\n\n# ${mistake.id}\n\n- ルール: ${mistake.lintRule}\n- 制約: ${mistake.constraint}\n- 検証: ${mistake.testTemplate}\n- 例: \`${mistake.example}\`\n`;
}

function testText(mistake) {
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('${mistake.id}: generated rule metadata', () => {\n  const rule = ${JSON.stringify(mistake)};\n  assert.equal(rule.id, '${mistake.id}');\n  assert.ok(rule.lintRule);\n  assert.ok(rule.testTemplate);\n  assert.ok(rule.constraint);\n});\n`;
}

export async function generate(registry, outDir) {
  await mkdir(outDir, { recursive: true });
  const outputs = [];
  for (const mistake of registry.mistakes) {
    for (const [suffix, content] of [['md', ruleText(mistake)], ['test.mjs', testText(mistake)]]) {
      const file = path.join(outDir, `${mistake.id.toLowerCase()}.${suffix}`);
      await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
      outputs.push(file);
    }
  }
  return outputs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputs = await generate(await loadRegistry(args.registry), args['out-dir']);
  process.stdout.write(`${JSON.stringify({ generated: outputs.length, files: outputs }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
