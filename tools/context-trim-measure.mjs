#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { simulate, totalTokens, missingInfoRate } from './context-trim.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE || 'C:\\Users\\USER';

/**
 * Parse a Claude Code session JSONL text into the internal message format
 * expected by context-trim.mjs's simulate().
 *
 * Each JSONL line is a JSON object with a `type` field.
 * Only lines with type "user" or "assistant" are converted; everything else
 * (metadata, attachments, etc.) is skipped.
 *
 * @param {string} text  Raw JSONL text
 * @returns {Array<{kind:'text'|'tool_result'|'tool_use', text:string, hasError?:boolean, ref?:string}>}
 */
export function parseSessionJsonl(text) {
  const messages = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // invalid JSON line – skip
      continue;
    }

    if (!obj || typeof obj !== 'object') continue;
    const type = obj.type;
    if (type !== 'user' && type !== 'assistant') continue;

    const msg = obj.message;
    if (!msg || typeof msg !== 'object') continue;

    const rawContent = msg.content;

    if (type === 'user') {
      if (typeof rawContent === 'string') {
        messages.push({ kind: 'text', text: rawContent });
      } else if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            const text = extractText(block.content);
            const hasError = block.is_error === true;
            messages.push({ kind: 'tool_result', text, hasError });
          } else if (block.type === 'text') {
            const text = typeof block.text === 'string' ? block.text : '';
            messages.push({ kind: 'text', text });
          }
          // other block types in user messages (e.g. image) are skipped
        }
      }
    } else if (type === 'assistant') {
      if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text') {
            const text = typeof block.text === 'string' ? block.text : '';
            messages.push({ kind: 'text', text });
          } else if (block.type === 'tool_use') {
            const text = typeof block.input !== 'undefined'
              ? JSON.stringify(block.input)
              : '';
            messages.push({ kind: 'tool_use', text });
          }
          // thinking blocks are skipped
        }
      }
    }
  }
  return messages;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => (block && typeof block.text === 'string' ? block.text : ''))
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  // fallback: stringify
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/**
 * Select representative JSONL log files from a root directory.
 *
 * Walks root recursively for *.jsonl files, picks the largest files
 * ensuring they come from different modification dates to get diverse
 * session logs.
 *
 * @param {string} root   Directory to search (e.g. ~/.claude/projects)
 * @param {object} [opts]
 * @param {number} [opts.min=3]         Minimum number of files to select
 * @param {number} [opts.minBytes=200000]  Minimum file size in bytes
 * @returns {{files: string[], criteria: string}}
 */
export function selectLogs(root, { min = 3, minBytes = 200000 } = {}) {
  /** @type {Array<{file:string, size:number, date:string}>} */
  const entries = [];

  if (!fs.existsSync(root)) {
    return { files: [], criteria: `root not found: ${root}` };
  }

  function walk(dir) {
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const fullPath = path.join(dir, child.name);
      if (child.isDirectory()) {
        walk(fullPath);
      } else if (child.isFile() && child.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size >= minBytes) {
            const mtime = stat.mtime;
            const date = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')}`;
            entries.push({ file: fullPath, size: stat.size, date });
          }
        } catch {
          // permission issue or similar – skip
        }
      }
    }
  }

  walk(root);

  // Sort by size descending
  entries.sort((a, b) => b.size - a.size);

  // First pass: pick the largest file from each date
  const seenDates = new Set();
  const selected = [];

  for (const entry of entries) {
    if (!seenDates.has(entry.date)) {
      seenDates.add(entry.date);
      selected.push(entry);
    }
  }

  // Second pass: if we need more, add remaining by size order
  if (selected.length < min) {
    const selectedPaths = new Set(selected.map(e => e.file));
    for (const entry of entries) {
      if (selectedPaths.has(entry.file)) continue;
      selected.push(entry);
      if (selected.length >= min) break;
    }
  }

  const criteria = `selectLogs(root=${root}, min=${min}, minBytes=${minBytes}): ` +
    `found ${entries.length} eligible files across ${new Set(entries.map(e => e.date)).size} dates, ` +
    `selected ${selected.length} files from ${seenDates.size} unique dates`;

  return {
    files: selected.map(e => e.file),
    criteria,
  };
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

export function parseArgs(argv) {
  const args = argv ?? process.argv.slice(2);
  const opts = {
    keepRecent: 6,
    maxChars: 400,
    protectErrors: true,
    recent: 6,
    progressiveMaxChars: 800,
    progressiveThreshold: 0.2,
    minChars: 200,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--root':
        opts.root = args[++i];
        break;
      case '--files':
        opts.files = args[++i];
        break;
      case '--window':
        opts.window = parseInt(args[++i], 10);
        break;
      case '--json':
        opts.json = true;
        break;
      case '--max-messages':
        opts.maxMessages = parseInt(args[++i], 10);
        break;
      case '--keep-recent':
        opts.keepRecent = parseInt(args[++i], 10);
        break;
      case '--max-chars':
        opts.maxChars = parseInt(args[++i], 10);
        break;
      case '--no-protect-errors':
        opts.protectErrors = false;
        break;
      case '--recent':
        opts.recent = parseInt(args[++i], 10);
        break;
      case '--progressive-max-chars':
        opts.progressiveMaxChars = parseInt(args[++i], 10);
        break;
      case '--progressive-threshold':
        opts.progressiveThreshold = parseFloat(args[++i]);
        break;
      case '--min-chars':
        opts.minChars = parseInt(args[++i], 10);
        break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const root = opts.root || path.join(HOME, '.claude', 'projects');
  const windowTokens = opts.window || 200000;
  const outputJson = opts.json || false;
  const maxMessages = opts.maxMessages || 600;

  let files;
  let criteria;

  if (opts.files) {
    files = opts.files.split(',').map(f => f.trim()).filter(Boolean);
    criteria = `explicit file list: ${files.length} file(s)`;
  } else {
    const result = selectLogs(root, { min: 3, minBytes: 200000 });
    files = result.files;
    criteria = result.criteria;
  }

  if (files.length === 0) {
    const msg = 'No log files found.';
    if (outputJson) {
      process.stdout.write(JSON.stringify({ error: msg, criteria }) + '\n');
    } else {
      process.stdout.write(`${msg}\ncriteria: ${criteria}\n`);
    }
    process.exit(1);
  }

  const simOpts = {
    windowTokens,
    threshold: 0.8,
    keepRecent: opts.keepRecent ?? 6,
    maxChars: opts.maxChars ?? 400,
    protectErrors: opts.protectErrors !== false,
  };
  const progressiveOpts = {
    windowTokens,
    progressiveThreshold: opts.progressiveThreshold ?? 0.2,
    keepRecent: opts.keepRecent ?? 6,
    progressiveMaxChars: opts.progressiveMaxChars ?? 800,
    minChars: opts.minChars ?? 200,
    protectErrors: opts.protectErrors !== false,
  };
  const missingRecent = opts.recent ?? 6;

  const results = [];
  let totalNone = 0;
  let totalBulk = 0;
  let totalProgressive = 0;
  let totalEveryTurn = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const messages = parseSessionJsonl(raw);

    // Limit messages to keep simulation fast
    const limited = messages.length > maxMessages
      ? messages.slice(0, maxMessages)
      : messages;

    const noneResult = simulate(limited, 'none', simOpts);
    const bulkResult = simulate(limited, 'bulk', simOpts);
    const progressiveResult = simulate(limited, 'progressive', progressiveOpts);
    const everyTurnResult = simulate(limited, 'everyTurn', simOpts);

    totalNone += noneResult.cumulativeInputTokens;
    totalBulk += bulkResult.cumulativeInputTokens;
    totalProgressive += progressiveResult.cumulativeInputTokens;
    totalEveryTurn += everyTurnResult.cumulativeInputTokens;

    const bulkReduction = noneResult.cumulativeInputTokens > 0
      ? ((1 - bulkResult.cumulativeInputTokens / noneResult.cumulativeInputTokens) * 100).toFixed(1)
      : '0.0';
    const progressiveReduction = noneResult.cumulativeInputTokens > 0
      ? ((1 - progressiveResult.cumulativeInputTokens / noneResult.cumulativeInputTokens) * 100).toFixed(1)
      : '0.0';
    const everyTurnReduction = noneResult.cumulativeInputTokens > 0
      ? ((1 - everyTurnResult.cumulativeInputTokens / noneResult.cumulativeInputTokens) * 100).toFixed(1)
      : '0.0';

    // missing info rate for bulk, progressive, and everyTurn
    const bulkMissing = missingInfoRate(limited, bulkResult.finalMessages, { recent: missingRecent });
    const progressiveMissing = missingInfoRate(limited, progressiveResult.finalMessages, { recent: missingRecent });
    const everyTurnMissing = missingInfoRate(limited, everyTurnResult.finalMessages, { recent: missingRecent });

    results.push({
      file: path.basename(file),
      filePath: file,
      messagesTotal: messages.length,
      messagesUsed: limited.length,
      cumulativeNone: noneResult.cumulativeInputTokens,
      cumulativeBulk: bulkResult.cumulativeInputTokens,
      cumulativeProgressive: progressiveResult.cumulativeInputTokens,
      cumulativeEveryTurn: everyTurnResult.cumulativeInputTokens,
      bulkReductionPct: parseFloat(bulkReduction),
      progressiveReductionPct: parseFloat(progressiveReduction),
      everyTurnReductionPct: parseFloat(everyTurnReduction),
      missingInfoRateBulk: bulkMissing,
      missingInfoRateProgressive: progressiveMissing,
      missingInfoRateEveryTurn: everyTurnMissing,
    });
  }

  const overallBulkReduction = totalNone > 0
    ? ((1 - totalBulk / totalNone) * 100).toFixed(1)
    : '0.0';
  const overallProgressiveReduction = totalNone > 0
    ? ((1 - totalProgressive / totalNone) * 100).toFixed(1)
    : '0.0';
  const overallEveryTurnReduction = totalNone > 0
    ? ((1 - totalEveryTurn / totalNone) * 100).toFixed(1)
    : '0.0';

  const missingInfoRateBulkAvg = results.length > 0
    ? results.reduce((sum, r) => sum + r.missingInfoRateBulk, 0) / results.length
    : 0;
  const missingInfoRateProgressiveAvg = results.length > 0
    ? results.reduce((sum, r) => sum + r.missingInfoRateProgressive, 0) / results.length
    : 0;
  const missingInfoRateEveryTurnAvg = results.length > 0
    ? results.reduce((sum, r) => sum + r.missingInfoRateEveryTurn, 0) / results.length
    : 0;
  const missingInfoRateProgressiveMax = results.length > 0
    ? Math.max(...results.map(r => r.missingInfoRateProgressive))
    : 0;
  const missingInfoRateEveryTurnMax = results.length > 0
    ? Math.max(...results.map(r => r.missingInfoRateEveryTurn))
    : 0;

  if (outputJson) {
    const output = {
      criteria,
      maxMessages,
      params: {
        keepRecent: simOpts.keepRecent,
        maxChars: simOpts.maxChars,
        progressiveMaxChars: progressiveOpts.progressiveMaxChars,
        progressiveThreshold: progressiveOpts.progressiveThreshold,
        minChars: progressiveOpts.minChars,
        protectErrors: simOpts.protectErrors,
        recent: missingRecent,
        windowTokens,
        threshold: 0.8,
        maxMessages,
      },
      logCount: files.length,
      logs: results,
      totals: {
        cumulativeNone: totalNone,
        cumulativeBulk: totalBulk,
        cumulativeProgressive: totalProgressive,
        cumulativeEveryTurn: totalEveryTurn,
        bulkReductionPct: parseFloat(overallBulkReduction),
        progressiveReductionPct: parseFloat(overallProgressiveReduction),
        everyTurnReductionPct: parseFloat(overallEveryTurnReduction),
        missingInfoRateBulkAvg,
        missingInfoRateProgressiveAvg,
        missingInfoRateEveryTurnAvg,
        missingInfoRateProgressiveMax,
        missingInfoRateEveryTurnMax,
      },
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    const sep = '+'.padEnd(200, '-') + '+';
    process.stdout.write(`Selection criteria: ${criteria}\n`);
    process.stdout.write(`Max messages per log: ${maxMessages}\n`);
    process.stdout.write(`Log files: ${files.length}\n`);
    process.stdout.write('\n');
    process.stdout.write(sep + '\n');
    process.stdout.write(
      `| ${'File'.padEnd(45)} | ${'Msgs'.padEnd(5)} | ${'None'.padEnd(10)} | ${'Bulk'.padEnd(10)} | ${'Prog'.padEnd(10)} | ${'EveryTurn'.padEnd(10)} | ${'Bulk%'.padEnd(6)} | ${'Prog%'.padEnd(6)} | ${'ET%'.padEnd(6)} | ${'BulkMiss'.padEnd(8)} | ${'ProgMiss'.padEnd(8)} | ${'ETMiss'.padEnd(8)} |\n`
    );
    process.stdout.write(sep + '\n');
    for (const r of results) {
      const fileLabel = r.file.length > 43 ? r.file.slice(0, 40) + '...' : r.file;
      process.stdout.write(
        `| ${fileLabel.padEnd(45)} | ${String(r.messagesUsed).padStart(5)} | ${formatNumber(r.cumulativeNone).padStart(10)} | ${formatNumber(r.cumulativeBulk).padStart(10)} | ${formatNumber(r.cumulativeProgressive).padStart(10)} | ${formatNumber(r.cumulativeEveryTurn).padStart(10)} | ${r.bulkReductionPct.toFixed(1).padStart(5)}% | ${r.progressiveReductionPct.toFixed(1).padStart(5)}% | ${r.everyTurnReductionPct.toFixed(1).padStart(5)}% | ${(r.missingInfoRateBulk * 100).toFixed(1).padStart(7)}% | ${(r.missingInfoRateProgressive * 100).toFixed(1).padStart(7)}% | ${(r.missingInfoRateEveryTurn * 100).toFixed(1).padStart(7)}% |\n`
      );
    }
    process.stdout.write(sep + '\n');
    process.stdout.write(
      `| ${'TOTAL'.padEnd(45)} | ${' '.padEnd(5)} | ${formatNumber(totalNone).padStart(10)} | ${formatNumber(totalBulk).padStart(10)} | ${formatNumber(totalProgressive).padStart(10)} | ${formatNumber(totalEveryTurn).padStart(10)} | ${overallBulkReduction.padStart(5)}% | ${overallProgressiveReduction.padStart(5)}% | ${overallEveryTurnReduction.padStart(5)}% | ${' '.padEnd(8)} | ${' '.padEnd(8)} | ${' '.padEnd(8)} |\n`
    );
    process.stdout.write(sep + '\n');
  }
}

// Run only when executed directly, not when imported by test runner
if (process.argv[1] && (process.argv[1].endsWith('context-trim-measure.mjs') || process.argv[1].endsWith('context-trim-measure'))) {
  main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
