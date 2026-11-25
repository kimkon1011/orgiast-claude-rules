#!/usr/bin/env node
/**
 * Context Garbage Collection — X-0037
 *
 * Automatically identifies and folds/archives old context segments when
 * the session context window is under pressure. Integrates with:
 *   - session-fold.mjs for segment folding
 *   - context-trim.mjs for message-level trimming
 *   - tool-output-compress.mjs for compacting tool results before folding
 *
 * GC strategy:
 *   1. Fold segments oldest-first beyond `keepRecent`
 *   2. Compress large folded segments (tool outputs)
 *   3. Evict segments past `maxAge` completely (hard GC)
 *   4. Ensure prefix integrity is never violated
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSession, fold, stats, saveSession, loadSession } from './session-fold.mjs';
import { compressOutput } from './tool-output-compress.mjs';

const ONE_HOUR_MS = 3_600_000;

export function collectGarbage(session, {
  keepRecent = 6,
  maxAge = undefined,        // ms; segments older than this get evicted
  compressFolded = true,
  compressMaxTokens = 400,
  now = Date.now(),
  sessionStart = undefined,  // ms timestamp of session start
} = {}) {
  if (!session || !Array.isArray(session.index)) throw new Error('session is required');

  // Phase 1: Fold old segments (session-fold pattern)
  let result = fold(session, { keepRecent });
  const foldedCount = result.index.filter(e => e.state === 'folded').length;

  // Phase 2: Compress folded segments' stored content
  if (compressFolded && foldedCount > 0) {
    for (const entry of result.index) {
      if (entry.state === 'folded' && result.store[entry.id] && typeof result.store[entry.id] === 'string') {
        const original = result.store[entry.id];
        if (original.length > 500) {
          const compressed = compressOutput(original, { maxTokens: compressMaxTokens });
          if (compressed.length < original.length) {
            result.store[entry.id] = compressed;
            const newBytes = Buffer.byteLength(compressed, 'utf8');
            const newTokens = Math.ceil(newBytes / 3);
            entry.bytes = newBytes;
            entry.tokens = newTokens;
            entry.sha256 = crypto.createHash('sha256').update(Buffer.from(compressed, 'utf8')).digest('hex');
          }
        }
      }
    }
  }

  // Phase 3: Hard eviction of segments past maxAge
  if (maxAge !== undefined && sessionStart !== undefined) {
    const eligibleEnd = Math.max(0, result.index.length - keepRecent);
    for (let i = 0; i < eligibleEnd; i++) {
      const entry = result.index[i];
      if (entry.state !== 'folded') continue;
      const age = now - sessionStart;
      if (age > maxAge) {
        const stubText = `[[evicted: ${entry.id} age=${Math.floor(age / 1000)}s]]`;
        result.store[entry.id] = stubText;
        entry.bytes = Buffer.byteLength(stubText, 'utf8');
        entry.tokens = Math.ceil(entry.bytes / 3);
        entry.sha256 = crypto.createHash('sha256').update(Buffer.from(stubText, 'utf8')).digest('hex');
      }
    }
    // Rebuild segments to reflect eviction stubs
    for (const entry of result.index) {
      const idx = result.index.findIndex(e => e.id === entry.id);
      if (idx >= 0) {
        result.segments[idx] = result.store[entry.id];
      }
    }
  }

  return result;
}

export function gcStats(session) {
  validate(session);
  const s = stats(session);
  const foldedEntries = session.index.filter(e => e.state === 'folded');
  const liveEntries = session.index.filter(e => e.state === 'live');
  const evicted = session.index.filter(e => e.state === 'folded' && /^\[\[evicted\]\]/u.test(session.segments[session.index.findIndex(x => x.id === e.id)]));
  return {
    ...s,
    foldedCount: foldedEntries.length,
    liveCount: liveEntries.length,
    evictedCount: evicted.length,
    compressionRatio: s.originalTokens > 0 ? (s.liveTokens + s.foldedTokens) / s.originalTokens : 1,
  };
}

function validate(session) {
  if (!session || !Array.isArray(session.index)) throw new Error('invalid session object');
}

// ── CLI mode ──────────────────────────────────────────────────────
export function main(args = process.argv.slice(2)) {
  const dir = args[args.indexOf('--dir') + 1];
  if (!dir || !args.includes('--dir') || args.includes('--help')) {
    console.error('Usage: context-gc.mjs --dir <session-dir> [--keep-recent N] [--max-age-ms N]');
    process.exitCode = 1;
    return;
  }
  const keepRecent = args.includes('--keep-recent') ? Number(args[args.indexOf('--keep-recent') + 1]) : 6;
  const maxAge = args.includes('--max-age-ms') ? Number(args[args.indexOf('--max-age-ms') + 1]) : undefined;

  let session;
  try { session = loadSession(dir); } catch (error) {
    console.error(`Failed to load session: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const gcResult = collectGarbage(session, { keepRecent, maxAge, compressFolded: true });
  saveSession(dir, gcResult);
  console.log(JSON.stringify(gcStats(gcResult), null, 2));
}

import { isEntry } from './is-entry.mjs';
if (isEntry(import.meta.url)) { main(); }