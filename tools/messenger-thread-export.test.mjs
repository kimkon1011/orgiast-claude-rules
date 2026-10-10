import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  threadUrl,
  defaultOutPath,
  normalizeText,
  stripAriaPrefix,
  extractTime,
  messageKey,
  parseMessageRows,
  dedupeMessages,
  mergeMessages,
  createScrollTracker,
  toJsonl,
  writeJsonl,
  formatSummary,
  DEFAULT_MAX_SCROLLS,
  STAGNANT_LIMIT,
  SAVE_EVERY_SCROLLS,
} from "./messenger-thread-export.mjs";

test("parseArgs: 既定値とオプションを解釈する", () => {
  assert.deepEqual(parseArgs(["123456"]), {
    threadId: "123456",
    maxScrolls: DEFAULT_MAX_SCROLLS,
    out: null,
    error: null,
  });
  assert.equal(parseArgs(["123456", "--max-scrolls", "10"]).maxScrolls, 10);
  assert.equal(parseArgs(["123456", "--max-scrolls=10"]).maxScrolls, 10);
  assert.equal(parseArgs(["123456", "--out", "x.jsonl"]).out, "x.jsonl");
  assert.equal(parseArgs(["123456", "--out=x.jsonl"]).out, "x.jsonl");
  assert.equal(parseArgs(["--max-scrolls", "5", "t_99"]).threadId, "t_99");
});

test("parseArgs: 不正な入力は error を返す", () => {
  assert.match(parseArgs([]).error, /スレッドID/);
  assert.match(parseArgs(["1", "2"]).error, /引数が多すぎます/);
  assert.match(parseArgs(["1", "--unknown"]).error, /不明なオプション/);
  assert.match(parseArgs(["1", "--max-scrolls", "0"]).error, /正の整数/);
  assert.match(parseArgs(["1", "--max-scrolls", "abc"]).error, /正の整数/);
  assert.match(parseArgs(["1", "--max-scrolls"]).error, /正の整数/);
  assert.match(parseArgs(["1", "--out"]).error, /--out/);
  assert.match(parseArgs(["../etc/passwd"]).error, /スレッドIDが不正/);
});

test("threadUrl / defaultOutPath", () => {
  assert.equal(threadUrl("1234567890"), "https://www.facebook.com/messages/t/1234567890/");
  assert.equal(threadUrl("t_99"), "https://www.facebook.com/messages/t/t_99/");
  assert.equal(
    defaultOutPath("C:/home", "123"),
    path.join("C:/home", ".claude", "messenger-export", "123.jsonl"),
  );
});

test("normalizeText / stripAriaPrefix / extractTime", () => {
  assert.equal(normalizeText("  a \n b  "), "a b");
  assert.equal(normalizeText(null), "");
  assert.equal(stripAriaPrefix("メッセージ: こんにちは"), "こんにちは");
  assert.equal(stripAriaPrefix("Message, hello"), "hello");
  assert.equal(stripAriaPrefix("こんにちは"), "こんにちは");
  assert.equal(extractTime("火曜日 12:34"), "12:34");
  assert.equal(extractTime("速報 昨日"), "昨日");
  assert.equal(extractTime("昨日会った"), "");
  assert.equal(extractTime(""), "");
});

test("messageKey: sender+text+time で決まり、要素が違えば変わる", () => {
  assert.equal(messageKey("A", "hi", "12:34"), messageKey("A", "hi", "12:34"));
  assert.notEqual(messageKey("A", "hi", "12:34"), messageKey("A", "hi", "12:35"));
  assert.notEqual(messageKey("A", "hi", "12:34"), messageKey("B", "hi", "12:34"));
});

test("parseMessageRows: 送信者を継承し、見出しと末尾の時刻を本文から外す", () => {
  const rows = [
    { sender: "ヤマサン", text: "ヤマサン 速報 12:34", time: "12:34", ariaLabel: "" },
    { sender: "", text: "追伸です", time: "12:35", ariaLabel: "" },
    { sender: "Bさん", text: "こんにちは", time: "12:36", ariaLabel: "" },
  ];
  assert.deepEqual(parseMessageRows(rows), [
    { key: messageKey("ヤマサン", "速報", "12:34"), sender: "ヤマサン", text: "速報", time: "12:34" },
    { key: messageKey("ヤマサン", "追伸です", "12:35"), sender: "ヤマサン", text: "追伸です", time: "12:35" },
    { key: messageKey("Bさん", "こんにちは", "12:36"), sender: "Bさん", text: "こんにちは", time: "12:36" },
  ]);
});

test("parseMessageRows: 本文が無い行は aria-label から作り、時刻は本文からも拾う", () => {
  const rows = [
    { sender: "A", text: "", time: "", ariaLabel: "メッセージ: 写真を送信しました" },
    { sender: "A", text: "A おはよう 昨日", time: "", ariaLabel: "" },
  ];
  assert.deepEqual(parseMessageRows(rows), [
    { key: messageKey("A", "写真を送信しました", ""), sender: "A", text: "写真を送信しました", time: "" },
    { key: messageKey("A", "おはよう", "昨日"), sender: "A", text: "おはよう", time: "昨日" },
  ]);
});

test("parseMessageRows: 重複を落とし、空入力は空配列", () => {
  const rows = [
    { sender: "A", text: "A 同じ", time: "1:00", ariaLabel: "" },
    { sender: "A", text: "A 同じ", time: "1:00", ariaLabel: "" },
  ];
  assert.equal(parseMessageRows(rows).length, 1);
  assert.deepEqual(parseMessageRows([]), []);
  assert.deepEqual(parseMessageRows(null), []);
  assert.deepEqual(parseMessageRows(undefined), []);
  assert.deepEqual(parseMessageRows([null, 1, "x", { sender: "", text: "", ariaLabel: "" }]), []);
});

test("dedupeMessages: キーで重複を落として順序を保つ", () => {
  const list = [
    { key: "a", text: "1" },
    { key: "b", text: "2" },
    { key: "a", text: "1" },
  ];
  assert.deepEqual(dedupeMessages(list).map((m) => m.key), ["a", "b"]);
  assert.deepEqual(dedupeMessages(null), []);
});

test("mergeMessages: 上に読み込んだ古いメッセージを先頭へ差し込む", () => {
  const base = [
    { key: "k1", text: "1" },
    { key: "k2", text: "2" },
  ];
  const snap = [
    { key: "n1", text: "0" },
    { key: "n2", text: "0.5" },
    { key: "k1", text: "1" },
    { key: "k2", text: "2" },
  ];
  assert.deepEqual(mergeMessages(base, snap).map((m) => m.key), ["n1", "n2", "k1", "k2"]);
});

test("mergeMessages: 重なりが無い/空のときの扱い", () => {
  const base = [{ key: "k1", text: "1" }];
  const fresh = [
    { key: "k2", text: "2" },
    { key: "k3", text: "3" },
  ];
  assert.deepEqual(mergeMessages(base, fresh).map((m) => m.key), ["k1", "k2", "k3"]);
  assert.deepEqual(mergeMessages([], fresh).map((m) => m.key), ["k2", "k3"]);
  assert.deepEqual(mergeMessages(base, []).map((m) => m.key), ["k1"]);
  assert.deepEqual(mergeMessages(null, null), []);
});

test("mergeMessages: 中間に抜けていたメッセージは正しい位置へ入る", () => {
  const base = [
    { key: "k1", text: "1" },
    { key: "k3", text: "3" },
  ];
  const snap = [
    { key: "k1", text: "1" },
    { key: "k2", text: "2" },
    { key: "k3", text: "3" },
  ];
  assert.deepEqual(mergeMessages(base, snap).map((m) => m.key), ["k1", "k2", "k3"]);
});

test("mergeMessages: 末尾側の新着はそのまま末尾へ", () => {
  const base = [{ key: "k1", text: "1" }];
  const snap = [
    { key: "k1", text: "1" },
    { key: "k9", text: "new" },
  ];
  assert.deepEqual(mergeMessages(base, snap).map((m) => m.key), ["k1", "k9"]);
});

test("createScrollTracker: 5回連続で増えなければ先頭到達とみなす", () => {
  const tracker = createScrollTracker({ maxScrolls: 100 });
  assert.equal(STAGNANT_LIMIT, 5);
  // 初回は 0→10 の増加として扱われるので、停滞5回はその後の5回。
  assert.equal(tracker.record(10).stop, false);
  for (let i = 0; i < STAGNANT_LIMIT - 1; i += 1) assert.equal(tracker.record(10).stop, false);
  const last = tracker.record(10);
  assert.equal(last.stop, true);
  assert.equal(last.reason, "top-reached");
  assert.equal(last.count, 10);
});

test("createScrollTracker: 件数が増えたら停滞カウントを戻す", () => {
  const tracker = createScrollTracker({ maxScrolls: 100 });
  tracker.record(10);
  for (let i = 0; i < STAGNANT_LIMIT - 1; i += 1) tracker.record(10);
  const grown = tracker.record(11);
  assert.equal(grown.stop, false);
  assert.equal(tracker.state.stagnant, 0);
});

test("createScrollTracker: max-scrolls で打ち切る", () => {
  const tracker = createScrollTracker({ maxScrolls: 2 });
  assert.equal(tracker.record(1).stop, false);
  const done = tracker.record(2);
  assert.equal(done.stop, true);
  assert.equal(done.reason, "max-scrolls");
  assert.equal(done.scrolls, 2);
});

test("toJsonl / formatSummary / writeJsonl", () => {
  const messages = [
    { key: "k1", sender: "A", text: "おはよう", time: "9:00" },
    { key: "k2", sender: "B", text: "hi", time: "9:01" },
  ];
  const lines = toJsonl(messages).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { time: "9:00", sender: "A", text: "おはよう", key: "k1" });
  assert.equal(toJsonl([]), "");
  assert.match(formatSummary(messages), /2件/);
  assert.match(formatSummary(messages), /先頭: 9:00/);
  assert.match(formatSummary(messages), /末尾: 9:01/);
  assert.match(formatSummary([]), /0件/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-export-io-"));
  const file = path.join(dir, "nested", "a.jsonl");
  writeJsonl(file, messages);
  assert.equal(fs.readFileSync(file, "utf8").trimEnd().split("\n").length, 2);
  writeJsonl(file, []);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("playwright-core を import せずにテストが走る（動的 import）", () => {
  const source = fs.readFileSync(new URL("./messenger-thread-export.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('await import("playwright-core")'));
  assert.ok(!/^import .*playwright-core/m.test(source));
  assert.ok(source.includes("headless: true"));
  assert.ok(SAVE_EVERY_SCROLLS === 50);
});

function makePage({ url = "https://www.facebook.com/messages/t/123/", rows = [], sources = [], passwordField = false } = {}) {
  return {
    goto: async () => {},
    url: () => url,
    evaluate: async (fn) => {
      const src = String(fn);
      sources.push(src);
      if (src.includes('input[type="password"]')) return passwordField;
      if (src.includes("scrollHeight")) return { scrolled: true, scrollHeight: 1000 };
      return rows;
    },
  };
}

test("main: スクロールのみで全件を JSONL に保存する", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-export-"));
  const sources = [];
  const rows = [
    { sender: "ヤマサン", text: "ヤマサン 速報 12:34", time: "12:34", ariaLabel: "" },
    { sender: "", text: "追伸です", time: "12:35", ariaLabel: "" },
  ];
  const page = makePage({ rows, sources });
  const launched = [];
  const fakeChromium = {
    launchPersistentContext: async (profileDir, options) => {
      launched.push({ profileDir, options });
      return { pages: () => [page], close: async () => {} };
    },
  };
  const out = [];
  const { main } = await import("./messenger-thread-export.mjs");
  const code = await main(["123", "--max-scrolls", "1"], {
    home,
    stdout: (line) => out.push(line),
    stderr: () => {},
    sleep: async () => {},
    random: () => 0,
    executablePath: "C:/fake/chrome.exe",
    chromium: fakeChromium,
  });

  assert.equal(code, 0);
  const file = path.join(home, ".claude", "messenger-export", "123.jsonl");
  const saved = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].sender, "ヤマサン");
  assert.equal(saved[0].text, "速報");
  assert.equal(saved[1].sender, "ヤマサン");
  assert.match(out.join("\n"), /2件/);
  assert.match(out.join("\n"), /1回スクロール/);

  // 同じプロファイルを headless で使う
  assert.equal(launched[0].profileDir, path.join(home, ".claude", "messenger-profile"));
  assert.equal(launched[0].options.headless, true);
  assert.equal(launched[0].options.executablePath, "C:/fake/chrome.exe");
  // 読み取りのみ: スクロールは scrollTop=0、キーボード操作の類は呼ばない
  assert.ok(sources.some((s) => s.includes("scrollTop = 0")));
  assert.ok(!/keyboard|press\(|click\(|type\(/.test(sources.join("\n")));
});

test("main: --out を指定するとそこへ書き、再実行で重複しない", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-export-"));
  const outFile = path.join(home, "custom.jsonl");
  const rows = [{ sender: "A", text: "A おはよう", time: "9:00", ariaLabel: "" }];
  const page = makePage({ rows });
  const fakeChromium = {
    launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }),
  };
  const { main } = await import("./messenger-thread-export.mjs");
  const deps = {
    home,
    stdout: () => {},
    stderr: () => {},
    sleep: async () => {},
    random: () => 0,
    executablePath: "C:/fake/chrome.exe",
    chromium: fakeChromium,
  };
  assert.equal(await main(["55", "--max-scrolls", "1", "--out", outFile], deps), 0);
  assert.equal(fs.readFileSync(outFile, "utf8").trimEnd().split("\n").length, 1);
  assert.equal(await main(["55", "--max-scrolls", "1", "--out", outFile], deps), 0);
  assert.equal(fs.readFileSync(outFile, "utf8").trimEnd().split("\n").length, 1);
});

test("main: ログインが切れていたら exit 2 でファイルを書かない", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-export-"));
  const page = makePage({ url: "https://www.facebook.com/login/", passwordField: true });
  const fakeChromium = {
    launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }),
  };
  const errors = [];
  const { main } = await import("./messenger-thread-export.mjs");
  const code = await main(["123"], {
    home,
    stdout: () => {},
    stderr: (line) => errors.push(line),
    sleep: async () => {},
    random: () => 0,
    executablePath: "C:/fake/chrome.exe",
    chromium: fakeChromium,
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /ログインが切れています/);
  assert.equal(fs.existsSync(path.join(home, ".claude", "messenger-export", "123.jsonl")), false);
});

test("main: 引数不正は exit 1", async () => {
  const errors = [];
  const { main } = await import("./messenger-thread-export.mjs");
  const code = await main([], { stdout: () => {}, stderr: (line) => errors.push(line) });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /スレッドID/);
});
