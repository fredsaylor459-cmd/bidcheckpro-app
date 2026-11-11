'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { isLocalPostgresUrl } = require('./database-url');

async function applyMigrations(connectionString) {
  if (!isLocalPostgresUrl(connectionString)) {
    throw new Error('Refusing to migrate a non-local database URL');
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const seen = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (seen.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

module.exports = { applyMigrations };
