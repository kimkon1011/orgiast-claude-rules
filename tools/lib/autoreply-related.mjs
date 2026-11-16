/**
 * Extract search terms and search related conversations via Beeper API.
 * Used by autoreply modules to gather context from other conversations
 * so the LLM can make informed decisions instead of returning "未確認".
 */

import { pathToFileURL } from 'node:url';

const AUTOREPLY_PREFIX_PTN = /^【kimのClaudeによる代理回答】/;

/**
 * Extract proper nouns (company names, person names, project names,
 * project codes, exhibition names, etc.) from text and documents.
 * Uses LLM first (cheap category), falls back to regex patterns.
 *
 * @param {string} text - The message text to extract terms from
 * @param {string[]} [documents] - Document texts to also extract from
 * @param {Function} [llm] - Optional LLM function (createLlm result) for AI extraction
 * @returns {Promise<string[]>} Up to 6 unique search terms
 */
export async function extractSearchTerms(text, documents = [], llm = null) {
  const combined = [text, ...documents.map(d => typeof d === 'string' ? d : d?.text)].filter(Boolean).join('\n');
  if (!combined.trim()) return [];

  // Try LLM extraction first if available
  if (llm) {
    try {
      const raw = await llm({
        category: 'classification',
        system: 'Extract proper nouns (company names, person names with 様, project names, exhibition/event names, project codes, invoice-related names) from the text that could be used as search queries to find related conversations. Return ONLY a JSON array of strings, maximum 6 terms. Only return terms that are specific enough to be useful as search queries. Example: ["スマートエイト", "DXPO福岡", "studioreal"]',
        input: { text: combined },
      });
      const parsed = JSON.parse(
        raw.includes('[') && raw.includes(']')
          ? raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
          : raw
      );
      if (Array.isArray(parsed) && parsed.length > 0) {
        const terms = [...new Set(parsed.filter(t => typeof t === 'string').map(t => t.trim()).filter(t => t.length >= 2))].slice(0, 6);
        if (terms.length) return terms;
      }
    } catch {
      // Fall through to regex
    }
  }

  return extractTermsRegex(combined);
}

/**
 * Regex-based fallback term extraction.
 */
export function extractTermsRegex(text) {
  if (!text) return [];
  const terms = new Set();

  // 「〇〇様」pattern
  const samaPtn = /([\u4e00-\u9fff\u3040-\u30ffー\w]{1,20})様/g;
  let match;
  while ((match = samaPtn.exec(text)) !== null) {
    if (match[1].length >= 2) terms.add(match[1]);
  }

  // 【…】 bracketed content (project names, labels)
  const bracketPtn = /【([^】]{2,30})】/g;
  while ((match = bracketPtn.exec(text)) !== null) {
    terms.add(match[1]);
  }

  // After 「案件名：」「請求者名：」「プロジェクト：」「展示会：」「会社名：」「イベント名：」
  const labelPtn = /(?:案件名|請求者名|プロジェクト|展示会|会社名|イベント名|顧客名|取引先)[：:]\s*([\u4e00-\u9fff\u3040-\u30ffー\w\-]{2,30})/g;
  while ((match = labelPtn.exec(text)) !== null) {
    terms.add(match[1]);
  }

  // Alphanumeric codes (project codes, invoice numbers, etc.)
  const codePtn = /\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[A-Z][A-Z0-9]{2,10})\b/g;
  while ((match = codePtn.exec(text)) !== null) {
    terms.add(match[1]);
  }

  const companyPtn = /(?:株式会社|有限会社)[\p{L}\p{N}ー]+|[\p{L}\p{N}ー]+(?:株式会社|商会|工業|産業|商事)/gu;
  while ((match = companyPtn.exec(text)) !== null) terms.add(match[0]);

  return [...terms].slice(0, 6);
}

/**
 * Generate search variants for a term: full-width ↔ half-width digit conversion,
 * and splitting multi-word terms into individual words.
 */
export function generateSearchVariants(term) {
  const variants = new Set([term]);
  // Full-width to half-width digits
  const fwToHw = term.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (fwToHw !== term) variants.add(fwToHw);
  // Half-width to full-width digits
  const hwToFw = term.replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  if (hwToFw !== term) variants.add(hwToFw);
  // Split multi-word terms (space or full-width space separated)
  if (/[\s　]/.test(term)) {
    const parts = term.split(/[\s　]+/).filter(p => p.length >= 2);
    for (const part of parts) {
      variants.add(part);
      // Also add digit variants of each part
      const partFwToHw = part.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      if (partFwToHw !== part) variants.add(partFwToHw);
      const partHwToFw = part.replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
      if (partHwToFw !== part) variants.add(partHwToFw);
    }
  }
  return [...variants];
}

/**
 * Regex for financial/agreement patterns in context expansion.
 * Matches amounts (digit+万/千/円), yen signs, and cost-related keywords.
 */
const CONTEXT_MONEY_PTN = /[0-9０-９][0-9０-９,，.]*\s*(万|千|円)|¥|￥|税抜|税込|合計|見積|請求|原価|発注|認識でよろしい|合意|承知|了解|確認しました|対応します|進めてください/;

/**
 * Project code pattern: 6 digits + 2+ uppercase letters (e.g., 261022SME).
 */
const PROJECT_CODE_PTN = /\b\d{6}[A-Z]{2,}\b/gi;

/** Per-chat limit for context expansion items. */
const CHAT_CONTEXT_LIMIT = 8;

/**
 * Search related conversations via Beeper API.
 * Supports two-stage search: first with extracted terms, then with AI-generated
 * additional terms to find evidence the first pass missed.
 *
 * @param {Object} options
 * @param {string[]} options.terms - Search terms (first stage)
 * @param {Function} options.beeperFetch - Beeper API fetch function (beeperFetch from beeper-api.mjs)
 * @param {Set<string>} [options.excludeMessageIds] - Message IDs to exclude from results
 * @param {number} [options.sinceDays=180] - Look back period in days
 * @param {number} [options.maxItems=30] - Maximum items to return
 * @param {number} [options.maxBytes=20000] - Maximum total text bytes
 * @param {string|string[]} [options.excludeChatIds] - Chat IDs to exclude from context expansion
 * @param {string} [options.currentChatId] - Deprecated: use excludeChatIds instead
 * @param {Function} [options.llm] - LLM function for second-stage term generation (cheap category, non-jp_reply)
 * @param {string} [options.question] - Original question text for second-stage term generation
 * @param {Object} [options.stage2TermHits] - If provided, populated with { term: hitCount } for Stage 2 terms
 * @returns {Promise<Array<{chat: string, sender: string, ts: string, text: string, via?: string}>>}
 */
export async function searchRelated({ terms, beeperFetch, excludeMessageIds = new Set(), sinceDays = 180, maxItems = 30, maxBytes = 20000, currentChatId, excludeChatIds, llm, question, stage2TermHits }) {
  if (!Array.isArray(terms) || terms.length === 0 || typeof beeperFetch !== 'function') return [];

  const since = Date.now() - sinceDays * 86400000;
  const seen = new Set();
  const results = [];
  const chatHits = Object.create(null); // chatID -> { title, timestamps: [], hitIds: [] }

  // Normalize excludeChatIds: accept string, array, or both
  const excludeIds = new Set();
  if (excludeChatIds) {
    const ids = Array.isArray(excludeChatIds) ? excludeChatIds : [excludeChatIds];
    ids.forEach(id => { if (id) excludeIds.add(id); });
  }
  if (currentChatId) excludeIds.add(currentChatId);

  for (const term of terms) {
    if (!term || String(term).length < 2) continue;

    try {
      const data = await beeperFetch('/v1/messages/search', {
        query: { query: String(term), limit: 20 },
      });

      if (!data?.items?.length) continue;

      const chats = data.chats || {};

      for (const item of data.items) {
        if (!item) continue;

        // Deduplicate by composite key (id or chatID+timestamp+text)
        const dedupKey = `${item.chatID}:${item.id || `${item.timestamp}:${item.text}`}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        // Exclude specific message IDs
        if (item.id && excludeMessageIds.has(item.id)) continue;

        // Skip autoreply's own messages
        const text = stripHtml(item.text || '');
        if (!text || AUTOREPLY_PREFIX_PTN.test(text)) continue;

        const ts = Date.parse(item.timestamp);
        if (!Number.isFinite(ts) || ts < since) continue;

        const chatTitle = chats[item.chatID]?.title || item.chatID || '不明';

        results.push({
          chat: chatTitle,
          sender: item.senderName || '不明',
          ts: item.timestamp,
          text,
        });

        // Track chat for context expansion
        if (item.chatID) {
          if (!chatHits[item.chatID]) {
            chatHits[item.chatID] = { title: chatTitle, timestamps: [], hitIds: [], codes: new Set() };
          }
          chatHits[item.chatID].timestamps.push(ts);
          if (item.id) chatHits[item.chatID].hitIds.push(item.id);
          for (const code of text.match(PROJECT_CODE_PTN) || []) chatHits[item.chatID].codes.add(code.toUpperCase());
        }
      }
    } catch {
      // Search failure must not stop the reply
      continue;
    }
  }

  // Phase 2: Expand financial/agreement evidence linked to the search hits.
  if (Object.keys(chatHits).length > 0) {
    const expansionTargets = Object.entries(chatHits)
      .filter(([id]) => !excludeIds.has(id))
      .sort((a, b) => b[1].timestamps.length - a[1].timestamps.length)
      .slice(0, 5);

    for (const [chatId, hitInfo] of expansionTargets) {
      try {
        // Fetch chat messages (newest first), up to 300 items
        let cursor;
        let fetched = 0;
        const chatMessages = [];
        const cursors = new Set();

        while (fetched < 300) {
          const query = { limit: Math.min(100, 300 - fetched), direction: 'before' };
          if (cursor) query.cursor = cursor;
          const chatData = await beeperFetch(`/v1/chats/${encodeURIComponent(chatId)}/messages`, { query });
          if (!chatData?.items?.length) break;
          const page = chatData.items.slice(0, 300 - fetched);
          chatMessages.push(...page);
          fetched += page.length;
          if (!chatData.hasMore || !chatData.oldestCursor || cursors.has(chatData.oldestCursor)) break;
          cursors.add(chatData.oldestCursor);
          cursor = chatData.oldestCursor;
        }

        // Compute proximity indices: messages within ±10 positions of a hit message
        const proximityIndices = new Set();
        if (hitInfo.hitIds && hitInfo.hitIds.length > 0) {
          chatMessages.forEach((msg, idx) => {
            if (msg.id && hitInfo.hitIds.includes(msg.id)) {
              for (let di = -10; di <= 10; di++) {
                const ni = idx + di;
                if (ni >= 0 && ni < chatMessages.length) proximityIndices.add(ni);
              }
            }
          });
        }

        // Require money/agreement AND (a search term, the same project code,
        // or ±10 messages from a direct hit), within ±45 days.
        let contextCount = 0;
        for (let msgIndex = 0; msgIndex < chatMessages.length && contextCount < CHAT_CONTEXT_LIMIT; msgIndex++) {
          const msg = chatMessages[msgIndex];
          if (!msg || (msg.id && excludeMessageIds.has(msg.id))) continue;
          const msgTs = Date.parse(msg.timestamp);
          if (!Number.isFinite(msgTs) || !hitInfo.timestamps.some(hitTs => Math.abs(msgTs - hitTs) <= 45 * 86400000)) continue;
          const text = stripHtml(msg.text || '');
          if (!text || AUTOREPLY_PREFIX_PTN.test(text)) continue;

          // Relevance check: at least one condition must match
          const matchesMoney = CONTEXT_MONEY_PTN.test(text);
          const matchesSearchTerm = terms.some(term => text.toLowerCase().includes(String(term).toLowerCase()));
          const matchesProjectCode = (text.match(PROJECT_CODE_PTN) || []).some(code => hitInfo.codes.has(code.toUpperCase()));
          const isNearHit = proximityIndices.has(msgIndex);

          if (!matchesMoney || (!matchesSearchTerm && !matchesProjectCode && !isNearHit)) continue;

          // Dedup against search results and other context items
          const dedupKey = `${chatId}:${msg.id || `${msg.timestamp}:${msg.text}`}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          results.push({
            chat: hitInfo.title || chatId || '不明',
            sender: msg.senderName || '不明',
            ts: msg.timestamp,
            text,
            via: 'context',
          });
          contextCount++;
        }
      } catch {
        // Expansion failure must not stop the reply
        continue;
      }
    }
  }

  // ── Stage 2: AI-generated additional search terms ──────────────────────
  // If the first pass found results but may have missed key evidence (e.g.
  // a message that doesn't contain any company name), ask a cheap LLM to
  // suggest additional search terms (person+amount, project code, etc.).
  if (llm && question && results.length > 0) {
    try {
      const stage1Summary = results.slice(0, 15).map(r =>
        `[${r.chat}] ${r.sender}: ${r.text.slice(0, 200)}`
      ).join('\n');
      const raw = await llm({
        category: 'classification',
        system: `あなたは関連会話検索の補助AIです。1段目の検索結果と質問文から、不足している決め手の証拠を見つけるための追加検索語を最大4つ提案してください。
既存の検索語と同じ語は不要です。人名（姓のみでも可）＋金額語（例: 「川本 制作費」「４万」「2万」）、案件コード、日付など具体的な語が効果的です。全角数字（２・４）と半角数字（2・4）の両方で検索するので、どちらでも構いません。人名だけの単独語（例: 「川本」）も有効です。
出力はJSON配列のみ: ["語1", "語2", ...]。追加検索語が不要なら空配列 [] を返してください。`,
        input: { question, stage1Results: stage1Summary, existingTerms: terms },
      });
      let extraTerms;
      try {
        const parsed = JSON.parse(
          raw.includes('[') && raw.includes(']')
            ? raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
            : raw
        );
        extraTerms = Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string' && t.trim().length >= 2).slice(0, 4) : [];
      } catch {
        extraTerms = [];
      }

      if (extraTerms.length > 0) {
        // Search with additional terms and their variants (full-width ↔ half-width digits, split multi-word)
        for (const term of extraTerms) {
          const variants = generateSearchVariants(term);
          let termHitCount = 0;
          for (const variant of variants) {
            try {
              const data = await beeperFetch('/v1/messages/search', {
                query: { query: String(variant), limit: 20 },
              });
              if (!data?.items?.length) continue;
              const chats = data.chats || {};
              for (const item of data.items) {
                if (!item) continue;
                const dedupKey = `${item.chatID}:${item.id || `${item.timestamp}:${item.text}`}`;
                if (seen.has(dedupKey)) continue;
                seen.add(dedupKey);
                if (item.id && excludeMessageIds.has(item.id)) continue;
                const text = stripHtml(item.text || '');
                if (!text || AUTOREPLY_PREFIX_PTN.test(text)) continue;
                const ts = Date.parse(item.timestamp);
                if (!Number.isFinite(ts) || ts < since) continue;
                const chatTitle = chats[item.chatID]?.title || item.chatID || '不明';
                results.push({
                  chat: chatTitle,
                  sender: item.senderName || '不明',
                  ts: item.timestamp,
                  text,
                  via: 'stage2',
                });
                termHitCount++;
              }
            } catch {
              // Stage 2 search failure must not stop the reply
              continue;
            }
          }
          if (stage2TermHits) stage2TermHits[term] = termHitCount;
        }
      }
    } catch {
      // Stage 2 LLM failure: continue with first-stage results only
    }
  }

  // Direct hits first (newest first), then stage2, then context in chat-priority order.
  results.sort((a, b) => {
    const aRank = !a.via ? 0 : a.via === 'stage2' ? 1 : 2;
    const bRank = !b.via ? 0 : b.via === 'stage2' ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    if (aRank === 0) return Date.parse(b.ts) - Date.parse(a.ts);
    return 0;
  });

  // Apply item limit: preserve all direct hits, stage2 items next, context items fill remaining
  const directHits = results.filter(r => !r.via);
  const stage2Hits = results.filter(r => r.via === 'stage2');
  const contextItems = results.filter(r => r.via === 'context');
  const remaining = Math.max(0, maxItems - directHits.length);
  const limited = [...directHits, ...stage2Hits.slice(0, remaining), ...contextItems.slice(0, Math.max(0, maxItems - directHits.length - stage2Hits.length))];

  // Bound the serialized UTF-8 payload, including metadata. Never cut evidence
  // mid-sentence: an incomplete amount/qualification could change its meaning.
  const byteLimited = [];
  for (const item of limited) {
    if (Buffer.byteLength(JSON.stringify([...byteLimited, item]), 'utf8') > maxBytes) continue;
    byteLimited.push(item);
  }

  return byteLimited;
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?\s*>|<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, value) => {
      const point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * CLI probe mode: display terms and related entries for a question.
 * Usage: node tools/lib/autoreply-related.mjs --probe "<question>" [--exclude-chat <id>] [--llm]
 *   --llm: enable two-stage search with AI-generated additional terms
 */
async function main(argv = process.argv.slice(2)) {
  const probeIndex = argv.indexOf('--probe');
  if (probeIndex < 0) {
    console.error('Usage: node tools/lib/autoreply-related.mjs --probe "<question>" [--exclude-chat <id>] [--llm]');
    process.exit(1);
  }
  const question = argv[probeIndex + 1];
  if (!question) {
    console.error('--probe requires a question text');
    process.exit(1);
  }

  const excludeChatIndex = argv.indexOf('--exclude-chat');
  const excludeChatId = excludeChatIndex >= 0 ? argv[excludeChatIndex + 1] : undefined;
  const useLlm = argv.includes('--llm');

  // Dynamically import beeperFetch to avoid circular deps at module level
  const { beeperFetch } = await import('../beeper-api.mjs');
  const terms = await extractSearchTerms(question);
  console.log('=== Search Terms (Stage 1) ===');
  terms.forEach(t => console.log(`  ${t}`));

  const failures = new Set();
  let llmFn;
  if (useLlm) {
    const { createLlm } = await import('../discord-autoreply.mjs');
    const os = await import('node:os');
    llmFn = createLlm({ home: os.homedir() });
  }
  const stage2TermHits = {};
  const related = await searchRelated({
    terms,
    question,
    llm: llmFn,
    stage2TermHits,
    beeperFetch: async (ep, init) => {
      try {
        return await beeperFetch(ep, { ...init, timeoutMs: 10000 });
      } catch (error) {
        failures.add(error.code || 'BEEPER_ERROR');
        throw error;
      }
    },
    maxItems: 30,
    maxBytes: 20000,
    ...(excludeChatId ? { excludeChatIds: excludeChatId } : {}),
  });

  if (useLlm) {
    // Show stage 2 raw terms and hit counts
    const stage2Items = related.filter(r => r.via === 'stage2');
    console.log('=== Stage 2 Terms (AI-generated) ===');
    if (Object.keys(stage2TermHits).length === 0) {
      console.log('  (no terms generated — LLM returned empty array or parsing failed)');
    } else {
      for (const [term, hits] of Object.entries(stage2TermHits)) {
        console.log(`  "${term}" → ${hits} hits`);
      }
    }
    if (stage2Items.length > 0) {
      console.log(`  Total unique Stage 2 items: ${stage2Items.length}`);
    }
  }

  if (failures.size) {
    console.error(`Beeper取得失敗（結果は不完全）: ${[...failures].join(', ')}`);
    process.exitCode = 1;
  }
  console.log('=== Related ===');
  if (related.length === 0) {
    console.log('  (none)');
  }
  for (const r of related) {
    const snippet = r.text.replace(/\n/g, ' ');
    const tag = r.via ? ` (via: ${r.via})` : '';
    console.log(`  [${r.chat}] ${r.sender} @ ${r.ts}: ${snippet}${tag}`);
  }
}

// Run as standalone CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
