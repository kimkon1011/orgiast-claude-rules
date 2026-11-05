import fs from 'node:fs';

let src = fs.readFileSync('tools/kim-inbox.mjs', 'utf8');
const lines = src.split('\n');

// Strategy: Remove <<<<<<< ======= >>>>>>> markers, keep both sides' content.
// Then we'll need to fix structural issues (duplicate functions etc).

const result = [];
for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trim();
  if (trimmed === '<<<<<<< HEAD' || trimmed === '=======' || trimmed.startsWith('>>>>>>> origin')) {
    continue; // skip marker lines
  }
  result.push(lines[i]);
}

fs.writeFileSync('tools/kim-inbox.mjs', result.join('\n'), 'utf8');
console.log('Removed all conflict markers from kim-inbox.mjs');

// Now check for the structural issue: duplicate addItem, forwardItem functions etc
// We'll need to examine what needs fixing
const src2 = fs.readFileSync('tools/kim-inbox.mjs', 'utf8');
const addItemCount = (src2.match(/^export async function addItem/gm) || []).length;
const forwardItemCount = (src2.match(/^async function forwardItem/gm) || []).length;
console.log('addItem declarations:', addItemCount);
console.log('forwardItem declarations:', forwardItemCount);
console.log('splitInboxText:', (src2.match(/^export function splitInboxText/gm) || []).length);
console.log('isInboxNoise:', (src2.match(/^export function isInboxNoise/gm) || []).length);
console.log('seenMatching:', (src2.match(/^export function seenMatching/gm) || []).length);
console.log('spoolItem:', (src2.match(/^export function spoolItem/gm) || []).length);
console.log('drainSpool:', (src2.match(/^export async function drainSpool/gm) || []).length);