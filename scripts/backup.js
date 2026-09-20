'use strict';
const { DatabaseSync, backup } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
async function main() {
  const source = process.env.DATA_FILE;
  const destination = process.argv[2];
  if (!source || !destination) throw new Error('Set DATA_FILE and pass a new backup file path');
  mkdirSync(path.dirname(destination), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); console.log('Database backup saved'); }
  finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
