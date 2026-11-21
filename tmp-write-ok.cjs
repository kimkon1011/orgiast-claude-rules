const fs = require('fs');
const path = require('path');
const os = require('os');
const dir = path.join(os.homedir(), 'gb-offload', 'lane-doctor-work');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'WRITE_OK.txt'), 'WRITE_OK\n');
const got = fs.readFileSync(path.join(dir, 'WRITE_OK.txt'), 'utf8').trim();
console.log('WRITE_VERIFY=' + got);
console.log('MATCH=' + (got === 'WRITE_OK'));
