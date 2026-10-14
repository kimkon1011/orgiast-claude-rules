import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const INTRO = `# ☕ カフェ改善ダイジェスト（kim-PC → cafe015-PC 自動配達）
出典: LINE オープンチャット「レンスペ民の集い」。他店オーナーの伝聞で未検証。
使い方: 下の「未処理の提案」を 212coffee の業務・アプリ・掲示物の改善候補として扱い、採用するものは next-session.md の残TODOに起票する。kim の判断が要るものは \`node tools/notify-kim.mjs\` で DM を送る。採用しないものは理由を1行残す。`;

export async function runDeliver({ home = os.homedir(), args = [], spawn = spawnSync, log = console.log } = {}) {
  const finish = (status, exitCode = 0) => { log(status); return { status, exitCode }; };
  let tempDir;
  try {
    const toIndex = args.indexOf('--to');
    const to = toIndex < 0 ? 'cafe015-PC' : args[toIndex + 1];
    if (!to || to.startsWith('--')) throw new Error('--to の宛先がありません');
    const base = path.join(home, '.claude');
    const digestFile = path.join(base, 'cafe-digest.md');
    if (!fs.existsSync(digestFile)) return finish('skip:ダイジェストなし');
    const text = fs.readFileSync(digestFile, 'utf8');
    const section = text.match(/<!-- CAFE-DIGEST-START -->[\s\S]*?<!-- CAFE-DIGEST-END -->/)?.[0];
    if (!section) return finish('skip:ダイジェストなし');
    const hash = createHash('sha256').update(section).digest('hex');
    const stateFile = path.join(base, 'line-openchat', 'cafe-deliver-state.json');
    // A malformed state must not silently trigger a duplicate delivery.
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    if (!args.includes('--force') && state.lastHash === hash) return finish('skip:変更なし');
    const body = `${INTRO}\n\n${section}\n`;
    if (args.includes('--dry-run')) {
      log(`[dry-run] 宛先: ${to}\n${body}`);
      return finish('skip:dry-run');
    }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    tempDir = fs.mkdtempSync(path.join(path.dirname(stateFile), 'cafe-deliver-'));
    const bodyFile = path.join(tempDir, 'body.md');
    fs.writeFileSync(bodyFile, body, { mode: 0o600 });
    const result = spawn(process.execPath, [
      fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)),
      '--send', '--to', to, '--kind', 'note', '--body-file', bodyFile,
      '--why', 'LINE レンスペ民の集いのカフェ改善ダイジェスト（自動）',
    ], { shell: false, encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || String(result.stderr || result.stdout || `終了コード ${result.status}`));
    }
    const mailId = String(result.stdout || '').match(/\bmail-[\w-]+/)?.[0] || '';
    fs.writeFileSync(stateFile, JSON.stringify({ lastHash: hash, lastSentAt: new Date().toISOString(), lastMailId: mailId }, null, 2) + '\n');
    return finish(`ok:送信 ${mailId || 'ID不明'}`);
  } catch (error) {
    return finish(`error:${String(error.message).replace(/[\r\n]+/g, ' ').slice(0, 120)}`, 1);
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (isEntry(import.meta.url)) {
  runDeliver({ args: process.argv.slice(2) }).then(({ exitCode }) => { process.exitCode = exitCode; });
}
