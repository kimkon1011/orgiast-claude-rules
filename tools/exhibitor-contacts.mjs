import { readFileSync, writeFileSync } from 'node:fs';
import { isEntry } from './is-entry.mjs';

// Local normalized evidence only. This does not call or authorize a provider.
export function selectContacts(input) {
  const hasEvidence = value => typeof value === 'string' && value.trim().length > 0;
  const now = Date.parse(input.referenceAt);
  if (!Number.isFinite(now) || !Array.isArray(input.contacts)) throw new Error('referenceAt and contacts required');
  const seen = new Set();
  const counts = new Map();
  return input.contacts.map(c => {
    const reasons = [];
    let status = 'review';
    if (!c.id || !c.companyId) reasons.push('missing-id');
    const key = c.id;
    if (seen.has(key)) reasons.push('duplicate-contact');
    seen.add(key);
    if (!Number.isInteger(c.employees)) reasons.push('unknown-employees');
    else if (c.employees < 25 || c.employees > 250) reasons.push('employee-range');
    if (['distributor', 'association', 'media'].includes(c.companyType)) reasons.push('excluded-company');
    else if (c.companyType !== 'manufacturer') reasons.push('unknown-company-type');
    if (c.crmStatus === 'contacted') reasons.push('already-contacted');
    else if (c.crmStatus !== 'uncontacted' || !hasEvidence(c.crmEvidence)) reasons.push('unknown-crm');
    if (!hasEvidence(c.roleEvidence) || !hasEvidence(c.boothEvidence)) reasons.push('unknown-role-or-booth-authority');
    const posts = c.posts;
    const times = Array.isArray(posts) ? posts.map(p => Date.parse(p.publishedAt)) : [];
    const sources = Array.isArray(posts) ? posts.map(p => typeof p.source === 'string' ? p.source.trim() : '') : [];
    if (c.postsStatus !== 'ok') reasons.push('posts-fetch-failed-or-unknown');
    else if (times.length !== 5 || times.some(t => !Number.isFinite(t) || t > now) || sources.some(s => !s) || new Set(sources).size !== 5) reasons.push('invalid-five-posts');
    else if (!times.some(t => now - t <= 60 * 86400000)) reasons.push('inactive');
    const exclusions = ['employee-range', 'excluded-company', 'already-contacted', 'duplicate-contact', 'inactive'];
    if (reasons.some(r => exclusions.includes(r))) status = 'excluded';
    else if (!reasons.length) {
      const count = counts.get(c.companyId) ?? 0;
      if (count >= 3) { status = 'excluded'; reasons.push('company-cap'); }
      else { status = 'eligible'; counts.set(c.companyId, count + 1); }
    }
    return { id: c.id ?? null, companyId: c.companyId ?? null, status, reasons, fetchFullProfile: status === 'eligible' };
  });
}

if (isEntry(import.meta.url)) {
  try {
    const [, , source, output] = process.argv;
    if (!source || !output) throw new Error('Usage: node tools/exhibitor-contacts.mjs input.json output.json');
    writeFileSync(output, JSON.stringify(selectContacts(JSON.parse(readFileSync(source, 'utf8'))), null, 2) + '\n');
  } catch (e) { console.error(e.message); process.exitCode = 2; }
}
