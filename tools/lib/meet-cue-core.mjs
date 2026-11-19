/**
 * meet-cue-core.mjs
 * 純粋ロジック部（ブラウザ・ネットワークに触れない、テスト対象）
 */

import { sameFleetPc } from '../fleet-pc-identity.mjs';

export function normalizeCaptionRows(rows) {
  return rows.flatMap(({ text: rawText, fromFallback, ...row }) => {
    const text = rawText.trim();
    if (!text || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(text)) return [];
    if (fromFallback && /^[a-z0-9_]+$/.test(text)) return [];
    return [{ ...row, text }];
  });
}

/**
 * Formats a Date object or timestamp as JST string (UTC+9).
 */
export function formatJstDateTime(date = new Date()) {
  const d = typeof date === 'number' ? new Date(date) : date;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function formatJstTime(date = new Date()) {
  const d = typeof date === 'number' ? new Date(date) : date;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${min}:${ss}`;
}

export function formatJstSessionDate(date = new Date()) {
  const d = typeof date === 'number' ? new Date(date) : date;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

/**
 * Sanitizes card data field to ensure numbers in data come from brief.
 * If data contains numbers that do not appear anywhere in brief, clear data.
 */
export function sanitizeCardData(card, brief = '') {
  if (!card) return card;
  const copy = { ...card };
  if (!copy.data || typeof copy.data !== 'string') {
    copy.data = '';
    return copy;
  }

  const numbers = copy.data.match(/\d+/g);
  if (numbers && numbers.length > 0) {
    const briefStr = typeof brief === 'string' ? brief : '';
    const existsInBrief = numbers.some(num => briefStr.includes(num));
    if (!existsInBrief) {
      copy.data = '';
    }
  }
  return copy;
}

export const DEFAULT_SEAT_HOSTNAMES = ['kim-PC'];

export function resolveSeatHostnames(config) {
  const configured = config.seatHostnames ?? config.seatHostname;
  return (Array.isArray(configured) ? configured : [configured])
    .filter(name => typeof name === 'string' && name.trim())
    .map(name => name.trim());
}

export function matchesSeatHostname(hostnames, hostname) {
  return hostnames.length === 0 || hostnames.some(name => sameFleetPc(name, hostname));
}

export const MEET_SELECTORS = {
  inCallButtons: [
    'button[aria-label*="通話から退出"]',
    'button[aria-label*="通話を退出"]',
    'button[aria-label*="通話を終了"]',
    'button[aria-label*="Leave call" i]',
  ],
  joinButtons: ['今すぐ参加', 'Join now', '参加をリクエスト', 'Ask to join', '参加'],
  lobbyTexts: [/参加をリクエストしています|参加をリクエストしました|参加の承認を待|asking to join|ask to join|request sent|someone.*let you in|waiting to be admitted/i],
  guestNameInput: [
    'input[placeholder*="名前"]',
    'input[placeholder*="Name"]',
    'input[aria-label*="名前"]',
    'input[aria-label*="Name"]',
    'input[type="text"]',
  ],
  captionsEnable: ['字幕をオンにする', 'Turn on captions'],
  captionsDisable: ['字幕をオフにする', 'Turn off captions'],
  captionToggles: ['button[aria-label="字幕と翻訳"]'],
  captionContainers: [
    '[role="region"][aria-label="字幕"]',
    '[role="region"][aria-label="Captions"]',
  ],
  captionRows: ['.nMcdL'],
  captionSpeakers: ['.adE6rb .NWpY1d'],
  captionTexts: ['.ygicle'],
  dismissibleDialogs: ['会議の準備が整いました', 'Gemini をご利用いただけます'],
  leftCallTexts: [
    '通話から退出しました',
    'You left the call',
    'Return to home screen',
    'ホーム画面に戻る',
  ],
};

/**
 * Bot 表示名の既定値。顧客に見える Meet 参加者名。
 * 内部用語（カンペ・cue・指示・台本）を含まないこと。
 */
export const BOT_DISPLAY_NAME_DEFAULT = 'オージャストAI';

/**
 * 設定から Bot 表示名を解決する。
 * config.botDisplayName が非空文字列ならそれを使うが、
 * 内部用語（カンペ・cue・指示・台本）を含む場合は既定値に戻す。
 */
export function resolveBotDisplayName(config) {
  const name = config?.botDisplayName;
  if (name && typeof name === 'string' && name.trim()) {
    const internalTerms = ['カンペ', 'cue', '指示', '台本'];
    if (internalTerms.some(term => name.includes(term))) {
      return BOT_DISPLAY_NAME_DEFAULT;
    }
    return name.trim();
  }
  return BOT_DISPLAY_NAME_DEFAULT;
}

export const STANDARD_CARDS = [
  {
    id: 'card-budget',
    title: '予算の懸念',
    trigger: 'お客様が予算オーバー、費用が高い、予算感が合わないと仰った時',
    say: 'ご予算に合わせて、造作と什器の配分を変えたプランもお出しできます。上限の金額を伺えますか。',
    data: '',
    material_url: '',
  },
  {
    id: 'card-schedule',
    title: '納期の懸念',
    trigger: 'お客様がスケジュールが厳しい、納期に間に合うか不安とおっしゃった時',
    say: '逆算すると、デザイン確定の期限がいつになるかを今日お伝えできます。',
    data: '',
    material_url: '',
  },
  {
    id: 'card-competitor',
    title: '競合と比較',
    trigger: '他社サービスとの違いや、なぜオージャストなのか聞かれた時',
    say: '比較の際は、施工・運営当日の体制まで含めた総額で見ていただくのがおすすめです。',
    data: '',
    material_url: '',
  },
  {
    id: 'card-decision-maker',
    title: '決裁者が不在',
    trigger: '上司や役員への相談が必要、決裁を通す必要があるとおっしゃった時',
    say: '部長様がご判断しやすいように、比較表付きの資料をお作りしましょうか。',
    data: '',
    material_url: '',
  },
  {
    id: 'card-fallback',
    title: '質問に答えられない時のつなぎ',
    trigger: '即答できない技術的質問や詳細な確認が必要な事項を問われた時',
    say: '正確にお答えしたいので、確認して本日中にご連絡します。',
    data: '',
    material_url: '',
  },
  {
    id: 'card-closing',
    title: '次のアクション確定（クロージング）',
    trigger: '打合せの終盤、または提案内容にひと通りご納得いただいた局面',
    say: '次回、ラフデザインをお見せする日程を今決めてもよろしいですか。',
    data: '',
    material_url: '',
  },
  {
    id: 'reuse',
    title: '再利用の提案',
    trigger: '次回以降も展示会に出展する予定がある、コストを抑えたいとおっしゃった時',
    say: '次回以降も使い回せるReブースにすると、次回からの費用を抑えられます。',
    data: '',
    material_url: '',
  },
];

/** 話者ブロックの全文から、安定した文だけを記録する。 */
export class CaptionAssembler {
  constructor({ finalizeDelayMs = 2500, silenceDelayMs = 4000 } = {}) {
    this.finalizeDelayMs = finalizeDelayMs;
    this.silenceDelayMs = silenceDelayMs;
    this.rows = new Map();
    this.confirmedBySpeaker = new Map();
    this.finalizedLines = []; // { id, speaker, text, timestamp }
    this.lastActivity = -Infinity;
  }

  pushMutation({ rowId, speaker = '不明', text = '', timestamp = Date.now() }) {
    text = text.trim();
    const previous = this.rows.get(rowId);
    if (!text) {
      this.rows.delete(rowId);
      return [];
    }
    if (previous?.speaker === speaker && previous.text === text) return [];
    this.lastActivity = timestamp;

    const sameSpeaker = previous?.speaker === speaker ? previous : undefined;
    const confirmed = this.confirmedBySpeaker.get(speaker) ?? new Set();
    this.confirmedBySpeaker.set(speaker, confirmed);
    let committedTail;
    const sentences = [];
    for (const match of text.matchAll(/[^。？！?!]+[。？！?!]*|[。？！?!]+/g)) {
      const original = match[0].trim();
      let sentence = original;
      const complete = /[。？！?!]$/.test(sentence);
      const key = this._normalize(sentence);
      // Meet が先頭を文の途中まで切り詰めたとき、記録済みの断片を残さない。
      const clipped = sentences.length === 0 && complete && sameSpeaker?.sentences.some(part =>
        (part.clipped || confirmed.has(part.key)) && part.key.endsWith(key));
      const oldTail = sameSpeaker?.committedTail;
      if (!committedTail && oldTail && sentence.startsWith(oldTail)) {
        committedTail = oldTail;
        sentence = sentence.slice(oldTail.length).trim();
      }
      const pendingKey = this._normalize(sentence);
      sentences.push({
        original,
        text: sentence,
        key: pendingKey,
        complete,
        clipped,
        since: sameSpeaker?.sentences.find(part => part.key === pendingKey)?.since ?? timestamp,
      });
    }

    this.rows.set(rowId, { speaker, text, sentences, confirmed, committedTail });
    return [];
  }

  tick(now = Date.now()) {
    const lines = [];
    for (const row of this.rows.values()) {
      for (const sentence of row.sentences) {
        const { text, key, complete, clipped, since } = sentence;
        if (clipped || !text || /^[。？！?!]+$/.test(text) || row.confirmed.has(key)) continue;
        const ready = complete
          ? now - since >= this.finalizeDelayMs
          : now - this.lastActivity >= this.silenceDelayMs;
        if (!ready) continue;

        row.confirmed.add(key);
        if (!complete) row.committedTail = sentence.original;
        const line = { id: `cap-${this.finalizedLines.length + 1}`, speaker: row.speaker, text, timestamp: now };
        this.finalizedLines.push(line);
        lines.push(line);
      }
    }
    return lines;
  }

  flush(now = Date.now()) {
    const lines = this.tick(now);
    this.rows.clear();
    return lines;
  }

  _normalize(text) {
    return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  getRecentWindow(now = Date.now(), windowMs = 120000) {
    const cutoff = now - windowMs;
    return this.finalizedLines.filter(line => line.timestamp >= cutoff);
  }

  formatWindowText(now = Date.now(), windowMs = 120000) {
    const lines = this.getRecentWindow(now, windowMs);
    if (lines.length === 0) return '(字幕データなし)';
    return lines.map(line => {
      const timeStr = formatJstTime(line.timestamp);
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
  const cleanData = (data || '').trim();
  const cleanUrl = (url || '').trim();
  const headerPrefix = isKim ? '【kimより】' : '【言うこと】';
  const timePrefix = timestampStr ? `${timestampStr} ` : '';
  const firstLine = `${timePrefix}${headerPrefix}${say}\n`;
  const secondLine = cleanData ? `根拠: ${cleanData}\n` : '';
  const thirdLine = cleanUrl ? `資料: ${cleanUrl}\n` : '';
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

  // 3. Format second line if cleanData (12pt)
  if (cleanData) {
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

  // 4. Format third line if cleanUrl (12pt + link)
  if (cleanUrl) {
    const thirdLineLen = thirdLine.length;
    requests.push({
      updateTextStyle: {
        range: { startIndex: currIndex, endIndex: currIndex + thirdLineLen },
        textStyle: {
          fontSize: { magnitude: 12, unit: 'PT' },
          link: { url: cleanUrl },
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
