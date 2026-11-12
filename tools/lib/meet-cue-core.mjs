/**
 * meet-cue-core.mjs
 * 純粋ロジック部（ブラウザ・ネットワークに触れない、テスト対象）
 */

export const MEET_SELECTORS = {
  joinButtons: [
    'button:has-text("今すぐ参加")',
    'button:has-text("参加をリクエスト")',
    'button:has-text("Join now")',
    'button:has-text("Ask to join")',
    'button[aria-label*="参加"]',
    'button[aria-label*="Join"]',
  ],
  guestNameInput: [
    'input[placeholder*="名前"]',
    'input[placeholder*="Name"]',
    'input[aria-label*="名前"]',
    'input[aria-label*="Name"]',
    'input[type="text"]',
  ],
  captionToggleButtons: [
    'button[aria-label*="字幕"]',
    'button[aria-label*="caption"]',
    'button[aria-label*="Caption"]',
    '[data-tooltip*="字幕"]',
  ],
  captionContainers: [
    '.a7238b',
    '[aria-label*="字幕"]',
    '[data-caption-tracks]',
    'div[role="region"][aria-label*="caption"]',
    '.aG928e',
    '.T4L22b',
    '.yg3S7d',
  ],
  leftCallTexts: [
    '通話から退出しました',
    'You left the call',
    'Return to home screen',
    'ホーム画面に戻る',
  ],
};

export const STANDARD_CARDS = [
  {
    id: 'card-budget',
    title: '予算の懸念',
    trigger: 'お客様が予算オーバー、費用が高い、予算感が合わないと仰った時',
    say: 'ご予算について懸念がございましたら、機能のフェーズ分けや規模の個別調整も可能です。',
    data: 'ご予算内での柔軟なプラン調整満足度 98%',
    material_url: '',
  },
  {
    id: 'card-schedule',
    title: '納期の懸念',
    trigger: 'お客様がスケジュールが厳しい、納期に間に合うか不安とおっしゃった時',
    say: '短納期のご要望につきましても、重要機能からの段階的リリースで迅速に対応可能です。',
    data: '最短2週間でのスピード立ち上げ実績多数',
    material_url: '',
  },
  {
    id: 'card-competitor',
    title: '競合と比較',
    trigger: '他社サービスとの違いや、なぜオージャストなのか聞かれた時',
    say: '他社様との最大の違いは、導入後も伴走し続ける手厚い運用サポート体制にございます。',
    data: '導入後継続率 95% 超のサポート実績',
    material_url: '',
  },
  {
    id: 'card-decision-maker',
    title: '決裁者が不在',
    trigger: '上司や役員への相談が必要、決裁を通す必要があるとおっしゃった時',
    say: '社内ご検討用として、ご決裁者様向けの比較資料やサマリーシートをすぐにお作りします。',
    data: '稟議用サマリー資料を即日発行対応',
    material_url: '',
  },
  {
    id: 'card-fallback',
    title: '質問に答えられない時のつなぎ',
    trigger: '即答できない技術的質問や詳細な確認が必要な事項を問われた時',
    say: '確実な情報をお伝えするため、社内専門スタッフに確認の上、本日中にメールにてお戻しいたします。',
    data: '24時間以内の追加入力・ご回答率 100%',
    material_url: '',
  },
  {
    id: 'card-closing',
    title: '次のアクション確定（クロージング）',
    trigger: '打合せの終盤、または提案内容にひと通りご納得いただいた局面',
    say: '本日のお話を踏まえ、次回のご面談日程、またはお見積もりのご送付日程を設定させていただけますか。',
    data: '次回日程確定後のプロジェクト成功率3倍',
    material_url: '',
  },
];

/**
 * Subtitle streaming assembler.
 * Handles growing text for live speakers, deduplicating, and finalizing after 1.5s pause or speaker change.
 */
export class CaptionAssembler {
  constructor({ finalizeDelayMs = 1500 } = {}) {
    this.finalizeDelayMs = finalizeDelayMs;
    this.currentSpeaker = null;
    this.currentText = '';
    this.lastChangeTime = 0;
    this.finalizedLines = []; // { id, speaker, text, timestamp }
    this.nextId = 1;
  }

  pushMutation({ speaker = '不明', text = '', timestamp = Date.now() }) {
    const trimmedText = text.trim();
    if (!trimmedText) return [];

    const newFinalized = [];

    // Check if speaker changed
    if (this.currentSpeaker && this.currentSpeaker !== speaker && this.currentText) {
      newFinalized.push(this._finalizeCurrent(timestamp));
    }

    this.currentSpeaker = speaker;
    if (this.currentText !== trimmedText) {
      this.currentText = trimmedText;
      this.lastChangeTime = timestamp;
    }

    return newFinalized;
  }

  tick(now = Date.now()) {
    const newFinalized = [];
    if (this.currentText && this.lastChangeTime && (now - this.lastChangeTime >= this.finalizeDelayMs)) {
      newFinalized.push(this._finalizeCurrent(now));
    }
    return newFinalized;
  }

  _finalizeCurrent(timestamp) {
    const line = {
      id: `cap-${this.nextId++}`,
      speaker: this.currentSpeaker || '話者',
      text: this.currentText,
      timestamp,
    };
    this.finalizedLines.push(line);
    this.currentSpeaker = null;
    this.currentText = '';
    this.lastChangeTime = 0;
    return line;
  }

  getRecentWindow(now = Date.now(), windowMs = 120000) {
    const cutoff = now - windowMs;
    return this.finalizedLines.filter(line => line.timestamp >= cutoff);
  }

  formatWindowText(now = Date.now(), windowMs = 120000) {
    const lines = this.getRecentWindow(now, windowMs);
    if (lines.length === 0) return '(字幕データなし)';
    return lines.map(line => {
      const d = new Date(line.timestamp);
      const timeStr = d.toTimeString().split(' ')[0];
      return `[${timeStr}] ${line.speaker}: ${line.text}`;
    }).join('\n');
  }

  getTotalCharCount() {
    return this.finalizedLines.reduce((acc, line) => acc + line.text.length, 0);
  }
}

/**
 * Builds state for askJev
 */
export function buildJevState({ captionsText, cards = [], lastCue = null, lastCueAgeSec = null, brief = '' }) {
  const cardSummaries = cards.map(c => `- ${c.id}: [${c.title}] トリガー: ${c.trigger}`);
  const briefText = brief ? brief.slice(0, 300) : '（指定なし）';
  const lastCueText = lastCue
    ? `直前に出したカンペ: ${lastCue.title} (${lastCueAgeSec != null ? `${lastCueAgeSec}秒前` : '直近'})`
    : '直前に出したカンペ: なし';

  return `【打合せ概要】
${briefText}

【状況】
${lastCueText}

【直近120秒の字幕】
${captionsText}

【利用可能なカンペカード】
${cardSummaries.join('\n')}`;
}

/**
 * Builds questions object for askJev
 */
export function buildJevQuestions(cards = []) {
  const actionCriteria = {
    none: '今カードを出す必要がない、または静観すべき',
    generate: 'カード一覧に適切なものがないが、社員に助け舟・セリフを出すべき',
  };
  for (const c of cards) {
    actionCriteria[c.id] = `[${c.title}] ${c.trigger}`;
  }

  return {
    phase: {
      type: 'choice',
      instructions: '現在会話がどの局面にあるか選択してください。',
      criteria: {
        ice_break: 'アイスブレイク・挨拶・雑談',
        hearing: 'ヒアリング・課題感の確認・状況把握',
        proposal: 'サービス提案・解決策の説明・機能紹介',
        price: '見積・価格・費用感・予算の議論',
        objection: '懸念点・反論・競合比較・比較検討',
        closing: '次回アクション設定・クロージング・まとめ',
        smalltalk: 'その他雑談・脱線',
      },
    },
    action: {
      type: 'choice',
      instructions: '社員に今カンペカードを提示すべきか判定してください。',
      criteria: actionCriteria,
    },
  };
}

/**
 * Parses and validates Jev response
 */
export function parseJevResponse(jevResult, cards = []) {
  if (!jevResult || !jevResult.ok || !jevResult.answers) {
    return { phase: 'smalltalk', action: 'none', confidence: 0, reason: jevResult?.reason || 'no_response' };
  }

  const { answers } = jevResult;

  // Extract phase
  let phase = 'smalltalk';
  if (typeof answers.phase === 'string') phase = answers.phase;
  else if (answers.phase && typeof answers.phase.choice === 'string') phase = answers.phase.choice;

  // Extract action & confidence
  let action = 'none';
  let confidence = 1.0;

  if (typeof answers.action === 'string') {
    action = answers.action;
  } else if (answers.action && typeof answers.action.choice === 'string') {
    action = answers.action.choice;
    if (typeof answers.action.confidence === 'number') {
      confidence = answers.action.confidence;
    }
  }

  // If confidence < 0.7, treat as 'none'
  if (confidence < 0.7) {
    action = 'none';
  }

  // Check if action is valid card ID, generate, or none
  const validCardIds = new Set(cards.map(c => c.id));
  if (action !== 'none' && action !== 'generate' && !validCardIds.has(action)) {
    action = 'none';
  }

  return { phase, action, confidence };
}

/**
 * Tracks presented cues, cooldowns, and deduplication
 */
export class CueTracker {
  constructor({ globalCooldownMs = 40000, cardRepeatCooldownMs = 300000 } = {}) {
    this.globalCooldownMs = globalCooldownMs;
    this.cardRepeatCooldownMs = cardRepeatCooldownMs;
    this.lastCueTime = 0;
    this.lastCueDetails = null;
    this.cardPresentedTimes = new Map(); // cardId -> timestamp
    this.history = [];
  }

  canPresentCue(action, now = Date.now()) {
    if (action === 'none') return false;

    // Check global cooldown (40s)
    if (this.lastCueTime && (now - this.lastCueTime < this.globalCooldownMs)) {
      return false;
    }

    // Check card deduplication (5m)
    if (action !== 'generate' && this.cardPresentedTimes.has(action)) {
      const lastTime = this.cardPresentedTimes.get(action);
      if (now - lastTime < this.cardRepeatCooldownMs) {
        return false;
      }
    }

    return true;
  }

  recordCuePresented(action, cueDetails, now = Date.now()) {
    this.lastCueTime = now;
    this.lastCueDetails = cueDetails;
    if (action !== 'generate') {
      this.cardPresentedTimes.set(action, now);
    }
    this.history.push({ action, cueDetails, timestamp: now });
  }

  getLastCueAgeSec(now = Date.now()) {
    if (!this.lastCueTime) return null;
    return Math.floor((now - this.lastCueTime) / 1000);
  }
}

/**
 * Google Docs batchUpdate request builders
 */

export function buildDocHeaderRequests({ title = '', staff = '', dateStr = '' }) {
  const text = `【Meetカンペ】${title ? `${title}` : '打合せ'}\n` +
    `日時: ${dateStr} / 参加社員: ${staff}\n` +
    `※ 使い方: 最新の指示は一番上に出ます。kim はこの Doc に直接書き込めば社員に届きます。Bot は字幕を読んでいるだけで発言しません。\n` +
    `----------------------------------------\n\n`;

  const requests = [
    {
      insertText: {
        location: { index: 1 },
        text,
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 1 + `【Meetカンペ】${title ? `${title}` : '打合せ'}`.length },
        textStyle: { bold: true, fontSize: { magnitude: 18, unit: 'PT' } },
        fields: 'bold,fontSize',
      },
    },
  ];

  return { requests, headerLength: text.length };
}

export function buildDocCueRequests({
  timestampStr = '',
  say = '',
  data = '',
  url = '',
  isKim = false,
  insertIndex = 1,
}) {
  const headerPrefix = isKim ? '【kimより】' : '【言うこと】';
  const timePrefix = timestampStr ? `${timestampStr} ` : '';
  const firstLine = `${timePrefix}${headerPrefix}${say}\n`;
  const secondLine = data ? `根拠: ${data}\n` : '';
  const thirdLine = url ? `資料: ${url}\n` : '';
  const spacer = '\n';

  const fullText = `${firstLine}${secondLine}${thirdLine}${spacer}`;

  const requests = [
    // 1. Insert full text
    {
      insertText: {
        location: { index: insertIndex },
        text: fullText,
      },
    },
  ];

  let currIndex = insertIndex;

  // 2. Format first line (bold, 20pt, red if kim)
  const firstLineLen = firstLine.length;
  const textStyle = {
    bold: true,
    fontSize: { magnitude: 20, unit: 'PT' },
  };

  if (isKim) {
    textStyle.foregroundColor = {
      color: {
        rgbColor: { red: 0.8, green: 0, blue: 0 },
      },
    };
  }

  requests.push({
    updateTextStyle: {
      range: { startIndex: currIndex, endIndex: currIndex + firstLineLen },
      textStyle,
      fields: isKim ? 'bold,fontSize,foregroundColor' : 'bold,fontSize',
    },
  });

  currIndex += firstLineLen;

  // 3. Format second line if data (12pt)
  if (data) {
    const secondLineLen = secondLine.length;
    requests.push({
      updateTextStyle: {
        range: { startIndex: currIndex, endIndex: currIndex + secondLineLen },
        textStyle: { fontSize: { magnitude: 12, unit: 'PT' } },
        fields: 'fontSize',
      },
    });
    currIndex += secondLineLen;
  }

  // 4. Format third line if url (12pt + link)
  if (url) {
    const thirdLineLen = thirdLine.length;
    requests.push({
      updateTextStyle: {
        range: { startIndex: currIndex, endIndex: currIndex + thirdLineLen },
        textStyle: {
          fontSize: { magnitude: 12, unit: 'PT' },
          link: { url },
        },
        fields: 'fontSize,link',
      },
    });
    currIndex += thirdLineLen;
  }

  return { requests, textLength: fullText.length };
}

/**
 * Parses transcript lines for simulate command
 * Expects lines like: "Speaker: Text" or "[14:00:00] Speaker: Text"
 */
export function parseSimulateTranscript(rawText) {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const result = [];

  for (const line of lines) {
    const timeMatch = line.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)/);
    let timeText = '';
    let content = line;
    if (timeMatch) {
      timeText = timeMatch[1];
      content = timeMatch[2];
    }

    const colonIdx = content.indexOf(':');
    const fullColonIdx = content.indexOf('：');
    let idx = -1;
    if (colonIdx >= 0 && fullColonIdx >= 0) idx = Math.min(colonIdx, fullColonIdx);
    else if (colonIdx >= 0) idx = colonIdx;
    else if (fullColonIdx >= 0) idx = fullColonIdx;

    if (idx > 0) {
      const speaker = content.slice(0, idx).trim();
      const text = content.slice(idx + 1).trim();
      result.push({ speaker, text, timeText });
    } else {
      result.push({ speaker: '参加者', text: content, timeText });
    }
  }

  return result;
}

/**
 * Executes a single decision round: assemble state -> askJev -> parse -> canPresent -> generate -> record -> Doc insert
 */
export async function runDecisionRound({
  assembler,
  tracker,
  cards = [],
  brief = '',
  now = Date.now(),
  askJev,
  generateHelpCue,
  insertCue,
  log = null,
  label = 'meet-cue-loop',
  onCue = null,
} = {}) {
  const captionsText = assembler ? assembler.formatWindowText(now, 120000) : '';
  const state = buildJevState({
    captionsText,
    cards,
    lastCue: tracker ? tracker.lastCueDetails : null,
    lastCueAgeSec: tracker ? tracker.getLastCueAgeSec(now) : null,
    brief,
  });

  const questions = buildJevQuestions(cards);
  const jevResult = await askJev({ state, questions, label, timeoutMs: 8000 });
  const decision = parseJevResponse(jevResult, cards);

  if (decision.action !== 'none' && (!tracker || tracker.canPresentCue(decision.action, now))) {
    let cueToPresent = cards.find(c => c.id === decision.action);
    if (decision.action === 'generate' && typeof generateHelpCue === 'function') {
      cueToPresent = await generateHelpCue({ brief, captionsText });
    }

    if (cueToPresent) {
      if (tracker) {
        tracker.recordCuePresented(decision.action, cueToPresent, now);
      }

      if (typeof onCue === 'function') {
        try {
          await onCue({ timestamp: now, action: decision.action, cue: cueToPresent, decision });
        } catch { /* ignore */ }
      }

      if (typeof log === 'function') {
        log(decision, cueToPresent);
      }

      if (typeof insertCue === 'function') {
        try {
          await insertCue(cueToPresent);
        } catch (e) {
          if (typeof log === 'function') log('meet-cue: Doc 差し込みエラー:', e.message);
        }
      }

      return { presented: true, decision, cue: cueToPresent };
    }
  }

  return { presented: false, decision, cue: null };
}
