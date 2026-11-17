import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignInPage, isInventoryPage, PROFILE_DIR } from './sellercentral-session.mjs';

for (const [name, url, hasPasswordInput, expected] of [
  ['Amazon sign-in redirect', 'https://www.amazon.co.jp/ap/signin', false, true],
  ['seller sign-in', 'https://sellercentral.amazon.co.jp/signin', false, true],
  ['case-insensitive sign-in', 'https://sellercentral.amazon.co.jp/AP/SIGNIN', false, true],
  ['password form without redirect', 'https://sellercentral.amazon.co.jp/', true, true],
  ['inventory with password form', 'https://sellercentral.amazon.co.jp/inventory', true, true],
  ['inventory without password form', 'https://sellercentral.amazon.co.jp/inventory', false, false],
  ['other page follows specified classification', 'https://sellercentral.amazon.co.jp/home', false, false],
]) {
  test(name, () => assert.equal(isSignInPage({ url, hasPasswordInput }), expected));
}

test('login completion accepts only Amazon inventory pages', () => {
  for (const url of [
    'https://sellercentral.amazon.co.jp/inventory',
    'https://sellercentral.amazon.co.jp/myinventory/inventory?fulfilledBy=all',
  ]) assert.equal(isInventoryPage(url), true);
  for (const url of [
    'https://sellercentral.amazon.co.jp/ap/signin?return_to=/inventory',
    'https://sellercentral.amazon.co.jp/inventory?signin=true',
    'https://example.com/inventory',
    'https://sellercentral.amazon.co.jp.example.com/inventory',
    'http://sellercentral.amazon.co.jp/inventory',
    'https://sellercentral.amazon.co.jp/inventory-other',
    'not a URL',
  ]) assert.equal(isInventoryPage(url), false);
});

test('profile is dedicated to TETSUKO', () => {
  assert.equal(PROFILE_DIR, String.raw`C:\Users\user\.claude\browser-profiles\sellercentral-tetsuko`);
});
