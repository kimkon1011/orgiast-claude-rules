// Bank spellings are search hints, never evidence that a vendor has no work history.
export const cleanPayeeName = value => String(value ?? '').normalize('NFKC')
  .replace(/\s+([\u3099\u309a])/g, '$1').normalize('NFC')
  .replace(/株式会社|有限会社|合同会社|\((?:株|有|同)\)/g, '')
  .replace(/(?:\((?:カ|ユ|ド|シャ|シヤ|ザイ|トクヒ)\)?|(?:カ|ユ|ド|シャ|シヤ|ザイ|トクヒ)\))/g, '').trim();
const largeKana = value => value.replace(/[ァィゥェォャュョッヮ]/g, c => ({ァ:'ア',ィ:'イ',ゥ:'ウ',ェ:'エ',ォ:'オ',ャ:'ヤ',ュ:'ユ',ョ:'ヨ',ッ:'ツ',ヮ:'ワ'})[c]);
export const normalizeKana = value => largeKana(cleanPayeeName(value)
  .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)))
  .replace(/[-−‐‑–—ｰー]/g, 'ー').replace(/[\s・･]+/g, '');
export const kanaOnly = value => /\p{Script=Katakana}/u.test(normalizeKana(value)) && /^[\p{Script=Katakana}\p{N}\p{P}ー\s]+$/u.test(normalizeKana(value));
export function payeeSearch(name, patterns = {}, partners = []) {
  const term = cleanPayeeName(name);
  if (!kanaOnly(term)) return { searchTerms: [term].filter(Boolean), searchBasis: '実名', kanaUnverified: false };
  const key = normalizeKana(term);
  const aliases = Object.entries(patterns.kana_vendor_aliases || {}).filter(([k]) => normalizeKana(k) === key).flatMap(([, v]) => v);
  const named = aliases.length ? aliases : partners.filter(p => p.name_kana && normalizeKana(p.name_kana) === key).map(p => p.name);
  const names = [...new Set(named.map(cleanPayeeName).filter(n => n && !kanaOnly(n)))];
  if (names.length) return { searchTerms: names, searchBasis: aliases.length ? 'kana_vendor_aliases' : 'freee name_kana', kanaUnverified: false };
  return { searchTerms: [...new Set([term, term.replace(/[-−‐‑–—ｰ]/g, 'ー').replace(/\s+/g, ''), key])], searchBasis: 'カナ正規化バリアント', kanaUnverified: true };
}
