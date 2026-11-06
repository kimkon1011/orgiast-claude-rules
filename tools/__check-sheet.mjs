#!/usr/bin/env node
import { getDriveToken } from './lib/drive-auth.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const keyPath = join(homedir(), '.claude/keys/aujust-sheets-reader.json');

const token = await getDriveToken({
  keyPath,
  impersonate: 'seisaku-team@orgiast.jp',
  scope,
  fetchImpl: globalThis.fetch,
});

const sid = '1QCW86DIri6nryqheFKw8Cr6e9Ce0YRV6FvFFW0zqBnc';
const range = encodeURIComponent("'備品在庫管理表'!C3448:N3451");
const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sid + '/values/' + range, {
  headers: { Authorization: 'Bearer ' + token }
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));