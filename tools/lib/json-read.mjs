import fs from 'node:fs';

export function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '');
}

export function parseJsonLoose(text, { source = 'JSON input' } = {}) {
  const cleaned = stripBom(text);
  let originalError;
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    originalError = error;
  }

  const starts = [...cleaned.matchAll(/[\[{]/g)].map(match => match.index);
  for (const start of starts) {
    const end = cleaned.lastIndexOf(cleaned[start] === '{' ? '}' : ']');
    if (end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // Try the next object/array start; log prefixes such as "[info]" are not JSON.
      }
    }
  }

  throw new SyntaxError(`${originalError.message} (source: ${source})`, { cause: originalError });
}

export function readJsonFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return parseJsonLoose(buffer.toString('utf8'), { source: filePath });
}
