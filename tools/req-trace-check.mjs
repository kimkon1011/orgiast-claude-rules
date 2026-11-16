#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

function getLayer(id) {
  if (!id) return null;
  const match = String(id).match(/^(REQ|SPEC|TASK|TEST)-/);
  return match ? match[1] : null;
}

function isAllowedParentLayer(childLayer, parentLayer) {
  if (childLayer === 'REQ') {
    return false;
  }
  if (childLayer === 'SPEC') {
    return parentLayer === 'REQ';
  }
  if (childLayer === 'TASK') {
    return parentLayer === 'SPEC' || parentLayer === 'REQ';
  }
  if (childLayer === 'TEST') {
    return parentLayer === 'TASK' || parentLayer === 'SPEC' || parentLayer === 'REQ';
  }
  return false;
}

/**
 * Parses markdown text to extract trace table rows.
 * Only data rows from tables whose header matches "| ID | 親ID | 成果物パス | 担当 |" (whitespace insensitive)
 * outside code fences are extracted.
 */
export function parseTraceRows(mdText) {
  if (!mdText) return [];

  const lines = mdText.split(/\r?\n/);
  const rows = [];

  let inCodeBlock = false;
  let inTargetTable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check code blocks
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }

    // Check header match
    const isHeader = /^\s*\|\s*ID\s*\|\s*親ID\s*\|\s*成果物パス\s*\|\s*担当\s*\|\s*$/i.test(line);
    if (isHeader) {
      inTargetTable = true;
      continue;
    }

    if (inTargetTable) {
      if (!trimmed.startsWith('|')) {
        inTargetTable = false;
        continue;
      }

      // Skip separator line (|---|---|---|---|)
      if (/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)) {
        continue;
      }

      const rawCells = line.split('|').map(c => c.trim());
      if (rawCells[0] === '') rawCells.shift();
      if (rawCells.length > 0 && rawCells[rawCells.length - 1] === '') rawCells.pop();

      if (rawCells.length >= 4) {
        const id = rawCells[0];
        const parentIdRaw = rawCells[1];
        const artifactPath = rawCells[2];
        const assignee = rawCells[3];

        const parentIds = (!parentIdRaw || parentIdRaw === '-')
          ? []
          : parentIdRaw.split(',').map(s => s.trim()).filter(Boolean);

        rows.push({
          id,
          parentIdRaw,
          parentIds,
          artifactPath,
          assignee
        });
      }
    }
  }

  return rows;
}

/**
 * Validates trace table rows for hierarchy, orphans, uncovered REQs, duplicate IDs, missing parents,
 * and missing artifact paths.
 */
export function checkTrace(rows = [], options = {}) {
  const violations = [];

  if (!rows || rows.length === 0) {
    violations.push({
      code: 'NO_ROWS',
      id: null,
      message: 'No trace table rows found'
    });
    return violations;
  }

  const { checkPaths = false, baseDir = process.cwd() } = options;

  // 1. DUPLICATE_ID check
  const seenIds = new Set();
  const allRowIdsSet = new Set(rows.map(r => r.id));

  for (const row of rows) {
    if (seenIds.has(row.id)) {
      violations.push({
        code: 'DUPLICATE_ID',
        id: row.id,
        message: `Duplicate ID: ${row.id}`
      });
    } else {
      seenIds.add(row.id);
    }
  }

  // Map first occurrence of each row by id for parent lookup
  const rowMap = new Map();
  for (const r of rows) {
    if (!rowMap.has(r.id)) {
      rowMap.set(r.id, r);
    }
  }

  // 2. Row level checks
  for (const row of rows) {
    const layer = getLayer(row.id);

    // ORPHAN check: non-REQ element with no parent
    if (layer !== 'REQ' && row.parentIds.length === 0) {
      violations.push({
        code: 'ORPHAN',
        id: row.id,
        message: `Orphan element ${row.id} has no parent`
      });
    }

    // MISSING_PARENT & BAD_PARENT_LAYER check
    for (const pId of row.parentIds) {
      if (!allRowIdsSet.has(pId)) {
        violations.push({
          code: 'MISSING_PARENT',
          id: row.id,
          message: `Parent ${pId} missing for ${row.id}`
        });
      } else {
        const parentRow = rowMap.get(pId);
        const parentLayer = parentRow ? getLayer(parentRow.id) : null;
        if (!isAllowedParentLayer(layer, parentLayer)) {
          violations.push({
            code: 'BAD_PARENT_LAYER',
            id: row.id,
            message: `Invalid parent layer ${parentLayer} (${pId}) for ${layer} (${row.id})`
          });
        }
      }
    }

    // MISSING_ARTIFACT_PATH check
    if (!row.artifactPath || row.artifactPath.trim() === '') {
      violations.push({
        code: 'MISSING_ARTIFACT_PATH',
        id: row.id,
        message: `Artifact path is empty for ${row.id}`
      });
    } else if (checkPaths) {
      const fullPath = path.resolve(baseDir, row.artifactPath);
      if (!fs.existsSync(fullPath)) {
        violations.push({
          code: 'MISSING_ARTIFACT_PATH',
          id: row.id,
          message: `Artifact path does not exist: ${row.artifactPath}`
        });
      }
    }
  }

  // 3. UNCOVERED_REQ check
  const childrenMap = new Map();
  for (const r of rows) {
    for (const pId of r.parentIds) {
      if (!childrenMap.has(pId)) {
        childrenMap.set(pId, []);
      }
      childrenMap.get(pId).push(r.id);
    }
  }

  for (const row of rows) {
    const layer = getLayer(row.id);
    if (layer === 'REQ') {
      const visited = new Set();
      const queue = [row.id];
      let hasTask = false;
      let hasTest = false;

      while (queue.length > 0) {
        const currId = queue.shift();
        if (visited.has(currId)) continue;
        visited.add(currId);

        const currLayer = getLayer(currId);
        if (currLayer === 'TASK') hasTask = true;
        if (currLayer === 'TEST') hasTest = true;

        const children = childrenMap.get(currId) || [];
        for (const childId of children) {
          if (!visited.has(childId)) {
            queue.push(childId);
          }
        }
      }

      if (!hasTask || !hasTest) {
        violations.push({
          code: 'UNCOVERED_REQ',
          id: row.id,
          message: `REQ ${row.id} is not covered by both TASK and TEST`
        });
      }
    }
  }

  return violations;
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  let checkPaths = false;
  const filePaths = [];

  for (const arg of args) {
    if (arg === '--check-paths') {
      checkPaths = true;
    } else if (arg.startsWith('-')) {
      // Ignore or handle unknown flags if any
    } else {
      filePaths.push(arg);
    }
  }

  if (filePaths.length === 0) {
    console.error('Error: No markdown files specified.');
    process.exit(2);
  }

  const allRows = [];
  for (const fp of filePaths) {
    let content;
    try {
      content = fs.readFileSync(fp, 'utf8');
    } catch (err) {
      console.error(`Error: Cannot read file ${fp}: ${err.message}`);
      process.exit(2);
    }
    const rows = parseTraceRows(content);
    allRows.push(...rows);
  }

  const violations = checkTrace(allRows, { checkPaths });
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`[${v.code}] ${v.id ? v.id + ': ' : ''}${v.message}`);
    }
    process.exit(1);
  }

  const reqCount = allRows.filter(r => getLayer(r.id) === 'REQ').length;
  console.log(`OK: ${allRows.length} rows, ${reqCount} REQ`);
  process.exit(0);
}
