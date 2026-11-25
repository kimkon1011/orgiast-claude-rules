#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "external-channel-unmonitored-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "external-channel-unmonitored-gate"}]};
// Stop gate: 外部チャネル（LINE/Discord/Beeper）の返信待ち promise を検出し、
// auto-progress の監視が未登録の場合に block する。
// docs/x-0045-missing-gates.md 優先3「外部チャネル未監視型」

const EXTERNAL_CHANNEL_PROMISE = /返信(?:待|が届い|があっ|を待)|返事待|回答待|reply.*wait|awaiting.*reply/i;
const GMAIL_REFERENCE = /gmail|メール|e-?mail|inbox/i;
const EXTERNAL_CHANNEL = /line|discord|beeper|チャネル|channel|グループ|group/i;
const PAST_TENSE = /(?:返信|回答|返事)(?:し|を送|しま|があり)/i;
const USER_DIRECTIVE = /(?:user|ユーザー|kim)から.*(?:指示|依頼|order|instruction)|(?:LINE|Discord)で.*(?:待っ|返事)/i;

export function evaluateExternalChannelPromise(text) {
  if (!text || typeof text !== 'string') return { decision: 'pass' };

  // 外部チャネルの返信待ち promise が無ければ pass
  if (!EXTERNAL_CHANNEL_PROMISE.test(text)) return { decision: 'pass' };

  // コードブロック内の引用は除外
  const codeBlocks = [...text.matchAll(/```[\s\S]*?```/g)];
  const bodyText = codeBlocks.reduce((t, m) => t.replace(m[0], ''), text);

  // Gmail のみの返信待ちは除外（external-waiting.mjs がカバー済み）
  if (GMAIL_REFERENCE.test(bodyText) && !EXTERNAL_CHANNEL.test(bodyText)) return { decision: 'pass' };

  // 過去形（送信済み）は除外
  if (PAST_TENSE.test(bodyText)) return { decision: 'pass' };

  // user からの直接指示は除外
  if (USER_DIRECTIVE.test(bodyText)) return { decision: 'pass' };

  // 外部チャネル名が明示されていない場合は pass（LINE/Discord/Beeper のいずれかが必要）
  if (!EXTERNAL_CHANNEL.test(bodyText)) return { decision: 'pass' };

  return {
    decision: 'block',
    reason: `[EXTERNAL-CHANNEL-UNMONITORED] 外部チャネル（LINE/Discord/Beeper）の返信待ち promise を検出しましたが、auto-progress の監視が未登録の可能性があります。返信待ちの約束をする場合は、事前に auto-progress-external-check.mjs を使った監視を登録してください。既に登録済みの場合はこの block を無視して進めてください。`,
    code: 'EXTERNAL-CHANNEL-UNMONITORED',
  };
}