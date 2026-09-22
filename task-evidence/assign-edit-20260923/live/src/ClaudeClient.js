/**
 * Claude API クライアント。
 * - Model: claude-opus-4-7（クオリティ優先）
 * - Prompt Caching: マニュアル参照と見積テンプレ等の大きな静的コンテキストは cache_control マーク
 * - API キーは Script Properties.CLAUDE_API_KEY に保存
 * - ハルシネーション防止のため system プロンプトに「入力にない情報を捏造しない」を明示
 */

const CLAUDE_MODEL = 'claude-opus-4-7';
// Fable5は§1.16により全用途禁止(別課金)。旧Fable5呼び出し箇所は品質重視タスク向けにOpus 4.8を使う。
const CLAUDE_MODEL_HQ = 'claude-opus-4-8';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_API_VERSION = '2023-06-01';
var _CLAUDE_EXTRA_INSTRUCTION = '';

function ClaudeClient_setExtraInstruction(text) {
  _CLAUDE_EXTRA_INSTRUCTION = String(text == null ? '' : text).slice(0, 4000);
}

function ClaudeClient_clearExtraInstruction() {
  _CLAUDE_EXTRA_INSTRUCTION = '';
}

/**
 * @param {Object} opts
 *   - system: string  (system プロンプト本文)
 *   - cachedContext: Array<string>  (キャッシュ対象の大きなコンテキスト群。最後のブロックに cache_control が付く)
 *   - userMessage: string  (今回の質問/指示)
 *   - documents: Array<{driveFileId, label?, kind?, mimeType?}> (任意。PDF/Slides/Docs/PPTX/画像を添付)
 *   - maxTokens: number (default 4096)
 *   (temperature は Opus 4.7 で deprecated のため指定しない)
 * @return {{text: string, usage: object}}
 */
function ClaudeClient_call(opts) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY が未設定です。メニュー「Claude API キーを設定」から登録してください。');

  const system = [];
  const baseSystem = (opts.system || '') + '\n\n' + ClaudeClient_baseSystemPrompt();
  system.push({ type: 'text', text: baseSystem });
  if (opts.cachedContext && opts.cachedContext.length > 0) {
    opts.cachedContext.forEach(function (ctx, i) {
      const block = { type: 'text', text: ctx };
      // 最後のキャッシュ対象ブロックに cache_control を付与
      if (i === opts.cachedContext.length - 1) {
        block.cache_control = { type: 'ephemeral' };
      }
      system.push(block);
    });
  }

  // user message を content blocks に組み立て (documents があれば資料を先頭に置く)
  const userContent = [];
  if (opts.documents && opts.documents.length > 0) {
    // Claude API: cache_control は request 全体で max 4 ブロック (system 側で 1 個使うので docs には 3 個まで)。
    // 末尾から 3 個に cache_control を付ける (最後の docs ほどキャッシュ価値が高い)。
    const docBlocks = [];
    let totalBase64Bytes = 0;
    const maxBase64Bytes = 20 * 1024 * 1024;
    opts.documents.forEach(function (d) {
      try {
        const file = DriveApp.getFileById(d.driveFileId);
        const fileMimeType = d.mimeType || file.getMimeType();
        const kind = d.kind || CaseMaterials_kindForMimeType(fileMimeType);
        let blob = null, blockType = 'document', mediaType = 'application/pdf';
        if (kind === 'pdf') blob = file.getBlob();
        else if (kind === 'slides' || kind === 'docs') blob = file.getAs('application/pdf');
        else if (kind === 'pptx') blob = CaseMaterials_pptxToPdf(d.driveFileId);
        else if (kind === 'image') {
          blob = file.getBlob(); blockType = 'image'; mediaType = fileMimeType;
        } else {
          console.warn('document attach skipped (unsupported mimeType): ' + d.driveFileId + ' / ' + fileMimeType);
          return;
        }
        if (!blob) return;
        const b64 = Utilities.base64Encode(blob.getBytes());
        if (totalBase64Bytes + b64.length > maxBase64Bytes) {
          console.warn('document attach skipped (base64 total over 20MB): ' + d.driveFileId + ' / ' + fileMimeType);
          return;
        }
        totalBase64Bytes += b64.length;
        const block = { type: blockType, source: { type: 'base64', media_type: mediaType, data: b64 } };
        if (blockType === 'document') block.title = d.label || file.getName();
        docBlocks.push(block);
      } catch (e) {
        console.warn('document attach failed: ' + d.driveFileId + ' / ' + e.message);
      }
    });
    const cacheCount = Math.min(3, docBlocks.length);
    for (let i = docBlocks.length - cacheCount; i < docBlocks.length; i++) {
      docBlocks[i].cache_control = { type: 'ephemeral' };
    }
    docBlocks.forEach(function (b) { userContent.push(b); });
  }
  var userMessage = opts.userMessage;
  if (_CLAUDE_EXTRA_INSTRUCTION) {
    userMessage += '\n\n## 追加の修正指示 (前回の生成結果に対して人が出した指示。最優先で反映する)\n' +
      _CLAUDE_EXTRA_INSTRUCTION +
      '\n上の指示と矛盾する既定の書き方は、この修正指示を優先して上書きしてください。';
  }
  userContent.push({ type: 'text', text: userMessage });

  const payload = {
    model: opts.model || CLAUDE_MODEL,
    max_tokens: opts.maxTokens || 4096,
    system: system,
    messages: [
      { role: 'user', content: userContent }
    ]
  };

  const response = UrlFetchApp.fetch(CLAUDE_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': CLAUDE_API_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) {
    throw new Error('Claude API エラー [' + code + ']: ' + body);
  }
  const data = JSON.parse(body);
  const text = data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
  return { text: text, usage: data.usage || {} };
}

/**
 * API キーが正しく設定されているか・到達できるかを確認する小さなテスト。
 * 50 トークンの軽い呼び出しで成功すれば OK。
 */
function ClaudeClient_pingTest() {
  const ui = SpreadsheetApp.getUi();
  try {
    const res = ClaudeClient_call({
      userMessage: 'pong とだけ返してください。',
      maxTokens: 30
    });
    ui.alert(
      'Claude API 疎通テスト 成功',
      'モデル応答: ' + (res.text || '(空)') +
      '\n\n使用トークン:' +
      '\n  input: ' + (res.usage.input_tokens || 0) +
      '\n  output: ' + (res.usage.output_tokens || 0) +
      '\n  cache_creation: ' + (res.usage.cache_creation_input_tokens || 0) +
      '\n  cache_read: ' + (res.usage.cache_read_input_tokens || 0),
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('Claude API 疎通テスト 失敗', String(e), ui.ButtonSet.OK);
  }
}

function ClaudeClient_baseSystemPrompt() {
  return [
    'あなたはオージャストの展示会ブース制作チームを支援するアシスタントです。',
    '以下を厳守してください:',
    '- 入力データに存在しない情報（クライアントの担当者名・役職・部門等）を推測して書かないこと。',
    '- 不明・未確定の点は本文に書かず、JSON の "confirmations" 配列に「カテゴリ + 確認内容」として列挙すること。',
    '- 出力フォーマットがユーザーから指定されている場合はそれに厳密に従うこと。',
    '- 社内用語は提供された辞書通りに表記すること（揺れを起こさない）。'
  ].join('\n');
}
