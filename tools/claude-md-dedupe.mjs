// Only migrate known distributed text when its replacement is present in the index.
// Never infer that a locally edited preference is redundant.
import fs from 'node:fs';

const legacy = JSON.parse(fs.readFileSync(new URL('./claude-md-legacy.json', import.meta.url), 'utf8'));
const normalize = text => text.replace(/\r\n/g, '\n').trim();

export function dedupePreferences(current, index) {
  if (current === null) return current;
  const eligible = legacy.filter(entry => entry.requires.every(rule => index.includes(rule)));
  // Keep managed blocks out of migration, including malformed/unclosed ones.
  const parts = current.split(/(^<!-- BEGIN: オージャスト共通ルール[^\n]*\r?\n[\s\S]*?(?:^<!-- END: オージャスト共通ルール -->[^\n]*(?:\n|$)|(?![\s\S])))/gm);
  return parts.map(part => {
    if (part.startsWith('<!-- BEGIN: オージャスト共通ルール')) return part;
    return part.split(/(?=^## )/m).map(section => {
      if (eligible.some(entry => entry.kind === 'section' && normalize(section) === entry.text)) return '';
      // The initial account heading and other local preferences are preserved verbatim.
      return section.split(/(\r?\n\r?\n)/).map(paragraph =>
        eligible.some(entry => entry.kind === 'paragraph' && normalize(paragraph) === entry.text) ? '' : paragraph
      ).join('');
    }).join('');
  }).join('');
}
