const stopWords = new Set(['して', 'する', 'します', 'ください', 'お願い', 'それ', 'これ', 'あの', 'the', 'and', 'for', 'with', 'this', 'that']);


// session-purpose-gate.mjs の tokens() と同じ正規化（台帳は参照しない）。
export function purposeTokens(text) {
  const found = new Set();
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) || []) found.add(word.toLowerCase());
  for (const word of text.match(/[ァ-ヶー]{2,}/g) || []) found.add(word);
  for (const word of text.match(/[一-龥]{2,}/g) || []) {
    if (word.length >= 3) for (let i = 0; i < word.length - 1; i++) found.add(word.slice(i, i + 2));
    else found.add(word);
  }
  for (const word of [...found]) if (word.length < 2 || /^\d+$/.test(word) || stopWords.has(word)) found.delete(word);
  return found;
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

