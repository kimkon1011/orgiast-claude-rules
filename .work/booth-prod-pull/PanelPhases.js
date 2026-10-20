const PANEL_PHASES = [
  { order: 0, key: 'common', label: '⚙ いつでも使う（全フェーズ共通）', background: '#eceff1', color: '#37474f' },
  { order: 1, key: 'sales', label: '① 営業フェーズ（提案・見積）', background: '#e8f5e9', color: '#1b5e20' },
  { order: 2, key: 'p1', label: '② 第一フェーズ（受注直後の初動）', background: '#e3f2fd', color: '#0d47a1' },
  { order: 3, key: 'p2', label: '③ 第二フェーズ（制作準備）', background: '#fff8e1', color: '#e65100' },
  { order: 4, key: 'p3', label: '④ 第三フェーズ（入稿・最終チェック）', background: '#fce4ec', color: '#880e4f' },
  { order: 5, key: 'onsite', label: '⑤ 本番当日', background: '#ede7f6', color: '#4527a0' },
  { order: 6, key: 'after', label: '⑥ アフターフェーズ', background: '#efebe9', color: '#4e342e' }
];

function PanelPhases_normalize(rawLabel) {
  var text = String(rawLabel == null ? '' : rawLabel).normalize('NFKC').trim();
  if (!text || text === '必要が出たら着手') return null;
  text = text.replace(/^【|】$/g, '').trim();
  if (text === '営業' || text === '失注' || text === '受注') return 'sales';
  if (text === '初動' || text === '第1フェーズ') return 'p1';
  if (text === '第2フェーズ') return 'p2';
  if (text === '第3フェーズ' || text === '第4フェーズ' || text === '本番前') return 'p3';
  if (text === '本番') return 'onsite';
  if (text === 'アフター' || text === 'ここまでは本番後一週間を目処に' || text === '完了') return 'after';
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PANEL_PHASES: PANEL_PHASES, PanelPhases_normalize: PanelPhases_normalize };
}
