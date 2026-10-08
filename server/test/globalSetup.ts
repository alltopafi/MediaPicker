import pg from 'pg';
import { adminUrl, TEST_DB_NAMES, testDatabaseUrl } from './helpers.js';

// Recreate the throwaway test databases fresh for every run.
export async function setup() {
  const url = new URL(testDatabaseUrl());
  const admin = new pg.Client({ connectionString: adminUrl(url) });
  await admin.connect();
  try {
    for (const name of TEST_DB_NAMES(url)) {
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.query(`create database "${name}"`);
    }
  } finally {
    await admin.end();
  }
}
