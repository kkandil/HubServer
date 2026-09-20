'use strict';

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');

// The limited collection interface used by the existing server, backed by SQLite.
// No network database is needed. Values retain their original JSON types.
class SQLiteClient {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.sql = new DatabaseSync(filename);
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS collections (db TEXT, name TEXT, PRIMARY KEY(db,name));
      CREATE TABLE IF NOT EXISTS documents (
        row_id INTEGER PRIMARY KEY, db TEXT NOT NULL, collection TEXT NOT NULL, body TEXT NOT NULL,
        FOREIGN KEY(db,collection) REFERENCES collections(db,name) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS document_collection ON documents(db,collection);`);
  }
  async connect() {}
  async close() { this.sql.close(); }
  db(name = 'admin') {
    const sql = this.sql;
    return {
      command: async () => ({ ok: 1 }),
      admin: () => ({ listDatabases: async () => ({ databases: sql.prepare('SELECT DISTINCT db AS name FROM collections').all() }) }),
      createCollection: async col => {
        sql.prepare('INSERT INTO collections(db,name) VALUES(?,?)').run(name, col);
        return this.collection(name, col);
      },
      listCollections: (filter = {}) => ({ toArray: async () =>
        sql.prepare('SELECT name FROM collections WHERE db=?').all(name).filter(row => !filter.name || row.name === filter.name) }),
      collection: col => this.collection(name, col)
    };
  }
  collection(db, col) {
    const sql = this.sql;
    const ensure = () => sql.prepare('INSERT OR IGNORE INTO collections(db,name) VALUES(?,?)').run(db, col);
    const rows = (filter = {}) => sql.prepare('SELECT row_id,body FROM documents WHERE db=? AND collection=?').all(db, col)
      .map(row => ({ id: row.row_id, doc: JSON.parse(row.body) }))
      .filter(row => Object.entries(filter).every(([key, value]) => row.doc[key] === value));
    const insert = doc => {
      ensure();
      const saved = { ...doc, _id: doc._id ?? randomUUID() };
      sql.prepare('INSERT INTO documents(db,collection,body) VALUES(?,?,?)').run(db, col, JSON.stringify(saved));
      return saved;
    };
    const update = (filter, change, options = {}) => {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const row = rows(filter)[0];
        if (!row && !options.upsert) { sql.exec('COMMIT'); return null; }
        const doc = { ...(row ? row.doc : filter), ...(change.$set || {}) };
        for (const [key, value] of Object.entries(change.$inc || {})) doc[key] = (doc[key] || 0) + value;
        const saved = row ? doc : insert(doc);
        if (row) sql.prepare('UPDATE documents SET body=? WHERE row_id=?').run(JSON.stringify(doc), row.id);
        sql.exec('COMMIT');
        return saved;
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    };
    return {
      insertOne: async doc => ({ insertedId: insert(doc)._id }),
      findOne: async filter => rows(filter)[0]?.doc || null,
      find: (filter = {}, options = {}) => ({ toArray: async () => rows(filter).map(({ doc }) => {
        if (!options.projection) return doc;
        return Object.fromEntries(Object.entries(doc).filter(([key]) => options.projection[key] === 1));
      }) }),
      updateOne: async (filter, change) => ({ matchedCount: update(filter, change) ? 1 : 0 }),
      findOneAndUpdate: async (filter, change, options) => update(filter, change, options),
      deleteOne: async filter => {
        const row = rows(filter)[0];
        if (row) sql.prepare('DELETE FROM documents WHERE row_id=?').run(row.id);
        return { deletedCount: row ? 1 : 0 };
      },
      drop: async () => { sql.prepare('DELETE FROM collections WHERE db=? AND name=?').run(db, col); }
    };
  }
}
module.exports = { SQLiteClient };
