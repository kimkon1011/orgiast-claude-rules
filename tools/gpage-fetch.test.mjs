import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs, isLoginUrl, findChromium } from "./gpage-fetch.mjs";

test("parseArgs が URL のみを正しく取る", () => {
  const args = parseArgs(["https://example.com"]);
  assert.equal(args.url, "https://example.com");
  assert.equal(args.login, false);
  assert.equal(args.json, false);
  assert.equal(args.out, null);
  assert.equal(args.timeout, 60000);
});

test("parseArgs が --json --out path --timeout 1000 を正しく取る", () => {
  const args = parseArgs(["--json", "--out", "output.txt", "--timeout", "1000", "https://example.com"]);
  assert.equal(args.url, "https://example.com");
  assert.equal(args.json, true);
  assert.equal(args.out, "output.txt");
  assert.equal(args.timeout, 1000);
});

test("parseArgs が --login を真偽で取る", () => {
  const args = parseArgs(["--login"]);
  assert.equal(args.url, null);
  assert.equal(args.login, true);
  assert.equal(args.json, false);
  assert.equal(args.out, null);
  assert.equal(args.timeout, 60000);
});

test("isLoginUrl が accounts.google.com を true にする", () => {
  assert.equal(isLoginUrl("https://accounts.google.com/signin"), true);
  assert.equal(isLoginUrl("https://accounts.google.com/ServiceLogin?continue=..."), true);
});

test("isLoginUrl が sites.google.com を false にする", () => {
  assert.equal(isLoginUrl("https://sites.google.com/view/my-site"), false);
});

test("findChromium がスタブ化した readdirFn/existsFn で chromium- ディレクトリを名前降順に選ぶ", () => {
  const entries = [
    { name: "chromium-111", isDirectory: () => true },
    { name: "chromium-109", isDirectory: () => true },
    { name: "chromium-118", isDirectory: () => true },
    { name: "other", isDirectory: () => true },
  ];
  const readdirFn = () => entries;
  // Windows では path.join が \ 区切りになるため、期待値も path.join で組み立てる
  const want = path.join("/fake/base", "chromium-118", "chrome-win", "chrome.exe");
  const existsFn = (p) => p === want;
  const result = findChromium("/fake/base", readdirFn, existsFn);
  assert.equal(result, want);
});

test("findChromium が chrome-win64 配置(Playwright 1228 以降)も見つける", () => {
  const entries = [{ name: "chromium-1228", isDirectory: () => true }];
  const want = path.join("/base", "chromium-1228", "chrome-win64", "chrome.exe");
  const result = findChromium("/base", () => entries, (p) => p === want);
  assert.equal(result, want);
});
