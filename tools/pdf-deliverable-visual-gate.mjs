#!/usr/bin/env node
/**
 * pdf-deliverable-visual-gate.mjs — PreToolUse hook
 *
 * お客様・kim に渡す資料PDFを渡す前に、全ページを画像で目視した証跡があるか確認する。
 * gate-hook-runner.mjs から呼ばれる。標準入力に hook 入力JSON、結果を標準出力にJSONで出す。
 *
 * 通す条件:
 *   1. 証跡ファイル ~/.claude/pdf-render/evidence/<sha256>.json が存在し、renderedAt > pdf mtime
 *   2. 現在のセッション transcript に証跡の全 pngs を Read した記録がある
 *   3. 証跡の機械チェックが fatal でない（社内向け語なし）
 *
 * 逃がし弁: 直前の assistant メッセージに [PDF-VISUAL-OK: <理由20文字以上>] があれば通す
 * 例外時は fail-open（通す）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';

export const GATE_CONTRACT = { name: 'pdf-deliverable-visual-gate', remedies: [{ kind: 'repo-file', ref: 'tools/gate-remedies.md', section: 'pdf-deliverable-visual-gate' }] };

const HOME = process.env.ORGIAST_HOME || os.homedir();
const EVIDENCE_DIR = path.join(HOME, '.claude', 'pdf-render', 'evidence');

// 対象のファイル名パターン（提案・企画・見積・資料等）
const TARGET_NAME = /提案|企画|見積|資料|スライド|proposal|deck|brief/i;

// 対象の操作パターン
const SEND_USER_FILE = 'SendUserFile';
const DRIVE_CREATE_FILE = /^mcp__claude_ai_Google_Drive(?:_\d+)?__create_file$/;
const DRIVE_UPLOAD = 'drive-upload.mjs';
const GMAIL_DRAFT = 'gmail-draft.mjs';
const SEISAKU_MAIL = 'seisaku-mail.mjs';

/**
 * PDF ファイルの sha256 を計算
 */
function sha256hex(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * ファイルの更新時刻を取得
 */
function fileMtime(filePath) {
  try { return fs.statSync(filePath).mtime; } catch { return 0; }
}

/**
 * PDF ファイルかどうか、対象かどうかを判定
 * @returns {{ isTarget: boolean, pdfPath?: string, sha256?: string }}
 */
function classifyPdf(filePath) {
  if (!filePath || typeof filePath !== 'string') return { isTarget: false };
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.pdf')) return { isTarget: false };
  const basename = path.basename(lower);
  if (!TARGET_NAME.test(basename)) return { isTarget: false };
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return { isTarget: false };
  const sha256 = sha256hex(absPath);
  return { isTarget: true, pdfPath: absPath, sha256 };
}

/**
 * SendUserFile から PDF ファイルを抽出
 */
function extractPdfFromSendUserFile(toolInput) {
  const files = toolInput?.files || [];
  const result = [];
  for (const entry of Array.isArray(files) ? files : []) {
    const file = typeof entry === 'string' ? entry : entry?.path || entry?.file_path || entry?.file;
    if (!file) continue;
    const classified = classifyPdf(String(file));
    if (classified.isTarget) result.push(classified);
  }
  return result;
}

/**
 * Drive create_file の base64Content から sha256 参照と絶対パスを抽出
 */
function extractPdfFromDriveCreate(toolInput) {
  const content = toolInput?.base64Content || '';
  const title = toolInput?.title || '';
  const mimeType = toolInput?.contentMimeType || '';
  if (mimeType !== 'application/pdf' && !title.toLowerCase().endsWith('.pdf')) return [];
  // sha256:<hex>:<絶対パス> 形式の参照
  const shaRef = content.match(/^sha256:([a-f0-9]{64}):([A-Za-z]:[\\/].+|\/.+)$/);
  if (shaRef) {
    const [, hex, filePath] = shaRef;
    const classified = classifyPdf(filePath);
    if (classified.isTarget && classified.sha256 === hex.toLowerCase()) return [classified];
  }
  return [];
}

/**
 * Bash コマンドから drive-upload / gmail-draft / seisaku-mail の --file / --attach 引数を抽出
 */
function extractPdfFromBash(command) {
  if (!command || typeof command !== 'string') return [];
  const result = [];
  // drive-upload.mjs --file <path>
  if (command.includes('drive-upload.mjs') || command.includes('gmail-draft.mjs') || command.includes('seisaku-mail.mjs')) {
    const fileFlag = /(?:--file|--attach)\s+"([^"]+)"|(?:--file|--attach)\s+'([^']+)'|(?:--file|--attach)\s+([^\s"'`|&;]+)/g;
    let match;
    while ((match = fileFlag.exec(command)) !== null) {
      const filePath = match[1] || match[2] || match[3];
      if (!filePath) continue;
      const classified = classifyPdf(filePath);
      if (classified.isTarget) result.push(classified);
    }
  }
  return result;
}

/**
 * transcript の全 Read ツール呼び出しをスキャンし、file_path のリストを返す
 */
function scanReadCalls(transcriptRaw) {
  const readFiles = new Set();
  if (!transcriptRaw) return readFiles;
  for (const line of transcriptRaw.split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant' && entry?.message?.role !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || block?.name !== 'Read') continue;
      const filePath = block?.input?.file_path;
      if (filePath && typeof filePath === 'string') {
        readFiles.add(canonicalPath(filePath));
      }
    }
  }
  return readFiles;
}

function canonicalPath(p) {
  return path.resolve(p).replaceAll('\\', '/');
}

/**
 * 証跡を確認
 * @returns {{ passed: boolean, reason?: string }}
 */
function checkEvidence(classified, evidenceDir = EVIDENCE_DIR) {
  const evFile = path.join(evidenceDir, `${classified.sha256}.json`);
  if (!fs.existsSync(evFile)) {
    return { passed: false, reason: '証跡なし（~/.claude/pdf-render/evidence/ に該当sha256の証跡がありません）' };
  }
  let ev;
  try { ev = JSON.parse(fs.readFileSync(evFile, 'utf8')); } catch {
    return { passed: false, reason: '証跡ファイルが読めません' };
  }
  // renderedAt が PDF の更新時刻より後であること
  const mtime = fileMtime(classified.pdfPath);
  if (mtime > 0 && ev.renderedAt < mtime) {
    return { passed: false, reason: '証跡が古い（PDF 更新時刻より後の描画記録がありません）' };
  }
  // 機械チェックが fatal でないこと
  if (ev.sha256 !== classified.sha256 || canonicalPath(ev.pdf || '') !== canonicalPath(classified.pdfPath) || ev.pages !== ev.pngs?.length) {
    return { passed: false, reason: '証跡のsha256・PDFパス・ページ数が一致しません' };
  }
  if (ev.fatal || ev.check?.fatal) {
    const warnings = ev.warnings || ev.check?.warnings || [];
    return { passed: false, reason: `機械チェックで社内向け語を検出: ${warnings.map(w => w.detail).join('; ')}` };
  }
  return { passed: true, evidence: ev };
}

/**
 * transcript に全 PNG の Read 記録があるか確認
 */
function checkReadVisual(transcriptRaw, evidence) {
  if (!evidence?.pngs?.length) return { passed: false, reason: '証跡にPNGがありません' };
  const readFiles = scanReadCalls(transcriptRaw);
  const canonicalPngs = evidence.pngs.map(p => canonicalPath(p));
  const missing = canonicalPngs.filter(p => !readFiles.has(p));
  if (missing.length > 0) {
    return { passed: false, reason: `未 Read のページ画像: ${missing.map(m => path.basename(m)).join(', ')}` };
  }
  return { passed: true };
}

/**
 * 逃がし弁: 直近の assistant テキストに [PDF-VISUAL-OK: 理由] があるか
 */
function checkEscapeHatch(assistantText) {
  const match = String(assistantText || '').match(/\[PDF-VISUAL-OK:\s*([^\]]{20,})\]/);
  if (match) return true;
  return false;
}

/**
 * メイン判定
 * @returns {{ decision: 'block'|'pass', reason?: string }}
 */
export function judge(input, { evidenceDir = EVIDENCE_DIR } = {}) {
  try {
    const toolName = input?.tool_name || '';
    const toolInput = input?.tool_input || {};
    const command = String(toolInput?.command || '');
    const transcriptPath = input?.transcript_path || '';
    const assistantText = latestAssistantText(transcriptPath);

    // 対象操作か判定
    let pdfs = [];
    if (toolName === SEND_USER_FILE) {
      pdfs = extractPdfFromSendUserFile(toolInput);
    } else if (DRIVE_CREATE_FILE.test(toolName)) {
      pdfs = extractPdfFromDriveCreate(toolInput);
    } else if (/^(?:Bash|PowerShell)$/i.test(toolName)) {
      pdfs = extractPdfFromBash(command);
    }

    // 該当PDFがなければ何もしない（fail-open = pass）
    if (pdfs.length === 0) return { decision: 'pass' };

    // 逃がし弁
    if (checkEscapeHatch(assistantText)) return { decision: 'pass' };

    // 証跡チェック
    for (const classified of pdfs) {
      const evResult = checkEvidence(classified, evidenceDir);
      if (!evResult.passed) {
        const reason = `[PDF-VISUAL-GATE] ${classified.sha256.slice(0, 12)}: ${evResult.reason}\n\n以下の手順で全ページを目視してください:\n① node tools/pdf-page-check.mjs --install（未導入なら）\n② node tools/pdf-page-check.mjs --pdf "${classified.pdfPath}"\n③ 出た全ページ画像を Read で1枚ずつ見る\n④ 見つけた問題を直して PDF を作り直し、②③をやり直す\n⑤ 再度渡す`;
        return { decision: 'block', reason };
      }

      let raw;
      try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { raw = ''; }
      const visualResult = checkReadVisual(raw, evResult.evidence);
      if (!visualResult.passed) {
        const reason = `[PDF-VISUAL-GATE] ${classified.sha256.slice(0, 12)}: ${visualResult.reason}\n\n全ページ画像を Read で1枚ずつ見てから渡してください。\n① node tools/pdf-page-check.mjs --pdf "${classified.pdfPath}"\n② 出力された全ページ画像を Read（file_path にPNGの絶対パス）\n③ 問題を直したらPDFを作り直して①②をやり直す\n④ 再度渡す`;
        return { decision: 'block', reason };
      }
    }

    return { decision: 'pass' };
  } catch (err) {
    // fail-open: 例外は握りつぶさず stderr に出して pass
    console.error(`pdf-deliverable-visual-gate fail-open: ${err.message}`);
    return { decision: 'pass' };
  }
}

async function main() {
  const raw = await readStdinWithTimeout();
  if (!raw) { process.exit(0); return; }
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); return; }
  const result = judge(input);
  // PreToolUse gate は block/warn の時だけ決定打を出力、pass は無出力が通す
  if (result.decision === 'block') {
    console.error(result.reason);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  }
}

if (isEntry(import.meta.url)) await main();
