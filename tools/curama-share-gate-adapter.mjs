import { assertExternalLinks } from './share-before-send-gate.mjs';

// Await immediately before the send click. Inspect the actual textarea, not a stale body file.
// This adapter only reads and validates; it never clicks, posts or sends a message.
export async function assertCuramaLinks(page, dependencies) {
  const body = await page.locator('textarea[placeholder="メッセージを入力"]').inputValue();
  return assertExternalLinks(body, dependencies);
}
