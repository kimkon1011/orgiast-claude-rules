// X-0021: Convert Codex implementation instructions into verifiable outcome contracts.
// Each contract defines: deliverable, acceptance criteria, evidence requirements, and cost limits.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);

// Outcome contract schema
export class OutcomeContract {
  constructor({ id, title, description, deliverable, criteria, evidence, costLimit, timeoutMs, maxRetries }) {
    this.id = id || crypto.randomUUID();
    this.title = title || '';
    this.description = description || '';
    this.deliverable = deliverable || '';        // What must be produced
    this.criteria = criteria || [];              // Acceptance criteria strings
    this.evidence = evidence || [];              // Evidence types required
    this.costLimit = costLimit || 0;             // Cost cap in credits/tokens
    this.timeoutMs = timeoutMs || 300000;        // Default 5 min
    this.maxRetries = maxRetries || 3;           // Default 3 retries
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  toJSON() {
    return { ...this };
  }
}

// Parse implementation instructions into an outcome contract.
// Scans instruction text for deliverable descriptions, acceptance markers, and evidence types.
export function parseInstructionsToContract(instructions, options = {}) {
  const text = String(instructions || '');
  const id = options.id;
  const title = options.title || extractTitle(text);
  const deliverable = options.deliverable || extractDeliverable(text);
  const criteria = options.criteria?.length ? options.criteria : extractCriteria(text);
  const evidence = options.evidence?.length ? options.evidence : extractEvidenceTypes(text);
  const costLimit = options.costLimit || extractCostLimit(text);
  const timeoutMs = options.timeoutMs || 300000;
  const maxRetries = options.maxRetries || 3;

  return new OutcomeContract({ id, title, description: text, deliverable, criteria, evidence, costLimit, timeoutMs, maxRetries });
}

// Save a contract to the contracts registry.
export function saveContract(contract, { contractsDir = path.join(repoDir, '.claude', 'contracts') } = {}) {
  fs.mkdirSync(contractsDir, { recursive: true });
  const file = path.join(contractsDir, `${contract.id}.json`);
  fs.writeFileSync(file, JSON.stringify(contract.toJSON(), null, 2), 'utf8');
  return file;
}

// Load a contract from the registry.
export function loadContract(id, { contractsDir = path.join(repoDir, '.claude', 'contracts') } = {}) {
  const file = path.join(contractsDir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new OutcomeContract(data);
}

// List all active contracts.
export function listContracts({ contractsDir = path.join(repoDir, '.claude', 'contracts') } = {}) {
  if (!fs.existsSync(contractsDir)) return [];
  return fs.readdirSync(contractsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(contractsDir, f), 'utf8')))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// --- Private helpers ---

function extractTitle(text) {
  const match = text.match(/^###?\s+(.+)$/m);
  return match ? match[1].trim() : text.split('\n')[0].slice(0, 80).trim();
}

function extractDeliverable(text) {
  // Look for deliverable/fix/target descriptions
  for (const prefix of ['Deliverable:', 'deliverable:', 'Fix:', 'Target:', 'What:']) {
    const match = text.match(new RegExp(`${prefix}\\s*(.+)$`, 'm'));
    if (match) return match[1].trim();
  }
  // Fallback: first sentence after "## " heading
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^###?\s+/)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].trim() && !lines[j].startsWith('#')) return lines[j].trim();
      }
    }
  }
  return text.slice(0, 120).trim();
}

function extractCriteria(text) {
  const criteria = [];
  // Collect checklist items and numbered requirements
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // Match: - [ ] something, * something, 1. something (requirements)
    if (trimmed.match(/^[-*\d+.]\s+(\[.?\]\s+)?(.+)$/)) {
      const item = trimmed.replace(/^[-*\d+.]\s+\[.?\]\s+/, '').trim();
      if (item.length > 10 && !item.match(/^(?:https?:\/\/|```)/)) {
        criteria.push(item);
      }
    }
  }
  return criteria.length ? criteria : ['Implements described functionality'];
}

function extractEvidenceTypes(text) {
  const evidence = [];
  const lower = text.toLowerCase();
  if (/\btest(s|ing)?\b/.test(lower)) evidence.push('test-pass');
  if (/\b(typecheck|type.check|typescript)\b/.test(lower)) evidence.push('type-check');
  if (/\blog(s)?\b/.test(lower)) evidence.push('log');
  if (/\b(screenshot|スクショ)\b/.test(lower)) evidence.push('screenshot');
  if (/\blint\b/.test(lower)) evidence.push('lint-pass');
  if (!evidence.length) evidence.push('test-pass');
  return evidence;
}

function extractCostLimit(text) {
  const match = text.match(/cost\s*(?:limit|上限|budget|cap)\s*[:：]?\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}