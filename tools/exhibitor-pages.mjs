import { readFileSync, writeFileSync } from 'node:fs';
import { isEntry } from './is-entry.mjs';

// Local normalized capture format; no claim about a provider's response schema.
export function extractPages(input) {
  if (!input || !Number.isSafeInteger(input.total) || input.total < 0 ||
      !Array.isArray(input.pages) || input.pages.length === 0) {
    throw new Error('total and nonempty pages are required');
  }
  const issues = [];
  const rows = [];
  const ids = new Set();
  let offset = 0;
  const pages = [...input.pages].sort((a, b) => a.offset - b.offset);
  for (const [index, page] of pages.entries()) {
    if (!Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset !== offset) {
      issues.push({ type: 'page-gap-or-overlap', page: index, expected: offset, actual: page.offset });
    }
    if (page.error) issues.push({ type: 'fetch-error', page: index, error: String(page.error) });
    if (page.total !== input.total) issues.push({ type: 'total-mismatch', page: index });
    if (!Array.isArray(page.rows)) {
      issues.push({ type: 'invalid-rows', page: index });
      continue;
    }
    for (const raw of page.rows) {
      const row = {};
      for (const key of ['id', 'company', 'booth', 'description', 'website']) {
        row[key] = typeof raw?.[key] === 'string' ? raw[key].trim() : '';
      }
      row.source = typeof page.source === 'string' ? page.source : '';
      row.fetchedAt = typeof page.fetchedAt === 'string' ? page.fetchedAt : '';
      const missing = Object.keys(row).filter(key => !row[key]);
      if (missing.length) issues.push({ type: 'missing-fields', page: index, row: rows.length, fields: missing });
      if (!/^https?:\/\//.test(row.source) || !/^https?:\/\//.test(row.website) ||
          !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.fetchedAt) ||
          !Number.isFinite(Date.parse(row.fetchedAt))) {
        issues.push({ type: 'invalid-provenance-or-url', page: index, row: rows.length });
      }
      if (row.id && ids.has(row.id)) issues.push({ type: 'duplicate-id', id: row.id });
      if (row.id) ids.add(row.id);
      rows.push(row);
    }
    offset = page.offset + page.rows.length;
  }
  if (rows.length !== input.total || ids.size !== input.total || offset !== input.total) {
    issues.push({ type: 'count-mismatch', expected: input.total, rows: rows.length, uniqueIds: ids.size, end: offset });
  }
  return { complete: issues.length === 0, total: input.total, uniqueIds: ids.size, rows, issues };
}

if (isEntry(import.meta.url)) {
  try {
    const [, , input, output] = process.argv;
    if (!input || !output) throw new Error('Usage: node tools/exhibitor-pages.mjs capture.json report.json');
    const report = extractPages(JSON.parse(readFileSync(input, 'utf8')));
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    if (!report.complete) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
