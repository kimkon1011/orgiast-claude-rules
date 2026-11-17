import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isUnattendedSession } from './unattended-session.mjs';
import { displayPcNames } from './pc-display.mjs';

export const revisionOf = item => createHash('sha256').update(JSON.stringify([item.kind, item.text, item.revision, item.progressVersion])).digest('hex');
export const jstDay = now => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
const cap = (text, length) => Array.from(text).slice(0, length).join('');
export function inboxSummary(item) {
  const lines = String(item.text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (item.source === 'knowledge-lock-passkey-link' && lines.some(line => /^登録リンク: https:\/\//.test(line))) return lines.join(' ');
  const heading = cap(lines.filter(line => !/^(作業ID:|成果物:|自動起票:|原因:|対処:|\d+[.．、)）])/.test(line)).join(' '), 140);
  const action = lines.slice(1).find(s => /承認待ち|kim.*(?:判断|承認|操作)|登録リンク/.test(s));
  return (heading + (action && !heading.includes(action) ? ` / ${cap(action, 90)}` : '')).replace(/\s+/g, ' ').trim();
}
export function relayDue(item, sessionId, now = Date.now()) {
  const delivery = item.deliveredToKim;
  if (!delivery || delivery.revision !== revisionOf(item)) return true;
  if (item.kind === 'ask') return delivery.sessions?.[sessionId]?.day !== jstDay(now);
  return item.kind !== 'info';
}
const withoutEmoji = text => text.replace(/[\p{Extended_Pictographic}️‍]/gu, '').trim();
const metadataLine = /^(?:【[^】]*】\s*(?:プロジェクト|セッションの目的)|プロジェクト|作業ID|セッションの目的)[:：]/;
const actionLabel = /^(?:あなたの返事待ち|答えてほしいこと|判断してほしいこと|あなたの作業待ち|kim がすること|kim がやること[^:：]*)[:：]/;
const anyActionLabel = /^(?:あなたの返事待ち|答えてほしいこと|判断してほしいこと|あなたの作業待ち|kim がすること|kim がやること[^:：]*|承認待ち|約束)[:：]/;
const linkGuideLine = /^(?:手順書[（(]|手順書[:：]|開く(?:アカウント)?[:：]|成果物[:：]|以下のURL[:：]|参照[:：]|詳細[:：]|リンク[:：])/;
const stripMarkdown = text => text.replace(/^[#\-*]+\s*/gm, '').replace(/\*\*/g, '').trim();
const cleanDisplayText = text => stripMarkdown(withoutEmoji(text));
const stripSubjectBrackets = text => text.replace(/^【([^】]+)】\s*/, '$1 ').trim();
const capTopic = (text, length) => {
  if (Array.from(text).length <= length) return text;
  const shortened = /https?:\/\//.test(text) ? capWithoutSplittingUrl(text, length) : cap(text, length);
  const open = shortened.lastIndexOf('（');
  const close = shortened.lastIndexOf('）');
  return open > close ? `${shortened.slice(0, open).trimEnd()}…` : shortened;
};
const capWithoutSplittingUrl = (text, length) => {
  if (Array.from(text).length <= length) return text;
  const boundary = Array.from(text).slice(0, length).join('').length;
  const crossingUrl = [...text.matchAll(/https?:\/\/\S+/g)]
    .find(({ index, 0: url }) => index < boundary && index + url.length > boundary);
  return crossingUrl ? text.slice(0, crossingUrl.index + crossingUrl[0].length) : text.slice(0, boundary) + '…';
};

function extractWorkId(text) {
  const m = String(text).match(/作業ID:\s*([a-f0-9]{8})(?![a-f0-9])/i);
  return m ? m[1] : null;
}

export function groupInboxItems(items) {
  // Group by work ID + normalized decide. Items without a work ID are each their own group.
  const groups = new Map();
  for (const item of items) {
    const workId = extractWorkId(item.text);
    const decide = inboxBrief(item).decide;
    const key = workId ? `${workId}::${decide}` : item.id;
    if (groups.has(key)) {
      const group = groups.get(key);
      const representative = group.representative;
      if (item.createdAt > representative.createdAt
        || (item.createdAt === representative.createdAt && item.id > representative.id)) {
        group.duplicates.push(group.representative.id);
        group.representative = item;
      } else {
        group.duplicates.push(item.id);
      }
    } else {
      groups.set(key, { representative: item, duplicates: [] });
    }
  }
  return Array.from(groups.values());
}

export function inboxBrief(item, options = {}) {
  const text = String(item.text || '');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.find(line => metadataLine.test(line));
  const purpose = header?.match(/セッションの目的[:：]\s*(.*?)(?:\s*／\s*(?:作業ID|プロジェクト)[:：]|$)/)?.[1].trim();
  const pc = String(item.from || '').split('・')[0].trim();
  const displayPc = displayPcNames((pc && !pc.includes('@') ? pc : header?.match(/^【([^・】]+)/)?.[1]) || '', options);
  const meaning = lines.map(withoutEmoji).find(line => line && !metadataLine.test(line) && !/^https?:\/\//.test(line) && !linkGuideLine.test(line)) || '';
  const topicSource = cleanDisplayText(stripSubjectBrackets(purpose || (header ? meaning : lines[0]) || '件名なし'));
  let topic = capTopic(topicSource, 80);
  if (displayPc && !topic.startsWith(displayPc)) topic = `${displayPc}: ${topic}`;
  const happenedRaw = meaning ? capWithoutSplittingUrl(meaning, 120) : '';
  // Compare the displayed subject and first meaningful line without subject brackets.
  const normTopic = stripSubjectBrackets(topicSource);
  const normHappened = stripSubjectBrackets(happenedRaw || '');
  const duplicatedMeaning = cleanDisplayText(stripSubjectBrackets(meaning)) === normTopic
    || (normTopic && normHappened && (normTopic.includes(normHappened) || normHappened.includes(normTopic)));
  let happened = (!header && purpose === undefined && duplicatedMeaning)
    ? (() => {
        const meaningIndex = lines.map(withoutEmoji).findIndex(l => l === meaning);
        const nextLine = lines.slice(meaningIndex + 1).map(withoutEmoji).find(l => l && !metadataLine.test(l) && !/^https?:\/\//.test(l) && !linkGuideLine.test(l) && !actionLabel.test(l));
        return nextLine ? cleanDisplayText(capWithoutSplittingUrl(nextLine, 120)) : '';
      })()
    : cleanDisplayText(happenedRaw);
  const unspecified = `返事内容の指定なし（原文確認: node tools/kim-inbox.mjs --show ${item.id}）`;
  const actions = lines.map(withoutEmoji);
  const actionLineInfo = (() => {
    for (let i = 0; i < actions.length; i++) {
      if (actionLabel.test(actions[i])) return { line: actions[i], index: i };
    }
    for (let i = 0; i < actions.length; i++) {
      if (/^(?:kim の)?承認待ち/.test(actions[i])) return { line: actions[i], index: i };
    }
    for (let i = 0; i < actions.length; i++) {
      if (/^約束[:：]/.test(actions[i])) return { line: actions[i], index: i };
    }
    return null;
  })();
  const resumeFailed = item.source === 'auto-progress-resume-failed';
  const infoDecideKeywords = /承認待ち|確認してください|状況を確認|返信してください|kim がやること|kim がすること|あなたの返事待ち|答えてほしいこと|判断してほしいこと/;
  const negativeInfoPattern = /kim がすること:\s*なし|承認待ちの列挙なし/;
  let decide;
  if (resumeFailed) {
    decide = '自動再開が止まっている。続けるか中止するか';
  } else if (item.kind === 'info') {
    const infoActionLine = actions.find(line => infoDecideKeywords.test(line) && !negativeInfoPattern.test(line));
    if (infoActionLine) {
      decide = infoActionLine.replace(anyActionLabel, '').trim() || unspecified;
    } else {
      decide = '判断不要（報告のみ）';
    }
  } else if (actionLineInfo) {
    const stripped = actionLineInfo.line.replace(anyActionLabel, '').trim();
    let baseDecide;
    // Fix 2: capture follow-up lines only when the label line has no content (heading-only)
    if (!stripped) {
      const followUps = [];
      for (let i = actionLineInfo.index + 1; i < actions.length && followUps.length < 3; i++) {
        const l = actions[i];
        if (actionLabel.test(l) || /^(?:kim の)?承認待ち/.test(l) || /^約束[:：]/.test(l)) break;
        if (metadataLine.test(l)) continue;
        followUps.push(l);
      }
      if (followUps.length > 0) {
        baseDecide = capWithoutSplittingUrl(followUps.join('\n'), 300);
      } else {
        baseDecide = unspecified;
      }
    } else {
      baseDecide = stripped;
    }
    decide = baseDecide;
  } else {
    decide = unspecified;
  }
  decide = cleanDisplayText(decide);
  const normDecide = stripSubjectBrackets(decide);
  if (happened && normDecide && happened === normDecide) happened = '';
  const hasRealDecide = decide && decide !== '判断不要（報告のみ）';
  const reply = item.kind === 'deadline' ? `${item.key || 'D-003'} 完了／延期 11/20／不要`
    : resumeFailed ? 'N 続けて／N 中止'
    : hasRealDecide && /(?:\bPR\b|プルリク|\/pull\/\d+)/i.test(`${decide}\n${text}`) ? 'N マージしてよい／N <修正点>'
    : item.kind === 'info' && !hasRealDecide ? '返事不要' : 'N 可／N 不要／N <指示>';
  const rawLinks = [...text.matchAll(/https?:\/\/[^\s<>「」『』【】（）]+/g)].map(m => m[0]);
  const sanitized = rawLinks.map(url => url.replace(/[*)\]）。、.,]+$/, ''));
  const seenRefs = new Map(); // ref → index in links[]
  const links = [];
  for (const url of sanitized) {
    const docMatch = url.match(/\/d\/([^/?#\s]+)/);
    const ref = docMatch ? docMatch[1] : url;
    if (seenRefs.has(ref)) {
      if (docMatch && url.includes('authuser=')) {
        const existingUrl = links[seenRefs.get(ref)];
        if (!existingUrl.includes('authuser=')) {
          links[seenRefs.get(ref)] = url;
        }
      }
    } else {
      seenRefs.set(ref, links.length);
      links.push(url);
    }
  }
  return { topic, happened, decide, reply, links };
}
export function formatInboxBrief(item, n = 'N', options = {}) {
  const brief = inboxBrief(item, options);
  const reply = brief.reply.replace(/\bN(?= )/g, String(n));
  let result = `${n}. ${brief.topic}（${item.id}）`;
  if (brief.happened) result += `\n   起きたこと: ${brief.happened}`;
  result += `\n   判断してほしいこと: ${brief.decide}`;
  result += `\n   返事の例: ${reply}`;
  for (const link of brief.links) {
    if (brief.decide.includes(link)) continue;
    result += `\n   開く: ${link}`;
  }
  return result;
}

export function interactiveInboxSession(input, { home, env = process.env, raw = '' } = {}) {
  if (input.agent_id || input.isSidechain || /(?:^|[\\/])subagents[\\/]/.test(input.transcript_path || '')) return false;
  if (isUnattendedSession({ ...input, entrypoint: input.entrypoint || input.entryPoint || env.CLAUDE_CODE_ENTRYPOINT }, { home, env })) return false;
  const entries = raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const entrypoint = entries.filter(e => e.isSidechain !== true && (e.entrypoint || e.entryPoint)).at(-1);
  return !['sdk-cli', 'sdk-ide'].includes(entrypoint?.entrypoint || entrypoint?.entryPoint);
}
const stateFile = (home, sessionId) => path.join(home, '.claude/kim-inbox-relay', createHash('sha256').update(sessionId).digest('hex') + '.json');
export function readRelayState(home, sessionId) {
  try { return JSON.parse(fs.readFileSync(stateFile(home, sessionId), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export function writeRelayState(home, sessionId, state) {
  if (!sessionId) return;
  const file = stateFile(home, sessionId), temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function recordInjection(home, sessionId, items, { event, now = Date.now() } = {}) {
  if (!sessionId) return;
  const state = readRelayState(home, sessionId);
  writeRelayState(home, sessionId, { ...state, sessionId, event, injectedAt: new Date(now).toISOString(),
    pending: items.map((item, n) => ({ id: item.id, revision: revisionOf(item), summary: formatInboxBrief(item, n + 1, { home }).split('\n')[0] })) });
}
export function recordPromptAnswers(home, sessionId, prompt, { listItems, answerItem }) {
  if (!sessionId) return [];
  const state = readRelayState(home, sessionId), delivered = state.lastDelivered || [];
  const lines = prompt.trim().split(/\r?\n/);
  const matches = lines.map(line => line.trim().match(/^(ki-\d{14}-[a-f0-9]{4}|[1-9]\d*)\s*[:：、.．]?\s+(可|不可|承認|否認|はい|いいえ|不要|完了|OK|保留)[。.!！]?$/i));
  if (!matches.length || matches.some(m => !m)) return [];
  const items = listItems(home), answers = [];
  for (const match of matches) {
    const receipt = delivered.find(d => match[1] === d.id || match[1] === String(d.number));
    const item = items.find(i => i.id === receipt?.id && i.kind === 'ask' && i.status === 'open' && revisionOf(i) === receipt.revision);
    if (!item || match[2] === '保留') continue;
    if (!match[1].startsWith('ki-') && (item.text.match(/^\s*\d+[.．、)）]/gm) || []).length > 1) continue;
    answers.push(answerItem(home, item.id, match[2], sessionId));
  }
  return answers;
}

// Natural language reply classification (prefix match, allows sentence-ending particles)
function classifyNaturalLanguage(text) {
  const t = text.trim().replace(/[。、.!！\s]+$/g, '');
  if (/^(?:不要|やめ|止め|だめ|ダメ|不可|いいえ|保留|ちょっと待って|待って)/.test(t)) return '否認';
  if (/^(?:良い|大丈夫|入れ|ok|お願い|進めて|承認|はい|可)/i.test(t)) return '可';
  if (/^(?:完了|おわり|終わり)/.test(t)) return '完了';
  if (/^(?:上[のの]?\d+(?:\s*[、,]\s*\d+)*\s*(?:は|も)?\s*)(?:OK|良い|大丈夫|お願い|承認|可|全部OK)/i.test(t)) return '可';
  // "全部OK" "両方OK" "全部進めて" as standalone
  if (/^(?:全部|両方|すべて)\s*(?:OK|良い|大丈夫|お願い|進めて|可)/i.test(t)) return '可';
  if (/^(?:全部|両方|すべて)\s*(?:不要|やめ|止め)/i.test(t)) return '否認';
  return null;
}

function writeTempAnswer(home, text) {
  const dir = path.join(home, '.claude', 'kim-inbox-relay', 'tmp-answers');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.${randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// Loose classification: check if affirmative/negative keywords appear anywhere in text
function classifyNaturalLanguageLoose(text) {
  const t = text.trim().toLowerCase();
  // Japanese affirmative keywords (no \b since it doesn't work with Japanese)
  const affirmative = ['良い', '大丈夫', 'ok', 'お願い', '進めて', '承認', 'はい', '可', 'よい', 'いい', 'マージしてよい', 'リリースしてよい', '公開してよい', '入れてよい', '削除してよい'];
  for (const kw of affirmative) { if (t.includes(kw)) return '可'; }
  const negative = ['不要', 'やめ', '止め', 'だめ', 'ダメ', '不可', 'いいえ', '保留', 'やめて', 'やめる', 'ストップ'];
  for (const kw of negative) { if (t.includes(kw)) return '否認'; }
  const done = ['完了', 'おわり', '終わり'];
  for (const kw of done) { if (t.includes(kw)) return '完了'; }
  // "全部OK" / "両方OK" patterns
  if (/(全部|両方|すべて)\s*(ok|良い|大丈夫|進めて|可)/i.test(t)) return '可';
  if (/(全部|両方|すべて)\s*(不要|やめ|止め)/i.test(t)) return '否認';
  return null;
}

// Match awaiting item by title words in prompt. Returns { id, answer } or null.
function matchAwaitingItemByContent(prompt, awaitingItem) {
  const lines = prompt.trim().split(/\r?\n/).filter(Boolean);
  const promptText = lines.join(' ').toLowerCase();
  // Title words that are distinctive (≥2 chars, not common stopwords)
  const stopwords = new Set(['して', 'する', 'ため', 'こと', 'これ', 'それ', 'あれ', 'この', 'その', 'ある', 'ない', 'いる', 'なる', 'ます', 'です', 'たい', 'もの', 'とき', 'ため', 'よう', 'から', 'まで', 'の', 'へ', 'を', 'が', 'に', 'は', 'と', 'も', 'で', 'や', 'て', 'た', 'だ', 'な', 'い', 'う', 'お', 'か', 'き', 'く', 'け', 'こ', 'さ', 'し', 'す', 'せ', 'そ', 'ち', 'つ']);
  const titleWords = String(awaitingItem.title).split(/[\s/／（）()、,]+/).filter(w => w.length >= 2 && !stopwords.has(w));
  const askWords = String(awaitingItem.ask).split(/[\s/／（）()、,]+/).filter(w => w.length >= 2 && !stopwords.has(w));
  const allKeywords = [...new Set([...titleWords, ...askWords])];
  if (allKeywords.length === 0) return null;
  // Flexible matching: check if keyword (or its significant prefix) appears in prompt
  const matchCount = allKeywords.filter(w => {
    if (promptText.includes(w)) return true;
    // Allow partial match: prompt contains first 80% of keyword
    const prefixLen = Math.max(2, Math.floor(w.length * 0.8));
    const prefix = w.slice(0, prefixLen);
    return prefix.length >= 2 && promptText.includes(prefix);
  }).length;
  // Require at least 2 keyword matches, or 1 if the item only has 1 keyword
  const threshold = allKeywords.length === 1 ? 1 : 2;
  if (matchCount < threshold) return null;
  // Use loose classification for content-matched items
  const answer = classifyNaturalLanguageLoose(promptText);
  return answer ? { id: awaitingItem.id, answer } : null;
}

// Record natural-language replies. Returns { answers, hints }. Low confidence → hints only, not recorded.
// Extended with awaitingItems (ap:/fm:/ex:) and respond callback for non-kim-inbox items.
export function recordNaturalLanguageAnswers(home, sessionId, prompt, { listItems, answerItem, respond, awaitingItems } = {}) {
  if (!sessionId) return { answers: [], hints: [] };
  const state = readRelayState(home, sessionId), delivered = state.lastDelivered || [];

  const lines = prompt.trim().split(/\r?\n/).filter(Boolean);
  const answers = [];
  const hints = [];

  // --- Part 1: ki-* kim-inbox items (existing logic) ---
  if (delivered.length) {
    const items = listItems ? listItems(home) : [];
    const openAsks = delivered
      .map(d => items.find(i => i.id === d.id && i.kind === 'ask' && i.status === 'open' && revisionOf(i) === d.revision))
      .filter(Boolean);

    if (openAsks.length) {
      // Pattern 1: numbered natural language "1. 良い 2. OK 3. 不要"
      const numberedNatural = lines.map(line => {
        const m = line.trim().match(/^([1-9]\d*)\s*[.．、)）]\s*(.+)$/);
        if (!m) return null;
        const answer = classifyNaturalLanguage(m[2]);
        if (!answer) return null;
        return { number: parseInt(m[1]), answer };
      }).filter(Boolean);

      if (numberedNatural.length > 0) {
        let matched = 0;
        for (const nn of numberedNatural) {
          const receipt = delivered.find(d => d.number === nn.number);
          const item = receipt ? openAsks.find(i => i.id === receipt.id) : null;
          if (!item) continue;
          if (nn.answer === '否認' || nn.answer === '保留') continue;
          answers.push(answerItem(home, item.id, nn.answer, sessionId));
          matched++;
        }
        // Fallback: single numbered item with single pending ask, positive only
        if (matched === 0 && numberedNatural.length === 1 && openAsks.length === 1 && numberedNatural[0].answer === '可') {
          answers.push(answerItem(home, openAsks[0].id, numberedNatural[0].answer, sessionId));
        }
        // If ki-* matched, still check awaiting items below
      }

      // Pattern 2: whole prompt is a single reply "良いですよ" "OK" "進めて" (only if no ki-* match yet)
      if (!numberedNatural.length) {
        const promptAnswer = classifyNaturalLanguage(lines.join(' '));
        if (promptAnswer && openAsks.length === 1) {
          answers.push(answerItem(home, openAsks[0].id, promptAnswer, sessionId));
        } else if (promptAnswer && openAsks.length >= 2 && openAsks.length <= 3) {
          hints.push(`kim の返事が判断待ちの項目への回答のように見えます。「${promptAnswer}」として記録します（違えば訂正してください）。`);
        }
      }
    }
  }

  // --- Part 2: Awaiting items (ap:, fm:, ex:) ---
  // Skip awaiting handling if ki-* items were already answered (prioritize kim-inbox items)
  if (awaitingItems?.length && respond && !answers.length) {
    const awaitingApFm = awaitingItems.filter(ai => ai.id.startsWith('ap:') || ai.id.startsWith('fm:'));
    const awaitingEx = awaitingItems.filter(ai => ai.id.startsWith('ex:'));

    // Pattern 3: "全部OK" "全部進めて" → all ap/fm items
    const allAnswer = classifyNaturalLanguage(lines.join(' '));
    if (/^(?:全部|両方|すべて)/.test(lines.join(' ').trim()) && allAnswer && awaitingApFm.length >= 2) {
      for (const ai of awaitingApFm) {
        const bodyFile = writeTempAnswer(home, allAnswer);
        respond(ai.id, { home, bodyFile });
        answers.push(ai.id);
      }
      return { answers, hints };
    }

    // Pattern 4: Single awaiting item + single reply
    if (awaitingApFm.length === 1) {
      const promptAnswer = classifyNaturalLanguage(lines.join(' '));
      if (promptAnswer) {
        const ai = awaitingApFm[0];
        const bodyFile = writeTempAnswer(home, promptAnswer);
        respond(ai.id, { home, bodyFile });
        answers.push(ai.id);
        return { answers, hints };
      }
    }

    // Pattern 5: Content match by title/ask words
    for (const ai of awaitingApFm) {
      const match = matchAwaitingItemByContent(prompt, ai);
      if (match) {
        const bodyFile = writeTempAnswer(home, match.answer);
        respond(ai.id, { home, bodyFile });
        answers.push(ai.id);
      }
    }

    // Pattern 6: Low confidence for multiple awaiting items
    if (!answers.length && awaitingApFm.length >= 2 && awaitingApFm.length <= 3) {
      const promptAnswer = classifyNaturalLanguage(lines.join(' '));
      if (promptAnswer) {
        hints.push(`kim の返事が返事待ち項目（${awaitingApFm.map(ai => ai.title).join('、')}）への回答のように見えます。「${promptAnswer}」として記録します（違えば訂正してください）。`);
      }
    }
  }

  return { answers, hints };
}
