const TARGET_TITLES = new Set([
  'vp sales',
  'vp of sales',
  'bd責任者',
  'head of bd',
  'cro',
  'chief revenue officer',
  '営業ディレクター',
  'sales director',
  '創業者',
  'founder',
  'co-founder',
]);

function isTargetContact(contact) {
  return typeof contact?.title === 'string'
    && TARGET_TITLES.has(contact.title.trim().toLocaleLowerCase());
}

export function filterContacts(companies) {
  const result = [];

  for (const company of companies) {
    if (typeof company?.employees !== 'number'
      || !Number.isFinite(company.employees)
      || company.employees < 25
      || company.employees > 250) {
      continue;
    }

    const contacts = Array.isArray(company.contacts)
      ? company.contacts.filter(isTargetContact).slice(0, 3)
      : [];

    if (contacts.length > 0) result.push({ name: company.name, contacts });
  }

  return result;
}
