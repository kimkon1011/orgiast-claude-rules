import fs from 'node:fs';

export function parseEnvText(text) {
  const values = {};
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function readEnvValue(file, key) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8'))[key] ?? ''; } catch { return ''; }
}
