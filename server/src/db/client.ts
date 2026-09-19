import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '../../trivia.db');
export const db = new DatabaseSync(dbPath);

// Enable WAL mode for performance
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Run schema migrations
const schemaSql = fs.readFileSync(path.resolve(__dirname, 'schema.sql'), 'utf-8');
db.exec(schemaSql);

/**
 * `CREATE TABLE IF NOT EXISTS` never adds columns to a table that already
 * exists, so new columns need an explicit ALTER for databases created by an
 * earlier build.
 */
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`[DB] Migrated: added ${table}.${column}`);
  }
}

ensureColumn('sessions', 'current_category_index', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('sessions', 'current_question_index', 'INTEGER NOT NULL DEFAULT 0');

/**
 * Salted scrypt password hashing, stored as `scrypt$<salt hex>$<hash hex>`.
 * Bare 64-char hex values are legacy unsalted SHA-256 digests written by an
 * earlier build; `verifyPassword` still accepts them so existing hosts can log
 * in, and upgrades them in place on the next successful login.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    if (!stored.startsWith('scrypt$')) {
      // Legacy unsalted SHA-256.
      const legacy = crypto.createHash('sha256').update(password).digest('hex');
      return legacy.length === stored.length &&
        crypto.timingSafeEqual(Buffer.from(legacy, 'hex'), Buffer.from(stored, 'hex'));
    }
    const [, salt, expected] = stored.split('$');
    const derived = crypto.scryptSync(password, salt, 64);
    const expectedBuf = Buffer.from(expected, 'hex');
    return derived.length === expectedBuf.length && crypto.timingSafeEqual(derived, expectedBuf);
  } catch {
    return false;
  }
}

export function isLegacyHash(stored: string): boolean {
  return !stored.startsWith('scrypt$');
}

// Seed initial default host and sample event if empty
export function initDb() {
  const hostStmt = db.prepare('SELECT id FROM hosts LIMIT 1');
  const existingHost = hostStmt.get();

  if (!existingHost) {
    const hostId = crypto.randomUUID();
    // Seed password comes from HOST_PASSWORD when set, so a deployed server is
    // not standing on a published default.
    const seedPassword = process.env.HOST_PASSWORD || 'password123';
    const passwordHash = hashPassword(seedPassword);


    db.prepare(`
      INSERT INTO hosts (id, email, password_hash, display_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hostId, 'host@trivia.app', passwordHash, 'Trivia Master', Date.now());

    // Create sample event
    const eventId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, host_id, title, answer_mode, settings_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, hostId, 'NWTF Pub Trivia — Inaugural Night', 'ink', '{}', Date.now());

    // Category 1: Philippine History
    const cat1Id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO categories (id, event_id, title, position) VALUES (?, ?, ?, ?)
    `).run(cat1Id, eventId, 'Philippine History', 1);

    const q1 = [
      { prompt: 'Who was the first president of the Philippine Republic?', ans: 'Emilio Aguinaldo', pts: 2, t: 15 },
      { prompt: 'In which year did Ferdinand Magellan arrive in the Philippines?', ans: '1521', pts: 1, t: 15 },
      { prompt: 'What is the oldest city in the Philippines?', ans: 'Cebu City', pts: 1, t: 15 }
    ];

    q1.forEach((q, idx) => {
      db.prepare(`
        INSERT INTO questions (id, category_id, type, prompt, correct_answer, points, time_limit_seconds, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), cat1Id, 'ink', q.prompt, q.ans, q.pts, q.t, idx + 1);
    });

    // Category 2: World Geography
    const cat2Id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO categories (id, event_id, title, position) VALUES (?, ?, ?, ?)
    `).run(cat2Id, eventId, 'World Geography', 2);

    const q2 = [
      { prompt: 'What is the capital city of Australia?', ans: 'Canberra', pts: 1, t: 15 },
      { prompt: 'Which country has the longest coastline in the world?', ans: 'Canada', pts: 2, t: 15 },
      { prompt: 'Which river flows through the Grand Canyon?', ans: 'Colorado River', pts: 1, t: 15 }
    ];

    q2.forEach((q, idx) => {
      db.prepare(`
        INSERT INTO questions (id, category_id, type, prompt, correct_answer, points, time_limit_seconds, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), cat2Id, 'ink', q.prompt, q.ans, q.pts, q.t, idx + 1);
    });

    // Category 3: Science & Nature
    const cat3Id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO categories (id, event_id, title, position) VALUES (?, ?, ?, ?)
    `).run(cat3Id, eventId, 'Science & Nature', 3);

    const q3 = [
      { prompt: 'Which chemical element has the symbol Fe?', ans: 'Iron', pts: 1, t: 15 },
      { prompt: 'What is the hardest natural substance on Earth?', ans: 'Diamond', pts: 1, t: 15 },
      { prompt: 'How many planets in our solar system have rings?', ans: '4', pts: 2, t: 15 }
    ];

    q3.forEach((q, idx) => {
      db.prepare(`
        INSERT INTO questions (id, category_id, type, prompt, correct_answer, points, time_limit_seconds, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), cat3Id, 'ink', q.prompt, q.ans, q.pts, q.t, idx + 1);
    });

    console.log(
      '[DB] Seeded host host@trivia.app and a sample trivia event. Password comes from ' +
      (process.env.HOST_PASSWORD ? 'HOST_PASSWORD.' : 'the development default — set HOST_PASSWORD before deploying.')
    );
  }
}
