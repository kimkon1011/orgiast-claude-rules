/**
 * Phase5: 質問応答 (Q&A) — 現場/お客様の質問に即答するサポート機能。
 *
 * 流れ:
 *   1) caseId と質問を受け取る
 *   2) 質問からキーワード抽出 → マニュアル抜粋を 5〜10 ページ取得
 *   3) 案件 zissi の「確認」「報告」「アイテムリスト」「設営」シートを context として乗せる
 *   4) Claude に質問 + context を投げて回答 + 参照元 を JSON で返す
 *
 * 出力:
 *   { answer, sources[], confidence, follow_up_questions[] }
 *   ハルシネーション禁止 — 答えられない場合は「マニュアル/案件データに該当情報なし」と書く。
 */

function Phase5_Qna_ask(caseId, question) {
  if (!question || !String(question).trim()) {
    throw new Error('質問が空です。');
  }
  const q = String(question).trim();

  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  const built = _Phase5_buildQnaContext(c, q);
  const queries = built.queries;
  const manualPages = built.manualPages;
  const zissiSs = built.zissiSs;
  const cachedContext = built.cachedContext;

  const userPrompt = [
    '展示会ブース制作の規定判定ができる職人 AI として、上の context と添付 PDF のみを根拠に',
    '以下の質問に答えてください。**context に書いていない情報は推測で答えず**、確認すべき相手 (主催/施工/CL 等) を follow_up_questions に出す。',
    '',
    '## 質問',
    q,
    '',
    '## 出力形式（厳守・JSON 単体、説明文/```json``` ブロック禁止）',
    '{',
    '  "regulation_check": {"verdict": "適合|違反|グレー|規定に記載なし", "quoted_rule": "<原文引用。改変禁止。無ければ空文字>", "source_label": "<PDFファイル名 or マニュアルページ名>", "reasoning": "<読み方>"},',
    '  verdict の定義:',
    '    適合 = 引用条文に照らして問題なし',
    '    違反 = 引用条文に明確に反する',
    '    グレー = 適用される条文は引用できたが、質問の具体的なケースの可否が明記されていない',
    '      （★条文を1つでも quoted_rule に引用できたなら「規定に記載なし」ではなく必ずこれ）',
    '    規定に記載なし = 関連する条文が資料内に一切見つからず quoted_rule が空',
    '  "solutions": [{"rank": 1, "tier": "規格組替|再利用フィラー|構造で吸収|消耗品", "action": "<具体策>", "waste": "ゼロ|少|消耗", "note": "<制約・注意>"}],',
    '  "answer": "<回答本文。前置きなしで端的に。300 字以内目安>",',
    '  "sources": [',
    '    {"type": "出展規定PDF|マニュアル|案件資料ダイジェスト|保有機材|案件zissi", "label": "<参照元>", "excerpt": "<100字以内>"}',
    '  ],',
    '  "confidence": "high|mid|low",',
    '  "follow_up_questions": [',
    '    "<答えるために追加で確認すべきこと>"',
    '  ]',
    '}',
    '',
    '## 厳守ルール',
    '- マニュアル/案件データに書いていない事実は答えない。「context に該当情報がないため要確認」と書き follow_up_questions に積む。',
    '- 数値・日時・連絡先は context から完全一致で引用。少しでも曖昧なら confidence=low、要確認と明記。',
    '- 推測は禁止。ハルシネーション禁止。',
    '- sources は必ず実在の引用元のみ（マニュアル抜粋 or zissi シート名）。捏造禁止。'
    ,'- quoted_rule は添付 PDF / マニュアルからの原文コピーのみ。要約・言い換え・創作は禁止。引用できなければ verdict="規定に記載なし" とし、主催者事務局への確認を follow_up_questions に必ず入れる。'
    ,'- quoted_rule が空でない場合 verdict に "規定に記載なし" を選んではならない。適合/違反/グレーのいずれかにする。'
    ,'- solutions は廃棄ゼロ優先で、規格組替 → 再利用フィラー → 構造で吸収 → 消耗品の順。木工造作・使い捨て部材を第一候補にしない。'
    ,'- 寸法・数量はモジュール割り計算結果と保有機材の値をそのまま使い、再計算・上書きしない。'
    ,'- 在庫数を超える使用を提案しない。展示パネルは単体で自立しない制約も守る。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: built.manualPdfs,
    maxTokens: 2500
  });

  const parsed = _Phase1_parseJson(res.text);

  // Q&A ログを zissi の「Claude_QAログ」シートに追記
  if (zissiSs) {
    _Phase5_appendQaLog(zissiSs, q, parsed);
  }

  return {
    question: q,
    regulationCheck: parsed.regulation_check || { verdict: '規定に記載なし', quoted_rule: '', source_label: '', reasoning: '' },
    solutions: parsed.solutions || [],
    answer: parsed.answer || '(回答が取得できませんでした)',
    sources: parsed.sources || [],
    confidence: parsed.confidence || 'low',
    followUpQuestions: parsed.follow_up_questions || [],
    manualPagesUsed: manualPages.length,
    queriesUsed: queries,
    usage: res.usage
  };
}

function _Phase5_buildQnaContext(c, q) {
  const queries = _Phase5_extractQueryKeywords(q);
  const manualPages = ManualLoader_findPages(queries).slice(0, 8);
  const manualPdfs = CaseManualPdf_find(c, { maxFiles: 3 }).slice(0, 3);
  const digest = CaseDigest_load(c) || '';
  let zissiSs = null;
  if (c.zissiId) try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  const zissiContext = zissiSs ? _Phase5_extractZissiContext(zissiSs) : '';
  const targets = [];
  const seen = {};
  const re = /(?:^|[^0-9])([0-9]{4,})(?=[^0-9]|$)/g;
  let m;
  while ((m = re.exec(String(q))) && targets.length < 3) {
    const n = Number(m[1]); if (!seen[n]) { targets.push(n); seen[n] = true; }
  }
  const parts = OwnedEquipment_wallParts();
  const calculations = targets.map(function (target) {
    return { targetMm: target, result: ModuleFit_solve(target, parts) };
  });
  const calcText = calculations.map(function (x) {
    const choices = x.result.exact.length ? x.result.exact : x.result.closest;
    const lines = choices.map(function (s) {
      return s.pieces.map(function (p) { return p.name + ' ' + p.width + '×' + p.count; }).join(' + ') + ' = ' + s.total + 'mm / gap ' + s.gap + 'mm';
    });
    const headline = x.result.exact.length ? 'ぴったり組める解あり。' : 'ぴったり組める解なし。最小の余りは ' + (choices[0] ? Math.abs(choices[0].gap) : '算出不能') + ' mm。';
    return '対象幅 ' + x.targetMm + 'mm: ' + headline + '\n' + lines.join('\n');
  }).join('\n\n');
  const cachedContext = [
    OwnedEquipment_describe(),
    digest ? '【案件資料ダイジェスト(夜間に全資料を読んで作成)】\n' + digest : '',
    '【関連マニュアル抜粋】\n' + manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; }).join('\n\n'),
    '【案件情報】\n- 案件 ID: ' + c.caseId + '\n- クライアント: ' + c.clientName + '\n- 案件名: ' + c.caseName + '\n- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate) + '\n- ブースサイズ: ' + (c.boothSize || '未確定'),
    '【案件 zissi 抜粋】\n' + (zissiContext || '(zissi 未取得)'),
    calcText ? '【モジュール割り計算結果（コードで計算済み・この数値を使うこと）】\nこの計算はコードで実行済み。LLM 側で再計算・上書きしないこと。\n' + calcText : ''
  ].filter(Boolean);
  return { queries: queries, manualPages: manualPages, manualPdfs: manualPdfs, digest: digest, zissiSs: zissiSs, cachedContext: cachedContext, solverTargets: targets, solverParts: parts, solverCalculations: calculations };
}

function _debug_qnaContext(caseId, question) {
  const c = CaseList_getById(caseId);
  if (!c) return { error: 'not found' };
  const b = _Phase5_buildQnaContext(c, String(question || ''));
  return { caseId: caseId, manualPages: b.manualPages.length, regulationPdfs: b.manualPdfs.map(function (p) { return p.label; }), digestPresent: Boolean(b.digest), digestChars: b.digest.length, solverInput: { targets: b.solverTargets, parts: b.solverParts }, solverResults: b.solverCalculations, context: b.cachedContext };
}

function _Phase5_extractQueryKeywords(question) {
  const text = String(question || '').trim();
  const particles = /(?:しかありません|について|における|ですが|ますが|です|ます|必要|場合|とは|には|では|から|まで|ので|のに|けど|が|は|を|に|で|と|も|や|へ|の)/;
  const fragments = text
    .replace(/[、。．・「」『』（）()【】\[\]\?？!！\.,]/g, ' ')
    .split(/\s+/)
    .reduce(function (all, phrase) { return all.concat(phrase.split(particles)); }, [])
    .map(function (part) { return part.trim(); })
    .filter(function (part) { return part.length >= 2 && !/^[0-9０-９]+(?:mm)?$/i.test(part) && !/^[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]+$/.test(part); });
  const tokens = [];
  const preferred = text.match(/パネル|間仕切り?|施工|規定/g) || [];
  preferred.forEach(function (token) { tokens.push(token.replace(/り$/, '')); });
  fragments.forEach(function (fragment) {
    const blocks = fragment.match(/[ァ-ヶー]{3,}|[一-龠]{2,}|[A-Za-z][A-Za-z0-9]{2,}/g) || [];
    blocks.forEach(function (block) { tokens.push(block); });
    if (fragment.length <= 20 && !/^[0-9０-９]+$/.test(fragment)) tokens.push(fragment);
  });
  const seen = {};
  const out = [];
  for (let i = 0; i < tokens.length && out.length < 8; i++) {
    if (!seen[tokens[i]]) { seen[tokens[i]] = true; out.push(tokens[i]); }
  }
  return out.length > 0 ? out : [text.slice(0, 20) || '質問'];
}

function _Phase5_extractZissiContext(zissiSs) {
  const sections = [];
  // 確認シート
  try {
    const sh = zissiSs.getSheetByName('確認') || _Phase6_findSheetByKeyword(zissiSs, ['確認事項']);
    if (sh) {
      const lastRow = Math.min(sh.getLastRow(), 40);
      const lastCol = Math.min(sh.getLastColumn(), 6);
      if (lastRow >= 2 && lastCol >= 2) {
        const data = sh.getRange(1, 1, lastRow, lastCol).getValues();
        sections.push('--- 「' + sh.getName() + '」抜粋 ---\n' + _Phase5_renderRows(data));
      }
    }
  } catch (e) {}
  // アイテムリスト
  try {
    const sh = zissiSs.getSheetByName(ITEMLIST_PROPOSAL_SHEET_NAME);
    if (sh) {
      const lastRow = Math.min(sh.getLastRow(), 60);
      const lastCol = Math.min(sh.getLastColumn(), 5);
      if (lastRow >= 2 && lastCol >= 2) {
        const data = sh.getRange(1, 1, lastRow, lastCol).getValues();
        sections.push('--- 「アイテムリスト」抜粋 ---\n' + _Phase5_renderRows(data));
      }
    }
  } catch (e) {}
  // 設営/搬入関連 Doc/シート
  try {
    const sh = _Phase6_findSheetByKeyword(zissiSs, ['設営', '搬入', '当日']);
    if (sh) {
      const lastRow = Math.min(sh.getLastRow(), 40);
      const lastCol = Math.min(sh.getLastColumn(), 6);
      if (lastRow >= 2 && lastCol >= 2) {
        const data = sh.getRange(1, 1, lastRow, lastCol).getValues();
        sections.push('--- 「' + sh.getName() + '」抜粋 ---\n' + _Phase5_renderRows(data));
      }
    }
  } catch (e) {}
  return sections.join('\n\n');
}

function _Phase5_renderRows(data) {
  const lines = [];
  data.forEach(function (row) {
    const text = row.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' | ');
    if (text) lines.push(text);
  });
  return lines.join('\n');
}

function _Phase5_appendQaLog(zissiSs, question, parsed) {
  const SHEET = 'Claude_QAログ';
  let sh = zissiSs.getSheetByName(SHEET);
  if (!sh) {
    try { sh = zissiSs.insertSheet(SHEET); }
    catch (e) { sh = zissiSs.getSheetByName(SHEET); }
    if (sh) {
      sh.getRange(1, 1, 1, 8).setValues([['日時', '質問', '回答', '確信度', '要追加確認', '規定判定', '引用条文', '採用解決策']])
        .setFontWeight('bold').setBackground('#cfe2f3');
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 130);
      sh.setColumnWidth(2, 300);
      sh.setColumnWidth(3, 400);
      sh.setColumnWidth(4, 80);
      sh.setColumnWidth(5, 260);
    }
  }
  if (!sh) return;
  const expected = ['日時', '質問', '回答', '確信度', '要追加確認', '規定判定', '引用条文', '採用解決策'];
  if (sh.getMaxColumns() < expected.length) sh.insertColumnsAfter(sh.getMaxColumns(), expected.length - sh.getMaxColumns());
  const current = sh.getRange(1, 1, 1, expected.length).getValues()[0];
  for (let i = 0; i < expected.length; i++) if (!current[i]) sh.getRange(1, i + 1).setValue(expected[i]);
  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  const regulation = parsed.regulation_check || {};
  const adopted = (parsed.solutions || []).map(function (s) { return (s.rank || '') + '. [' + (s.tier || '') + '] ' + (s.action || ''); }).join('\n');
  sh.appendRow([
    ts,
    question,
    parsed.answer || '',
    parsed.confidence || '',
    (parsed.follow_up_questions || []).join('\n'),
    regulation.verdict || '',
    regulation.quoted_rule || '',
    adopted
  ]);
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  _Phase5_extractQueryKeywords: _Phase5_extractQueryKeywords
};
