import fs from 'node:fs';
const src = fs.readFileSync('tools/x-ai-tips-collect.mjs', 'utf8');

// 1. Add isFallback parameter to function signature
let result = src.replace(
  'export function selectProposals(items, records, state, topic, now, config) {',
  'export function selectProposals(items, records, state, topic, now, config, isFallback = false) {'
);
if (result === src) { console.error('FAIL: signature not matched'); process.exit(1); }

// 2. Replace the validation line to split fallback vs non-fallback
const oldValidation = 'if (!url || [\'author\', \'title\', \'summary\', \'steps\'].some(k => typeof item[k] !== \'string\' || !item[k].trim()) || item.purpose !== topic.purpose || !Number.isFinite(posted) || posted < +now - 2 * DAY || posted > +now || !Number.isFinite(item.likes) || item.likes < config.minLikes) { invalid++; continue; }';

const newValidation = `if (!url || ['author', 'title', 'summary', 'steps'].some(k => typeof item[k] !== 'string' || !item[k].trim()) || item.purpose !== topic.purpose) { invalid++; continue; }
    if (!isFallback && (!Number.isFinite(posted) || posted < +now - 2 * DAY || posted > +now || !Number.isFinite(item.likes) || item.likes < config.minLikes)) { invalid++; continue; }`;

result = result.replace(oldValidation, newValidation);
if (result === src) { console.error('FAIL: validation line not matched'); process.exit(1); }

// 3. Replace the push line to use x-fallback source and null for missing values
const oldPush = "added.push({ id: `X-${String(next++).padStart(4, '0')}`, createdAt: now.toISOString(), status: 'pending', title: item.title.trim(), action: item.steps.trim(), evidence: `${url} ${item.author}: ${item.summary}`, category: CATEGORIES.includes(item.category) ? item.category : 'other', confidence: 'low', purpose: topic.purpose, source: 'x', author: item.author, postedAt: item.postedAt, likes: item.likes, summary: item.summary, contentHash: hash });";

const newPush = "added.push({ id: `X-${String(next++).padStart(4, '0')}`, createdAt: now.toISOString(), status: 'pending', title: item.title.trim(), action: item.steps.trim(), evidence: `${url} ${item.author}: ${item.summary}`, category: CATEGORIES.includes(item.category) ? item.category : 'other', confidence: 'low', purpose: topic.purpose, source: isFallback ? 'x-fallback' : 'x', author: item.author, postedAt: isFallback ? (item.postedAt || null) : item.postedAt, likes: isFallback ? (Number.isFinite(item.likes) ? item.likes : null) : item.likes, summary: item.summary, contentHash: hash });";

result = result.replace(oldPush, newPush);
if (result === src) { console.error('FAIL: push line not matched'); process.exit(1); }

fs.writeFileSync('tools/x-ai-tips-collect.mjs', result, 'utf8');
console.log('OK: selectProposals updated');