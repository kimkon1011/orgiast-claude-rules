import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { journalHome, validId } from './prompt-journal.mjs';
import { findLostPrompts } from './lost-prompt-scan.mjs';

export async function hookMain(raw, { home = journalHome(), stdout = console.log } = {}) {
  try {
    const input = JSON.parse(raw);
    const event = input.hook_event_name;
    if (!['SessionStart', 'UserPromptSubmit'].includes(event) || !validId(input.session_id)) return;
    const lost = await findLostPrompts({
      home, sessionId: input.session_id, transcript: input.transcript_path,
      ...(event === 'SessionStart' ? { graceMs: 0 } : {}),
    });
    if (!lost.length) return;
    const additionalContext = [
      '以下はこのセッションで記録から欠落した kim の返答です。内容を確認して回答してください。実際に回答した項目ごとに、対応する prompt-journal-answered 行を回答の末尾に独立した行として記載してください。',
      ...lost.map(row => `kim の未達の返答: ${row.prompt}\nprompt-journal-answered: ${row.id}`),
    ].join('\n\n');
    stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
  } catch { /* Recovery must fail open. */ }
}

if (isEntry(import.meta.url)) {
  try { await hookMain(await readStdinWithTimeout()); } catch { /* fail open */ }
}
