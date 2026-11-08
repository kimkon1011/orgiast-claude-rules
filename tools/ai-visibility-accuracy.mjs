const FIELD_DEFINITIONS = {
  companyName: { labels: ['会社名', '法人名', 'company name'] },
  location: { labels: ['所在地', '本社所在地', '住所', 'location', 'address'] },
  foundedYear: { labels: ['設立年', '設立', '創業年', '創業', 'founded', 'established'] },
  representative: { labels: ['代表者', '代表取締役', '代表', 'representative', 'ceo'] },
};

const ALL_LABELS = Object.values(FIELD_DEFINITIONS).flatMap(({ labels }) => labels);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .trim();
}

function canonicalValue(field, value) {
  if (field === 'foundedYear') {
    const match = String(value).normalize('NFKC').trim().match(/^(\d{4})(?:年)?$/);
    if (!match) throw new TypeError('canonicalFacts.foundedYear must be a four-digit year');
    return match[1];
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`canonicalFacts.${field} must be a non-empty string`);
  }
  return normalizeText(value);
}

function parseResponse(response) {
  const observed = Object.fromEntries(Object.keys(FIELD_DEFINITIONS).map(key => [key, []]));
  const unparsed = [];
  const label = ALL_LABELS.map(escapeRegExp).join('|');
  const pattern = new RegExp(`^(${label})\\s*(?:は|が|:)\\s*(.*)$`, 'iu');
  for (const line of response.normalize('NFKC').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.trim().match(pattern);
    if (!match) { unparsed.push(line); continue; }
    const field = Object.keys(FIELD_DEFINITIONS).find(key =>
      FIELD_DEFINITIONS[key].labels.includes(match[1].toLowerCase()));
    observed[field].push(match[2].trim());
  }
  return { observed, unparsed };
}

function compare(field, actual, expected) {
  if (field === 'foundedYear') {
    const years = [...String(actual).normalize('NFKC').matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map(match => match[1]);
    return years.length === 1 && years[0] === expected && /^\s*\d{4}(?:年)?\s*$/.test(String(actual).normalize('NFKC'));
  }
  return normalizeText(actual) === expected;
}

/**
 * Deterministically checks labelled company facts in an AI response.
 * Every supplied canonical fact must be present, and every occurrence of that
 * field must exactly agree. This deliberately treats omissions as failures.
 * Input grammar: one labelled fact per line (label: value / labelはvalue).
 * Unparsed lines, unknown facts and prose are rejected, never silently ignored.
 * This is a conservative fact-record evaluator, not a natural-language verifier.
 * score is the fraction of supplied facts that match; only decision is approval.
 */
export function scoreAiVisibilityAccuracy({ response, canonicalFacts } = {}) {
  if (typeof response !== 'string') throw new TypeError('response must be a string');
  if (!canonicalFacts || typeof canonicalFacts !== 'object' || Array.isArray(canonicalFacts)) {
    throw new TypeError('canonicalFacts must be an object');
  }

  const fields = Object.keys(canonicalFacts);
  if (fields.length === 0) throw new TypeError('canonicalFacts must not be empty');
  const unsupported = fields.filter(field => !Object.hasOwn(FIELD_DEFINITIONS, field));
  if (unsupported.length) throw new TypeError(`unsupported canonical fact: ${unsupported.join(', ')}`);

  const parsed = parseResponse(response);
  const uncheckedFields = Object.keys(parsed.observed).filter(field =>
    parsed.observed[field].length && !Object.hasOwn(canonicalFacts, field));
  const details = {};
  for (const field of fields) {
    const expected = canonicalValue(field, canonicalFacts[field]);
    const observed = parsed.observed[field];
    const matches = observed.map(value => compare(field, value, expected));
    details[field] = {
      pass: observed.length > 0 && matches.every(Boolean),
      reason: observed.length === 0 ? 'missing' : matches.every(Boolean) ? 'exact-match' : 'mismatch-or-contradiction',
      observed,
    };
  }

  const matched = Object.values(details).filter(detail => detail.pass).length;
  return {
    decision: matched === fields.length && !parsed.unparsed.length && !uncheckedFields.length ? 'pass' : 'fail',
    score: matched / fields.length,
    matched,
    total: fields.length,
    details,
    unparsed: parsed.unparsed,
    uncheckedFields,
  };
}

