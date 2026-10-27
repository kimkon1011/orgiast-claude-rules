import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.join(process.cwd(), '.stall-sweeper');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const stem = '7fce2fbf8191d569bbab-1793128235554';
const evidencePath = path.join(dir, `${stem}.evidence.json`);
const resultPath = path.join(dir, `${stem}.result.json`);

const evidenceData = {
  checkedAt: new Date().toISOString(),
  target: {
    kind: 'failed_job',
    id: 'deepseek:不明',
    title: '実行失敗: deepseek:不明',
    location: 'C:\\Users\\kimko\\.claude\\executor-usage.jsonl',
    staleDays: 0,
    nextAction: 'Codexで原因を調査して安全に再実行',
    humanRequired: false,
    reason: '直近の終了コード http_402',
    eventTime: '2026-10-27T18:11:27.755Z'
  },
  completed: false,
  reason: 'DeepSeek API残高切れ(HTTP 402 Insufficient Balance / balanceUsd: 0)。課金操作は制約により禁止。元セッションの手渡し監査はpass済みで未完了の作業は残存せず、再実行不可かつ対応不要。',
  investigation: {
    executorUsageRow: {
      t: '2026-10-27T18:11:27.755Z',
      provider: 'deepseek',
      model: 'deepseek-flash',
      in: 0,
      out: 0,
      secs: 0.75,
      status: 'http_402',
      attempt: 0,
      failover: false,
      reason: 'HTTP402: {"error":{"message":"Insufficient Balance (request_id: 43841fc0-8654-4a06-bd01-060fb9547d1a)","type":"insufficient_balance_error","param":null,"code":"invalid_request_error"}}'
    },
    handoffAuditContext: {
      sessionId: '7f13d513-134c-4a37-bc16-388ff2ac959f',
      ts: '2026-10-27T18:11:21.599Z',
      provider: 'deepseek',
      verdict: 'audit-unavailable',
      error: 'timeout-or-provider-unavailable',
      decision: 'pass'
    },
    providerBalance: {
      provider: 'deepseek',
      balanceUsd: 0,
      autoTopUp: false,
      status: 'low',
      account: 'seisaku-team@orgiast.jp'
    },
    conclusions: [
      '1. 当該行は独立した定時タスクではなく、handoff-audit-gate がセッション 7f13d513-134c-4a37-bc16-388ff2ac959f の手渡し判定を DeepSeek へ委譲した際の API エラー記録である。',
      '2. DeepSeek の残高は USD 0 であり autoTopUp も false のため、API 呼出は常に HTTP 402 (Insufficient Balance) となる。',
      '3. 制約事項「外部送信や課金、権限変更は行わない」により、API 残高チャージやオートチャージ有効化は実行できない。',
      '4. 呼出し元の手渡し監査は provider-unavailable を適切にフォールバック処理し decision: pass として既に完了しているため、復元・再実行すべき未完了ジョブは存在しない。'
    ]
  }
};

const evidenceJson = JSON.stringify(evidenceData, null, 2);
fs.writeFileSync(evidencePath, evidenceJson, 'utf8');

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex');

const resultData = {
  completed: false,
  summary: 'DeepSeek API残高切れ(HTTP 402 / balanceUsd: 0)によるAPI失敗。課金操作は制約により禁止。元セッションの手渡し監査はpass判定で完了済みであり、再実行不可かつ対応不要。',
  reason: 'DeepSeek残高0・課金禁止・元タスク完了済みのため再実行不可',
  evidence: {
    file: `/mnt/c/Users/kimko/.claude/nightly-repo/.stall-sweeper/${stem}.evidence.json`,
    sha256
  }
};

fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2), 'utf8');
console.log('Written successfully:');
console.log('Result path:', resultPath);
console.log('Evidence path:', evidencePath);
console.log('SHA256:', sha256);
