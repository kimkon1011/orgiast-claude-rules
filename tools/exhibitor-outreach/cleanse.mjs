const EXCLUSION_RULES = [
  {
    reason: 'distributor',
    keywords: ['distributor', 'distribution', 'wholesale', '卸', '代理店', 'ディストリビューター'],
  },
  {
    reason: 'association',
    keywords: ['association', 'federation', 'chamber of commerce', '協会', '連盟', '組合'],
  },
  {
    reason: 'media',
    keywords: ['magazine', 'media', 'publisher', 'news', 'メディア', '出版', '新聞'],
  },
];

export function cleanseList(companies) {
  const kept = [];
  const excluded = [];

  for (const company of companies) {
    const searchable = `${company?.name ?? ''}\n${company?.description ?? ''}`.toLowerCase();
    let match = null;

    for (const rule of EXCLUSION_RULES) {
      const keyword = rule.keywords.find((candidate) => searchable.includes(candidate.toLowerCase()));
      if (keyword !== undefined) {
        match = { reason: rule.reason, keyword };
        break;
      }
    }

    if (match) excluded.push({ company, ...match });
    else kept.push(company);
  }

  return { kept, excluded };
}
