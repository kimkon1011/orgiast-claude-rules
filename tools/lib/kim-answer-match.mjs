// Deterministic reply matching only. No LLM, execution, deletion or outbound calls.
export const visibleAnswerText = text => String(text || '').replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '')
  .split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n').trim();
const ID = /\b(?:ki-\d{14}-[a-f0-9]{4}|(?:ap|ex):[a-f0-9]{12}|fm:[\w-]+)\b/g;
export const numberedQuestions = text => [...visibleAnswerText(text).matchAll(/^\s*(?:[-*]\s*)?(\d+)[.．、)）]\s*(\S[^\n]*)/gm)]
  .map(m => ({ number: Number(m[1]), title: m[2], index: m.index }));

export function replyIntent(text) {
  if (!text || /[?？]|保留|わからない|分からない|かもしれ|たぶん|多分|なら|場合|例[:：]|という(?:返事|回答)|と言っ/.test(text)) return null;
  if (/不可|不要|否認|いいえ|良くない|よくない|だめ|ダメ|やめて|中止|(?:し|せ|入れ|進め|送ら|削除し)ない(?:で|こと|$)/.test(text)) return 'negative';
  if (/良い|よい|いいよ|入れる|入れて|入れよう|お願い|進めて|進める|やって|続けて|承認|賛成|完了|はい|(?:^|\W)OK(?:$|\W)|^可[。.!！]?$|して(?:ください|良い|よい|いい|$)/i.test(text)) return 'positive';
  return null;
}

// A receipt is eligible only when it occurs in the most recent final reply.
// A single unnumbered ask may contain several numbered questions; keep those separate.
export function presentedTargets(candidates, assistantText) {
  if (assistantText === undefined) return candidates.flatMap(c => {
    const questions = numberedQuestions(c.text || '');
    return questions.length > 1 ? questions.map(q => ({ ...c, ...q, part: q.number, parts: questions.map(q => q.number) })) : [c];
  });
  const text = visibleAnswerText(assistantText), questions = numberedQuestions(text);
  const present = candidates.filter(c => text.includes(c.id) || (c.title?.length >= 4 && text.includes(c.title)));
  return present.flatMap(c => {
    const direct = questions.filter(q => q.title.includes(c.id) || (c.title?.length >= 4 && q.title.includes(c.title)));
    if (direct.length === 1) return [{ ...c, number: direct[0].number }];
    // Never map subquestions from some other item to a bundled ask.
    if (present.length === 1 && questions.length > 1 && !direct.length) {
      return questions.map(q => ({ ...c, ...q, part: q.number, parts: questions.map(q => q.number) }));
    }
    return [{ ...c, number: null }];
  });
}

const subjectWords = title => String(title || '').split(/[\s:：、。・「」『』【】()（）／/]+|から|について|して|する|です|ます|[のをはがにとへ]/)
  .filter(word => [...word].length >= 3 && !/^(確認|判断|承認|返事|お願い|この件|この作業|ください|してよい|よいですか)/.test(word));
const keyOf = target => `${target.id}#${target.part || ''}`;

export function matchPromptAnswers(prompt, targets, { assistantText = '' } = {}) {
  const text = visibleAnswerText(prompt), matches = [], uncertain = [];
  // UserPromptSubmit also receives machine messages and pasted instructions.
  if (!text || text.length > 2000 || /^(?:Stop hook feedback:|<|\[headless:|例[:：]|#{1,6}\s)/.test(text)) return { matches, uncertain };
  const segments = text.replace(/(?:^|\s)(?=\d+\s*[.．)）]\s*\S)/g, '\n').split(/\r?\n|(?<=[。！!])\s*/).map(s => s.trim()).filter(Boolean);
  for (const segment of segments) {
    if (!replyIntent(segment)) continue;
    const ids = [...segment.matchAll(ID)].map(m => m[0]);
    const numbered = segment.match(/^(?:上の\s*)?(\d+(?:(?:\s*[・、と〜～-]\s*)\d+)*)\s*(?:まで)?\s*[.．:：)）]?\s*/);
    let refs = [];
    if (numbered && !ids.length) {
      const raw = numbered[1], nums = raw.match(/\d+/g).map(Number);
      if (/[〜～-]/.test(raw)) {
        if (nums.length !== 2 || nums[1] < nums[0] || nums[1] - nums[0] > 20) continue;
        refs = Array.from({ length: nums[1] - nums[0] + 1 }, (_, i) => nums[0] + i);
      } else refs = nums;
    }
    let selected = [];
    if (ids.length) {
      selected = targets.filter(t => ids.includes(t.id));
      // An ID alone does not answer every question in a bundled ask.
      if (selected.some(t => t.part)) { uncertain.push(...selected); continue; }
    } else if (refs.length) {
      selected = targets.filter(t => refs.includes(t.number));
      const scopes = refs.map(n => new Set(selected.filter(t => t.number === n).map(t => t.group || keyOf(t))));
      // A footer referring to another numbered proposal is a separate namespace.
      const shadow = String(assistantText).split(/\r?\n/).find(line => /次に kim がすること[:：]/.test(line) && /案.*\d+[・〜～].*(?:入れる|含め|のみ)/.test(line));
      if (shadow) { uncertain.push({ title: shadow.replace(/^.*?次に kim がすること[:：]\s*/, '').split(/[、。]/)[0] }); continue; }
      if (scopes.some(scope => scope.size !== 1)) { uncertain.push(...selected); continue; }
    } else {
      const named = targets.filter(t => subjectWords(t.title).some(word => segment.includes(word)));
      if (new Set(named.map(keyOf)).size === 1) selected = named;
      else if (named.length) { uncertain.push(...named); continue; }
      // Only a short, standalone reply can refer implicitly to one presented ask.
      else if (targets.length === 1 && text.length <= 80 && segments.length === 1) selected = targets;
      else if (targets.length) { uncertain.push(...targets); continue; }
    }
    if (!selected.length) continue;
    const answer = ids.length ? segment : numbered ? segment.slice(numbered[0].length).trim() : segment;
    if (!answer || !replyIntent(answer)) continue;
    for (const target of selected) matches.push({ target, answer });
  }
  // Conflicting answers to one target in the same prompt are never guessed.
  const conflicts = new Set(matches.filter(m => matches.some(other => keyOf(m.target) === keyOf(other.target) && m.answer !== other.answer)).map(m => keyOf(m.target)));
  uncertain.push(...matches.filter(m => conflicts.has(keyOf(m.target))).map(m => m.target));
  const seen = new Set();
  return { matches: matches.filter(m => !conflicts.has(keyOf(m.target)) && !seen.has(keyOf(m.target)) && seen.add(keyOf(m.target))), uncertain };
}

export function answerConfirmation(uncertain) {
  const titles = [...new Set(uncertain.map(t => String(t.title || t.summary || t.id).replace(/[\r\n]/g, ' ').slice(0, 100)))].slice(0, 3);
  return titles.length ? `次の応答に「この返事は「${titles.join('／')}」への回答として記録します（違えば言ってください）」と1行書く。照合の確信が低いため今回は台帳への確定記録を保留し、操作や再入力は求めない。` : '';
}
