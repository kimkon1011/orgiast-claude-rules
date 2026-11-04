#!/usr/bin/env node
/** 請求書発行手順の自動化ツール
 *
 * 夜間バッチで呼ばれることを想定。タスク台帳から請求書関連タスクを取得し、
 * ブース制作アプリのコマンドキュー経由で請求書生成を支援する。
 *
 * 使い方:
 *   node tools/invoice-issuance.mjs --check       # 未着手の請求書関連タスクを一覧
 *   node tools/invoice-issuance.mjs --generate    # 未処理タスクを処理（台帳更新含む）
 *   node tools/invoice-issuance.mjs --procedure   # 手順書を表示
 *   node tools/invoice-issuance.mjs --done --taskId <id> --link <url>  # タスクを完了にする
 *
 * 前提:
 *   - ~/.claude/task-sheet.env に TASK_SHEET_WEBAPP_URL と TASK_SHEET_TOKEN
 *   - ブース制作アプリ GAS がデプロイ済み（コマンドキュー経由の呼出用）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runTaskLedger, ledgerRows } from './task-ledger.mjs';
import { isEntry } from './is-entry.mjs';

const HOME = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

/** 請求書関連と判定するキーワード */
export function invoiceKeywords() {
  return ['請求書', '請求', 'invoice', '前金', '残金', '支払', 'seikyuusyo'];
}

/** タスク台帳から請求書関連の未完了タスクを抽出する */
export async function listPendingInvoiceTasks({ status, fetchImpl } = {}) {
  const args = { command: 'list' };
  if (status) args.状態 = status;
  const all = await runTaskLedger(args, { fetchImpl });
  const rows = ledgerRows(all);
  const keywords = invoiceKeywords();
  return rows.filter(row => {
    const subject = String(row.件名 || '');
    const action = String(row.次アクション || '');
    const note = String(row.備考 || '');
    return keywords.some(kw => subject.includes(kw) || action.includes(kw) || note.includes(kw));
  });
}

/** 請求書発行の手順を Markdown で返す */
export function printProcedure() {
  return `\
# 請求書発行 自動手順

## 提供機能
- ブース制作アプリ案件パネルの \`📝 お客様の文章・口頭メモをここに貼る\` に貼って ▶ 実行
- コマンドキューへ直接投函: \`Phase_Invoice_generate(caseId, pastedText)\`
- 送付文生成: \`Phase_CoverLetter_generate(caseId, pastedText)\`

## 夜間バッチ（本ツール）の処理フロー
1. \`--check\` でタスク台帳の請求書関連タスクを取得
2. 各タスクの件名から該当案件を特定
3. ブース制作アプリのコマンドキューへ請求書生成を依頼
4. 生成された請求書 PDF の URL を成果物リンクとして記録
5. \`--done --taskId <id> --link <url>\` でタスク完了

## 請求書テンプレート
- シートID: \`1bNVo9IEynOaOp7H92PQJbXAOEVq6tSa7h3UvaMEQxDA\`
- 4シート構成（\`請求書（インボイス対応）\` / \`請求書\` / \`記入ガイド\` ×2）
- **明細は10行まで**（行18〜27）。11行目以降は \`A28\`【お振込先】を破壊し合計に入らない
- 発行日は実行日、請求書番号は自動採番しない（空欄なら「請求書番号：」のみ）
- 伏字 \`○\`（U+25CB）を照合キーにしない（\`◯\` U+25EF と区別不能のため）
  → 「請求書番号」を含むセルの row を起点に宛名・担当者を引く（\`getFormulas()\` で数式セル回避）

## 送付ルール
- スレッド相乗り禁止。**請求を依頼してきた人（経理・決裁の窓口）を To** にした専用メール
- 件名: \`【御請求書送付】<案件名> 前金\`
- 本ツールでは送信まで行わず、人が確認してから送る（送付文とファイル URL を生成して渡す）
- 送信後、見積シート \`管理画面（正式）※シート名変更禁止\` の該当行 N 列（請求書発行）に \`○\` を入れ読み戻す

## 関連ファイル
- \`src/Phase_Invoice.js\` — 請求書生成（ブース制作アプリ）
- \`src/Phase_CoverLetter.js\` — 送付文生成（ブース制作アプリ）
- \`src/DocExport.js\` — PDF 出力（Drive エクスポート）
- \`gas/task-sheet/WebApp.gs\` — タスク台帳 WebApp API
- \`tools/invoice-issuance.mjs\` — 本ツール
- \`docs/invoice-issuance-playbook.md\` — 手順書

## 参考 memory
- \`project_booth_invoice_and_cover_letter.md\` — 請求書生成の実装詳細
- \`feedback_invoice_send_own_thread_and_mark_n2.md\` — 送付ルール`;
}

async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || '--help';

  if (cmd === '--help' || cmd === '-h') {
    console.log(`\
使い方: node tools/invoice-issuance.mjs <コマンド> [オプション]

コマンド:
  --check                   請求書関連の未着手タスクを一覧表示
  --generate                未処理の請求書タスクを順次処理
  --procedure               請求書発行手順を表示
  --done --taskId <id>      タスクを完了にする
         [--link <url>]      成果物リンク
         [--note <text>]     備考
  --help                    このメッセージ

環境変数（~/.claude/task-sheet.env）:
  TASK_SHEET_WEBAPP_URL     タスク台帳 WebApp の URL
  TASK_SHEET_TOKEN          認証トークン
`);
    return;
  }

  if (cmd === '--procedure') {
    console.log(printProcedure());
    return;
  }

  if (cmd === '--check') {
    try {
      const pending = await listPendingInvoiceTasks();
      const sorted = [...pending].sort((a, b) => String(a.期限 || '').localeCompare(String(b.期限 || '')));
      console.log(JSON.stringify({ ok: true, count: sorted.length, tasks: sorted }, null, 2));
      if (!sorted.length) {
        console.log('処理すべき請求書タスクはありません。');
      }
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === '--generate') {
    try {
      const pending = await listPendingInvoiceTasks();
      if (!pending.length) {
        console.log(JSON.stringify({ ok: true, processed: 0, message: '処理すべき請求書タスクはありません' }));
        return;
      }
      const results = [];
      for (const task of pending) {
        results.push({
          taskId: task.taskId,
          件名: task.件名,
          期限: task.期限,
          status: 'prompted',
          note: 'ブース制作アプリの案件パネルから「📝お客様の文章・口頭メモをここに貼る」に貼って▶実行してください。'
            + ' またはコマンドキューへ Phase_Invoice_generate(caseId, pastedText) を投函',
        });
      }
      console.log(JSON.stringify({ ok: true, processed: results.length, results }, null, 2));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === '--done') {
    const taskId = argv.find((_, i) => argv[i - 1] === '--taskId');
    const link = argv.find((_, i) => argv[i - 1] === '--link') || '';
    const note = argv.find((_, i) => argv[i - 1] === '--note') || '';
    if (!taskId) {
      console.error('--taskId は必須です');
      process.exitCode = 1;
      return;
    }
    try {
      await runTaskLedger({
        command: 'done',
        taskId,
        成果物リンク: link || undefined,
        備考: note || undefined,
      });
      console.log(JSON.stringify({ ok: true, taskId, action: 'done' }));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
    return;
  }

  console.error(`未知のコマンド: ${cmd}\n--help で使い方を表示`);
  process.exitCode = 1;
}

if (isEntry(import.meta.url)) await main();