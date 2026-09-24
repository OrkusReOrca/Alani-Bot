// SQLite helpers shared by every database module.

// Adds a column to a table that already exists in production. Guarded by
// a column-existence check (a bare ALTER TABLE ADD COLUMN errors on the
// second run), so it stays safe to call on every startup. Rows that
// predate the column read back NULL for it.
export function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
