#!/usr/bin/env node
/**
 * improve.mjs — コード改善計画の策定と実行をオーケストレーションする
 *
 * 使用方法:
 *   node tools/improve.mjs --target <path> --plan-only          # 計画生成（強めのAIで思考）
 *   node tools/improve.mjs --plan improve-plan.json --execute    # 計画実行（安いAIで実装）
 *   node tools/improve.mjs --plan improve-plan.json --ids IMP-001,IMP-003  # 特定項目のみ実行
 *   node tools/improve.mjs --target <path> --execute             # 計画生成→即実行
 *
 * X-0035: 高コストAIを計画策定フェーズに限定して費用を抑える
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLM_ASK = path.join(ROOT, 'tools', 'llm-ask.mjs');
const CODEX_DO = path.join(ROOT, 'tools', 'codex-do.mjs');
const GENSKARK_PROXY_STRONG = 'genspark'; // genspark proxy は opus 級モデルをサポート
const GENSKARK_MODEL = 'claude-opus-5';

// ============================================================
// ヘルパー
// ============================================================

function usage(exitCode = 0) {
  console.log(`使用法:
  node tools/improve.mjs --target <path> --plan-only [--cwd <dir>] [--output <file>]
  node tools/improve.mjs --plan <file> [--execute] [--ids ID1,ID2] [--cwd <dir>]
  node tools/improve.mjs --target <path> --execute [--cwd <dir>] [--output <file>]

オプション:
  --target <path>    レビュー対象のファイル/ディレクトリ（--plan と排他）
  --plan <file>      既存の改善計画JSONファイルのパス（--target と排他）
  --execute          計画を実行する（codex-do に委譲）
  --plan-only        計画の生成のみ（execute の逆）
  --ids ID1,ID2      実行する改善項目IDのカンマ区切りリスト
  --output <file>    計画JSONの出力先（既定: cwd/improve-plan.json）
  --cwd <dir>        作業ディレクトリ（codex-do に渡す。既定は process.cwd()）
  --strict           P0 かつ estimateMinutes <= 5 の項目だけ実行
  --skip-verify      実行後の検証をスキップ
  --proof <file>     実行結果のproofファイル出力先`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
  const has = (name) => argv.includes(name);
  const target = opt('--target', null);
  const planFile = opt('--plan', null);
  const execute = has('--execute');
  const planOnly = has('--plan-only');
  const idsRaw = opt('--ids', null);
  const output = opt('--output', null);
  const cwd = opt('--cwd', process.cwd());
  const strict = has('--strict');
  const skipVerify = has('--skip-verify');
  const proof = opt('--proof', null);
  const ids = idsRaw ? idsRaw.split(',').map(s => s.trim()).filter(Boolean) : null;

  if (has('--help') || has('-h')) usage(0);
  if (!target && !planFile) { console.error('--target または --plan のいずれかが必要です'); usage(1); }
  if (target && planFile) { console.error('--target と --plan は排他です'); usage(1); }

  return { target, planFile, execute, planOnly, ids, output, cwd, strict, skipVerify, proof, argv };
}

function resolvePath(p, cwd) {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** 指定パスのファイル一覧を取得（ディレクトリの場合は再帰） */
function collectTargetFiles(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];
  if (!stat.isDirectory()) throw new Error(`対象がファイルでもディレクトリでもありません: ${targetPath}`);

  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(mjs|js|ts|jsx|tsx|json|md|css|html|yml|yaml|mts|cts)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(targetPath);
  return files;
}

/** ファイルを読み、行番号付きで連結する */
function readFilesWithLines(filePaths) {
  const parts = [];
  for (const fp of filePaths) {
    const rel = path.relative(process.cwd(), fp);
    const content = fs.readFileSync(fp, 'utf-8');
    const lines = content.split('\n');
    parts.push(`## FILE: ${rel} (${lines.length} lines, ${Buffer.byteLength(content)} bytes)`);
    // 大きいファイルは先頭200行＋末尾50行に省略
    if (lines.length > 500) {
      for (let i = 0; i < 200 && i < lines.length; i++) {
        parts.push(`${i + 1}:${lines[i]}`);
      }
      parts.push(`... (${lines.length - 250} lines omitted)`);
      for (let i = Math.max(200, lines.length - 50); i < lines.length; i++) {
        parts.push(`${i + 1}:${lines[i]}`);
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        parts.push(`${i + 1}:${lines[i]}`);
      }
    }
  }
  return parts.join('\n');
}

// ============================================================
// Phase 1: 計画生成
// ============================================================

async function generatePlan(targetFiles, outputPath, cwd) {
  const fileContents = readFilesWithLines(targetFiles);
  const fileNames = targetFiles.map(f => path.relative(cwd, f));

  // genspark proxy 経由で Opus 級モデルを呼ぶ（計画策定に高コストAIを使う）
  const planPrompt = `あなたはシニアソフトウェアエンジニアです。以下のファイルをレビューし、改善計画をJSON形式で出力してください。

## レビュー観点（優先順）
1. **バグ・エラーハンドリング**: try/catch漏れ、未チェックのnull/undefined、ネットワークエラーの握り潰し
2. **パフォーマンス**: 不必要なループ、メモ化可能な計算、N+1クエリ
3. **セキュリティ**: インジェクション、認証バイパス、秘匿値の漏洩
4. **テスト不足**: 重要なロジックのテスト欠落
5. **保守性**: 重複コード、大きな関数、複雑な条件分岐
6. **非効率**: 不要なAPI呼び出し、過剰なファイルI/O

## 重要: 改善項目がない場合
改善すべき点がなければ、items を空配列にして、rationale フィールドに「改善点なし」と理由を書いてください。無理に項目を作らないでください。

## 出力形式
以下のJSONのみを出力。コードブロックや説明は一切含めない。
\`\`\`json
{
  "meta": {
    "target": "${fileNames.join(', ')}",
    "analyzedAt": "${new Date().toISOString()}",
    "model": "claude-opus-5",
    "totalFiles": ${targetFiles.length},
    "estimatedMinutes": 0
  },
  "items": [
    {
      "id": "IMP-001",
      "file": "relative/path/to/file.mjs",
      "line": 42,
      "summary": "短い説明（60字以内）",
      "category": "correctness | performance | security | test-coverage | maintainability | efficiency",
      "priority": "P0 | P1 | P2 | P3",
      "estimateMinutes": 5,
      "description": "問題の詳細説明",
      "suggestion": "修正コードのスニペット",
      "files": ["relative/path/to/file.mjs"]
    }
  ],
  "rationale": "全体的な所感、または改善点なしの理由"
}
\`\`\`

## 優先度基準
- **P0**: 実際のバグ、データ欠損、クラッシュ、セキュリティホール。確実なバグのみ。
- **P1**: パフォーマンス問題、テスト不足の重要ロジック、エッジケースのバグ。
- **P2**: リファクタリング候補、可読性改善、保守性向上。
- **P3**: スタイル、命名、コメントの改善。
- **改善不要（NO-OP）**: 改善点がない場合は items を空配列に。無理に項目を作らない。

## 対象ファイル
\`\`\`
${fileContents}
\`\`\``;

  console.error(`[improve] 計画生成中... (genspark proxy / ${GENSKARK_MODEL}、${targetFiles.length} files)`);

  const result = spawnSync(process.execPath, [
    LLM_ASK, '--provider', GENSKARK_PROXY_STRONG, '--model', GENSKARK_MODEL,
    '--system', 'あなたはコードレビューの専門家。JSONのみを出力し、説明は一切含めない。',
    '--max', '8192',
    planPrompt,
  ], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 300_000, // 5分
    windowsHide: true,
  });

  if (result.error) {
    // genspark が使えない場合は deepseek にフォールバック
    console.error(`[improve] genspark 呼び出し失敗: ${result.error.message}`);
    console.error(`[improve] deepseek にフォールバックします`);
    return await fallbackGeneratePlan(targetFiles, fileContents, fileNames, outputPath, cwd);
  }

  if (result.status !== 0) {
    console.error(`[improve] plan generation failed (exit ${result.status}): ${result.stderr}`);
    return await fallbackGeneratePlan(targetFiles, fileContents, fileNames, outputPath, cwd);
  }

  const output = (result.stdout || '').trim();
  return writePlanFromOutput(output, outputPath, targetFiles.length, fileNames);
}

async function fallbackGeneratePlan(targetFiles, fileContents, fileNames, outputPath, cwd) {
  console.error(`[improve] deepseek で計画生成（安価フォールバック）...`);
  const planPrompt = `以下のコードをレビューし、改善計画をJSONで出力してください。改善点がなければ items を空配列に。

${fileContents}

出力は以下のJSONのみ。コードブロック不要。
{"meta":{"target":"${fileNames.join(', ')}","analyzedAt":"${new Date().toISOString()}","model":"deepseek","totalFiles":${targetFiles.length},"estimatedMinutes":0},"items":[...],"rationale":"..."}`;

  const result = spawnSync(process.execPath, [
    LLM_ASK, '--provider', 'deepseek',
    '--system', 'JSON only, no explanations.',
    '--max', '8192',
    planPrompt,
  ], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 300_000,
    windowsHide: true,
  });

  if (result.status !== 0 || result.error) {
    console.error(`[improve] フォールバックも失敗: ${result.error?.message || `exit ${result.status}`}`);
    // 最低限の空計画を出力
    const empty = {
      meta: { target: fileNames.join(', '), analyzedAt: new Date().toISOString(), model: 'fallback_failed', totalFiles: targetFiles.length, estimatedMinutes: 0 },
      items: [],
      rationale: `計画生成に失敗しました（LLM呼び出しエラー）。手動レビューが必要です。`,
    };
    fs.writeFileSync(outputPath, JSON.stringify(empty, null, 2), 'utf-8');
    console.error(`[improve] 空の計画を ${outputPath} に出力しました`);
    return empty;
  }

  const output = (result.stdout || '').trim();
  return writePlanFromOutput(output, outputPath, targetFiles.length, fileNames);
}

function writePlanFromOutput(rawOutput, outputPath, totalFiles, fileNames) {
  // JSON を抽出（コードブロック内にあっても拾う）
  const jsonMatch = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/) || rawOutput.match(/{[\s\S]*"items"[\s\S]*}/);
  const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : rawOutput;

  let plan;
  try {
    plan = JSON.parse(jsonStr.trim());
  } catch (e) {
    console.error(`[improve] JSON parse error: ${e.message}`);
    console.error(`[improve] raw output (first 500): ${rawOutput.slice(0, 500)}`);
    plan = {
      meta: { target: fileNames.join(', '), analyzedAt: new Date().toISOString(), model: 'parse_error', totalFiles, estimatedMinutes: 0 },
      items: [],
      rationale: `JSONパースに失敗したため空の計画を出力します。`,
    };
  }

  if (!plan.meta) plan.meta = {};
  plan.meta.analyzedAt = plan.meta.analyzedAt || new Date().toISOString();
  plan.meta.totalFiles = totalFiles;
  if (!plan.items) plan.items = [];
  if (!plan.rationale) plan.rationale = '';

  // ID を付与
  plan.items.forEach((item, i) => {
    if (!item.id) item.id = `IMP-${String(i + 1).padStart(3, '0')}`;
  });
  // 優先度ソート（P0→P1→P2→P3）
  const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
  plan.items.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));
  plan.meta.estimatedMinutes = plan.items.reduce((sum, item) => sum + (item.estimateMinutes || 0), 0);

  fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2), 'utf-8');
  console.error(`[improve] 計画を ${outputPath} に保存（${plan.items.length} items / 計${plan.meta.estimatedMinutes}分）`);
  return plan;
}

// ============================================================
// Phase 2: 計画実行
// ============================================================

function executePlan(plan, { ids, cwd, strict, skipVerify, proof }) {
  let items = plan.items;
  if (ids) {
    const idSet = new Set(ids);
    items = items.filter(item => idSet.has(item.id));
    console.error(`[improve] ${items.length}/${plan.items.length} items を ID フィルタで選択`);
  }
  if (strict) {
    items = items.filter(item => item.priority === 'P0' && (item.estimateMinutes || 0) <= 5);
    console.error(`[improve] ${items.length}/${plan.items.length} items を strict フィルタで選択（P0 & <=5min）`);
  }

  if (items.length === 0) {
    console.error(`[improve] 実行する改善項目がありません`);
    return { executed: 0, succeeded: 0, failed: 0, skipped: 0, proof: [] };
  }

  // 作業ツリーのスナップショット（変更検証用）
  const origDiff = spawnSync('git', ['-C', cwd, 'diff', '--stat'], { encoding: 'utf-8', windowsHide: true }).stdout || '';

  const proofEntries = [];
  let succeeded = 0, failed = 0;

  for (const item of items) {
    const instruction = `${item.file}:${item.line} — ${item.summary}\n\n${item.description}\n\n修正案:\n${item.suggestion}`;
    console.error(`\n[improve] === [${item.id}] ${item.summary} (${item.file}:${item.line}, ${item.estimateMinutes || '?'}分) ===`);

    // codex-do で安いAIに実行させる
    const codexResult = spawnSync(process.execPath, [
      CODEX_DO,
      `改善: ${item.file} の ${item.summary}`,
      '--cwd', cwd,
      '--origin', 'improve-skill',
      '--timeout', String(Math.max(120, (item.estimateMinutes || 5) * 60)),
    ], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: Math.max(180_000, (item.estimateMinutes || 5) * 60_000 + 30_000),
    });

    const proofEntry = {
      id: item.id,
      file: item.file,
      summary: item.summary,
      exitCode: codexResult.status,
      error: codexResult.error?.message || null,
      stderr: (codexResult.stderr || '').slice(0, 500),
      stdout: (codexResult.stdout || '').slice(0, 500),
      timestamp: new Date().toISOString(),
    };

    if (codexResult.status === 0 && !codexResult.error) {
      succeeded++;
      proofEntry.status = 'succeeded';
      console.error(`[improve] ✅ ${item.id} 成功`);
    } else if (codexResult.status === 75) {
      // exit 75 = deferred（Codex 上限 etc.）。スキップ扱い
      proofEntry.status = 'deferred';
      console.error(`[improve] ⏸ ${item.id} 保留（Codex上限）`);
    } else {
      failed++;
      proofEntry.status = 'failed';
      console.error(`[improve] ❌ ${item.id} 失敗: ${codexResult.stderr?.slice(0, 200) || codexResult.error?.message || '不明'}`);
    }
    proofEntries.push(proofEntry);

    // 5秒待機（連続実行によるレート制限回避）
    if (items.length > 1) {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { windowsHide: true, timeout: 10_000 });
    }
  }

  // 検証
  let verifyResult = null;
  if (!skipVerify) {
    const newDiff = spawnSync('git', ['-C', cwd, 'diff', '--stat'], { encoding: 'utf-8', windowsHide: true }).stdout || '';
    verifyResult = { origDiff, newDiff };
    if (origDiff !== newDiff) {
      console.error(`[improve] 作業ツリーに変更があります（git diff 確認）`);
    }
  }

  const proofResult = { executed: items.length, succeeded, failed, skipped: items.length - succeeded - failed, entries: proofEntries, verifyResult };
  if (proof) {
    fs.writeFileSync(proof, JSON.stringify(proofResult, null, 2), 'utf-8');
    console.error(`[improve] proof を ${proof} に保存`);
  }

  return proofResult;
}

// ============================================================
// メイン
// ============================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd);
  const outputPath = args.output ? resolvePath(args.output, cwd) : path.join(cwd, 'improve-plan.json');

  if (args.target) {
    // Phase 1: 計画生成
    const targetPath = resolvePath(args.target, cwd);
    if (!fs.existsSync(targetPath)) {
      console.error(`対象パスが存在しません: ${targetPath}`);
      process.exit(1);
    }
    const files = collectTargetFiles(targetPath);
    if (files.length === 0) {
      console.error(`レビュー対象のファイルが見つかりません: ${targetPath}`);
      process.exit(1);
    }
    console.error(`[improve] 対象: ${files.length} files in ${args.target}`);

    const plan = await generatePlan(files, outputPath, cwd);

    if (args.execute) {
      console.error(`\n[improve] --- 実行フェーズ ---`);
      executePlan(plan, { ids: args.ids, cwd, strict: args.strict, skipVerify: args.skipVerify, proof: args.proof });
    }
  } else if (args.planFile) {
    // Phase 2: 計画実行（既存計画読み込み）
    const planPath = resolvePath(args.planFile, cwd);
    if (!fs.existsSync(planPath)) {
      console.error(`計画ファイルが見つかりません: ${planPath}`);
      process.exit(1);
    }
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
    console.error(`[improve] 計画を読み込み: ${plan.meta?.target || '不明'} (${plan.items.length} items)`);

    if (args.execute || args.ids || args.strict) {
      executePlan(plan, { ids: args.ids, cwd, strict: args.strict, skipVerify: args.skipVerify, proof: args.proof });
    } else {
      console.error(`[improve] 計画の概要:`);
      for (const item of plan.items) {
        console.error(`  ${item.id} [${item.priority}] ${item.file}:${item.line} — ${item.summary} (${item.estimateMinutes || '?'}分)`);
      }
      console.error(`[improve] 合計 ${plan.items.length} items / 計${plan.meta.estimatedMinutes || '?'}分`);
      console.log(JSON.stringify(plan, null, 2));
    }
  }

  console.error(`[improve] 完了`);
}

main().catch(err => {
  console.error(`[improve] エラー: ${err.message}`);
  process.exit(1);
});