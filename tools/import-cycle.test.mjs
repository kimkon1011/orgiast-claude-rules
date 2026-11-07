// tools/ 配下の ESM の相対 import に循環がないことを検査する。
// 動的 import() を含む循環は、入口の CLI がトップレベル await で main を待つ間に
// 循環先が入口モジュールの評価完了を待ち合い、Node が exit 13 で黙って終わる。
// 単体テストは依存を注入するのでこの経路を通らず見逃す（PR #726: fleet-mail.mjs ⇄ fleet-beacon.mjs で
// 全PCの fleet-mail --send が停止。同型の eval-harness.mjs ⇄ model-scout.mjs も同時に修正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const STATIC_RE = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+\.m?js)['"]/g;
const DYNAMIC_RE = /import\(\s*['"](\.{1,2}\/[^'"]+\.m?js)['"]\s*\)/g;

// 静的 import だけの循環は評価順で解決されて止まらないが、増やさない。既存分は理由付きでここに登録する。
const KNOWN_STATIC_CYCLES = new Set([
  // hasHandoff は呼び出し時にだけ使われ、モジュール評価中には参照されない。
  'handoff-action-evidence.mjs -> handoff-quality-gate.mjs -> handoff-action-evidence.mjs',
]);

function listModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listModules(full);
    return /\.mjs$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name) ? [full] : [];
  });
}

export function buildGraph(files) {
  const graph = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const deps = new Map();
    for (const [re, kind] of [[STATIC_RE, 'static'], [DYNAMIC_RE, 'dynamic']]) {
      for (const match of text.matchAll(re)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (fs.existsSync(target) && deps.get(target) !== 'dynamic') deps.set(target, kind);
      }
    }
    graph.set(file, deps);
  }
  return graph;
}

export function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, 'active');
    stack.push(node);
    for (const [dep] of graph.get(node) ?? []) {
      if (state.get(dep) === 'active') {
        const nodes = stack.slice(stack.indexOf(dep)).concat(dep);
        const dynamic = nodes.slice(0, -1).some((from, i) => graph.get(from).get(nodes[i + 1]) === 'dynamic');
        cycles.push({ nodes, dynamic });
      } else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

const graphOf = (edges) => new Map(Object.entries(edges).map(([from, deps]) => [from, new Map(Object.entries(deps))]));

test('findCycles は相互 import を検出し、動的 import を含むかを区別する', () => {
  assert.deepEqual(findCycles(graphOf({ a: { b: 'dynamic' }, b: { a: 'static' } })).map((c) => c.dynamic), [true]);
  assert.deepEqual(findCycles(graphOf({ a: { b: 'static' }, b: { a: 'static' } })).map((c) => c.dynamic), [false]);
  assert.equal(findCycles(graphOf({ a: { b: 'static' }, b: {} })).length, 0);
});

test('tools/ の ESM に動的 import を含む循環がなく、静的な循環は登録済みのものだけ', () => {
  const rel = (file) => path.relative(toolsDir, file).replaceAll('\\', '/');
  const problems = findCycles(buildGraph(listModules(toolsDir)))
    .map((cycle) => ({ ...cycle, label: cycle.nodes.map(rel).join(' -> ') }))
    .filter((cycle) => cycle.dynamic || !KNOWN_STATIC_CYCLES.has(cycle.label))
    .map((cycle) => `${cycle.dynamic ? '[動的 import を含む・exit 13 の恐れ] ' : '[未登録の静的循環] '}${cycle.label}`);
  assert.deepEqual(problems, [], `import の循環:\n${problems.join('\n')}`);
});
