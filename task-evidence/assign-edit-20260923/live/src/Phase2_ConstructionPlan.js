/**
 * Phase2: 施工手順書【設営+撤去】 PDF レベル 26 スライド版 を Fable5 で生成。
 *
 * 参考ドキュメント: 施工手順書_マークスライフ様_設営撤去.pdf (26ページ)
 *   - Cover / 前提条件 / 体制(仮置き) / 絶対に守るべき5項目 / 先行リスク /
 *   - 第1部 設営 (班分け・全体スケジュール・15分刻みマトリクス2枚・P0-P7 手順・
 *     破損防止&立会・想定リスク&CP・緊急時&完了報告) /
 *   - 第2部 撤去 (同構成 P0-P6) /
 *   - 確定後差替項目 / 最終メッセージ
 *
 * Model: claude-fable-5 (詩的・構造的センスで PDF レベルの手順書に必要な緻密なテーブル/警告バー/
 *        15分刻みタイムテーブル/完了報告テンプレを 1 発で生成する狙い)
 *
 * 使い方: Phase2_ConstructionPlan_generate(caseId)
 *   → Slides + Doc の 2 種を Drive 保存、 URL を CaseList に記録
 */

const _CONSTRUCTION_PLAN_CONFIG = {
  displayName: '施工手順書(設営撤去)',
  docSuffix: '施工手順書_設営撤去_Fable5版',
  confirmCategoryPrefix: '[施工手順書]',
  manualQueries: ['設営', '撤去', '搬入', '搬出', 'ブース 施工手順', 'アンカー', 'トラス', 'LEDUP']
};

const _CP_FIXED_RULE_ASK_STAFF = {
  title: '自己判断禁止 ─ 迷ったら即座に社員へ',
  body: 'スタッフ間で議論したり、自分で悩んで自己判断しない。ほとんどのケースでやり直しになる。必ず即座に社員(オージャスト社員)に聞く。',
  highlight: true
};

const _CP_FIXED_RULE_STYRENE_TEGUSU = {
  title: 'スチレンボード固定 ─ ベルクロ(面ファスナー)使用禁止・テグス必須',
  body: 'スチレンボードをベルクロ・面ファスナーで取り付けるのは禁止。毎回会期中に落ちてクレームになる。設置は必ずテグスで行う。',
  highlight: true
};

// 2026-09-13 kim 指示(Googleタスク): 結束バンドはすべてリピートタイ。撤収で絶対に切って外さない。設営時も先っぽをできるだけ切らない。
const _CP_FIXED_RULE_REPEAT_TIE = {
  title: '結束バンドはすべてリピートタイ ─ 撤収時に絶対に切らない',
  body: '当社で使う結束バンドはすべてリピートタイ(ロックを解除して繰り返し使えるタイプ)。撤収時は結束バンドを絶対に切って外さない。切ると再使用できず資材も傷む。必ずロックを解除して外す。設営時も同じ理由で、結束バンドの先っぽ(余り)はできるだけ切らずに処理する。',
  highlight: true
};

// 2026-09-22 kim 指示: 展示台パネルに両面テープを貼る施工は、必ず先に養生を下に貼ってから両面テープを貼る。
const _CP_FIXED_RULE_PANEL_TAPE_YOJO = {
  title: '展示台パネルへの両面テープ ─ 必ず養生を下に貼ってから',
  body: '展示台パネルに両面テープで貼り付ける施工では、パネル面に直接両面テープを貼らない。必ず先に養生テープ(養生)をパネル面に貼り、その上に両面テープを貼る。直貼りすると撤去時にパネル表面が剥離・糊残りして再使用できなくなる。撤去は両面テープごと養生を剥がす。',
  highlight: true
};

const _CP_FIXED_RULES = [
  { rule: _CP_FIXED_RULE_ASK_STAFF, dedupe: /自己判断|社員に聞/ },
  { rule: _CP_FIXED_RULE_STYRENE_TEGUSU, dedupe: /ベルクロ|面ファスナー|テグス/ },
  { rule: _CP_FIXED_RULE_REPEAT_TIE, dedupe: /リピートタイ|結束バンド|タイラップ/ },
  { rule: _CP_FIXED_RULE_PANEL_TAPE_YOJO, dedupe: /(展示台|パネル)[^。]*両面テープ|両面テープ[^。]*養生|養生[^。]*両面テープ/ }
];

const _CP_FIXED_PROCEDURE_TUBE_LIGHT = {
  key: 'tube_light',
  figure: 'tube_light',
  title: '標準施工手順 ─ チューブライト(LEDネオンチューブ)の取り付け',
  intro: 'チューブライトは 320° 発光・40° は非発光。断面の「平らな面」が光らず「円形の面」が光る。非発光の平らな面を客から見えない向きにするのが全て。',
  steps: [
    '構造確認: 通電前に断面を見て「平らな面(非発光)」と「円形の面(発光)」を全員で確認する。',
    'アクリルケースへ挿入: 床養生の上でチューブライトをアクリルケース(透明筒)に通す。ねじれないように送り、ケース内で平らな面の向きが端から端まで揃っていることを確認する。',
    'トラス屋根部分への取り付け: 非発光の平らな面を「上(天井側)」に向けて固定する。下・外から見た人に非発光部分が見えない。固定は結束バンドでトラス材に留める(締め過ぎてケースを割らない)。',
    '柱(縦トラス)への取り付け: 必ず 2 本使う。非発光の平らな面同士を背中合わせに合わせて固定し、どの方向から見ても非発光面が隠れるようにする。',
    '点灯確認: 取り付け後に点灯し、客動線側(通路側・正面)から暗い帯(非発光面)が見えないことを目視で確認する。見えていれば外して向きを直す。'
  ],
  notes: [
    '向きの確認は「挿入時」「固定時」「点灯時」の 3 回行う。',
    '迷ったら自己判断せず即座に社員に聞く(絶対ルール No.1)。'
  ]
};

// 出典: 昇降機 Manual (Google Doc 1ZKlIXxy0Eqknl1W3NXxEBWOva5dZB_Zb9IYNWeZzjkI)
const _CP_FIXED_PROCEDURE_LIFT = {
  key: 'lift',
  title: '標準施工手順 ─ 昇降機(リフター)の使い方',
  intro: '昇降機(リフター)は最大高さ 4m・耐荷重 85kg。昇降棒は「丸」と「四角」の 2 本で、丸→四角の順に上げる。ハンドルを回していて途中で固くなったら、それ以上は絶対に上げない(戻らなくなる)。',
  steps: [
    '仕様確認: 最大高さ 4m・耐荷重 85kg。載せる人+機材の合計が 85kg を超えないこと、4m を超える高さの作業に使わないことを全員で確認する。',
    '設置: 足(脚)を広げ、床養生の上の水平で安定した場所に置く。足が完全に開いていることを確認してから乗る。',
    '上げる①(丸の昇降棒): ピンを入れたり外したりして、先に「丸の昇降棒」が上がる状態にし、ハンドルを回して上げる。',
    '上げる②(限界厳守): ハンドルを回していて途中で固くなったら、それ以上は絶対に上げない。無理に上げると戻らなくなる。',
    '上げる③(四角の昇降棒): 次にピンを抜き差しして「四角の昇降棒」が上がる状態に切り替えて上げる。ピンが硬い場合は力で抜かず、ハンドルを少し戻すと外れやすくなる。',
    '下げる: 上げと同じ要領でピンを差し替え、先に「四角の昇降棒」を下げる。下がらなくなったらピンを差し替えて「丸の昇降棒」を下げる。'
  ],
  notes: [
    '固くなった所から先は上げない。戻らなくなった場合は自己判断で対処せず即座に社員へ。',
    'ピンが硬い時は力で抜かず、ハンドルを少し戻してから抜く。',
    '迷ったら自己判断せず即座に社員に聞く(絶対ルール No.1)。'
  ]
};

// 2026-09-12 kim 指示(Googleタスク): 撤収ではトラックから工具と脚立以外は降ろさない。最後にトラックごと入れるので、先に解体をするといれる。
const _CP_FIXED_PROCEDURE_TEARDOWN_TRUCK = {
  key: 'teardown_truck',
  part: 'teardown',
  title: '標準施工手順 ─ 撤収時のトラック扱い(工具と脚立以外は降ろさない)',
  intro: '撤収では、トラックから降ろすのは「工具」と「脚立」のみ。他の資材・機材は一切降ろさない。最後にトラックごと入れるため、先に解体を済ませておけばそのまま積み込める。',
  steps: [
    '降ろすものは最小限: 撤収開始時にトラックから降ろすのは工具と脚立だけ。それ以外の資材・機材は降ろさない(降ろすと最後に全部積み込み直す二度手間になる)。',
    '解体を先に済ませる: ブースの解体を先に進める。解体が終わったものからまとめておき、積込可能な状態になったら順にトラックへ積み込む。',
    '最後にトラックごと入れる: 撤収の最後はトラックごと(搬出口・搬入口へ)入れて、解体済みの資材・機材を直接トラックへ積み込む。'
  ],
  notes: [
    '工具・脚立以外をトラックから降ろす必要が生じたら、自己判断せず即座に社員に聞く(絶対ルール No.1)。'
  ]
};

// 2026-09-12 kim 指示(Googleタスク): 設営の最後に、撤収に必要な工具(脚立・工具等)を一つの車に載せる。
const _CP_FIXED_PROCEDURE_SETUP_TOOL_VEHICLE = {
  key: 'setup_tool_vehicle',
  title: '標準施工手順 ─ 設営完了後に撤収工具を1台の車へ積込(脚立・工具)',
  intro: '設営の最後に、撤収で必要になる工具類(脚立・工具等)を一つの車にまとめて載せておく。撤収時に探しまわらず、他の資材とも混ざらない。',
  steps: [
    '設営の完了確認と一緒に、撤収で必要になる工具類(脚立・工具等)を確認する。',
    'それらを一つの車(1台)にまとめて載せる。複数の車に分散させない。',
    '撤収時はその車から取り出して使う(載せたまま撤収まで待つ)。'
  ],
  notes: [
    '載せる車が決まっていない・迷う場合は、自己判断せず即座に社員に聞く(絶対ルール No.1)。'
  ]
};

// 2026-09-13 kim 指示(Googleタスク): 撤収マニュアルの最初の注意事項=結束バンドはすべてリピートタイ。絶対に切って外さない。
const _CP_FIXED_PROCEDURE_REPEAT_TIE_TEARDOWN = {
  key: 'repeat_tie_teardown',
  part: 'teardown',
  title: '標準施工手順 ─ 撤収時の結束バンド(リピートタイは絶対に切らない)',
  intro: '当社の結束バンドはすべてリピートタイ(ロックを解除できるタイプ)。撤収では絶対に切って外さない。切ると二度と使えず資材も傷む。撤収作業の最初に全員で確認する。',
  steps: [
    '撤収の最初に全員で確認: 結束バンドはすべてリピートタイ。切って外すのは禁止。',
    '外し方: ロック部(爪)を指でつまんで解除し、結束バンドをスライドさせて抜く。ニッパー・ハサミ等で切らない。',
    '外した結束バンドは回収して再利用する(捨てない)。オリコン等の決めた場所にまとめる。',
    '固着・破損等で解除できない結束バンドを見つけても、自己判断で切らず即座に社員に聞く。'
  ],
  notes: [
    '結束バンドを切って外すのは絶対禁止(すべてリピートタイ)。解除できない時は自己判断せず即座に社員に聞く(絶対ルール No.1)。'
  ]
};

// 2026-09-13 kim 指示(Googleタスク): 施工(設営)の最初にもリピートタイである旨。先っぽをできるだけ切らないで処理する。
const _CP_FIXED_PROCEDURE_REPEAT_TIE_SETUP = {
  key: 'repeat_tie_setup',
  title: '標準施工手順 ─ 設営時の結束バンド(リピートタイ・先っぽはできるだけ切らない)',
  intro: '設営で使う結束バンドもすべてリピートタイ。撤収で切らずに解除して外せるよう、先っぽ(余り)はできるだけ切らずに処理する。',
  steps: [
    '設営の最初に全員で確認: 結束バンドはすべてリピートタイ(撤収で解除して外すため切らない)。',
    '結束時は締め過ぎない(アクリルケース・資材を割らない)。緩みがない程度に留める。',
    '先っぽ(余り)の処理: 目につかない場所は先っぽをできるだけ切らない。切らずに根元側へ折り返して留める等で見えなくする。',
    '目につく場所でどうしても長い場合だけ必要な分を切る。ロック部(爪)と、つまんで解除できる余裕は絶対に残す。',
    '迷ったら自己判断せず即座に社員に聞く(絶対ルール No.1)。'
  ],
  notes: [
    '先っぽを切るほど撤収で解除しにくくなる。切らずに処理するのが原則。'
  ]
};

const _CP_LIFT_KEYWORDS = /昇降機|リフター|昇降棒|昇降台/;

/** 案件本文に昇降機の使用を示す語があるか判定する (GAS API 非依存)。 */
function Phase2_ConstructionPlan_usesLift(parsed) {
  if (parsed == null) return false;
  const content = {};
  Object.keys(parsed).forEach(function (key) {
    if (key !== 'fixed_procedures') content[key] = parsed[key];
  });
  return _CP_LIFT_KEYWORDS.test(JSON.stringify(content));
}

const _CP_FIXED_PROCEDURES = [
  { procedure: _CP_FIXED_PROCEDURE_TUBE_LIGHT, when: null },
  { procedure: _CP_FIXED_PROCEDURE_LIFT, when: Phase2_ConstructionPlan_usesLift },
  { procedure: _CP_FIXED_PROCEDURE_TEARDOWN_TRUCK, when: null },
  { procedure: _CP_FIXED_PROCEDURE_SETUP_TOOL_VEHICLE, when: null },
  { procedure: _CP_FIXED_PROCEDURE_REPEAT_TIE_TEARDOWN, when: null },
  { procedure: _CP_FIXED_PROCEDURE_REPEAT_TIE_SETUP, when: null },
];

/** 固定ルールを先頭に統一し、連番を振り直す (GAS API 非依存)。 */
function Phase2_ConstructionPlan_ensureFixedRules(parsed) {
  const rules = Array.isArray(parsed.absolute_rules) ? parsed.absolute_rules : [];
  parsed.absolute_rules = rules.filter(function (rule) {
    const title = rule && rule.title != null ? String(rule.title) : '';
    const body = rule && rule.body != null ? String(rule.body) : '';
    return !_CP_FIXED_RULES.some(function (fixed) {
      return fixed.dedupe.test(title) || fixed.dedupe.test(body);
    });
  });
  const fixedRules = _CP_FIXED_RULES.map(function (fixed) {
    return {
      title: fixed.rule.title,
      body: fixed.rule.body,
      highlight: fixed.rule.highlight
    };
  });
  parsed.absolute_rules = fixedRules.concat(parsed.absolute_rules);
  parsed.absolute_rules.forEach(function (rule, index) {
    rule.no = index + 1;
  });
  return parsed;
}

/** 標準施工手順を正規テンプレートのディープコピーで毎回上書きする (GAS API 非依存)。 */
function Phase2_ConstructionPlan_ensureFixedProcedures(parsed) {
  parsed.fixed_procedures = _CP_FIXED_PROCEDURES.filter(function (fixed) {
    return fixed.when == null || fixed.when(parsed);
  }).map(function (fixed) {
    const procedure = fixed.procedure;
    return {
      key: procedure.key,
      part: procedure.part || null,
      figure: procedure.figure || null,
      title: procedure.title,
      intro: procedure.intro,
      steps: procedure.steps.slice(),
      notes: procedure.notes.slice()
    };
  });
  return parsed;
}

/** 全固定コンテンツを決定的な順序で注入する (GAS API 非依存)。 */
function Phase2_ConstructionPlan_ensureFixedContent(parsed) {
  Phase2_ConstructionPlan_ensureFixedRules(parsed);
  Phase2_ConstructionPlan_ensureFixedProcedures(parsed);
  return parsed;
}

/**
 * 段階 A-1: Fable5 で「共通+設営」のみを生成し JSON を Drive 保存。
 * 段階 A-2: Fable5 で「撤去+後書き」のみを生成し JSON を Drive 保存。
 * 段階 B: A-1 + A-2 の 2 JSON をマージして Slides + Doc 生成。
 * 分割理由: Fable5 の応答時間 + Apps Script 6 分制限 (単一 15k tokens 呼び出しは 6 分超え)。
 */
function Phase2_ConstructionPlan_callFable5_setup(caseId, useOpus) {
  return _Phase2_callFable5Part(caseId, 'setup', useOpus);
}
function Phase2_ConstructionPlan_callFable5_teardown(caseId, useOpus) {
  return _Phase2_callFable5Part(caseId, 'teardown', useOpus);
}

function _Phase2_callFable5Part(caseId, part, useOpus) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const manualPages = ManualLoader_findPages(_CONSTRUCTION_PLAN_CONFIG.manualQueries).slice(0, 2);
  const itemListAndCatalog = _Phase2_loadItemListAndCatalog(c);
  const caseDigest = CaseDigest_load(c);
  const cachedContext = [
    Case_loadClientContext(c),
    caseDigest ? '【案件資料ダイジェスト(夜間に全資料を読んで作成)】\n' + caseDigest : '',
    '【関連マニュアル抜粋】\n' + manualPages.map(function (p) { return '# ' + p.title + '\n' + p.body.slice(0, 1000); }).join('\n\n'),
    '【案件アイテムリスト】\n' + (itemListAndCatalog || '(未生成)').slice(0, 3000)
  ].filter(function (s) { return s && s.trim(); });

  const userPrompt = _Phase2_buildPartialPrompt(c, part);
  const model = useOpus ? CLAUDE_MODEL : CLAUDE_MODEL_HQ;
  const res = ClaudeClient_call({
    model: model,
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 3500
  });
  const folderId = Case_resolveProjectRoot(c) || CMD_FOLDER_ID;
  const fileName = 'construction_plan_' + part + '_' + caseId + '_' + new Date().getTime() + '.json';
  const file = DriveApp.getFolderById(folderId).createFile(fileName, res.text || '', MimeType.PLAIN_TEXT);
  return {
    part: part, caseId: caseId, jsonFileId: file.getId(), jsonFileUrl: file.getUrl(),
    chars: (res.text || '').length, usage: res.usage
  };
}

/**
 * 2 分割合成 + Slides 生成。 jsonSetupFileId, jsonTeardownFileId を渡す。
 */
function Phase2_ConstructionPlan_buildFromParts(caseId, jsonSetupFileId, jsonTeardownFileId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const setupJson = DriveApp.getFileById(jsonSetupFileId).getBlob().getDataAsString('UTF-8');
  const teardownJson = DriveApp.getFileById(jsonTeardownFileId).getBlob().getDataAsString('UTF-8');
  const setupParsed = _Phase1_parseJson(setupJson);
  const teardownParsed = _Phase1_parseJson(teardownJson);
  if (!setupParsed || !teardownParsed) throw new Error('JSON parse 失敗');

  const parsed = {
    title: setupParsed.title || '施工手順書【設営+撤去】',
    subtitle: setupParsed.subtitle || (c.caseName + ' / ' + c.clientName),
    cover_info: setupParsed.cover_info || {},
    prerequisites: setupParsed.prerequisites || [],
    team_placeholder: setupParsed.team_placeholder || { rows: [] },
    absolute_rules: setupParsed.absolute_rules || [],
    critical_risks: setupParsed.critical_risks || [],
    setup: setupParsed.setup || {},
    teardown: teardownParsed.teardown || {},
    unconfirmed_items: teardownParsed.unconfirmed_items || setupParsed.unconfirmed_items || [],
    footer_message: teardownParsed.footer_message || setupParsed.footer_message || {},
    confirmations: [].concat(setupParsed.confirmations || [], teardownParsed.confirmations || [])
  };
  Phase2_ConstructionPlan_ensureFixedContent(parsed);

  const folderId = Case_resolveProjectRoot(c) || null;
  const allDesignDocs = _Phase2_findDesignDocs(c);
  const confirmations = _Phase2_collectAllConfirmations(parsed);
  if (confirmations.length > 0) {
    try {
      ConfirmationSheet_appendMany(c.zissiId, confirmations.map(function (cf) {
        return {
          category: _CONSTRUCTION_PLAN_CONFIG.confirmCategoryPrefix + (cf.category ? ' ' + cf.category : ''),
          content: cf.content
        };
      }));
    } catch (e) {}
  }

  let slidesUrl = null, docUrl = null;
  try {
    slidesUrl = _Phase2_buildConstructionPlanSlides(c, parsed, allDesignDocs, folderId).url;
    MasterWriteBack_recordArtifact(caseId, _CONSTRUCTION_PLAN_CONFIG.displayName + '(スライド版)',
      parsed.title + ' (Slides)', slidesUrl);
  } catch (e) { console.warn('Slides fail: ' + e.toString()); }
  try {
    docUrl = _Phase2_buildConstructionPlanDoc(c, parsed, folderId).url;
    MasterWriteBack_recordArtifact(caseId, _CONSTRUCTION_PLAN_CONFIG.displayName, parsed.title, docUrl);
  } catch (e) { console.warn('Doc fail: ' + e.toString()); }
  return {
    caseId: caseId, slidesUrl: slidesUrl, docUrl: docUrl,
    setupPhaseCount: (parsed.setup.phase_details || []).length,
    teardownPhaseCount: (parsed.teardown.phase_details || []).length,
    confirmationCount: confirmations.length
  };
}

/**
 * 段階 A: Fable5 を呼び出し、 応答 JSON を Drive に保存する。 Slides 生成は別実行。
 * 6 分制限内に Fable5 呼び出しだけ確実に完了させるための分割。
 * @return {object} {caseId, jsonFileId, jsonFileUrl, usage}
 */
function Phase2_ConstructionPlan_callFable5(caseId, attachPdfs) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const manualPages = ManualLoader_findPages(_CONSTRUCTION_PLAN_CONFIG.manualQueries).slice(0, 5);
  const itemListAndCatalog = _Phase2_loadItemListAndCatalog(c);
  // 資料添付は既定で無効 (Apps Script 6 分制限対策)。明示指定時のみ予算内で添付
  const designPdfs = attachPdfs ? Case_collectCaseMaterials(c, { maxFiles: 2 }) : [];

  const caseDigest = CaseDigest_load(c);
  const cachedContext = [
    OwnedEquipment_describe(),
    caseDigest ? '【案件資料ダイジェスト(夜間に全資料を読んで作成)】\n' + caseDigest : '',
    '【関連マニュアル抜粋 (上位5件)】\n' + manualPages.map(function (p) { return '# ' + p.title + '\n' + p.body.slice(0, 2000); }).join('\n\n'),
    '【案件アイテムリスト / 保有機材カタログ】\n' + (itemListAndCatalog || '(未生成)').slice(0, 8000)
  ].filter(function (s) { return s && s.trim(); });

  const userPrompt = _Phase2_buildConstructionPlanPrompt(c);
  const res = ClaudeClient_call({
    model: CLAUDE_MODEL_HQ,
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: designPdfs,
    maxTokens: 12000
  });

  // Drive に JSON 応答テキストを保存 (folder は cmd folder に fallback)
  const folderId = Case_resolveProjectRoot(c) || CMD_FOLDER_ID;
  const fileName = 'construction_plan_json_' + caseId + '_' + new Date().getTime() + '.json';
  const folder = DriveApp.getFolderById(folderId);
  const file = folder.createFile(fileName, res.text || '', MimeType.PLAIN_TEXT);
  return {
    caseId: caseId,
    caseName: c.caseName,
    jsonFileId: file.getId(),
    jsonFileUrl: file.getUrl(),
    responseChars: (res.text || '').length,
    usage: res.usage
  };
}

/**
 * 段階 B: 保存済み Fable5 JSON から Slides + Doc を生成。
 */
function Phase2_ConstructionPlan_buildFromJson(caseId, jsonFileId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const jsonText = DriveApp.getFileById(jsonFileId).getBlob().getDataAsString('UTF-8');
  const parsed = _Phase1_parseJson(jsonText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON parse 失敗: ' + jsonText.slice(0, 500));
  }
  Phase2_ConstructionPlan_ensureFixedContent(parsed);
  const folderId = Case_resolveProjectRoot(c) || null;
  const allDesignDocs = _Phase2_findDesignDocs(c);

  // confirmations
  const confirmations = _Phase2_collectAllConfirmations(parsed);
  if (confirmations.length > 0) {
    try {
      ConfirmationSheet_appendMany(c.zissiId, confirmations.map(function (cf) {
        return {
          category: _CONSTRUCTION_PLAN_CONFIG.confirmCategoryPrefix + (cf.category ? ' ' + cf.category : ''),
          content: cf.content
        };
      }));
    } catch (e) { console.warn('confirmations append failed: ' + e.toString()); }
  }

  let slidesUrl = null, docUrl = null;
  try {
    slidesUrl = _Phase2_buildConstructionPlanSlides(c, parsed, allDesignDocs, folderId).url;
    MasterWriteBack_recordArtifact(caseId, _CONSTRUCTION_PLAN_CONFIG.displayName + '(スライド版)',
      (parsed.title || _CONSTRUCTION_PLAN_CONFIG.displayName) + ' (Slides)', slidesUrl);
  } catch (e) { console.warn('Slides fail: ' + e.toString()); }
  try {
    docUrl = _Phase2_buildConstructionPlanDoc(c, parsed, folderId).url;
    MasterWriteBack_recordArtifact(caseId, _CONSTRUCTION_PLAN_CONFIG.displayName,
      (parsed.title || _CONSTRUCTION_PLAN_CONFIG.displayName), docUrl);
  } catch (e) { console.warn('Doc fail: ' + e.toString()); }

  return {
    caseId: caseId,
    slidesUrl: slidesUrl,
    docUrl: docUrl,
    setupPhaseCount: (parsed.setup && parsed.setup.phase_details) ? parsed.setup.phase_details.length : 0,
    teardownPhaseCount: (parsed.teardown && parsed.teardown.phase_details) ? parsed.teardown.phase_details.length : 0,
    confirmationCount: confirmations.length
  };
}

/**
 * PDF レベルの施工手順書を生成 (Slides + Doc)。
 * 案件 project フォルダに保存し MasterWriteBack へ記録。
 */
function Phase2_ConstructionPlan_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  const manualPages = ManualLoader_findPages(_CONSTRUCTION_PLAN_CONFIG.manualQueries).slice(0, 10);
  const itemListAndCatalog = _Phase2_loadItemListAndCatalog(c);
  const allDesignDocs = _Phase2_findDesignDocs(c);
  const designPdfs = Case_collectCaseMaterials(c, { maxFiles: 3 });

  const caseDigest = CaseDigest_load(c);
  const cachedContext = [
    OwnedEquipment_describe(),
    caseDigest ? '【案件資料ダイジェスト(夜間に全資料を読んで作成)】\n' + caseDigest : '',
    '【関連マニュアル抜粋】\n' + manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; }).join('\n\n'),
    '【案件アイテムリスト / 保有機材カタログ (備品コード参照可)】\n' + (itemListAndCatalog || '(未生成)')
  ].filter(function (s) { return s && s.trim(); });

  const userPrompt = _Phase2_buildConstructionPlanPrompt(c);
  const res = ClaudeClient_call({
    model: CLAUDE_MODEL_HQ,
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: designPdfs,
    maxTokens: 16000
  });

  const parsed = _Phase1_parseJson(res.text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Fable5 応答が JSON parse 失敗: ' + (res.text || '').slice(0, 500));
  }
  Phase2_ConstructionPlan_ensureFixedContent(parsed);

  // 確認事項を確認シートへ書き戻し
  const confirmations = _Phase2_collectAllConfirmations(parsed);
  if (confirmations.length > 0) {
    try {
      ConfirmationSheet_appendMany(c.zissiId, confirmations.map(function (cf) {
        return {
          category: _CONSTRUCTION_PLAN_CONFIG.confirmCategoryPrefix + (cf.category ? ' ' + cf.category : ''),
          content: cf.content
        };
      }));
    } catch (e) { console.warn('confirmations append failed: ' + e.toString()); }
  }

  // 案件フォルダ ID
  const folderId = Case_resolveProjectRoot(c) || null;

  // Slides 生成
  let slidesUrl = null;
  try {
    const slidesResult = _Phase2_buildConstructionPlanSlides(c, parsed, allDesignDocs, folderId);
    slidesUrl = slidesResult.url;
    MasterWriteBack_recordArtifact(caseId, _CONSTRUCTION_PLAN_CONFIG.displayName + '(スライド版)',
      (parsed.title || _CONSTRUCTION_PLAN_CONFIG.displayName) + ' (Slides)', slidesUrl);
  } catch (e) {
    console.warn('Slides 生成失敗: ' + e.toString());
  }

  // Doc 生成 (バックアップ・検索用)
  let docUrl = null;
  try {
    const docResult = _Phase2_buildConstructionPlanDoc(c, parsed, folderId);
    docUrl = docResult.url;
    MasterWriteBack_recordArtifact(caseId, _CONSTRUCTION_PLAN_CONFIG.displayName,
      (parsed.title || _CONSTRUCTION_PLAN_CONFIG.displayName), docUrl);
  } catch (e) {
    console.warn('Doc 生成失敗: ' + e.toString());
  }

  return {
    caseId: caseId,
    caseName: c.caseName,
    title: parsed.title || _CONSTRUCTION_PLAN_CONFIG.displayName,
    slidesUrl: slidesUrl,
    docUrl: docUrl,
    setupPhaseCount: (parsed.setup && Array.isArray(parsed.setup.phase_details)) ? parsed.setup.phase_details.length : 0,
    teardownPhaseCount: (parsed.teardown && Array.isArray(parsed.teardown.phase_details)) ? parsed.teardown.phase_details.length : 0,
    confirmationCount: confirmations.length,
    usage: res.usage
  };
}

/**
 * Fable5 に投げる指示文。 PDF 26 スライド構造を厳密に指定。
 */
function _Phase2_buildConstructionPlanPrompt(c) {
  const schema = _Phase2_constructionPlanSchema();
  return [
    '以下の案件の「施工手順書 (設営+撤去)」を、 参考PDF「施工手順書_マークスライフ様_設営撤去.pdf」 と 同レベルの緻密さで作成してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '- 会場: ' + (c.venue || '未確定'),
    '',
    '## 文書の目的',
    '施工現場 (職人・手元作業員・オージャストAB・立会ディレクター) が本番当日にそのまま参照する 26 スライド構成の手順書。',
    '会場入りから撤去搬出まで、時間割・班分け・チェックリスト・完了報告テンプレまで含む「実務レベル」を要求します。',
    '',
    '## 詳細レベル要件 (絶対)',
    '- absolute_rules の No.1 は必ず「自己判断禁止 ─ 迷ったら即座に社員へ」(スタッフ間の議論・自己判断は禁止、必ず即座に社員に聞く)。',
    '- absolute_rules の No.2 は必ず「スチレンボード固定 ─ ベルクロ(面ファスナー)使用禁止・テグス必須」。手順(phase_details の steps)でスチレンボード設置に触れる時も「テグスで固定、ベルクロ禁止」と書く。',
    '- absolute_rules の No.3 は必ず「結束バンドはすべてリピートタイ ─ 撤収時に絶対に切らない」。設営手順では最初(P0)に「結束バンドはすべてリピートタイ。先っぽはできるだけ切らずに処理する」、撤去手順では最初(P0)に「結束バンドはすべてリピートタイ。絶対に切って外さない(ロックを解除して外す)」を必ず含める。',
    '- absolute_rules の No.4 は必ず「展示台パネルへの両面テープ ─ 必ず養生を下に貼ってから」。展示台パネルに両面テープで貼り付ける施工に触れる steps では、毎回「パネル面に養生を先に貼り、その上に両面テープ」と書く(直貼り禁止)。',
    '- チューブライト(LEDネオンチューブ)を使う案件では、phase_details の steps に「アクリルケースに挿入→非発光の平らな面を屋根では上向き・柱では2本を背中合わせ→点灯して客側から非発光面が見えないか確認」を必ず含める(標準手順スライドは自動で付くので重複記述は不要)。',
    '- 高所作業(トラス上部・LEDUP・天井布・2m 超の壁面等)で昇降機(リフター)を使う案件では、phase_details の steps に「昇降機」と明記し、「足を広げて設置→丸の昇降棒を先に上げる→固くなったらそれ以上上げない→四角の昇降棒に切替」の要点を含める(最大高さ 4m・耐荷重 85kg。標準手順スライドは自動で付くので詳細の重複記述は不要)。使わない案件では書かない。',
    '### 使用機材の判定',
    '- Re ブース制作案件では トラス(300角シルバー等) / LEDUP / Re ブースパネル / ロゴボックス / 白布 等の自社保有機材は 原則使用する 前提で手順を書く。',
    '- パース図・アイテムリストが未整備でも「使用しない」「確認できず」と書くのは禁止。 未確定は confirmations に列挙。',
    '',
    '### タイムテーブル',
    '- 設営: 8:00 集合 → 21:00 閉館 の間で、 P0 集合MTG / P1 搬入検品 / P2 床敷設 / P3 トラス+アンカー / P4 LEDUP・天井布・モニター / P5 壁装飾家具 / P6 電気点灯確認 / P7 立会チェック 記録 清掃 の 8 フェーズで組む。完了目標は 17:15 (バッファ 3.5h)。',
    '- 撤去: 16:30 スタッフ入り → 20:30 搬出完了。 P0 準備MTG / P1 モニター LEDUP 天井布 / P2 トラス解体装飾 / P3 アンカー切断 床剥がし / P4 梱包立会 / P5 積込 / P6 清掃報告 の 7 フェーズ。',
    '- 15 分刻み task_matrix は 6 人 (澤山・古川・職人A/B/C/D) × 9:00-11:30 / 12:00-仕上げ の 2 枚を必ず埋める。',
    '',
    '### 絶対に守るべき 8 項目 (共通)',
    '  1. 自己判断禁止 ─ 迷ったら即座に社員へ (スタッフ間の議論・自己判断は禁止、必ず即座に社員に聞く)',
    '  2. スチレンボード固定 ─ ベルクロ(面ファスナー)使用禁止・テグス必須 (会期中に落下してクレームになるため、設置は必ずテグス)',
    '  3. 結束バンドはすべてリピートタイ ─ 撤収時に絶対に切らない (撤収はロックを解除して外す。設営時も先っぽをできるだけ切らずに処理する)',
    '  3-2. 展示台パネルへの両面テープは必ず養生を下に貼ってから (パネル直貼り禁止。養生→両面テープの順)',
    '  4. アンカー穴深さ 50mm 以内 / 会場貸与ドリルのみ (違反 1本 20,000円)',
    '  5. 破損防止 (LEDUP・55型モニター・天井布は A班固定 兼務禁止・2名運搬・床直置き禁止)',
    '  6. 安全 (ヘルメット / アンカー切断は保護ゴーグル+難燃服+消火器)',
    '  7. 床養生 (弱粘両面テープのみ、 接着剤・ボンド・床着色は禁止)',
    '  8. 記録 (収納前の立会破損チェック+写真、 判断変更は必ず社長へ報告)',
    '',
    '### 先行リスクは必ず列挙 (critical_risks)',
    '- アンカー穴深さ抵触 / 分電盤位置変更申請 / アンカー支給会場受取のみ / 撤去アンカー切断必須 / 完了時刻誤認 / 高さ規定抵触 の 6 リスクを、事象+推奨アクション+担当 の表形式で。',
    '',
    '### 立会チェックリスト',
    '- 6 項目: 数量品目破損 / LEDUP固定 / 天井布テンション / モニターワイヤー / アンカー本数位置深さ / 完成全体、 それぞれ サイン欄。',
    '',
    '### 完了報告テンプレート',
    '- 設営完了時・撤去完了時それぞれ、 Discord/LINE 貼付可能なメッセージテンプレ (@野村社長 @PM 宛て、 案件名・完了時刻・アンカー本数・LEDUP点灯確認・残課題・写真 の 6 項目) を必ず生成。',
    '',
    '### 記述レベル',
    '- 「会場入り」など抽象記述は禁止。 具体的な機材コード / 寸法 / 本数 / 人数 / 時刻を書く。',
    '- Reブース標準機材の想定値: パネル W3000×H2980、 トラス 300角、 LEDUP W1000/1500/2000/10000、 55型モニター、 白布、 ロゴBOX。',
    '- アンカーは M10×60mm を必要本数 (通常 8-16本)、φ10.5mm SDS ビット、 グラインダ切断砥石。',
    '',
    '## 出力形式 (厳守・前後の説明文や ```json``` ブロック禁止)',
    schema,
    '',
    '注意:',
    '- 案件情報に無い値 (会場住所・車両台数・人員名・具体時刻等) は本文に書かず confirmations に列挙。',
    '- 参考 PDF はレイアウト参考であり、本案件の情報を PDF から流用しない (マークスライフ様の情報を Deckers 案件などに混入させない)。',
    '- 全ての表・リストは日本語で。',
    '- 参考 PDF は フォールバック時 (アイテムリスト未整備時) の Reブース標準構成の参照として使用する。'
  ].join('\n');
}

/** 部分プロンプト: setup part or teardown part を個別生成 */
function _Phase2_buildPartialPrompt(c, part) {
  const isSetup = part === 'setup';
  const schema = isSetup ? _Phase2_setupPartSchema() : _Phase2_teardownPartSchema();
  const partLabel = isSetup ? '共通ヘッダー + 第1部 設営手順' : '第2部 撤去手順 + 末尾';
  const partRule = isSetup
    ? '第1部 設営(8フェーズ P0-P7 08:00-17:15)を必ず含め、15分刻み task_matrix 2 枚 (9:00-11:30 / 12:00-仕上げ) は必ず 6 人 x 6 行分埋める。'
    : '第2部 撤去(7フェーズ P0-P6 16:30-20:30)を必ず含め、P3 アンカー切断は最重要(赤ハイライト)扱い。';
  return [
    '以下の案件の「施工手順書」の ' + partLabel + ' を、 参考PDF「施工手順書_マークスライフ様_設営撤去.pdf」 と同レベルの緻密さで作成してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '- 会場: ' + (c.venue || '未確定'),
    '',
    '## 詳細レベル要件',
    '- absolute_rules の No.1 は必ず「自己判断禁止 ─ 迷ったら即座に社員へ」(スタッフ間の議論・自己判断は禁止、必ず即座に社員に聞く)。',
    '- absolute_rules の No.2 は必ず「スチレンボード固定 ─ ベルクロ(面ファスナー)使用禁止・テグス必須」。手順(phase_details の steps)でスチレンボード設置に触れる時も「テグスで固定、ベルクロ禁止」と書く。',
    '- チューブライト(LEDネオンチューブ)を使う案件では、phase_details の steps に「アクリルケースに挿入→非発光の平らな面を屋根では上向き・柱では2本を背中合わせ→点灯して客側から非発光面が見えないか確認」を必ず含める(標準手順スライドは自動で付くので重複記述は不要)。',
    isSetup ? '- 高所作業(トラス上部・LEDUP・天井布・2m 超の壁面等)で昇降機(リフター)を使う案件では、phase_details の steps に「昇降機」と明記し、「足を広げて設置→丸の昇降棒を先に上げる→固くなったらそれ以上上げない→四角の昇降棒に切替」の要点を含める(最大高さ 4m・耐荷重 85kg。標準手順スライドは自動で付くので詳細の重複記述は不要)。使わない案件では書かない。' : '',
    isSetup ? '- 設営手順の最初(P0)に「結束バンドはすべてリピートタイ。先っぽ(余り)はできるだけ切らずに処理する」を必ず含める(標準手順スライドは自動で付くので詳細の重複記述は不要)。' : '- 撤去手順の最初(P0)に「結束バンドはすべてリピートタイ。絶対に切って外さない(ロックを解除して外す)」を必ず含める(標準手順スライドは自動で付くので詳細の重複記述は不要)。',
    isSetup ? '- 展示台パネルに両面テープで貼り付ける施工(パネル・グラフィック・シート類の貼付)がある案件では、steps に必ず「パネル面に養生を先に貼り、その上に両面テープを貼る(直貼り禁止)」と書く。' : '- 展示台パネルの貼付物を剥がす手順では「両面テープごと養生を剥がす(パネル面を傷めない)」と書く。',
    isSetup ? '' : '- 撤去手順の最初(P0)に「トラックから降ろすのは工具と脚立のみ。他は降ろさない」を必ず含める。「先に解体を済ませ、最後にトラックごと入れて積み込む」流れを明示する(標準手順スライドは自動で付くので詳細の重複記述は不要)。',
    isSetup ? '- 設営手順の最後(P0)に「撤収に必要な工具(脚立・工具等)を一つの車に載せる」を必ず含める(標準手順は自動で付くので詳細の重複記述は不要)。' : '',
    '- Re ブース制作案件では トラス / LEDUP / Re ブースパネル / ロゴボックス / 白布 等の自社保有機材は 原則使用する 前提。',
    '- 抽象記述禁止。 具体的な機材名・寸法・本数・人数・時刻を書く。',
    '- ' + partRule,
    '',
    '## 出力形式 (JSON のみ、前後の説明文・コードブロック禁止)',
    schema
  ].join('\n');
}

function _Phase2_setupPartSchema() {
  return [
    '{',
    '  "title": "施工手順書【設営+撤去】",',
    '  "subtitle": "<案件名 / クライアント名>",',
    '  "cover_info": {"venue":"<会場>","setup_date":"<日付>","teardown_date":"<日付>","note":"仮置き"},',
    '  "prerequisites": [{"key":"会期","value":"..."},{"key":"設営日","value":"..."},{"key":"撤去日","value":"..."},{"key":"通電","value":"..."},{"key":"残業料金","value":"1社1時間45,000円(税別)"},{"key":"特殊機材","value":"..."},{"key":"造作・什器","value":"..."},{"key":"電気","value":"..."}],',
    '  "team_placeholder": {"note":"確定体制が未定のため標準体制で仮置き","rows":[{"role":"施工リーダー(職人)","setup":"1名","teardown":"1名"},{"role":"職人","setup":"2名","teardown":"1名"},{"role":"手元作業員","setup":"3名","teardown":"3名"},{"role":"オージャストAB","setup":"3名","teardown":"3名"},{"role":"現場合計","setup":"9名","teardown":"8名"},{"role":"立会ディレクター","setup":"未定","teardown":"未定"}]},',
    '  "absolute_rules": [{"no":1,"title":"自己判断禁止 ─ 迷ったら即座に社員へ","body":"スタッフ間で議論したり自分で悩んで自己判断しない。ほとんどのケースでやり直しになる。必ず即座に社員に聞く。","highlight":true},{"no":2,"title":"スチレンボード固定 ─ ベルクロ(面ファスナー)使用禁止・テグス必須","body":"スチレンボードをベルクロ・面ファスナーで取り付けるのは禁止。毎回会期中に落ちてクレームになる。設置は必ずテグスで行う。","highlight":true},{"no":3,"title":"規定 ─ アンカー穴深さ","body":"穴は50mm以内。会場貸与ドリルのみ。違反1本20,000円","highlight":true},{"no":4,"title":"破損防止","body":"LEDUP・55型モニター・天井布はA班固定・兼務禁止・2名運搬"},{"no":5,"title":"安全","body":"高所ヘルメット。切断は保護ゴーグル・難燃服・消火器"},{"no":6,"title":"床養生","body":"弱粘両面テープのみ。接着剤・ボンド・床着色禁止"},{"no":7,"title":"記録","body":"収納前立会破損チェック+写真。判断変更は社長へ報告"}],',
    '  "critical_risks": [{"issue":"アンカー穴深さ超過","action":"50mm以内・会場貸与ドリルのみ。担当:施工リーダー","highlight":true},{"issue":"アンカー本数変更申請","action":"主催者へ事前申請。担当:PM"},{"issue":"アンカーは会場支給品のみ","action":"朝に受取確認。担当:リーダー"},{"issue":"撤去時アンカー切断必須","action":"サンダー持込・切断未処理2,000円/本。担当:リーダー"},{"issue":"14:00を完了と誤認","action":"14:00は通電開始。完了は17:15。担当:PM"},{"issue":"高さ規定抵触","action":"小間種別・1m内側収まり確認。担当:施工図"}],',
    '  "setup": {',
    '    "date_time": "<yyyy年m月d日(曜) 08:00集合 ─ 17:15完了>",',
    '    "team_assignment": {"note":"4班以内","groups":[{"name":"A班","members":"リーダー+手元2=3名","role":"LEDUP搭載/天井布/55型モニター吊り","concurrent":"禁止","highlight":true},{"name":"B班","members":"職人1+手元1+AB1=3名","role":"トラス建込/アンカー打設/重り","concurrent":"可"},{"name":"C班","members":"職人1+AB2=3名","role":"床/壁/装飾/家具配置","concurrent":"可"}],"leader_notes":["A班長:LEDUP/天井布は次案件に直結。1パーツ1声掛け","B班長:立会揃うまで打設禁止。穴50mm厳守"]},',
    '    "overall_schedule": {"range":"08:00-17:15 / 555分","phases":[',
    '      {"phase":"P0 集合・受取・MTG","time":"08:00-09:00","duration":"60分","owner":"全員","content":"集合・バッジ配布・アンカー受取・安全MTG"},',
    '      {"phase":"P1 搬入・検品","time":"09:00-10:00","duration":"60分","owner":"全員","content":"荷下ろし・アイテムチェック"},',
    '      {"phase":"P2 床敷設","time":"10:00-11:30","duration":"90分","owner":"C班+応援","content":"カーペット/床タイル敷設"},',
    '      {"phase":"昼休憩","time":"11:30-12:15","duration":"45分","owner":"-","content":"交代でも可"},',
    '      {"phase":"P3 トラス+アンカー","time":"12:15-14:00","duration":"105分","owner":"B班+応援","content":"トラス建込・アンカー打設・重り","highlight":true},',
    '      {"phase":"P4 LEDUP・天井布・モニター","time":"14:00-15:30","duration":"90分","owner":"A班","content":"LEDUP搭載・天井布・モニター吊り","highlight":true},',
    '      {"phase":"P5 壁・装飾・家具","time":"15:30-16:15","duration":"45分","owner":"C班","content":"パネル・アコーディオン・什器・植栽"},',
    '      {"phase":"P6 電気・点灯確認","time":"16:15-16:45","duration":"30分","owner":"B班+A班","content":"コンセント接続・点灯確認"},',
    '      {"phase":"P7 立会・記録・清掃","time":"16:45-17:15","duration":"30分","owner":"全員","content":"破損チェック・写真・清掃・完了報告"},',
    '      {"phase":"設営完了目標","time":"17:15","duration":"-","owner":"-","content":"以降〜21:00閉館は微調整バッファ"}',
    '    ]},',
    '    "task_matrix1": {"title":"役割分担① 9:00-11:30","sub_title":"各担当+AB各1名","columns":["時刻","澤山","古川","職人A","職人B","職人C","職人D"],"rows":[["9:00","床LEDUP①","床LEDUP②","カーペット","カーペット","カーペット","カーペット"],["9:30","床LEDUP③","床LEDUP④","トラス配置","トラス配置","LED布張り","LED布張り"],["10:00","床LEDUP⑤","床LEDUP⑥","アンカー","アンカー","LED布張り","LED布張り"],["10:30","床LEDUP⑦","床LEDUP⑧","トラス組立","トラス組立","トラス組立","トラス組立"],["11:00","LEDUP配置","LEDUP配置","トラス組立","トラス組立","トラス組立","トラス組立"],["11:30","LEDUP配置","指示","トロマット","トロマット","ローリングタワー","-"]],"notes":["9:30アンカー→10:00トラス縦→10:30トラス横(立会必須・50mm以内)","11:00 LEDUPは部品を床に配置(取り違え防止)"]},',
    '    "task_matrix2": {"title":"役割分担② 12:00-仕上げ","sub_title":"各担当+AB各1名","columns":["時刻","澤山","古川","職人A","職人B","職人C","職人D"],"rows":[["12:00","LEDUP床板","LEDUP床板","LEDUP床板","LEDUP床板","LEDUP縦板","LEDUP縦板"],["12:30","LEDUP縦板","LEDUP縦板","LEDUP縦板","LEDUP縦板","LEDUP天板","LEDUP天板"],["13:00","LEDUP天板","LEDUP天板","LEDUP天板","LEDUP天板","LEDUP天板","LEDUP天板"],["13:30","LEDUP裏布","LEDUP裏布","LEDUP裏布","LEDUP裏布","LEDUP裏布","LEDUP裏布"],["14:00","LEDUP表布","LEDUP表布","LEDUP表布","LEDUP表布","LEDUP表布","LEDUP表布"],["仕上げ","ロゴBOX","ラック","ロゴカーペット","ロゴカーペット","床見切り","床見切り"]],"notes":["13:30 LEDUP裏布は基点明確に","LEDUP布は裏→表の順・テンション揃える"]},',
    '    "phase_details": [8フェーズ P0-P7 それぞれ {"phase":"P0 集合・受取・MTG","time":"08:00-09:00(60分)","owner":"全員","steps":["...","..."],"highlight_indexes":[]} 形式で。 steps は各フェーズ 3-6 個の具体的アクション。 highlight_indexes は特に注意すべき step の index],',
    '    "safety_check": {"prevention_notes":["...","..."],"check_items":[{"no":1,"item":"...","sign":"—"},...6項目]},',
    '    "risks_checkpoints": {"risks":[{"risk":"...","action":"...","owner":"..."},...5-6件],"checkpoints":[{"time":"09:00","item":"..."},...6件],"priority_note":"遅延時の優先順位: ..."},',
    '    "emergency_report": {"emergencies":[{"issue":"...","action":"..."},...5件],"report_template":"@野村社長 @PM ..."}',
    '  }',
    '}'
  ].join('\n');
}

function _Phase2_teardownPartSchema() {
  return [
    '{',
    '  "teardown": {',
    '    "date_time": "<yyyy年m月d日(曜) 16:30 ─ 20:30(搬出完了)>",',
    '    "team_assignment": {"note":"トラス解体は必ず4名(脚立2・下2)","groups":[{"name":"A班","members":"リーダー+手元2","role":"モニター/LEDUP/天井布の取外し・梱包","highlight":true},{"name":"B班","members":"職人1+手元1+AB1","role":"トラス解体/アンカー切断(サンダー)"},{"name":"C班","members":"AB2(A/B終了後応援)","role":"床剥がし/装飾/梱包/積込"}],"leader_notes":[]},',
    '    "overall_schedule": {"range":"16:30-20:30 / 240分","phases":[',
    '      {"phase":"P0 準備・MTG","time":"16:30-17:00","duration":"30分","owner":"全員","content":"入場・工具搬入・撤去MTG"},',
    '      {"phase":"P1 モニター/LEDUP/天井布","time":"17:00-17:30","duration":"30分","owner":"A班","content":"取外し・即養生・梱包"},',
    '      {"phase":"P2 トラス解体・装飾","time":"17:30-18:15","duration":"45分","owner":"B班+応援","content":"排水・トラス解体4名"},',
    '      {"phase":"P3 アンカー切断・床剥がし","time":"18:15-19:00","duration":"45分","owner":"B班","content":"サンダー水平切断・立会撮影","highlight":true},',
    '      {"phase":"P4 梱包・立会","time":"19:00-19:45","duration":"45分","owner":"全員","content":"什器解体・ロゴBOX収納・立会確認"},',
    '      {"phase":"P5 積込","time":"19:45-20:15","duration":"30分","owner":"全員","content":"車両進入・積込順序"},',
    '      {"phase":"P6 清掃・報告","time":"20:15-20:30","duration":"15分","owner":"全員","content":"ゴミ処理・忘れ物確認・完了報告"}',
    '    ]},',
    '    "phase_details": [7フェーズ P0-P6 それぞれ {"phase":"...","time":"...","owner":"...","steps":["...","..."],"highlight_indexes":[]} 形式。 P3 アンカー切断は 【最重要】 タグ付けて steps に 消火器・保護具・水平切断・立会撮影を含める],',
    '    "safety_check": {"prevention_notes":["高額パーツはA班固定","天井布は芯棒に巻く","モニターは画面上向きで梱包","ボルトは本体へ仮留め","立会4項目確認"]},',
    '    "risks_checkpoints": {"risks":[{"risk":"アンカー切断忘れ","action":"立会全数撮影","owner":"B班長"},{"risk":"火花・床損傷","action":"可燃物排除・消火器","owner":"リーダー"},{"risk":"撤去破損","action":"A班固定・2名運搬・即養生","owner":"A班長"},{"risk":"20:30に間に合わない","action":"P1-P3並行","owner":"PM"}],"checkpoints":[{"time":"17:30","item":"モニター/LEDUP/天井布 取外し"},{"time":"18:15","item":"トラス解体・装飾撤去"},{"time":"19:00","item":"アンカーN本切断・床剥がし"},{"time":"19:45","item":"梱包・立会チェック"},{"time":"20:15","item":"積込"},{"time":"20:30","item":"清掃・完了報告"}]},',
    '    "emergency_report": {"emergencies":[{"issue":"サンダー不調","action":"予備交換→切断のみ残し延長申請"},{"issue":"4名確保不可","action":"A班撤去後合流・積込先行"},{"issue":"梱包資材不足","action":"再利用優先・当日調達"}],"report_template":"@野村社長 @PM お疲れ様です。撤去が完了いたしました。..."}',
    '  },',
    '  "unconfirmed_items": ["体制の確定人数","立会者氏名","最終パース","搬入方式","持ち回り次案件の有無","アンカー本数確定"],',
    '  "footer_message": {"main":"施工は時間管理と破損防止が最優先。","sub":"判断変更は必ず社長(野村)・PMへ即共有。","footer":"株式会社Re:ブース 制作部 / <案件名>"},',
    '  "confirmations": [{"category":"<カテゴリ>","content":"<未確定項目>"}]',
    '}'
  ].join('\n');
}

function _Phase2_constructionPlanSchema() {
  return [
    '{',
    '  "title": "施工手順書【設営+撤去】",',
    '  "subtitle": "<展示会名> / <クライアント名> 様 ブース制作",',
    '  "cover_info": {',
    '    "venue": "<会場名 展示ホール 小間番号 寸法>",',
    '    "setup_date": "<yyyy年m月d日(曜)>",',
    '    "teardown_date": "<yyyy年m月d日(曜)>",',
    '    "note": "<体制の確定状況注記 (例: 仮置き・確定後差替)>"',
    '  },',
    '  "prerequisites": [',
    '    {"key": "会期", "value": "..."},',
    '    {"key": "設営日", "value": "..."},',
    '    {"key": "撤去日", "value": "..."},',
    '    {"key": "通電", "value": "..."},',
    '    {"key": "残業料金", "value": "1社1時間 45,000円(税別)・1時間未満も繰上"},',
    '    {"key": "特殊機材", "value": "300角シルバートラス/LEDUP/55型モニター/天井布/..."},',
    '    {"key": "造作・什器", "value": "..."},',
    '    {"key": "電気", "value": "コンセントN口を右側バックヤードのトラス足元に集約"}',
    '  ],',
    '  "team_placeholder": {',
    '    "note": "確定体制が未定のため標準体制で仮置き。各班の人数欄を差し替えれば確定版になります。",',
    '    "rows": [',
    '      {"role": "施工リーダー(職人)", "setup": "1名", "teardown": "1名"},',
    '      {"role": "職人", "setup": "2名", "teardown": "1名"},',
    '      {"role": "手元作業員", "setup": "3名", "teardown": "3名"},',
    '      {"role": "オージャストAB", "setup": "3名", "teardown": "3名"},',
    '      {"role": "現場合計", "setup": "9名", "teardown": "8名"},',
    '      {"role": "立会ディレクター", "setup": "未定", "teardown": "未定"}',
    '    ]',
    '  },',
    '  "absolute_rules": [',
    '    {"no": 1, "title": "自己判断禁止 ─ 迷ったら即座に社員へ", "body": "スタッフ間で議論したり自分で悩んで自己判断しない。ほとんどのケースでやり直しになる。必ず即座に社員に聞く。", "highlight": true},',
    '    {"no": 2, "title": "スチレンボード固定 ─ ベルクロ(面ファスナー)使用禁止・テグス必須", "body": "スチレンボードをベルクロ・面ファスナーで取り付けるのは禁止。毎回会期中に落ちてクレームになる。設置は必ずテグスで行う。", "highlight": true},',
    '    {"no": 3, "title": "規定 ─ アンカー穴深さ", "body": "穴は深さ50mm以内。会場貸与ドリルのみ使用(持込ドリル禁止)。違反は1本20,000円(税別)。", "highlight": true},',
    '    {"no": 4, "title": "破損防止 ─ 高額パーツ", "body": "LEDUP・55型モニター・天井布はA班固定/他作業兼務禁止。運搬は2名以上・床直置き禁止。"},',
    '    {"no": 5, "title": "安全 ─ 高所・切断", "body": "トラス・高所はヘルメット。アンカー切断は保護ゴーグル・長袖難燃服・消火器を手元に。"},',
    '    {"no": 6, "title": "床養生", "body": "床はコンクリート。カーペットは弱粘両面テープのみ(接着剤・ボンド・床着色は禁止)。"},',
    '    {"no": 7, "title": "記録", "body": "重要パーツは収納前に立会破損チェック+写真。判断変更は必ず社長へ報告。"}',
    '  ],',
    '  "critical_risks": [',
    '    {"issue": "アンカー穴深さ超過", "action": "50mm以内で徹底・会場貸与ドリルのみ。担当:施工リーダー", "highlight": true},',
    '    {"issue": "アンカー本数/分電盤位置変更申請", "action": "主催者へ事前申請・当日は承認内容で施工。担当:PM"},',
    '    {"issue": "アンカーは会場支給品のみ", "action": "受取本数・種類を朝に確認。担当:施工リーダー"},',
    '    {"issue": "撤去時アンカー切断必須", "action": "サンダー・替刃・保護具を持込。切断未処理2,000円/本。担当:施工リーダー"},',
    '    {"issue": "14:00を完了と誤認", "action": "14:00は通電開始時刻。完了目標は17:15。担当:PM"},',
    '    {"issue": "高さ規定抵触", "action": "小間種別と1m内側収まり確認。超過恐れは主催者へ協議。担当:施工図"}',
    '  ],',
    '  "setup": {',
    '    "date_time": "<yyyy年m月d日(曜) 08:00集合 ― 17:15完了(目標)>",',
    '    "team_assignment": {',
    '      "note": "4班以内",',
    '      "groups": [',
    '        {"name": "A班", "members": "リーダー(職人)+手元2=3名", "role": "LEDUP搭載/天井布/55型モニター吊り(高額・繊細)", "concurrent": "禁止", "highlight": true},',
    '        {"name": "B班", "members": "職人1+手元1+AB1=3名", "role": "トラス建込/アンカー打設(立会必須)/重り設置", "concurrent": "可"},',
    '        {"name": "C班", "members": "職人1+AB2=3名", "role": "床カーペット/壁DIYパネル/アコーディオン/装飾家具配置", "concurrent": "可"}',
    '      ],',
    '      "leader_notes": ["A班長:LEDUP/天井布の破損は持ち回り次案件に直結。手順厳守・1パーツ1声掛け。", "B班長:アンカーは立会者・会場スタッフ立会が揃うまで打設禁止。穴深さ50mm厳守。"]',
    '    },',
    '    "overall_schedule": {',
    '      "range": "08:00-17:15 / 555分",',
    '      "phases": [',
    '        {"phase": "P0 集合・受取・MTG", "time": "08:00-09:00", "duration": "60分", "owner": "全員", "content": "集合・バッジ配布・アンカー受取・安全MTG(9時前完了)"},',
    '        {"phase": "P1 搬入・検品", "time": "09:00-10:00", "duration": "60分", "owner": "全員", "content": "荷下ろし・アイテムチェック"},',
    '        {"phase": "P2 床敷設", "time": "10:00-11:30", "duration": "90分", "owner": "C班+応援", "content": "カーペット/床タイル敷設"},',
    '        {"phase": "昼休憩", "time": "11:30-12:15", "duration": "45分", "owner": "-", "content": "交代でも可"},',
    '        {"phase": "P3 トラス+アンカー", "time": "12:15-14:00", "duration": "105分", "owner": "B班+応援", "content": "トラス建込・アンカー打設(立会必須)・重り", "highlight": true},',
    '        {"phase": "P4 LEDUP・天井布・モニター", "time": "14:00-15:30", "duration": "90分", "owner": "A班", "content": "LEDUP搭載・トロマット・モニター吊り(通電14:00〜)", "highlight": true},',
    '        {"phase": "P5 壁・装飾・家具", "time": "15:30-16:15", "duration": "45分", "owner": "C班", "content": "DIYパネル・アコーディオン・什器・植栽配置"},',
    '        {"phase": "P6 電気・点灯確認", "time": "16:15-16:45", "duration": "30分", "owner": "B班+A班", "content": "コンセント接続・LEDUP/モニター点灯確認"},',
    '        {"phase": "P7 立会チェック・記録・清掃", "time": "16:45-17:15", "duration": "30分", "owner": "全員", "content": "破損チェック・写真・清掃・完了報告"},',
    '        {"phase": "設営完了目標", "time": "17:15", "duration": "-", "owner": "-", "content": "以降〜21:00閉館は微調整バッファ(約3.5時間)"}',
    '      ]',
    '    },',
    '    "task_matrix1": {',
    '      "title": "役割分担(当日タスク)① 9:00-11:30",',
    '      "sub_title": "各担当+アルバイト各1名/時刻はチーム当日タスク表に準拠(集合・MTGは別途08:00〜09:00)",',
    '      "columns": ["時刻", "澤山", "古川", "職人A", "職人B", "職人C", "職人D"],',
    '      "rows": [',
    '        ["9:00", "床LEDUP①", "床LEDUP②", "カーペット", "カーペット", "カーペット", "カーペット"],',
    '        ["9:30", "床LEDUP③", "床LEDUP④", "トラス配置", "トラス配置", "LED布張り", "LED布張り"],',
    '        ["10:00", "床LEDUP⑤", "床LEDUP⑥", "アンカー", "アンカー", "LED布張り", "LED布張り"],',
    '        ["10:30", "床LEDUP⑦", "床LEDUP⑧", "トラス組立", "トラス組立", "トラス組立", "トラス組立"],',
    '        ["11:00", "LEDUP配置", "LEDUP配置", "トラス組立", "トラス組立", "トラス組立", "トラス組立"],',
    '        ["11:30", "LEDUP配置", "指示", "トロマット", "トロマット", "ローリングタワー組立", "-"]',
    '      ],',
    '      "notes": ["9:30 アンカー打設 → 10:00 トラス縦 → 10:30 トラス横 (立会必須・穴深さ50mm以内・会場貸与ドリル)", "11:00 LEDUPは部品を間違えないよう床に配置(部品取り違え=戻り工数)"]',
    '    },',
    '    "task_matrix2": {',
    '      "title": "役割分担(当日タスク)② 12:00-仕上げ",',
    '      "sub_title": "各担当+アルバイト各1名",',
    '      "columns": ["時刻", "澤山", "古川", "職人A", "職人B", "職人C", "職人D"],',
    '      "rows": [',
    '        ["12:00", "LEDUP床板", "LEDUP床板", "LEDUP床板", "LEDUP床板", "LEDUP縦板", "LEDUP縦板"],',
    '        ["12:30", "LEDUP縦板", "LEDUP縦板", "LEDUP縦板", "LEDUP縦板", "LEDUP天板", "LEDUP天板"],',
    '        ["13:00", "LEDUP天板", "LEDUP天板", "LEDUP天板", "LEDUP天板", "LEDUP天板", "LEDUP天板"],',
    '        ["13:30", "LEDUP裏布", "LEDUP裏布", "LEDUP裏布", "LEDUP裏布", "LEDUP裏布", "LEDUP裏布"],',
    '        ["14:00", "LEDUP表布", "LEDUP表布", "LEDUP表布", "LEDUP表布", "LEDUP表布", "LEDUP表布"],',
    '        ["仕上げ", "ロゴBOX", "ラック", "ロゴカーペット", "ロゴカーペット", "床見切り仕上げ", "床見切り仕上げ"]',
    '      ],',
    '      "notes": ["13:30 LEDUP裏布は基点を明確に(曖昧だと張り直し)", "LEDUP布は裏→表の順。皺・波打ちが出ないようテンションを揃える"]',
    '    },',
    '    "phase_details": [',
    '      {"phase": "P0 集合・受取・MTG", "time": "08:00-09:00(60分)", "owner": "全員(9時前にMTG完了)", "steps": ["8:00集合。出展者バッジはトラックから配布(倉庫着分・運営受取不要)", "主催者受付で支給アンカー・貸与ドリル受取", "安全MTG:手順・順序・役割分担(9時前完了)", "iPadタイムラプスを全体が映る位置に設置", "車両のホール進入は9:00〜(2小間以上枠)→荷下ろしはP1"], "highlight_indexes": [1]},',
    '      {"phase": "P1 搬入・検品", "time": "09:00-10:00(60分)", "owner": "全員", "steps": ["台車で運搬。ロゴBOXは中身を出してから運ぶ(2人運搬)", "オリコンを番号が見える向きで整列・撮影", "アイテムチェック(箱→アイテム、コード/名称/個数)", "不足は当日チャネルへ即共有", "トラス・LEDUPの数量・寸法を図面照合"]},',
    '      {"phase": "P2 床カーペット/タイル", "time": "10:00-11:30(90分)", "owner": "C班+応援", "steps": ["床タイル/カーペットを敷設(小間より飛び出さない)", "赤パンチの熱転写ロゴ位置・向きをパース照合", "弱粘両面テープで固定(接着剤・床着色禁止)"], "highlight_indexes": [2]},',
    '      {"phase": "P3 トラス建込+アンカー", "time": "12:15-14:00(105分)", "owner": "B班+応援", "steps": ["スペース確保・ヘルメット着用、床で部品/寸法を最終確認", "足部トラスを2個×2箇所(計4個)で接続し図面通り組む", "立会者+会場スタッフ立会で打設位置マーキング", "貸与ドリルで穴あけ50mm以内→支給アンカーN本打設", "建て起こし→本締め、ウェイトバッグ(水4L)を脚へ"], "highlight_indexes": [2, 3]},',
    '      {"phase": "P4 LEDUP・天井布・モニター", "time": "14:00-15:30(90分)", "owner": "A班(兼務禁止)", "steps": ["LEDUPを別マニュアル手順で組立・トラス上部へ搭載", "上下2枚板サンドイッチ+M10×330で固定(Uボルト不可)", "天井布を皿ボルト方式で連続平板に固定(波打ち防止)", "55型モニター×N装着・落下防止ワイヤー(2人で持つ)", "電源・HDMI接続(点灯確認はP6)"], "highlight_indexes": [1, 3]},',
    '      {"phase": "P5 壁・装飾・家具", "time": "15:30-16:15(45分)", "owner": "C班", "steps": ["背面壁・DIYパネル設置、サイン面の通り確認", "アコーディオン:有孔アングル+両面テープ+インシュロック", "LEDUPフレームへの直ボルト固定は不可", "商談/カフェセット・椅子・植栽をパース位置へ", "ロゴBOX(受付)・カタログスタンドを配置"], "highlight_indexes": [1]},',
    '      {"phase": "P6 電気・点灯確認", "time": "16:15-16:45(30分)", "owner": "B班+A班", "steps": ["コンセントN口を右側バックヤードのトラス足元へ接続", "LEDUP全基・モニター点灯確認、表示/色味チェック", "延長コード養生・足元配線モール(通路へ突出禁止)"]},',
    '      {"phase": "P7 立会チェック・記録・清掃", "time": "16:45-17:15(30分)", "owner": "全員", "steps": ["立会者へ声掛け、チェックリストで全数確認", "完成ブースを複数角度から撮影", "ゴミ回収・養生残り・忘れ物チェック", "社長・PMへ完了報告(写真添付)"]}',
    '    ],',
    '    "safety_check": {',
    '      "prevention_notes": [',
    '        "LEDUP・天井布・モニターはA班固定・他作業兼務禁止",',
    '        "LEDUPはφ32トラスに上下2枚板サンドイッチ(Uボルト不可)/M10×330",',
    '        "天井布は連続全長アルミ平板(6mm厚・金具62個)に皿ボルト方式",',
    '        "全パーツ床直置き禁止(毛布・養生)/運搬は最低2名",',
    '        "梱包資材・紙素材も再利用。傷をつけず復元可能な形で扱う"',
    '      ],',
    '      "check_items": [',
    '        {"no": 1, "item": "搬入物の数量・品目・破損・不足(リスト照合)", "sign": "—"},',
    '        {"no": 2, "item": "LEDUP搭載後の固定・表示", "sign": "—"},',
    '        {"no": 3, "item": "天井布のテンション・通り(波打ちなし)", "sign": "—"},',
    '        {"no": 4, "item": "モニター固定・落下防止ワイヤー・カシメ", "sign": "—"},',
    '        {"no": 5, "item": "アンカー本数・位置・穴深さ50mm以内", "sign": "サイン"},',
    '        {"no": 6, "item": "完成全体(高さ・通り・通路突出なし)", "sign": "サイン"}',
    '      ]',
    '    },',
    '    "risks_checkpoints": {',
    '      "risks": [',
    '        {"risk": "アンカー穴深さ超過", "action": "貸与ドリルに50mm印・立会で都度確認", "owner": "B班長"},',
    '        {"risk": "支給アンカー不足", "action": "朝イチ受取本数確認・不足は主催者へ即連絡", "owner": "リーダー"},',
    '        {"risk": "LEDUP/モニター破損", "action": "A班固定・2名運搬・床養生・収納前立会撮影", "owner": "A班長"},',
    '        {"risk": "14:00を完了と誤認", "action": "14:00は通電開始時刻。完了は17:15で共有", "owner": "PM"},',
    '        {"risk": "高さ規定抵触", "action": "小間種別/1m内側を確認・超過時主催者協議", "owner": "施工図"}',
    '      ],',
    '      "checkpoints": [',
    '        {"time": "09:00", "item": "MTG完了・荷下ろし開始"},',
    '        {"time": "11:30", "item": "床敷設完了"},',
    '        {"time": "14:00", "item": "アンカー本数・トラス本締め"},',
    '        {"time": "15:30", "item": "LEDUP・天井布・モニター完了"},',
    '        {"time": "16:45", "item": "全点灯確認・配線養生完了"},',
    '        {"time": "17:15", "item": "立会・写真・清掃・完了報告"}',
    '      ],',
    '      "priority_note": "遅延時の優先順位: ①アンカー/トラス(安全・骨格)→②LEDUP/天井布→③点灯→④装飾(初日朝8:30-10:00で調整可)"',
    '    },',
    '    "emergency_report": {',
    '      "emergencies": [',
    '        {"issue": "職人遅刻(〜10:00)", "action": "床→検品を先行。トラスは到着後着手、昼休憩で吸収"},',
    '        {"issue": "職人欠勤", "action": "A班(LEDUP)最優先確保。応援集約・残業は社長承認で検討"},',
    '        {"issue": "支給アンカー不足/相違", "action": "打設保留し主催者へ即連絡。重り併用で仮安定"},',
    '        {"issue": "LEDUP/モニター不点灯", "action": "通電・HDMI・電源を切分け。代替は機材会社へ確認"},',
    '        {"issue": "搬入トラック遅延", "action": "当日チャネルで到着監視。床・壁を先行、検品順を入替"}',
    '      ],',
    '      "report_template": "@野村社長 @PM お疲れ様です。設営が完了いたしました。\\n・案件:<案件名>\\n・完了時刻:〇〇:〇〇\\n・アンカー:N本打設(深さ50mm以内・立会確認済)\\n・LEDUP/モニター:全基点灯確認済\\n・残課題:(なし/〇〇)\\n・写真:添付の通り\\nよろしくお願いいたします。"',
    '    }',
    '  },',
    '  "teardown": {',
    '    "date_time": "<yyyy年m月d日(曜) 16:30 - 20:30(搬出完了)>",',
    '    "team_assignment": {',
    '      "note": "トラス解体は必ず4名(脚立2・下2)",',
    '      "groups": [',
    '        {"name": "A班", "members": "リーダー+手元2", "role": "モニター/LEDUP/天井布の取外し・梱包(破損防止最優先)", "highlight": true},',
    '        {"name": "B班", "members": "職人1+手元1+AB1", "role": "トラス解体/アンカー切断(サンダー)"},',
    '        {"name": "C班", "members": "AB2(A/B終了後応援)", "role": "床剥がし/壁・装飾/梱包/搬出・積込"}',
    '      ],',
    '      "leader_notes": []',
    '    },',
    '    "overall_schedule": {',
    '      "range": "16:30-20:30 / 240分",',
    '      "phases": [',
    '        {"phase": "P0 準備・MTG", "time": "16:30-17:00", "duration": "30分", "owner": "全員", "content": "入場・工具搬入・撤去MTG"},',
    '        {"phase": "P1 モニター/LEDUP/天井布", "time": "17:00-17:30", "duration": "30分", "owner": "A班", "content": "電源OFF後 取外し・即養生・梱包"},',
    '        {"phase": "P2 トラス解体・装飾", "time": "17:30-18:15", "duration": "45分", "owner": "B班+応援", "content": "ウェイトバッグ排水・トラス解体4名"},',
    '        {"phase": "P3 アンカー切断・床剥がし", "time": "18:15-19:00", "duration": "45分", "owner": "B班", "content": "サンダー水平切断・立会撮影", "highlight": true},',
    '        {"phase": "P4 梱包・立会チェック", "time": "19:00-19:45", "duration": "45分", "owner": "全員", "content": "什器解体・ロゴBOX収納・立会確認"},',
    '        {"phase": "P5 積込", "time": "19:45-20:15", "duration": "30分", "owner": "全員", "content": "車両場内進入・積込順序遵守"},',
    '        {"phase": "P6 清掃・報告", "time": "20:15-20:30", "duration": "15分", "owner": "全員", "content": "ゴミ処理・忘れ物確認・完了報告"}',
    '      ]',
    '    },',
    '    "phase_details": [',
    '      {"phase": "P0 準備・MTG", "time": "16:30-17:00(30分)", "owner": "全員", "steps": ["入場・サンダー/工具搬入(展示中は搬出不可)", "撤去MTG:順序・防火・立会撮影タイミング", "床/通路養生、梱包資材を準備(再利用)"], "highlight_indexes": [0]},',
    '      {"phase": "P1 モニター/LEDUP/天井布", "time": "17:00-17:30(30分)", "owner": "A班", "steps": ["電源OFF(17:00)確認→電源/HDMI抜く", "モニターを吊具から外す(2人で持つ)", "ワイヤー/ボルトを本体へ仮留め", "天井布は芯棒に巻く(折らない)", "LEDUP降ろし→即養生・梱包"], "highlight_indexes": [1, 4]},',
    '      {"phase": "P2 トラス解体・装飾", "time": "17:30-18:15(45分)", "owner": "B班+応援", "steps": ["ウェイトバッグ外し・排水", "トラス解体:必ず4名(脚立2・下2)", "クランプ部品は不足確認し仮留め", "壁・DIY・アコーディオン撤去"], "highlight_indexes": [1]},',
    '      {"phase": "P3 アンカー切断・床剥がし【最重要】", "time": "18:15-19:00(45分)", "owner": "B班", "steps": ["周囲の可燃物を排除し消火器を手元に配置", "保護ゴーグル・長袖難燃服を着用", "アンカー頭部を床面と水平にサンダー切断(N本/1本3分目安)", "打込み・ガス溶断・引き抜きは禁止", "立会者がN本全数を確認・撮影(切断未処理2,000円/本)", "カーペット/床タイルを剥がし展示台・段ボールへ収納"], "highlight_indexes": [0, 1, 3]},',
    '      {"phase": "P4 梱包・立会チェック", "time": "19:00-19:45(45分)", "owner": "全員", "steps": ["什器・ハイテーブル解体しネジを本体へ仮留め", "ロゴBOXに備品を隙間なく詰め接触面を養生(上下逆)", "ポスター/グラフィックは折らず矢印方向で立てる", "立会者が全梱包の破損チェック・蓋閉め前撮影", "モニターは画面を上に向けて梱包"], "highlight_indexes": [4]},',
    '      {"phase": "P5 積込", "time": "19:45-20:15(30分)", "owner": "全員", "steps": ["車両を場内へ進入(17:00以降可)、小間付けに整列", "下段に展示台・上段にロゴBOX、接触面は必ず養生", "モニターは画面上向き/2人運搬", "ウェイトバッグ等を使い切り、隙間なく積込"], "highlight_indexes": [2]},',
    '      {"phase": "P6 清掃・報告", "time": "20:15-20:30(15分)", "owner": "全員", "steps": ["ゴミを集積場へ運搬、汚れを拭取り", "小間内の忘れ物・私物・共通工具を最終確認", "社長・PMへ撤去完了報告(写真添付)"]}',
    '    ],',
    '    "safety_check": {',
    '      "prevention_notes": [',
    '        "高額パーツはA班固定。最優先で先に外し即養生・梱包",',
    '        "天井布は芯棒に巻く/LEDUPは降ろした順に養生",',
    '        "モニターは画面上向きで梱包(故障防止)",',
    '        "ボルト/ネジは外した直後に本体へ仮留め+立会撮影",',
    '        "立会:①取外し破損なし ②アンカーN本切断 ③梱包前破損/数量 ④床損傷・テープ跡・忘れ物なし"',
    '      ]',
    '    },',
    '    "risks_checkpoints": {',
    '      "risks": [',
    '        {"risk": "アンカー切断忘れ", "action": "立会がN本全数を撮影確認", "owner": "B班長"},',
    '        {"risk": "火花・床損傷", "action": "可燃物排除・消火器・難燃服・水平切断", "owner": "リーダー"},',
    '        {"risk": "撤去破損", "action": "A班固定・2名運搬・即養生", "owner": "A班長"},',
    '        {"risk": "20:30に間に合わない", "action": "P1〜P3並行・積込17:00車両で前倒し", "owner": "PM"}',
    '      ],',
    '      "checkpoints": [',
    '        {"time": "17:30", "item": "モニター/LEDUP/天井布 取外し"},',
    '        {"time": "18:15", "item": "トラス解体・装飾撤去"},',
    '        {"time": "19:00", "item": "アンカーN本切断・床剥がし"},',
    '        {"time": "19:45", "item": "梱包・立会チェック"},',
    '        {"time": "20:15", "item": "積込"},',
    '        {"time": "20:30", "item": "清掃・忘れ物・完了報告"}',
    '      ]',
    '    },',
    '    "emergency_report": {',
    '      "emergencies": [',
    '        {"issue": "サンダー不調/替刃切れ", "action": "予備交換→不可なら切断のみ残し延長申請を社長承認で"},',
    '        {"issue": "4名確保不可", "action": "A班のLEDUP撤去後に合流・解体後ろ倒し、積込先行"},',
    '        {"issue": "梱包資材不足", "action": "再利用優先・当日チャネルで調達判断"}',
    '      ],',
    '      "report_template": "@野村社長 @PM お疲れ様です。撤去が完了いたしました。\\n・<小間番号>/完了〇〇:〇〇/アンカーN本全数切断・床面水平・立会確認済(写真添付)\\n・LEDUP/モニター/天井布:破損なく梱包・返送準備完了/床面:損傷・テープ跡なし\\n・返送:個数〇/方式〇/到着指定〇/〇 よろしくお願いいたします。"',
    '    }',
    '  },',
    '  "unconfirmed_items": [',
    '    "体制(職人・手元・AB の確定人数)→ 各班の人数欄",',
    '    "立会者氏名・アンカー打設時の会場スタッフ立会手配状況",',
    '    "最終パース(revised版で確定か)/解放面数・小間種別(高さ規定の判定)",',
    '    "搬入方式(自社トラック/JITBOX)・車両到着時刻・施工会社集合時刻",',
    '    "持ち回り次案件の有無と日程(梱包・返送優先度に反映)",',
    '    "アンカーは深さ50mm以内で施工徹底(会場貸与ドリルのみ)※本数N本・配管/分電盤位置は主催者申請完了・了承済み"',
    '  ],',
    '  "footer_message": {',
    '    "main": "施工は時間管理と破損防止が最優先。",',
    '    "sub": "判断変更は必ず社長(野村)・PMへ即共有。",',
    '    "footer": "株式会社Re:ブース 制作部 / <案件名> / <小間番号>"',
    '  },',
    '  "confirmations": [',
    '    {"category": "<カテゴリ>", "content": "<未確定項目>"}',
    '  ]',
    '}'
  ].join('\n');
}

/** parsed オブジェクトから setup/teardown/root の confirmations を全部集める */
function _Phase2_collectAllConfirmations(parsed) {
  const out = [];
  const push = function (arr) {
    if (Array.isArray(arr)) arr.forEach(function (cf) {
      if (cf && cf.content) out.push({ category: cf.category || '', content: cf.content });
    });
  };
  push(parsed.confirmations);
  if (parsed.setup) push(parsed.setup.confirmations);
  if (parsed.teardown) push(parsed.teardown.confirmations);
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Phase2_ConstructionPlan_ensureFixedRules: Phase2_ConstructionPlan_ensureFixedRules,
    Phase2_ConstructionPlan_ensureFixedProcedures: Phase2_ConstructionPlan_ensureFixedProcedures,
    Phase2_ConstructionPlan_ensureFixedContent: Phase2_ConstructionPlan_ensureFixedContent,
    _CP_FIXED_RULE_ASK_STAFF: _CP_FIXED_RULE_ASK_STAFF,
    _CP_FIXED_RULE_STYRENE_TEGUSU: _CP_FIXED_RULE_STYRENE_TEGUSU,
    _CP_FIXED_RULE_REPEAT_TIE: _CP_FIXED_RULE_REPEAT_TIE,
    _CP_FIXED_RULE_PANEL_TAPE_YOJO: _CP_FIXED_RULE_PANEL_TAPE_YOJO,
    _CP_FIXED_RULES: _CP_FIXED_RULES,
    _CP_FIXED_PROCEDURE_TUBE_LIGHT: _CP_FIXED_PROCEDURE_TUBE_LIGHT,
    _CP_FIXED_PROCEDURE_LIFT: _CP_FIXED_PROCEDURE_LIFT,
    _CP_FIXED_PROCEDURE_TEARDOWN_TRUCK: _CP_FIXED_PROCEDURE_TEARDOWN_TRUCK,
    _CP_FIXED_PROCEDURE_SETUP_TOOL_VEHICLE: _CP_FIXED_PROCEDURE_SETUP_TOOL_VEHICLE,
    _CP_FIXED_PROCEDURE_REPEAT_TIE_TEARDOWN: _CP_FIXED_PROCEDURE_REPEAT_TIE_TEARDOWN,
    _CP_FIXED_PROCEDURE_REPEAT_TIE_SETUP: _CP_FIXED_PROCEDURE_REPEAT_TIE_SETUP,
    _CP_LIFT_KEYWORDS: _CP_LIFT_KEYWORDS,
    Phase2_ConstructionPlan_usesLift: Phase2_ConstructionPlan_usesLift,
    _CP_FIXED_PROCEDURES: _CP_FIXED_PROCEDURES,
    _Phase2_setupPartSchema: _Phase2_setupPartSchema,
    _Phase2_constructionPlanSchema: _Phase2_constructionPlanSchema,
    _Phase2_buildPartialPrompt: _Phase2_buildPartialPrompt,
    _Phase2_buildConstructionPlanPrompt: _Phase2_buildConstructionPlanPrompt
  };
}
