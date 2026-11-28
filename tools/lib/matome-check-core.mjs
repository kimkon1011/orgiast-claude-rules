// 一回にまとめる：案件内の義務と計画を照合する純関数。
export const OBLIGATIONS = [
  { id: 'direct', label: '直送', re: /直送/u, planRe: /直送|代理人.{0,12}(?:宛て|あて)?.{0,12}送付書/u },
  { id: 'separate', label: '別送 / 追って送付', re: /別送|追って(?:郵送|送付|提出)/u },
  { id: 'copy', label: '控え', re: /控え/u },
  { id: 'copies', label: '写し部数', re: /写し\s*[0-9０-９一二三四五六七八九十]+\s*(?:部|通)/u },
  { id: 'sign', label: '署名・押印の追加', re: /署名(?:を)?もらう|署名済み|追加署名|押印/u },
  { id: 'certificate', label: '証明書の取得', re: /資格証明書|登記事項証明書|印鑑証明|住民票/u },
];

const excluded = /出さない|使わない|入れない|印刷もしない|印刷していない|今回は|今日は|保留|後で|後日|別件|返事の例|要承認|未着|出す場合|判断.*後/u;
const splitReason = /(?:^|\[)分割理由\s*:/u;
const remainder = /残り\s*:.+/u;

export function lineRecords(files) {
  return files.flatMap(file => String(file.text || '').replace(/\r/g, '').split('\n').map((text, i) => ({ file: file.name, line: i + 1, text })));
}

export function checkMatome({ sources = [], plans = [] }) {
  const sourceLines = lineRecords(sources);
  const planLines = lineRecords(plans);
  const hasReason = planLines.some(x => splitReason.test(x.text));
  const hasRemainder = planLines.some(x => remainder.test(x.text));
  const results = [];
  for (const kind of OBLIGATIONS) {
    const evidence = sourceLines.filter(x => kind.re.test(x.text));
    if (!evidence.length) continue;
    const matches = planLines.filter(x => (kind.planRe || kind.re).test(x.text));
    const positive = matches.filter(x => !excluded.test(x.text));
    let status = 'ok';
    let message = '計画に含まれている';
    if (hasReason && hasRemainder && (!positive.length || matches.some(x => excluded.test(x.text)))) {
      status = 'split'; message = '分割（理由あり）';
    } else if (!matches.length) {
      status = 'warning'; message = '計画に入っていない';
    } else if (!positive.length) {
      status = 'warning'; message = '計画から外されている（分けた理由と、残りをいつ・誰がやるかが書かれていない）';
    }
    const parties = kind.id === 'direct' ? evidence.flatMap(x => [...x.text.matchAll(/(?:申立人代理人|代理人|弁護士|相手方|先方)(?:（([^）]+)）|[：:\s]*([^、。には]+))?/gu)].map(m => (m[1] || m[2] || m[0]).trim())) : [];
    results.push({ kind: kind.id, label: kind.label, status, message, evidence, matches, parties: [...new Set(parties)] });
  }
  return { results, warnings: results.filter(x => x.status === 'warning') };
}

const clip = text => text.length > 80 ? `${text.slice(0, 79)}…` : text;
export function renderMatome(result, caseDir) {
  const out = [`まとめ確認（${caseDir}）`];
  if (!result.results.length) out.push('対象となる義務は見つかりませんでした。');
  for (const item of result.results) {
    out.push(`\n- ${item.label}: ${item.message}${item.parties.length ? `（相手: ${item.parties.join('、')}）` : ''}`);
    for (const e of item.evidence) out.push(`  出典 ${e.file}:${e.line} ${clip(e.text.trim())}`);
    for (const p of item.matches) out.push(`  計画 ${p.file}:${p.line} ${clip(p.text.trim())}`);
  }
  out.push('\n一回にまとめる：出す前に同じ案件・同じ相手・同じ締切の作業を全部洗い出して1回にまとめる。分けるときは理由を書く');
  return out.join('\n');
}
