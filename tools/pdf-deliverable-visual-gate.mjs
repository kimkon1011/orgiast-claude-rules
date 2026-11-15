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

export const GATE_CONTRACT = {"name":"pdf-deliverable-visual-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"pdf-deliverable-visual-gate"}]};

const HOME = process.env.ORGIAST_HOME || os.homedir();
const EVIDENCE_DIR = path.join(HOME, '.claude', 'pdf-render', 'evidence');

// 対象のファイル名パターン（提案・企画・見積・資料等）
const TARGET_NAME = /提案|企画|見積|資料|スライド|proposal|deck|brief/i;

// 対象の操作パターン
const SEND_USER_FILE = 'SendUserFile';
const DRIVE_CREATE_FILE = /^mcp__claude_ai_Google_Drive(?:_\d+)?__create_file$/;

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
  try { return fs.statSync(filePath).mtimeMs; } catch { return NaN; }
}

/**
 * PDF ファイルかどうか、対象かどうかを判定
 * @returns {{ isTarget: boolean, pdfPath?: string, sha256?: string }}
 */
function classifyPdf(filePath, cwd = process.cwd(), title = '') {
  if (!filePath || typeof filePath !== 'string') return { isTarget: false };
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.pdf')) return { isTarget: false };
  const basename = path.basename(title || lower);
  if (!TARGET_NAME.test(basename)) return { isTarget: false };
  const absPath = path.resolve(cwd, filePath);
  if (!fs.existsSync(absPath)) return { isTarget: false };
  const sha256 = sha256hex(absPath);
  return { isTarget: true, pdfPath: absPath, sha256 };
}

/**
 * SendUserFile から PDF ファイルを抽出
 */
function extractPdfFromSendUserFile(toolInput, cwd) {
  const files = toolInput?.files || [];
  const result = [];
  for (const entry of Array.isArray(files) ? files : []) {
    const file = typeof entry === 'string' ? entry : entry?.path || entry?.file_path || entry?.file;
    if (!file) continue;
    const classified = classifyPdf(String(file), cwd);
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
  const shaRef = typeof content === 'string' && content.match(/^sha256:([a-f0-9]{64}):(.+)$/i);
  if (shaRef) {
    const [, hex, filePath] = shaRef;
    if (!path.isAbsolute(filePath)) return [];
    // The connector reference is authoritative, including when its local file is absent.
    if (!TARGET_NAME.test(path.basename(title)) && !TARGET_NAME.test(path.basename(filePath))) return [];
    return [{ isTarget: true, pdfPath: filePath, sha256: hex.toLowerCase(), reference: true }];
  }
  return [];
}

/**
 * Bash コマンドから drive-upload / gmail-draft / seisaku-mail の --file / --attach 引数を抽出
 */
function extractPdfFromBash(command, cwd) {
  if (!command || typeof command !== 'string') return [];
  const result = [];
  // drive-upload.mjs --file <path>
  if (command.includes('drive-upload.mjs') || command.includes('gmail-draft.mjs') || command.includes('seisaku-mail.mjs')) {
    const fileFlag = /(?:^|\s)--(?:file|attach)(?:\s+|=)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`|&;]+))/g;
    let match;
    while ((match = fileFlag.exec(command)) !== null) {
      const filePath = match[1] || match[2] || match[3];
      if (!filePath) continue;
      if (/[$`]/.test(filePath)) continue; // Do not guess shell expansion.
      const classified = classifyPdf(filePath, cwd);
      if (classified.isTarget) result.push(classified);
    }
  }
  return result;
}

/**
 * transcript の全 Read ツール呼び出しをスキャンし、file_path のリストを返す
 */
function scanReadCalls(transcriptRaw, renderedAt, sessionId) {
  const readFiles = new Set();
  if (!transcriptRaw) return readFiles;
  for (const line of transcriptRaw.split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.isSidechain || (sessionId && entry?.sessionId && entry.sessionId !== sessionId)) continue;
    const at = Date.parse(entry?.timestamp);
    if (!Number.isFinite(at) || at <= renderedAt) continue;
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
  const resolved = path.resolve(p).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
  if (Number.isFinite(mtime) && classified.reference && sha256hex(classified.pdfPath) !== classified.sha256) {
    return { passed: false, reason: 'Drive参照のsha256が実ファイルと一致しません' };
  }
  if (!Number.isFinite(mtime) || !Number.isFinite(ev?.renderedAt) || ev.renderedAt <= mtime) {
    return { passed: false, reason: '証跡が古い（PDF 更新時刻より後の描画記録がありません）' };
  }
  // 機械チェックが fatal でないこと
  if (ev.sha256 !== classified.sha256 || typeof ev.pdf !== 'string' || canonicalPath(ev.pdf) !== canonicalPath(classified.pdfPath)
    || !Number.isInteger(ev.pages) || ev.pages < 1 || !Array.isArray(ev.pngs) || ev.pages !== ev.pngs.length
    || ev.pngs.some(p => typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p))
    || new Set(ev.pngs.map(canonicalPath)).size !== ev.pages) {
    return { passed: false, reason: '証跡のsha256・PDFパス・ページ数が一致しません' };
  }
  if (ev.fatal !== false || !Array.isArray(ev.warnings) || ev.warnings.some(w => w?.type === 'internal-word')) {
    const warnings = Array.isArray(ev.warnings) ? ev.warnings : [];
    return { passed: false, reason: `機械チェック未合格（社内向け語または結果不明）: ${warnings.map(w => w?.detail || '').join('; ')}` };
  }
  return { passed: true, evidence: ev };
}

/**
 * transcript に全 PNG の Read 記録があるか確認
 */
function checkReadVisual(transcriptRaw, evidence, sessionId) {
  if (!evidence?.pngs?.length) return { passed: false, reason: '証跡にPNGがありません' };
  const readFiles = scanReadCalls(transcriptRaw, evidence.renderedAt, sessionId);
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
  return [...String(assistantText || '').matchAll(/\[PDF-VISUAL-OK:([^\]]*)\]/g)]
    .some(match => [...match[1].trim()].length >= 20);
}

// Do not inherit an old override across another assistant message or human turn.
function lastAssistantMessage(raw) {
  for (const line of raw.trim().split(/\r?\n/).reverse()) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.isSidechain) continue;
    const content = entry?.message?.content;
    if (entry?.type === 'assistant' || entry?.message?.role === 'assistant') {
      return typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    }
    if ((entry?.type === 'user' || entry?.message?.role === 'user')
      && !(Array.isArray(content) && content.some(b => b.type === 'tool_result'))) return '';
  }
  return '';
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
    const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();

    // 対象操作か判定
    let pdfs = [];
    if (toolName === SEND_USER_FILE) {
      pdfs = extractPdfFromSendUserFile(toolInput, cwd);
    } else if (DRIVE_CREATE_FILE.test(toolName)) {
      pdfs = extractPdfFromDriveCreate(toolInput);
    } else if (/^(?:Bash|PowerShell)$/i.test(toolName)) {
      pdfs = extractPdfFromBash(command, cwd);
    }

    // 該当PDFがなければ何もしない（fail-open = pass）
    if (pdfs.length === 0) return { decision: 'pass' };

    // 逃がし弁
    let raw;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { raw = ''; }
    if (checkEscapeHatch(lastAssistantMessage(raw))) return { decision: 'pass' };

    // 証跡チェック
    for (const classified of pdfs) {
      const evResult = checkEvidence(classified, evidenceDir);
      if (!evResult.passed) {
        const reason = `[PDF-VISUAL-GATE] ${classified.sha256.slice(0, 12)}: ${evResult.reason}\n\n以下の手順で全ページを目視してください:\n① node tools/pdf-page-check.mjs --install（未導入なら）\n② node tools/pdf-page-check.mjs --pdf "${classified.pdfPath}"\n③ 出た全ページ画像を Read で1枚ずつ見る\n④ 見つけた問題を直して PDF を作り直し、②③をやり直す\n⑤ 再度渡す`;
        return { decision: 'block', reason };
      }

      const visualResult = checkReadVisual(raw, evResult.evidence, input?.session_id);
      if (!visualResult.passed) {
        const reason = `[PDF-VISUAL-GATE] ${classified.sha256.slice(0, 12)}: ${visualResult.reason}\n\n全ページ画像を Read で1枚ずつ見てから渡してください。\n① node tools/pdf-page-check.mjs --install（未導入なら）\n② node tools/pdf-page-check.mjs --pdf "${classified.pdfPath}"\n③ 出力された全ページ画像を Read（file_path にPNGの絶対パス）\n④ 問題を直したらPDFを作り直して②③をやり直す\n⑤ 再度渡す`;
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
  try { input = JSON.parse(raw); } catch (error) { console.error(`pdf-deliverable-visual-gate fail-open: ${error.message}`); return; }
  const result = judge(input);
  // PreToolUse gate は block/warn の時だけ決定打を出力、pass は無出力が通す
  if (result.decision === 'block') {
    console.error(result.reason);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  }
}

if (isEntry(import.meta.url)) {
  try { await main(); } catch (error) { console.error(`pdf-deliverable-visual-gate fail-open: ${error.message}`); }
}
