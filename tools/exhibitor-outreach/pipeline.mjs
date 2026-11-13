import { analyzeSite, buildDraft } from './analyze.mjs';
import { cleanseList } from './cleanse.mjs';
import { filterContacts } from './contacts.mjs';
import { classifyFreshness } from './linkedin.mjs';
import { normalizeExhibitors } from './normalize.mjs';

export async function run(input, deps) {
  if (input?.referenceDate === undefined) throw new TypeError('referenceDate is required');

  const normalized = normalizeExhibitors(input?.exhibitors ?? []);
  const { kept, excluded } = cleanseList(normalized);
  const contactCompanies = filterContacts(kept.map((company) => ({
    ...company,
    employees: input?.employees?.[company.name],
    contacts: input?.contacts?.[company.name],
  })));
  const freshCompanies = contactCompanies
    .map((company) => ({
      ...company,
      contacts: company.contacts.filter((contact) => (
        classifyFreshness(input?.posts?.[contact.name], input.referenceDate).eligible
      )),
    }))
    .filter((company) => company.contacts.length > 0);

  const companyByName = new Map(kept.map((company) => [company.name, company]));
  const analyzed = await Promise.all(freshCompanies.map((company) => (
    analyzeSite(companyByName.get(company.name), deps)
  )));
  const analysisByName = new Map(analyzed.map((analysis) => [analysis.name, analysis]));
  const drafts = freshCompanies.flatMap((company) => company.contacts.map((contact) => ({
    company: company.name,
    contact: contact.name,
    title: contact.title,
    draft: buildDraft(contact.title, analysisByName.get(company.name), contact.name),
  })));

  return {
    summary: {
      normalized: normalized.length,
      kept: kept.length,
      excluded: excluded.length,
      contactsKept: contactCompanies.reduce((sum, company) => sum + company.contacts.length, 0),
      fresh: freshCompanies.reduce((sum, company) => sum + company.contacts.length, 0),
      analyzed: analyzed.length,
      drafts: drafts.length,
    },
    excluded,
    drafts,
  };
}
