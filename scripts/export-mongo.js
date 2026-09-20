'use strict';
// Read-only export. The source database is never modified.
const { MongoClient } = require('mongodb');
const { writeFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node scripts/export-mongo.js OUTPUT.json');
  let uri = process.env.MONGO_URI;
  if (!uri && process.env.SOURCE_HEROKU_APP) {
    // Capture credentials in memory, never in terminal output or command arguments.
    const command = process.platform === 'win32' ? 'heroku.cmd' : 'heroku';
    const config = execFileSync(command, ['config', '--json', '-a', process.env.SOURCE_HEROKU_APP],
      { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    uri = JSON.parse(config).MONGO_URI;
  }
  if (!uri) throw new Error('Source MONGO_URI is unavailable');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  try {
    await client.connect();
    const output = { version: 1, exportedAt: new Date().toISOString(), databases: [] };
    const { databases } = await client.db().admin().listDatabases();
    for (const { name } of databases) {
      if (['admin', 'local', 'config'].includes(name)) continue;
      const cols = await client.db(name).listCollections({}, { nameOnly: true }).toArray();
      if (name !== 'SmartHomeMeta' && !cols.some(c => c.name === 'Devices')) continue;
      const collections = [];
      for (const col of cols) {
        collections.push({ name: col.name, documents: await client.db(name).collection(col.name).find().toArray() });
      }
      output.databases.push({ name, collections });
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify(output, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ exportedDatabases: output.databases.map(d => ({ name: d.name,
      collections: d.collections.map(c => ({ name: c.name, count: c.documents.length })) })) }, null, 2));
  } finally { await client.close(); }
}
main().catch(error => { console.error('Export failed:', error.name); process.exitCode = 1; });
