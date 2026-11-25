// 判断を行う人の分類。通知先の解決は既存通知ツールに任せる。
export function decisionOwnerOf(row) {
  if (/^(?:kim@orgiast\.jp|kim-PC)$/i.test(String(row.owner || '').trim())) return 'kim';
  return /決定ID|kim-PC|kim\s*(?:の\s*)?(?:承認|判断)|kim\s*ご自身/i.test(`${row.nextKim || ''}\n${row.reason || ''}`) ? 'kim' : 'owner';
}

export function isChoiceFormat(text) {
  return /[AＡ][)）][\s\S]*[BＢ][)）]|[1１一]\s*択で指示/i.test(String(text || ''));
}
