import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateProposal, proposalHome } from './tools/proposal-session.mjs';
import { acquireLock, resolveFleetLabel } from './tools/fleet-mail.mjs';
import { launchNextSession } from './tools/next-session-launch.mjs';
import { notifyKim } from './tools/notify-kim.mjs';
import { redactSecrets } from './tools/redact-secrets.mjs';

const home = os.homedir();
const dir = path.join(home, '.claude', 'proposals');

const input = {
  id: 'model-scout-b7168bc544d480da68d8',
  title: 'summarize に Crouton Alpha (stealth/crouton-alpha) を採用',
  source: 'model-scout',
  evidence: [
    'eval-results.jsonl: openrouter/stealth/crouton-alpha / summarize 合格率 100.0%（現行 100.0%）',
    '評価日時 2026-10-25 / 集計 1 回'
  ],
  proposal: {
    summary: 'summarize の品質を確認済みの安価なモデルへ変更する。',
    changes: [
      { file: 'tools/routing-table.json（生成側含む）', before: 'summarize: openrouter/anthropic/claude-3.5-haiku', after: 'summarize: openrouter/stealth/crouton-alpha' },
      { file: 'tools/llm-ask.mjs・関連テスト', before: '現行の既定経路', after: '採用モデルへの経路とテストを更新' }
    ],
    costImpact: { perMonthUsd: null, basis: '入力/出力 per MTok: $1/5 → $0.1/0.5。' },
    risks: []
  },
  onApprove: { kind: 'codex-task', promptFile: path.join(dir, 'model-scout-b7168bc544d480da68d8.codex.md') },
  onReject: '現行ルーティングを維持し、次の候補を評価する。'
};

const promptText = 'test prompt text for summarize';

// Let's run submitProposal body line by line WITHOUT try/catch!
console.log('1. validateProposal...');
validateProposal(input);

console.log('2. acquireLock...');
const release = acquireLock(path.join(dir, '.queue.lock'));
console.log('Lock acquired:', Boolean(release));

console.log('3. list pending/done...');
function list(dirPath) {
  try {
    return fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch { return []; }
}
const pending = list(dir), done = list(path.join(dir, 'done'));
console.log('Pending count:', pending.length, 'Done count:', done.length);

let p = structuredClone(input);
const prior = pending.find(x => x.id === p.id);
console.log('Prior:', prior?.id);

const changed = !prior || JSON.stringify(p) !== JSON.stringify(prior);
console.log('Changed:', changed);

if (promptText && changed) {
  p.onApprove.promptFile = path.join(dir, `${p.id}.codex.md`);
  console.log('Writing prompt file:', p.onApprove.promptFile);
  fs.writeFileSync(p.onApprove.promptFile, promptText);
}

console.log('4. check promptFile existence:', p.onApprove.promptFile);
if (!fs.existsSync(p.onApprove.promptFile)) console.error('PROMPT FILE MISSING!');
else console.log('Prompt file exists.');

console.log('5. launchNextSession...');
const first = pending[0] || p;
if (first.id === p.id && !p.launchAttemptedAt && resolveFleetLabel(home) === 'kim-PC') {
  console.log('Calling launchNextSession...');
  await launchNextSession(['--target', 'vscode', '--prompt', '/session-start'], { homedir: home, log: console.log });
}

console.log('6. notifyKim...');
const dm = `実装提案セッションを用意しました: ${p.title.replace(/[\r\n\t]+/g, ' ')}（次に Claude Code を開くと先頭に出ます）`;
console.log('Calling notifyKim with DM:', dm);
const result = await notifyKim(redactSecrets(dm), { home, webhookFallback: false });
console.log('notifyKim result:', result);

if (!['dm', 'session-inbox'].includes(result?.delivered)) {
  console.error('NOTIFICATION FAILED! Delivered status:', result?.delivered, 'result:', result);
} else {
  console.log('NOTIFICATION SUCCESS!');
}

if (release) release();
