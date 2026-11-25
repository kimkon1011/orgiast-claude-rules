#!/usr/bin/env node
// 「このファイルが直接実行されたか」を、junction/symlink/大文字小文字の違いを跨いでも正しく判定する。
// 素の文字列比較(import.meta.url === argv[1])だと、Windows の ~/orgiast-claude-rules が
// Downloads へのジャンクションになっている環境で判定が外れ、CLI が無言で何もしない(実測 2026-08-19)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isEntry(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (target) => {
    try { return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target); } catch { return path.resolve(target); }
  };
  const normalize = (target) => (process.platform === 'win32' ? real(target).toLowerCase() : real(target));
  try { return normalize(fileURLToPath(importMetaUrl)) === normalize(entry); } catch { return false; }
}
