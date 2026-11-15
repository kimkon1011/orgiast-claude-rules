#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

const ID_RE = /^seg-\d{4}$/;
const hash = text => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

export function estimateTokens(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function summary(text) {
  return [...text.replace(/\s+/gu, ' ').trim()].slice(0, 40).join('');
}

function validate(session) {
  if (!session || typeof session !== 'object') throw new Error('invalid session: expected object');
  if (typeof session.prefix !== 'string') throw new Error('invalid session: prefix must be a string');
  if (hash(session.prefix) !== session.prefixSha256) throw new Error('invalid session: prefix sha256 mismatch');
  if (!Array.isArray(session.index) || !Array.isArray(session.segments) || !session.store || typeof session.store !== 'object') {
    throw new Error('invalid session: index, segments, or store is missing');
  }
  if (session.index.length !== session.segments.length) throw new Error('invalid session: index/segments length mismatch');
  session.index.forEach((entry, i) => {
    if (!entry || !ID_RE.test(entry.id)) throw new Error(`invalid index at position ${i}: bad segment ID`);
    if (!['live', 'folded'].includes(entry.state)) throw new Error(`invalid index for ${entry.id}: bad state`);
    const original = session.store[entry.id];
    if (typeof original !== 'string') throw new Error(`missing store content for ${entry.id}`);
    if (hash(original) !== entry.sha256) throw new Error(`sha256 mismatch for ${entry.id}`);
    if (Buffer.byteLength(original, 'utf8') !== entry.bytes || estimateTokens(original) !== entry.tokens) {
      throw new Error(`metadata mismatch for ${entry.id}`);
    }
  });
}

export function createSession({ prefix, segments }) {
  if (typeof prefix !== 'string') throw new TypeError('prefix must be a string');
  if (!Array.isArray(segments) || segments.some(value => typeof value !== 'string')) throw new TypeError('segments must be a string[]');
  const store = {};
  const index = segments.map((text, i) => {
    const id = `seg-${String(i + 1).padStart(4, '0')}`;
    store[id] = text;
    return { id, summary: summary(text), sha256: hash(text), tokens: estimateTokens(text), bytes: Buffer.byteLength(text, 'utf8'), state: 'live' };
  });
  return { prefix, prefixSha256: hash(prefix), index, segments: [...segments], store };
}

function stub(entry) {
  return `[[folded:${entry.id} sha256=${entry.sha256.slice(0, 12)} tokens=${entry.tokens}]] ${entry.summary}`;
}

export function fold(session, { keepRecent, targetIds } = {}) {
  validate(session);
  if (!Number.isInteger(keepRecent) || keepRecent < 0) throw new Error('keepRecent must be a non-negative integer');
  if (targetIds !== undefined && (!Array.isArray(targetIds) || targetIds.some(id => typeof id !== 'string'))) throw new Error('targetIds must be a string[]');
  const result = clone(session);
  const eligibleEnd = Math.max(0, result.index.length - keepRecent);
  const targets = targetIds === undefined ? null : new Set(targetIds);
  if (targets) for (const id of targets) if (!result.index.some(entry => entry.id === id)) throw new Error(`unknown segment ID: ${id}`);
  result.index.forEach((entry, i) => {
    if (i >= eligibleEnd || entry.state !== 'live' || (targets && !targets.has(entry.id))) return;
    const original = result.store[entry.id];
    if (typeof original !== 'string' || hash(original) !== entry.sha256) throw new Error(`store verification failed for ${entry.id}`);
    entry.state = 'folded';
    result.segments[i] = stub(entry);
  });
  return result;
}

export function unfold(session, ids) {
  validate(session);
  if (!Array.isArray(ids)) throw new Error('ids must be an array');
  const result = clone(session);
  for (const id of ids) {
    const i = result.index.findIndex(entry => entry.id === id);
    if (i < 0) throw new Error(`unknown segment ID: ${id}`);
    const entry = result.index[i];
    const original = result.store[id];
    if (typeof original !== 'string') throw new Error(`missing store content for ${id}`);
    if (hash(original) !== entry.sha256) throw new Error(`sha256 mismatch for ${id}`);
    entry.state = 'live';
    result.segments[i] = original;
  }
  return result;
}

export function terms(text) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('und');
  const runs = normalized.match(/[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? [];
  return runs.flatMap(run => {
    if (/^[a-z0-9]+$/u.test(run)) return [run];
    const chars = [...run];
    if (chars.length < 2) return [];
    return chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
  });
}

export function search(session, query, { k } = {}) {
  validate(session);
  if (typeof query !== 'string') throw new Error('query must be a string');
  if (!Number.isInteger(k) || k < 0) throw new Error('k must be a non-negative integer');
  const needles = [...new Set(terms(query))];
  const folded = session.index.filter(entry => entry.state === 'folded').map(entry => ({
    entry,
    haystack: `${entry.summary} ${session.store[entry.id]}`.normalize('NFKC').toLocaleLowerCase('und'),
  }));
  const weightedNeedles = needles.map(term => {
    const df = folded.reduce((count, { haystack }) => count + (haystack.includes(term) ? 1 : 0), 0);
    return { term, weight: df === 0 ? 0 : Math.log(1 + folded.length / (1 + df)) };
  }).filter(({ weight }) => weight > 0);
  return folded.map(({ entry, haystack }) => {
    return { id: entry.id, score: weightedNeedles.reduce((score, { term, weight }) => score + (haystack.includes(term) ? weight : 0), 0) };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

export function stats(session) {
  validate(session);
  const prefixTokens = estimateTokens(session.prefix);
  let liveTokens = 0;
  let foldedTokens = 0;
  let originalTokens = 0;
  session.index.forEach((entry, i) => {
    originalTokens += entry.tokens;
    const current = estimateTokens(session.segments[i]);
    if (entry.state === 'live') liveTokens += current;
    else foldedTokens += current;
  });
  const foldedCount = session.index.filter(entry => entry.state === 'folded').length;
  return { totalTokens: prefixTokens + liveTokens + foldedTokens, prefixTokens, liveTokens, foldedTokens, originalTokens, foldedCount, segmentCount: session.index.length, foldRate: session.index.length ? foldedCount / session.index.length : 0, integrity: 'ok', tokenEstimate: 'ceil(UTF-8 bytes / 3); not a model-specific tokenizer' };
}

export function saveSession(dir, session) {
  validate(session);
  fs.mkdirSync(path.join(dir, 'store'), { recursive: true });
  const document = { version: 1, prefix: session.prefix, prefixSha256: session.prefixSha256, index: session.index };
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  for (const entry of session.index) fs.writeFileSync(path.join(dir, 'store', `${entry.id}.txt`), session.store[entry.id], 'utf8');
}

export function loadSession(dir) {
  let document;
  try { document = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); }
  catch (error) { throw new Error(`invalid index.json: ${error.message}`); }
  if (!document || document.version !== 1 || typeof document.prefix !== 'string' || !Array.isArray(document.index)) throw new Error('invalid index.json: unsupported or missing fields');
  const store = {};
  for (const entry of document.index) {
    if (!entry || typeof entry.id !== 'string') throw new Error('invalid index.json: segment ID is missing');
    try { store[entry.id] = fs.readFileSync(path.join(dir, 'store', `${entry.id}.txt`), 'utf8'); }
    catch (error) { throw new Error(`store read failed for ${entry.id}: ${error.message}`); }
  }
  const segments = document.index.map(entry => entry.state === 'folded' ? stub(entry) : store[entry.id]);
  const session = { prefix: document.prefix, prefixSha256: document.prefixSha256, index: document.index, segments, store };
  validate(session);
  return session;
}

function options(args) {
  const result = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) result._.push(args[i]);
    else {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`missing value for ${args[i]}`);
      result[args[i]] = args[++i];
    }
  }
  return result;
}

export function main(args = process.argv.slice(2)) {
  const opts = options(args);
  const command = opts._[0];
  if (!['stats', 'fold', 'search', 'unfold'].includes(command)) throw new Error('usage: session-fold.mjs stats|fold|search|unfold --dir <d> ...');
  if (!opts['--dir']) throw new Error('--dir is required');
  let session = loadSession(opts['--dir']);
  if (command === 'stats') console.log(JSON.stringify(stats(session), null, 2));
  if (command === 'fold') {
    session = fold(session, { keepRecent: Number(opts['--keep-recent'] ?? 0) });
    saveSession(opts['--dir'], session);
    console.log(JSON.stringify(stats(session), null, 2));
  }
  if (command === 'search') console.log(JSON.stringify(search(session, opts['--query'] ?? '', { k: Number(opts['--k'] ?? 5) }), null, 2));
  if (command === 'unfold') {
    const ids = (opts['--ids'] ?? '').split(',').filter(Boolean);
    session = unfold(session, ids);
    saveSession(opts['--dir'], session);
    console.log(JSON.stringify(ids.map(id => ({ id, text: session.store[id] })), null, 2));
  }
}

if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
