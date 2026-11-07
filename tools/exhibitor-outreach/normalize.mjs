function normalizeValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function normalizeExhibitors(raw) {
  const normalized = [];
  const companiesByName = new Map();

  for (const exhibitor of raw) {
    const entry = {
      name: normalizeValue(exhibitor?.name),
      booth: normalizeValue(exhibitor?.booth),
      description: normalizeValue(exhibitor?.description),
      website: normalizeValue(exhibitor?.website),
    };
    const duplicateKey = entry.name?.toLocaleLowerCase() ?? null;

    if (duplicateKey !== null && companiesByName.has(duplicateKey)) {
      const existing = companiesByName.get(duplicateKey);
      for (const field of ['booth', 'description', 'website']) {
        if (existing[field] === null && entry[field] !== null) {
          existing[field] = entry[field];
        }
      }
      continue;
    }

    normalized.push(entry);
    if (duplicateKey !== null) companiesByName.set(duplicateKey, entry);
  }

  return normalized;
}
