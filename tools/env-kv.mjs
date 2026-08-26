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

export function upsertEnvValue(text, key, value) {
  const source = String(text ?? '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const keyPattern = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linePattern = new RegExp(`^(?:export\\s+)?${keyPattern}\\s*=.*$`, 'm');
  const replacement = `${key}=${value}`;
  const match = source.match(linePattern);
  if (match) {
    if (parseEnvText(match[0])[key] === String(value)) return source;
    return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
  }
  if (!source) return replacement;
  // 末尾改行があったファイルは改行付きで返す。落とすと、後から別ツールが1行追記したときに
  // `LAST=v` + `NEXT=w` が同じ行に連結して env が壊れる。
  const endsWithNewline = source.endsWith('\n') || source.endsWith('\r');
  const separator = endsWithNewline ? '' : newline;
  return `${source}${separator}${replacement}${endsWithNewline ? newline : ''}`;
}
