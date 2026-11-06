function nullable(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function analyzeCompany(company, deps) {
  if (typeof deps?.fetchSite !== 'function') throw new TypeError('deps.fetchSite is required');
  if (typeof deps?.extract !== 'function') throw new TypeError('deps.extract is required');

  const base = { name: company?.name ?? null, sells: null, buyer: null, reason: null };
  if (company?.website == null) return { ...base, error: 'website is missing' };

  let text;
  try {
    text = await deps.fetchSite(company.website);
  } catch (error) {
    return { ...base, error: `fetchSite failed: ${errorMessage(error)}` };
  }

  try {
    const extracted = await deps.extract(text);
    const result = {
      ...base,
      sells: nullable(extracted?.sells),
      buyer: nullable(extracted?.buyer),
      reason: nullable(extracted?.reason),
    };
    const missing = ['sells', 'buyer', 'reason'].filter((key) => result[key] === null);
    return { ...result, error: missing.length ? `extract missing: ${missing.join(', ')}` : null };
  } catch (error) {
    return { ...base, error: `extract failed: ${errorMessage(error)}` };
  }
}

/**
 * Analyze plain site text using only the caller-provided extractor.
 *
 * The object form is retained for the earlier pipeline contract. New callers
 * pass a string (or null) and receive the three normalized insight fields.
 */
export function analyzeSite(siteText, deps) {
  if (typeof siteText === 'object' && siteText !== null && !Array.isArray(siteText)) {
    return analyzeCompany(siteText, deps);
  }
  if (typeof deps?.extractInsights !== 'function') {
    throw new TypeError('deps.extractInsights is required');
  }
  if (typeof siteText !== 'string' || siteText.trim() === '') {
    return { sellsTo: null, buyer: null, reason: null };
  }

  const extracted = deps.extractInsights(siteText);
  return {
    sellsTo: nullable(extracted?.sellsTo),
    buyer: nullable(extracted?.buyer),
    reason: nullable(extracted?.reason),
  };
}

export function composeDraft(analysis, recipientTitle, deps) {
  if (typeof deps?.generateDraft !== 'function') {
    throw new TypeError('deps.generateDraft is required');
  }
  return deps.generateDraft(analysis, recipientTitle);
}

const ROLE_OPENINGS = new Map([
  ['vp sales', '営業組織を率いるお立場から'],
  ['bd責任者', '事業開発を担うお立場から'],
  ['cro', '収益成長を統括するお立場から'],
  ['営業ディレクター', '営業現場を指揮するお立場から'],
  ['創業者', '事業を創業されたお立場から'],
]);

export function buildDraft(role, analysis, contactName) {
  const normalizedRole = typeof role === 'string' ? role.trim().toLocaleLowerCase() : '';
  const opening = ROLE_OPENINGS.get(normalizedRole) ?? 'ご担当のお立場から';
  const greeting = nullable(contactName) ? `${contactName.trim()}様、` : 'ご担当者様、';
  const details = [
    nullable(analysis?.sells) && `「${analysis.sells.trim()}」を提供されている点`,
    nullable(analysis?.buyer) && `主なお客様が「${analysis.buyer.trim()}」である点`,
    nullable(analysis?.reason) && `特に「${analysis.reason.trim()}」という背景`,
  ].filter(Boolean);
  const observation = details.length ? `${details.join('、')}を拝見しました。` : '';
  return `${greeting}${opening}ご連絡しました。${observation}展示会での商談機会について、短く情報交換できれば幸いです。`;
}
