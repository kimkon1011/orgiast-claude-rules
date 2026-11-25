import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const base = new URL('./', import.meta.url);
const html = await readFile(new URL('index.html', base), 'utf8');
const css = await readFile(new URL('styles.css', base), 'utf8');
const js = await readFile(new URL('app.js', base), 'utf8');

test('page has semantic event sections and local assets only', () => {
  for (const id of ['overview', 'program', 'gallery', 'access', 'register']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<iframe/i);
});

test('responsive and reduced-motion styles are present', () => {
  assert.match(css, /@media\(max-width:850px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('menu and accessible form validation are implemented without network calls', () => {
  assert.match(js, /aria-expanded/);
  assert.match(js, /aria-invalid/);
  assert.match(js, /preventDefault\(\)/);
  assert.doesNotMatch(js, /fetch\s*\(|XMLHttpRequest|sendBeacon/);
});
