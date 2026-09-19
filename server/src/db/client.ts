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

// Seed initial default host and sample event if empty
export function initDb() {
  const hostStmt = db.prepare('SELECT id FROM hosts LIMIT 1');
  const existingHost = hostStmt.get();

  if (!existingHost) {
    const hostId = crypto.randomUUID();
    // Default password 'password123'
    const passwordHash = crypto.createHash('sha256').update('password123').digest('hex');
    
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

    console.log('[DB] Seeded default host (host@trivia.app / password123) and sample trivia event.');
  }
}
