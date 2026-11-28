// 訪問・郵送の予定を全案件の必要書類と突き合わせる（kim 2026-11-27「訪問に行くのはものすごいコスト」）。
// 入力は期限台帳の行（deadline-ledger の FIELDS 形式）。外部送信はしない。
const CLOSED = new Set(['完了', '不要', '見送り']);

export function classify(row, offices) {
  const text = [row.title, row.action].filter(Boolean).join(' '); // 根拠・備考は他案件への言及を含むので窓口判定に使わない
  return offices.filter(o => new RegExp(o.match).test(text)).map(o => o.office);
}

function tagged(row, key) {
  // 備考に「訪問:2026-11-30@法務局」「郵送:2026-11-30」のように書かれた予定を拾う
  const m = String(row.notes || '').match(new RegExp(`${key}[:：]\\s*(\\d{4}-\\d{2}-\\d{2})(?:\\s*@\\s*([^\\s/、,]+))?`));
  return m ? { date: m[1], office: m[2] || '' } : null;
}

export function consolidate(rows, { offices, visitWords, mailWords, today }) {
  const open = rows.filter(r => r.id && !CLOSED.has(r.status));
  const items = open.map(r => ({ row: r, offices: classify(r, offices) }));
  const visits = [], mails = [];
  for (const it of items) {
    const text = [it.row.title, it.row.action, it.row.notes].join(' ');
    const v = tagged(it.row, '訪問') || (new RegExp(visitWords).test(text) && it.offices.some(o => o !== '郵便局（発送）') ? { date: it.row.due, office: '' } : null);
    if (v) for (const office of (v.office ? [v.office] : it.offices.filter(o => o !== '郵便局（発送）'))) visits.push({ id: it.row.id, title: it.row.title, date: v.date, office });
    const m = tagged(it.row, '郵送') || (new RegExp(mailWords).test(text) ? { date: it.row.due } : null);
    if (m) mails.push({ id: it.row.id, title: it.row.title, date: m.date });
  }
  const officeOf = name => offices.find(o => o.office === name) || { avoid: [] };
  const visitPlans = visits.map(v => ({
    ...v,
    bundle: items.filter(it => it.row.id !== v.id && it.offices.includes(v.office)).map(it => ({ id: it.row.id, title: it.row.title, due: it.row.due })),
    avoid: officeOf(v.office).avoid,
  }));
  const mailDates = [...new Set(mails.map(m => m.date).filter(Boolean))].sort();
  const mailBatches = mailDates.map(date => ({ date, items: mails.filter(m => m.date === date) })).filter(b => b.items.length > 1);
  const pendingWords = /【要確認】|要確認|後に取得|完了後|取り直|未定/;
  const unscheduled = items.filter(it => it.offices.length && (!it.row.due || pendingWords.test([it.row.title, it.row.action].join(' '))))
    .map(it => ({ id: it.row.id, title: it.row.title, offices: it.offices, why: !it.row.due ? '期限日が空' : '【要確認】のまま（期限・担当・取り方を決めて台帳に載せる）' }));
  const stale = items.filter(it => it.row.due && today && it.row.due < today && it.row.kind === '訴訟・法務')
    .map(it => ({ id: it.row.id, title: it.row.title, due: it.row.due, why: '期限を過ぎて未完了。期限が古い（延長・変更）なら正しい期限に直す' }));
  return { visitPlans, mailBatches, unscheduled, stale };
}

export function renderReport(result, { today, ledgerUrl = '' } = {}) {
  const L = [`# 訪問・郵送の集約チェック（${today}）`, ''];
  L.push('## 訪問予定と、同じ窓口でまとめられる用事');
  if (!result.visitPlans.length) L.push('- 訪問予定なし');
  for (const v of result.visitPlans) {
    L.push(`- ${v.date || '日付未定'} ${v.office}：${v.title}（${v.id}）`);
    L.push(`  - 先に訪問を避けられないか：${v.avoid.join(' / ') || '（辞書なし）'}`);
    L.push(v.bundle.length ? `  - 同じ窓口でまとめる候補：${v.bundle.map(b => `${b.title}（${b.id}${b.due ? '・期限' + b.due : ''}）`).join('、')}` : '  - 同じ窓口の他案件：なし');
  }
  L.push('', '## 同じ日の郵送（1便にまとめる）');
  L.push(...(result.mailBatches.length ? result.mailBatches.map(b => `- ${b.date}：${b.items.map(i => `${i.title}（${i.id}）`).join('、')}`) : ['- なし']));
  L.push('', '## 期限・取り方が決まっていない書類（要対応）');
  L.push(...(result.unscheduled.length ? result.unscheduled.map(u => `- ${u.title}（${u.id}・${u.offices.join('/')}）：${u.why}`) : ['- なし']));
  L.push('', '## 期限が古い可能性（訴訟・法務）');
  L.push(...(result.stale.length ? result.stale.map(s => `- ${s.title}（${s.id}・期限${s.due}）：${s.why}`) : ['- なし']));
  if (ledgerUrl) L.push('', `期限台帳: ${ledgerUrl}`);
  return L.join('\n') + '\n';
}
