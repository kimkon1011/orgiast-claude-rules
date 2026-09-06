import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readOwnerDiscordId } from '../packages/feedback-widget/install.mjs';

test('readOwnerDiscordId reads a valid Discord user ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-owner-'));
  const file = join(dir, 'id.txt');
  writeFileSync(file, '123456789012345678\n');
  assert.equal(readOwnerDiscordId(file), '123456789012345678');
});

test('readOwnerDiscordId returns empty when the file is missing', () => {
  assert.equal(readOwnerDiscordId(join(tmpdir(), 'missing-feedback-owner-id.txt')), '');
});

test('readOwnerDiscordId rejects an invalid Discord user ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-owner-'));
  const file = join(dir, 'id.txt');
  writeFileSync(file, 'not-a-discord-id\n');
  assert.equal(readOwnerDiscordId(file), '');
});

test('GAS relay template contains owner and submitter ID contract fields', async () => {
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
    new URL('../packages/feedback-gas/templates/FeedbackRelay.js', import.meta.url), 'utf8'));
  assert.match(source, /owner_discord_id/);
  assert.match(source, /FEEDBACK_OWNER_DISCORD_ID/);
  assert.match(source, /hasOwnerDiscordId/);
  assert.match(source, /submitter_discord_id/);
});
