'use strict';
const { randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Run locally. No keys are embedded in source or printed to the console.
const dir = path.resolve(__dirname, '../../Migration/private');
mkdirSync(dir, { recursive: true });
const filename = path.join(dir, 'gateway-keys.json');
const keys = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8'))
  : { HUB_TOKEN: randomBytes(32).toString('hex'), APP_TOKEN: randomBytes(32).toString('hex') };
writeFileSync(filename, JSON.stringify(keys), { mode: 0o600 });
const gateway = 'https://smarthomehub-1aec4600a734.herokuapp.com';
writeFileSync(path.join(dir, 'hub.env'),
  `PORT=3000\nDATA_FILE=/home/khaled/smarthome/data/smarthome.sqlite\nGATEWAY_URL=${gateway}\nHUB_TOKEN=${keys.HUB_TOKEN}\n`, { mode: 0o600 });
writeFileSync(path.join(dir, 'android-connection.txt'),
  `SmartHome app > menu > Server connection\nGateway URL: ${gateway}\nGateway access key: ${keys.APP_TOKEN}\n\nDirect home Wi-Fi URL: http://192.168.178.89:3000\nThe key is only sent over HTTPS.\n`, { mode: 0o600 });
execFileSync(process.platform === 'win32' ? 'heroku.cmd' : 'heroku',
  ['config:set', `HUB_TOKEN=${keys.HUB_TOKEN}`, `APP_TOKEN=${keys.APP_TOKEN}`, '-a', 'smarthomehub'],
  { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
console.log('Gateway keys configured; private Pi environment and app connection details saved.');
