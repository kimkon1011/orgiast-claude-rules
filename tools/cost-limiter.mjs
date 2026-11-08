// X-0021: Manage cost limits per deliverable/contract.
// Enforces token/credit budgets and prevents runaway execution.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);

const DEFAULT_LEDGER_DIR = path.join(repoDir, '.claude', 'cost-ledger');

// Cost budget entry for a contract or task.
export class CostBudget {
  constructor({ contractId, limit, spent = 0, currency = 'credits', resetAfterMs = 86400000 }) {
    this.contractId = contractId;
    this.limit = limit;               // Maximum cost allowed
    this.spent = spent;               // Cost already spent
    this.currency = currency;
    this.resetAfterMs = resetAfterMs; // Auto-reset period
    this.startedAt = Date.now();
    this.lastSpentAt = null;
  }

  get remaining() { return Math.max(0, this.limit - this.spent); }
  get exhausted() { return this.spent >= this.limit; }
  get utilization() { return this.limit > 0 ? (this.spent / this.limit) : 0; }
}

// Load or create a budget from the cost ledger.
export function loadBudget(contractId, { ledgerDir = DEFAULT_LEDGER_DIR } = {}) {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const file = path.join(ledgerDir, `${sanitizeId(contractId)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign(new CostBudget({ contractId: '' }), data);
  } catch {
    return null;
  }
}

// Save budget to the cost ledger.
export function saveBudget(budget, { ledgerDir = DEFAULT_LEDGER_DIR } = {}) {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const file = path.join(ledgerDir, `${sanitizeId(budget.contractId)}.json`);
  fs.writeFileSync(file, JSON.stringify(budget, null, 2), 'utf8');
  return file;
}

// Get or create budget for a contract.
export function getOrCreateBudget(contractId, limit, { ledgerDir = DEFAULT_LEDGER_DIR } = {}) {
  const existing = loadBudget(contractId, { ledgerDir });
  if (existing) return existing;
  const budget = new CostBudget({ contractId, limit });
  saveBudget(budget, { ledgerDir });
  return budget;
}

// Spend cost against a budget. Returns true if within budget.
export function spend(budget, amount, { ledgerDir = DEFAULT_LEDGER_DIR } = {}) {
  budget.spent += amount;
  budget.lastSpentAt = Date.now();
  saveBudget(budget, { ledgerDir });
  return !budget.exhausted;
}

// Check if execution would be within budget before running.
export function wouldExceedBudget(budget, additionalCost = 0) {
  return (budget.spent + additionalCost) > budget.limit;
}

// Reset a budget (for periodic resets).
export function resetBudget(contractId, { ledgerDir = DEFAULT_LEDGER_DIR } = {}) {
  const budget = loadBudget(contractId, { ledgerDir });
  if (!budget) return null;
  budget.spent = 0;
  budget.startedAt = Date.now();
  budget.lastSpentAt = null;
  saveBudget(budget, { ledgerDir });
  return budget;
}

// Get cost summary for reporting.
export function costSummary({ ledgerDir = DEFAULT_LEDGER_DIR } = {}) {
  if (!fs.existsSync(ledgerDir)) return { totalSpent: 0, totalLimit: 0, contracts: [] };
  const entries = fs.readdirSync(ledgerDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(ledgerDir, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
  return {
    totalSpent: entries.reduce((s, e) => s + (e.spent || 0), 0),
    totalLimit: entries.reduce((s, e) => s + (e.limit || 0), 0),
    contracts: entries,
  };
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}