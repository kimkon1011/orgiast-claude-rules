import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const INTRO = `# 🏠 民泊改善ダイジェスト（kim-PC → 作業用004 自動配達）
出典: LINE オープンチャット「民泊オーナー雑談ルーム」。他のオーナーの伝聞で未検証。
受け取った Claude は本文を nf-minpaku-automation/analysis/0openchat/<配達日 YYYY-MM-DD>.md に保存し、各提案を全室稼働95%・月次黒字の目標に照らして「試す／見送る（理由1行）」を付ける。kim の判断が要るものは kim-inbox（node tools/kim-inbox.mjs）に積む。Discord の DM は使わない。特区民泊の最低2泊を下回る提案は法令違反のため即却下する。`;

export async function runDeliver({ home = os.homedir(), args = [], spawn = spawnSync, log = console.log } = {}) {
  const finish = (status, exitCode = 0) => { log(status); return { status, exitCode }; };
  let tempDir;
  try {
    const toIndex = args.indexOf('--to');
    const to = toIndex < 0 ? '作業用004' : args[toIndex + 1];
    if (!to || to.startsWith('--')) throw new Error('--to の宛先がありません');
    const base = path.join(home, '.claude');
    const digestFile = path.join(base, 'minpaku-digest.md');
    if (!fs.existsSync(digestFile)) return finish('skip:ダイジェストなし');
    const text = fs.readFileSync(digestFile, 'utf8');
    const section = text.match(/<!-- MINPAKU-DIGEST-START -->[\s\S]*?<!-- MINPAKU-DIGEST-END -->/)?.[0];
    if (!section) return finish('skip:ダイジェストなし');
    const hash = createHash('sha256').update(section).digest('hex');
    const stateFile = path.join(base, 'line-openchat', 'minpaku-deliver-state.json');
    // A malformed state must not silently trigger a duplicate delivery.
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    if (!args.includes('--force') && state.lastHash === hash) return finish('skip:変更なし');
    const body = `${INTRO}\n\n${section}\n`;
    if (args.includes('--dry-run')) {
      log(`[dry-run] 宛先: ${to}\n${body}`);
      return finish('skip:dry-run');
    }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    tempDir = fs.mkdtempSync(path.join(path.dirname(stateFile), 'minpaku-deliver-'));
    const bodyFile = path.join(tempDir, 'body.md');
    fs.writeFileSync(bodyFile, body, { mode: 0o600 });
    const result = spawn(process.execPath, [
      fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)),
      '--send', '--to', to, '--kind', 'note', '--body-file', bodyFile,
      '--why', '[報告・返信不要] LINE 民泊オーナー雑談ルームの民泊改善ダイジェスト（自動）',
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
