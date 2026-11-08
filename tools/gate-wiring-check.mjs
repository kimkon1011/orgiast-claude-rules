#!/usr/bin/env node
// 2026-10-10: handoff-action-gate / shallow-answer-gate を stop-gate-runner に配線したのに
// gate-rollout-manifest.json への登録を忘れ、rolloutMode() が常に 'warn' を返して
// 応答を一度も止めなかった（配線しただけで動くと誤認した）。
// 「runner に登録した」「マニフェストに登録した」の2箇所が食い違っていないかを機械的に検査する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));

// tools/gate-runtime.mjs の applyNamedGatePolicy() が canonical 名へ寄せる対応表を写したもの。
// ここを直すときは gate-runtime.mjs 側と必ず揃えること（ズレると誤検知する）。
export const GATE_NAME_NORMALIZATION = {
  'control-group-gate': 'control-group-stop-gate',
};

export function normalizeGateName(name) {
  return GATE_NAME_NORMALIZATION[name] || name;
}

// stop-gate-runner.mjs の evaluateGates() 内 `const gates = [ ['name', () => ...], ... ];` から
// 第1要素（ゲート名）だけを出現順に抽出する。
export function extractRunnerGates(source) {
  const start = source.indexOf('const gates = [');
  if (start === -1) throw new Error('stop-gate-runner.mjs に `const gates = [` が見つかりません（配線の書式が変わった可能性）');
  const tail = source.slice(start);
  const end = tail.match(/\n\s*\];/);
  if (!end) throw new Error('`const gates = [` の終端 `];` が見つかりません');
  const body = tail.slice(0, end.index);
  const names = [];
  for (const m of body.matchAll(/\[\s*['"]([^'"]+)['"]\s*,\s*(?:async\s+)?\([^)]*\)\s*=>/g)) names.push(m[1]);
  if (!names.length) throw new Error('`const gates = [` の中にゲート名を1つも検出できませんでした');
  return names;
}

// 抽出できた名前の数と、配列に並んでいる要素の数が食い違ったら書式が変わった疑い。
// 取りこぼしたまま「問題なし」を返す（＝偽の安心）のを防ぐための警告。
export function countGateEntries(source) {
  const start = source.indexOf('const gates = [');
  if (start === -1) return null;
  const tail = source.slice(start);
  const end = tail.match(/\n\s*\];/);
  if (!end) return null;
  return tail.slice(0, end.index).match(/^\s*\[\s*['"]/gm)?.length ?? 0;
}

export function readManifestGates(manifest) {
  return Object.keys(manifest?.gates || {});
}

// runnerGates: 正規化済み・重複除去。manifestGates: manifest の gates キー（キー順）。
export function analyze({ runnerSource, manifest }) {
  const rawRunnerGates = extractRunnerGates(runnerSource);
  const runnerGates = [...new Set(rawRunnerGates.map(normalizeGateName))];
  const manifestGates = readManifestGates(manifest);
  const manifestSet = new Set(manifestGates);
  const runnerSet = new Set(runnerGates);
  const entries = countGateEntries(runnerSource);
  const scanWarnings = entries !== null && entries !== rawRunnerGates.length
    ? [`gates 配列の要素数(${entries})と抽出できたゲート名(${rawRunnerGates.length})が一致しません。runner の書式が変わった可能性があるため、抽出漏れを疑ってください。`]
    : [];
  return {
    ok: runnerGates.filter(n => !manifestSet.has(n)).length === 0,
    runnerGates,
    manifestGates,
    scanWarnings,
    // runner にあるのに manifest が知らない = rolloutMode() が 'warn' に落ち、永久に block できない。
    missingFromManifest: runnerGates.filter(n => !manifestSet.has(n)),
    // manifest にあるのに runner が呼ばない = 死んだ登録（他ランナー担当の PreToolUse 等も含むので警告止まり）。
    deadInManifest: manifestGates.filter(n => !runnerSet.has(n)),
    normalized: rawRunnerGates.filter(n => normalizeGateName(n) !== n).map(n => `${n} → ${normalizeGateName(n)}`),
  };
}

export function check({ runnerPath, manifestPath }) {
  const runnerSource = fs.readFileSync(runnerPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { ...analyze({ runnerSource, manifest }), runnerPath, manifestPath };
}

export function formatReport(report) {
  const lines = [];
  lines.push('ゲート配線チェック: stop-gate-runner.mjs × gate-rollout-manifest.json');
  lines.push(`  runner:   ${report.runnerPath}`);
  lines.push(`  manifest: ${report.manifestPath}`);
  lines.push('');
  lines.push(`runner 登録ゲート: ${report.runnerGates.length} 件 / マニフェスト登録: ${report.manifestGates.length} 件`);
  if (report.normalized.length) lines.push(`正規化: ${report.normalized.join(', ')}`);
  for (const warning of report.scanWarnings || []) lines.push(`⚠ ${warning}`);
  lines.push('');

  if (report.missingFromManifest.length) {
    lines.push(`✗ runner にあるのにマニフェスト未登録: ${report.missingFromManifest.length} 件`);
    lines.push('  これらは rolloutMode() の「PC ごと7日観察」に落ちて常に warn になり、応答を止められません。');
    for (const name of report.missingFromManifest) lines.push(`  - ${name}`);
    lines.push('  直し方: tools/gate-rollout-manifest.json の "gates" に次の形で追加する');
    for (const name of report.missingFromManifest) lines.push(`    "${name}": { "rollout": "deny", "legacy": true },`);
  } else {
    lines.push('✓ runner のゲートはすべてマニフェストに登録済み（block できる状態）');
  }
  lines.push('');

  if (report.deadInManifest.length) {
    lines.push(`⚠ マニフェストにあるのに runner に無い: ${report.deadInManifest.length} 件（死んだ登録・動作に影響なし）`);
    for (const name of report.deadInManifest) lines.push(`  - ${name}`);
  } else {
    lines.push('✓ マニフェスト側に余分な登録はなし');
  }
  return lines.join('\n');
}

function usage() {
  return [
    '使い方: node tools/gate-wiring-check.mjs [--json] [--runner <path>] [--manifest <path>]',
    '  --json               機械可読な JSON を stdout に出す',
    '  --runner <path>      stop-gate-runner.mjs のパス（既定: tools/stop-gate-runner.mjs）',
    '  --manifest <path>    gate-rollout-manifest.json のパス（既定: tools/gate-rollout-manifest.json）',
    '  環境変数 GATE_WIRING_RUNNER / GATE_WIRING_MANIFEST でも差し替え可',
    '終了コード: 0=問題なし / 1=runner にあるのにマニフェスト未登録 / 2=実行エラー',
  ].join('\n');
}

export function resolvePaths(argv = [], env = process.env, baseDir = toolsDir) {
  let runnerPath = env.GATE_WIRING_RUNNER || path.join(baseDir, 'stop-gate-runner.mjs');
  let manifestPath = env.GATE_WIRING_MANIFEST || path.join(baseDir, 'gate-rollout-manifest.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runner') runnerPath = argv[++i] ?? runnerPath;
    else if (argv[i] === '--manifest') manifestPath = argv[++i] ?? manifestPath;
  }
  return { runnerPath, manifestPath };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage() + '\n'); return 0; }
  const { runnerPath, manifestPath } = resolvePaths(argv, env);
  try {
    const report = check({ runnerPath, manifestPath });
    process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n');
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = String(error?.message || error);
    process.stderr.write(json ? JSON.stringify({ ok: false, error: message }) + '\n' : `ゲート配線チェックを実行できません: ${message}\n`);
    return 2;
  }
}

if (isEntry(import.meta.url)) process.exit(main());
