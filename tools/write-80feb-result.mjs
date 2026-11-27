import fs from 'fs';
import crypto from 'crypto';

const ep = 'C:/Users/user/.claude/nightly-repo/.stall-sweeper/80feb1272552384965bb-1795807767420.evidence.json';
const rp = 'C:/Users/user/.claude/nightly-repo/.stall-sweeper/80feb1272552384965bb-1795807767420.result.json';

const ev = {
  investigatedAt: '2026-11-28T04:30:00.000Z',
  target: {
    kind: 'failed_job',
    id: 'fallback:C:\\Users\\user\\.claude\\nightly-repo',
    eventTime: '2026-11-27T14:25:52.482Z',
    reason: '直近の終了コード error',
    cwd: 'C:\\Users\\user\\.claude\\nightly-repo'
  },
  originalFailure: {
    t: '2026-11-27T14:25:52.482Z',
    provider: 'fallback',
    model: 'openrouter-code/qwen/qwen3-coder',
    status: 'error',
    exitCode: 1,
    reason: 'quality_fail',
    launched: true,
    chainOutcomes: [{
      backend: 'openrouter-code',
      model: 'qwen/qwen3-coder',
      outcome: 'quality_fail',
      status: 0,
      secs: 418.413
    }]
  },
  deferredCodex: {
    t: '2026-11-27T14:25:52.484Z',
    status: 'deferred',
    reason: 'all_backends_failed',
    launched: false
  },
  laterSameKeySuccesses: [
    { t: '2026-11-27T19:25:18.619Z', status: 'ok', exitCode: 0, secs: 92.768 },
    { t: '2026-11-27T19:29:24.375Z', status: 'ok', exitCode: 0, secs: 116.664 }
  ],
  latestSameKeyRow: { t: '2026-11-27T19:29:24.375Z', status: 'ok', exitCode: 0 },
  reExecuteDecision: 'skip_already_done_by_later_ok'
};

fs.writeFileSync(ep, JSON.stringify(ev, null, 2) + '\n');
const eh = crypto.createHash('sha256').update(fs.readFileSync(ep)).digest('hex');

const res = {
  completed: true,
  summary: 'fallback:nightly-repo の 2026-11-27T14:25:52Z quality_fail は openrouter-code/qwen が品質不合格で exit=1、続く codex は all_backends_failed。同一 provider:cwd の後続 fallback 成功2件（19:25 / 19:29 とも exit=0）あり、タスクは後続で処理済み。',
  evidence: {
    file: '/mnt/c/Users/user/.claude/nightly-repo/.stall-sweeper/80feb1272552384965bb-1795807767420.evidence.json',
    sha256: eh
  }
};

fs.writeFileSync(rp, JSON.stringify(res, null, 2) + '\n');

const rh = crypto.createHash('sha256').update(fs.readFileSync(rp)).digest('hex');
console.log('Evidence SHA256:', eh);
console.log('Result SHA256:', rh);

// Verify both files
const evFile = JSON.parse(fs.readFileSync(ep, 'utf8'));
const resFile = JSON.parse(fs.readFileSync(rp, 'utf8'));
console.log('Evidence target id:', evFile.target.id);
console.log('Result completed:', resFile.completed);
console.log('Result evidence hash matches:', resFile.evidence.sha256 === eh ? 'YES' : 'NO');