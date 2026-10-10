export const GATE_CONTRACT = {"name": "decision-research-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "decision-research-gate"}]};
// 判断材料の先回り調査ゲート（kim 2026-10-10 厳命・全PC全アカウント）。
// 有料化・プラン変更・招待・購入・契約・アカウント作成などを user に勧める／選ばせる応答で、
// 選択肢の比較表（2案以上）と出典が無ければ差し戻す。user に「比較は検証した？」と聞かれてから調べるのを禁止する。
// 実例: 2026-10-10 Codex の上限対策で「ChatGPT Business にメンバー招待」を勧めたが、
// Plus 個別・Pro 5x との費用と利用枠の比較をしておらず、kim の指摘で初めて調べた。

const COST_DECISION = /(有料(?:化|プラン|アカウント|版)?|課金|購入|買(?:う|って|い)|契約|サブスク|subscription|アップグレード|upgrade|プラン(?:を|に|の)?(?:変更|追加|切り?替|上げ|選)|(?:メンバー|ユーザー|席|シート|seat)(?:を)?(?:招待|追加|購入)|招待して|アカウント(?:を)?(?:作成|作って|追加|新規)|月額|年額|料金が発生|費用が(?:かかる|発生))/i;
const ASKS_USER = /(次に kim がすること|kim への依頼|kim がすること|してください|して下さい|お願い|決めて|選んで|どちら(?:に|が)|返して|判断)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const SOURCE = /(出典|ソース|Sources?:|pricing-brief|https?:\/\/)/i;

function optionRows(text) {
  const rows = text.split(/\r?\n/).filter(l => TABLE_ROW.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l));
  // 見出し行を除いた行数 = 案の数
  return Math.max(0, rows.length - 1);
}

export function judge(text) {
  const body = String(text || '').replace(/```[\s\S]*?```/g, '');
  if (/\[RESEARCH-OK\]/.test(body)) return { triggered: false, missing: [] };
  if (!COST_DECISION.test(body) || !ASKS_USER.test(body)) return { triggered: false, missing: [] };
  const missing = [];
  if (optionRows(body) < 2) missing.push('選択肢の比較表（2案以上。現状維持・無料の代替を含む）');
  if (!/(月額|年額|\$|¥|円|ドル|費用|コスト|料金)/.test(body)) missing.push('各案の費用');
  if (!/(枠|上限|容量|性能|効果|節約|削減|回数|量)/.test(body)) missing.push('各案で得られるもの（利用枠・効果）');
  if (!SOURCE.test(body)) missing.push('出典（一次情報の URL か ~/.claude/pricing-brief.md）');
  if (!/(おすすめ|推奨|結論)/.test(body)) missing.push('推奨案とその理由');
  return { triggered: missing.length > 0, missing };
}

export function formatReason(missing) {
  return `[RESEARCH-FIRST] 費用・プラン・契約・アカウントの判断を user に求めていますが、判断材料の先回り調査が足りません: ${missing.join('・')}。`
    + ' user に聞かれる前に Claude が調べ、比較表（案・月額・得られる枠や効果・user の手間）＋出典＋推奨を付けてから提案すること'
    + '（料金は ~/.claude/pricing-brief.md → 無ければ WebSearch）。本当に比較不要なら [RESEARCH-OK] <理由>。';
}
