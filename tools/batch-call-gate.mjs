#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Analyzes tool call entries from a JSONL session log and detects
 * patterns where the same tool is called repeatedly without interruption.
 *
 * @param {Array<{tool?: string, type?: string, name?: string}>} logEntries - parsed JSONL entries
 * @returns {Array<{tool: string, count: number, suggestion: string}>}
 */
export function analyzeCalls(logEntries) {
  const suggestions = [];
  const toolsToCheck = ['Read', 'Glob', 'Grep'];

  let currentTool = null;
  let currentCount = 0;

  for (const entry of logEntries) {
    const toolName = entry.tool || entry.name || '';
    const type = entry.type || '';

    // Track tool call entries (type: tool_use or has tool field)
    if (type === 'tool_use' || toolName) {
      const name = toolName || entry.name || '';

      if (name === currentTool) {
        currentCount++;
      } else {
        if (currentTool && currentCount >= 3 && toolsToCheck.includes(currentTool)) {
          suggestions.push({
            tool: currentTool,
            count: currentCount,
            suggestion: `${currentCount}回の${currentTool}を1回のバッチ呼出にまとめられます`
          });
        }
        currentTool = name;
        currentCount = 1;
      }
    } else {
      // Non-tool entry (user message, system message, etc.) — resets sequence
      if (currentTool && currentCount >= 3 && toolsToCheck.includes(currentTool)) {
        suggestions.push({
          tool: currentTool,
          count: currentCount,
          suggestion: `${currentCount}回の${currentTool}を1回のバッチ呼出にまとめられます`
        });
      }
      currentTool = null;
      currentCount = 0;
    }
  }

  // Check final sequence
  if (currentTool && currentCount >= 3 && toolsToCheck.includes(currentTool)) {
    suggestions.push({
      tool: currentTool,
      count: currentCount,
      suggestion: `${currentCount}回の${currentTool}を1回のバッチ呼出にまとめられます`
    });
  }

  return suggestions;
}

/**
 * CLI handler for batch-call-gate.
 * @param {string[]} args
 */
export function runCli(args = process.argv.slice(2)) {
  const checkArg = args.findIndex(a => a === '--check');
  if (checkArg === -1) {
    console.error('[ERROR] Usage: node tools/batch-call-gate.mjs --check <logfile>');
    process.exit(1);
  }

  const logfile = args[checkArg + 1];
  if (!logfile) {
    console.error('[ERROR] Missing logfile path');
    process.exit(1);
  }

  if (!fs.existsSync(logfile)) {
    console.error(`[ERROR] Log file not found: ${logfile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(logfile, 'utf8');
  const entries = content.split(/\r?\n/).filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const suggestions = analyzeCalls(entries);
  const output = JSON.stringify({ suggestions, total: suggestions.length }, null, 2);
  console.log(output);
}

// Auto-run when executed as main script
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  runCli();
}