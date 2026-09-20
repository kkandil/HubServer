'use strict';
const { readFileSync, existsSync } = require('node:fs');
const { SQLiteClient } = require('../sqlite-store');

async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node scripts/import-snapshot.js SNAPSHOT.json NEW.sqlite');
  if (existsSync(destination)) throw new Error('Refusing to overwrite an existing database');
  const snapshot = JSON.parse(readFileSync(source, 'utf8'));
  if (snapshot.version !== 1 || !Array.isArray(snapshot.databases)) throw new Error('Invalid snapshot');
  const client = new SQLiteClient(destination);
  let maxId = 0, count = 0;
  try {
    for (const db of snapshot.databases) for (const col of db.collections) {
      await client.db(db.name).createCollection(col.name);
      for (const doc of col.documents) {
        if (col.name === 'Devices') {
          maxId = Math.max(maxId, Number(doc.id) || 0);
          doc.Status = 'Not_Connected';
        }
        await client.db(db.name).collection(col.name).insertOne(doc);
        count++;
      }
    }
    const counters = client.db('SmartHomeMeta').collection('Counters');
    const old = await counters.findOne({ _id: 'globalDeviceId' });
    await counters.findOneAndUpdate({ _id: 'globalDeviceId' }, { $set: { seq: Math.max(maxId, old?.seq || 0) } }, { upsert: true });
    console.log(`Imported ${count} documents; next device ID is above ${maxId}`);
  } finally { await client.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
