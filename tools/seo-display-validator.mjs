import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file' || argv[i] === '--registry') args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.file || !args.registry) throw new Error('Usage: node tools/seo-display-validator.mjs --file <index.html> --registry <registry.json>');
  return args;
}

const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(["'])[^"']*\\1`, 'i').test(tag);
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];

function checkKnown(id, html, css) {
  const head = html.match(/<head\b[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? '';
  const handlers = html.match(/<(?:div|span)\b[^>]*\bonclick\s*=[^>]*>|<a\b[^>]*\bhref\s*=\s*(["'])#\1[^>]*>/gi) ?? [];
  const iconButtons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi)?.filter(button => !/[a-zA-Z0-9\u3040-\u30ff\u3400-\u9fff]/u.test(button.replace(/<[^>]+>|&(?:#\d+|#x[\da-f]+|\w+);/gi, ''))) ?? [];
  const checks = {
    'SEO-001': () => /<meta\b[^>]*\bname\s*=\s*(["'])description\1/i.test(head),
    'SEO-002': () => /<html\b[^>]*\blang\s*=\s*(["'])ja\1/i.test(html),
    'SEO-003': () => /<meta\b[^>]*\bname\s*=\s*(["'])viewport\1/i.test(head),
    'SEO-004': () => tags(html, 'img').every(tag => attr(tag, 'alt')),
    'SEO-005': () => /<title\b[^>]*>\s*[^<\s][^<]*<\/title>/i.test(head),
    'SEO-006': () => /<h1\b[^>]*>/i.test(html),
    'UI-001': () => /:focus-visible\b/i.test(css),
    'UI-002': () => /--tap-size\s*:\s*(?:4[4-9]|[5-9]\d|\d{3,})px/i.test(css) || /(?:button|\.btn|\ba\b)[^{]*\{[^}]*(?:min-height|height)\s*:\s*(?:4[4-9]|[5-9]\d|\d{3,})px/is.test(css),
    'UI-003': () => iconButtons.every(button => attr(button.match(/^<button\b[^>]*>/i)?.[0] ?? '', 'aria-label')),
    'UI-004': () => handlers.every(tag => /\brole\s*=\s*(["'])(?:button|link)\1/i.test(tag))
  };
  return checks[id]?.();
}

async function linkedCss(html, htmlFile) {
  const hrefs = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1[^>]*\bhref\s*=\s*(["'])(.*?)\2[^>]*>/gi)].map(match => match[3]);
  const local = hrefs.filter(href => !/^(?:https?:|\/\/|data:)/i.test(href));
  const filename = htmlFile instanceof URL ? fileURLToPath(htmlFile) : htmlFile;
  return (await Promise.all(local.map(async href => {
    try { return await readFile(path.resolve(path.dirname(filename), href), 'utf8'); } catch { return ''; }
  }))).join('\n');
}

export async function validate({ file, registryFile }) {
  const [html, registryText] = await Promise.all([readFile(file, 'utf8'), readFile(registryFile, 'utf8')]);
  const registry = JSON.parse(registryText);
  if (!Array.isArray(registry.mistakes)) throw new Error('registry.mistakes must be an array');
  const css = await linkedCss(html, file);
  const details = registry.mistakes.map(mistake => {
    const known = checkKnown(mistake.id, html, css);
    const passed = known ?? new RegExp(mistake.expectedPattern, 'i').test(html);
    return { id: mistake.id, category: mistake.category, severity: mistake.severity, pass: passed, message: passed ? mistake.lintRule : mistake.description };
  });
  return { pass: details.every(item => item.pass), file, summary: { total: details.length, passed: details.filter(item => item.pass).length, failed: details.filter(item => !item.pass).length }, details };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(await validate({ file: args.file, registryFile: args.registry }), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(JSON.stringify({ pass: false, error: error.message })); process.exitCode = 1; });
