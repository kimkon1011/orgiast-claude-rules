import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { redactForShare } from './lib/share-secrets.mjs';

export const journalHome = () => process.env.ORGIAST_HOME || os.homedir();
export const journalDir = home => path.join(home, '.claude', 'prompt-journal');
export const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
export const promptText = text => redactForShare(text.replace(/\r\n/g, '\n'));
export const transcriptPath = (file, session) => typeof file === 'string' && path.isAbsolute(file)
  && path.basename(file) === session + '.jsonl' ? file : undefined;

export function journalPrompt(input, { home = journalHome(), now = new Date() } = {}) {
  const { session_id: session, prompt } = input;
  if (!validId(session) || typeof prompt !== 'string' || !prompt) return;
  try {
    if (resolveFleetLabel(home) !== 'kim-PC' && !isKimOperated(home)) return;
    const at = now.toISOString();
    const row = { id: randomUUID(), session_id: session, at, prompt: promptText(prompt),
      transcript_path: transcriptPath(input.transcript_path, session) };
    const dir = journalDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, at.slice(0, 10) + '.jsonl'), JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
    return row.id;
  } catch { /* Never interrupt prompt submission. */ }
}

const markerFile = (home, session, id, state) => path.join(journalDir(home), state, session, id);
export const hasJournalMarker = (home, session, id, state) => fs.existsSync(markerFile(home, session, id, state));

export function markJournal(home, session, id, state = 'handled') {
  if (!validId(session) || !validId(id)) return;
  try {
    const file = markerFile(home, session, id, state);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(file, 'a', 0o600));
  } catch { /* Retry recovery if its acknowledgement cannot be saved. */ }
}

export function acknowledgeRecovery(home, input) {
  if (!validId(input.session_id) || typeof input.last_assistant_message !== 'string'
    || !fs.existsSync(journalDir(home))) return;
  for (const match of input.last_assistant_message.matchAll(/^\s*prompt-journal-answered: ([a-f0-9-]{36})[\t ]*$/gim)) {
    markJournal(home, input.session_id, match[1]);
  }
}
