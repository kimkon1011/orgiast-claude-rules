// X-0021: Persistent task state save/restore.
// Enables long-running tasks to survive session restarts and continue from last state.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);

const DEFAULT_MEMORY_DIR = path.join(repoDir, '.claude', 'task-memory');

// Task memory entry
export class TaskMemory {
  constructor({ taskId, state = {}, context = {}, progress = 0, phase = 'init', metadata = {} }) {
    this.taskId = taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.state = state;           // Current execution state
    this.context = context;       // Contextual data (PR numbers, file paths, etc.)
    this.progress = progress;     // 0.0 - 1.0 progress indicator
    this.phase = phase;           // Current phase label
    this.metadata = metadata;     // Extra metadata
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.history = [];            // { action, timestamp, detail }
  }

  // Add a checkpoint to history
  checkpoint(action, detail = '') {
    this.history.push({ action, timestamp: Date.now(), detail });
    this.updatedAt = Date.now();
  }

  // Update progress value
  setProgress(value) {
    this.progress = Math.max(0, Math.min(1, value));
    this.updatedAt = Date.now();
  }

  // Transition to a new phase
  transitionTo(phase, detail = '') {
    this.phase = phase;
    this.checkpoint('phase_transition', `→ ${phase}${detail ? ': ' + detail : ''}`);
  }

  toJSON() {
    return { ...this };
  }
}

// Save task memory to disk.
export function saveTaskMemory(memory, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, `${sanitizeId(memory.taskId)}.json`);
  memory.updatedAt = Date.now();
  fs.writeFileSync(file, JSON.stringify(memory.toJSON(), null, 2), 'utf8');
  return file;
}

// Load task memory from disk.
export function loadTaskMemory(taskId, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  const file = path.join(memoryDir, `${sanitizeId(taskId)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const memory = Object.assign(new TaskMemory({}), data);
    return memory;
  } catch {
    return null;
  }
}

// Delete task memory.
export function deleteTaskMemory(taskId, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  const file = path.join(memoryDir, `${sanitizeId(taskId)}.json`);
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    return true;
  }
  return false;
}

// List all task memories.
export function listTaskMemories({ memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  if (!fs.existsSync(memoryDir)) return [];
  return fs.readdirSync(memoryDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(memoryDir, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Find tasks by phase or status.
export function findTasksByPhase(phase, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  return listTaskMemories({ memoryDir }).filter(m => m.phase === phase);
}

// Update a field in an existing task memory without full rewrite.
export function patchTaskMemory(taskId, patch, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  const memory = loadTaskMemory(taskId, { memoryDir });
  if (!memory) return null;
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'taskId' && key !== 'createdAt') {
      memory[key] = value;
    }
  }
  memory.updatedAt = Date.now();
  saveTaskMemory(memory, { memoryDir });
  return memory;
}

// Create or resume a task memory.
export function createOrResumeTask(taskId, initialState = {}, { memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  const existing = loadTaskMemory(taskId, { memoryDir });
  if (existing) {
    existing.checkpoint('resumed', 'Task resumed from saved state');
    saveTaskMemory(existing, { memoryDir });
    return { memory: existing, isNew: false };
  }
  const memory = new TaskMemory({ taskId, state: initialState });
  saveTaskMemory(memory, { memoryDir });
  return { memory, isNew: true };
}

// Get summary of all active tasks.
export function taskSummary({ memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  const memories = listTaskMemories({ memoryDir });
  return {
    total: memories.length,
    byPhase: Object.fromEntries(
      Object.entries(
        memories.reduce((acc, m) => {
          const p = m.phase || 'unknown';
          acc[p] = (acc[p] || 0) + 1;
          return acc;
        }, {})
      ).sort((a, b) => b[1] - a[1])
    ),
    recent: memories.slice(0, 5).map(m => ({
      taskId: m.taskId,
      phase: m.phase,
      progress: m.progress,
      updatedAt: new Date(m.updatedAt).toISOString(),
    })),
  };
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}