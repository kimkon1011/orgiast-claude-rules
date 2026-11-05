#!/usr/bin/env node
import { getDriveToken } from './lib/drive-auth.mjs';
const USER = 'seisaku-team@orgiast.jp';
const MSG_ID = '1a1613fb29adbbc2';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const token = await getDriveToken({ scope: SCOPE, impersonate: USER });
const url = `${API}/messages/${encodeURIComponent(MSG_ID)}?format=full`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const text = await res.text();
console.log('status:', res.status, 'size:', text.length);
const attMatch = text.matchAll(/"attachmentId"\s*:\s*"([^"]+)"/g);
const atts = [...attMatch].map(m => ({ attachmentId: m[1] }));
console.log('attachmentIds:', JSON.stringify(atts));
const fnMatch = text.matchAll(/"filename"\s*:\s*"([^"]+)"/g);
const fns = [...fnMatch].map(m => ({ filename: m[1] }));
console.log('filenames:', JSON.stringify(fns));