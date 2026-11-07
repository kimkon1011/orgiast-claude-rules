import { writeFile } from 'node:fs/promises';
import { isEntry } from '../is-entry.mjs';

const DEFAULT_APP_VERSION = '8_0';

function validateShowSlug(showSlug) {
  if (typeof showSlug !== 'string' || showSlug.trim() === '') {
    throw new TypeError('showSlug must be a non-empty string');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(showSlug)) {
    throw new TypeError('showSlug contains invalid characters');
  }
  return showSlug.trim();
}

function positiveInteger(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function stripHtml(value) {
  return text(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBooth(value) {
  return asArray(value)
    .map(item => text(typeof item === 'object' ? (item?.value ?? item?.name ?? item?.booth) : item))
    .map(item => item.replace(/randomstring$/i, '').trim())
    .filter(Boolean)
    .join(', ');
}

function hitsFrom(payload) {
  return asArray(payload?.DATA?.results?.exhibitor?.hit);
}

function extractWebsite(html) {
  const match = String(html).match(/websiteValue\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return '';
  try {
    return text(JSON.parse(`"${match[1]}"`));
  } catch {
    return text(match[1].replace(/\\\//g, '/').replace(/\\"/g, '"'));
  }
}

function wait(delayMs, signal) {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function fetchWebsite(baseUrl, appVersion, id, { signal, fetchImpl }) {
  const url = `${baseUrl}/${appVersion}/exhibitor/exhibitor-details.cfm?exhid=${encodeURIComponent(id)}`;
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return extractWebsite(await response.text());
  } catch (error) {
    if (signal?.aborted) throw error;
    return '';
  }
}

export async function fetchExhibitors(showSlug, options = {}) {
  const slug = validateShowSlug(showSlug);
  if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
  const appVersion = options.appVersion ?? DEFAULT_APP_VERSION;
  if (typeof appVersion !== 'string' || !/^\d+_\d+$/.test(appVersion)) {
    throw new TypeError('appVersion must look like 8_0');
  }
  const searchSize = positiveInteger(options.searchSize ?? 100, 'searchSize');
  const delayMs = positiveInteger(options.delayMs ?? 500, 'delayMs', { allowZero: true });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');

  const baseUrl = `https://${slug}.mapyourshow.com`;
  const pages = [];
  const rows = [];
  let total = 0;
  let offset = 0;
  let haveTotal = false;
  let detailRequests = 0;

  while (!haveTotal || offset < total) {
    const source = `${baseUrl}/${appVersion}/ajax/remote-proxy.cfm?action=search&searchtype=exhibitorgallery&searchsize=${searchSize}&start=${offset}`;
    const fetchedAt = new Date().toISOString();
    try {
      const response = await fetchImpl(source, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.SUCCESS === false) throw new Error('Map Your Show returned SUCCESS=false');
      const hits = hitsFrom(payload);
      const pageTotal = Number(payload?.DATA?.totalhits);
      if (Number.isSafeInteger(pageTotal) && pageTotal >= 0) {
        total = pageTotal;
        haveTotal = true;
      }

      const pageRows = [];
      for (const hit of hits) {
        const fields = hit?.fields ?? {};
        const id = text(fields.exhid_l);
        let website = '';
        if (id) {
          if (detailRequests > 0) await wait(delayMs, options.signal);
          detailRequests += 1;
          website = await fetchWebsite(baseUrl, appVersion, id, { signal: options.signal, fetchImpl });
        }
        const row = {
          id,
          company: text(fields.exhname_t),
          booth: cleanBooth(fields.boothsdisplay_la),
          description: stripHtml(fields.exhdesc_t),
          website,
          source,
          fetchedAt,
        };
        pageRows.push(row);
        rows.push(row);
      }
      pages.push({ offset, total, source, fetchedAt, rows: pageRows });
      offset += searchSize;
      if (hits.length < searchSize) break;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      pages.push({ offset, total, source, fetchedAt, rows: [], error: error instanceof Error ? error.message : String(error) });
      if (!haveTotal) break;
      offset += searchSize;
    }
  }

  return { total, rows, pages };
}

export async function fetchAllExhibitors(showSlug, options) {
  return (await fetchExhibitors(showSlug, options)).rows;
}

function parseCli(argv) {
  const [showSlug, ...args] = argv;
  if (!showSlug) throw new Error('Usage: node tools/exhibitor-outreach/map-your-show.mjs <show-slug> [--app-version 8_0] [--search-size 100] [--delay 500] [--output output.json]');
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !['--app-version', '--search-size', '--delay', '--output'].includes(flag)) {
      throw new Error(`Unknown or incomplete option: ${flag ?? ''}`);
    }
    values[flag] = value;
  }
  return {
    showSlug,
    output: values['--output'],
    options: {
      appVersion: values['--app-version'],
      searchSize: values['--search-size'] == null ? undefined : Number(values['--search-size']),
      delayMs: values['--delay'] == null ? undefined : Number(values['--delay']),
    },
  };
}

if (isEntry(import.meta.url)) {
  try {
    const { showSlug, output, options } = parseCli(process.argv.slice(2));
    const result = await fetchExhibitors(showSlug, options);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (output) await writeFile(output, json, 'utf8');
    else process.stdout.write(json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
