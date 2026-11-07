import { analyzeSite, composeDraft } from './analyze.mjs';
import { cleanseList } from './cleanse.mjs';
import { filterContacts } from './contacts.mjs';
import { classifyFreshness } from './linkedin.mjs';
import { normalizeExhibitors } from './normalize.mjs';

function requiredDeps(deps) {
  for (const name of ['fetchSiteText', 'extractInsights', 'generateDraft']) {
    if (typeof deps?.[name] !== 'function') throw new TypeError(`deps.${name} is required`);
  }
}

function contactsForCompany(company, contacts) {
  const embedded = Array.isArray(company?.contacts) ? company.contacts : [];
  const separate = contacts.filter((contact) => (
    contact?.company === company?.name
    || contact?.companyName === company?.name
  ));
  return separate.length > 0 ? separate : embedded;
}

/** Run C1 through C5 without performing any un-injected external operation. */
export function run(fixtures, deps) {
  requiredDeps(deps);

  const exhibitors = Array.isArray(fixtures?.exhibitors) ? fixtures.exhibitors : [];
  const companies = Array.isArray(fixtures?.companies) ? fixtures.companies : [];
  const contacts = Array.isArray(fixtures?.contacts) ? fixtures.contacts : [];
  const normalized = normalizeExhibitors(exhibitors);
  const exhibitorByName = new Map(normalized.map((company) => [company.name, company]));

  const contactCandidates = companies.map((company) => ({
    ...company,
    contacts: contactsForCompany(company, contacts),
  }));
  const filtered = filterContacts(contactCandidates);
  const enriched = filtered
    .filter((company) => exhibitorByName.has(company.name))
    .map((company) => ({ ...exhibitorByName.get(company.name), ...company }));
  const { kept: cleansed } = cleanseList(enriched);

  const fresh = cleansed.flatMap((company) => company.contacts
    .filter((contact) => classifyFreshness(contact?.posts, fixtures?.referenceDate).eligible)
    .map((contact) => ({ company, contact })));

  const details = fresh.map(({ company, contact }) => {
    const siteText = company.website == null ? null : deps.fetchSiteText(company.website);
    const analysis = analyzeSite(siteText, deps);
    const draft = composeDraft(analysis, contact.title, deps);
    return {
      company: company.name,
      contact: contact.name ?? null,
      title: contact.title ?? null,
      analysis,
      draft,
    };
  });

  return {
    stages: {
      normalized: normalized.length,
      filtered: filtered.length,
      cleansed: cleansed.length,
      fresh: fresh.length,
      analyzed: details.length,
      drafted: details.length,
    },
    details,
  };
}
