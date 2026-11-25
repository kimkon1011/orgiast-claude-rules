import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectTranscript, inspectTranscriptRaw } from './fable-session-guard.mjs';
test('raw and file inspection agree and ignore synthetic latest responses',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fable-inspect-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const raw=[{message:{model:'claude-fable-5',usage:{output_tokens:12}}},{message:{model:'claude-sonnet-5'}},{message:{model:'<synthetic>'}}].map(JSON.stringify).join('\n')+'\nmalformed';
  const file=path.join(dir,'t.jsonl');fs.writeFileSync(file,raw);
  assert.deepEqual(inspectTranscript(file),inspectTranscriptRaw(raw));assert.deepEqual(inspectTranscriptRaw(raw),{currentModel:'claude-sonnet-5',fableResponses:1,fableOutputTokens:12});
});
