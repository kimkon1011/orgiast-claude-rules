const OPS = /(ダブルクリック|クリック|タップ|長押し|押して|押す|押し|入力して|入力し|貼り付け|貼って|ログインして|ログインし|承認して|認証して|インストール|設定して|設定し|開いて|開く|選んで|選択して|選択し|有効に|オンに|ON ?に|許可して|許可し|Allow|ダウンロードして|実行して|起動して|再起動|撮って|撮影して|追加して|保存して|複製して|コピーして)/;
const REQUEST = /(てください|て下さい|てほしい|て欲しい|てもらえ|をお願いします|お願いします)/;
const REPLY = /(返信|返事|教え|知らせ|送って|貼って.*返|回答|一言|選んで.*(?:返|教え))(し)?て?\s*(ください|下さい|ほしい|欲しい)/;
export function classifyHandoff(text) {
  let fence = null;
  const prose = String(text || '').split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) { if (!fence) fence = match[1]; else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null; return false; }
    return !fence && !/^\s*>/.test(line);
  }).join('\n');
  const next = prose.match(/次に kim がすること[:：]\s*([^\n]*)/)?.[1] || '';
  if (prose.split(/[。！？\n]/).some(s => OPS.test(s) && REQUEST.test(s)) || prose.split('\n').filter(s => (/^\s*(?:\d+|[０-９]+)[.)．、]\s/.test(s) || /^\s*[①-⑩]/.test(s)) && OPS.test(s)).length >= 2 || (!next.startsWith('なし') && OPS.test(next))) return 'manual-steps';
  if (REPLY.test(prose) || /返信|返事|回答|教えて|知らせて/.test(next)) return 'reply-only';
  return 'none';
}
