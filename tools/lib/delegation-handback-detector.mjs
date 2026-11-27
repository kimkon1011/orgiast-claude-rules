// 手続き代行の即時開始ルール: 説明・確認・検証依頼による差し戻しを日次監査で検出する。
// ルール本文そのもの（「〜してはならない」という引用）は違反にしない。

const HAND_BACK = [
  /試して(?:、?結果を)?教えて(?:ください|ほしい|欲しい)/,
  /反応がなければ教えて(?:ください|ほしい)(?!もらう)/,
  /ご自身で(?:お)?(?:手続き|操作|進めて|実施)/,
  /以下の手順で(?:進めて|操作して|やって)ください/,
  /手順を(?:お送り|ご案内)します/,
  /代行しましょうか/,
  /依頼文の例を送って/,
  /例を(?:送って|ください|教えて)/,
];

const APPLICABLE = /手続き|代行|有効化|ログイン|どうやって|承認|サインイン|手順|検証をユーザー|差し戻し/;

export function detectDelegationHandback(text) {
  const t = String(text || '');
  if (!t.trim()) return { applicable: false, violation: false };
  const hitEarly = HAND_BACK.some((re) => re.test(t));
  if (!hitEarly && !APPLICABLE.test(t)) return { applicable: false, violation: false };
  // ルール・監査・テスト報告の引用は、禁止事項の文言を含んでいても違反にしない。
  const citingRule = /手続き代行の即時開始ルール/.test(t)
    && /検証をユーザーに任せること自体が差し戻し/.test(t);
  const quotingProhibition = /ユーザーに渡さない|差し戻しにあたる|確認で終わらせず|検証の手間を、ユーザーに渡さない/.test(t)
    && !/試して結果を教えてください[。．]?$/.test(t.trim());
  const hit = HAND_BACK.some((re) => re.test(t));
  if (hit && citingRule && !/試して結果を教えてください/.test(t) && !/代行しましょうか[？?]/.test(t.replace(/確認で終わらせず[sS]*代行しましょうか/, ''))) {
    // ルール本文に「代行しましょうか」の禁止引用だけがある場合は非違反。
    const instructing = /試して(?:、?結果を)?教えてください|反応がなければ教えてください|ご自身で進めてください|手順をお送りします|依頼文の例を送ってください/.test(t);
    return { applicable: true, violation: instructing };
  }
  if (hit && quotingProhibition && !/ください[。．]?$/.test(t.trim()) && !/代行しましょうか[？?]s*$/.test(t.trim())) {
    const instructing = /試して(?:、?結果を)?教えてください|反応がなければ教えてください|ご自身で進めてください|手順をお送りします|依頼文の例を送ってください/.test(t);
    if (!instructing) return { applicable: true, violation: false };
  }
  return { applicable: true, violation: hit };
}
