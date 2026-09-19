import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { db, verifyPassword, hashPassword, isLegacyHash } from '../db/client.js';
import { sessionStore } from '../state/session-store.js';
import { issueHostToken, resolveHostToken, revokeHostToken, bearerFrom } from '../auth/tokens.js';
import multipart from '@fastify/multipart';
import { parseWorkbook } from '../import/workbook.js';

export const MAX_CATEGORIES = 9;
export const MAX_QUESTIONS_PER_CATEGORY = 8;

const ACCEPTED_UPLOAD = /\.(xlsx|csv)$/i;

export async function registerApiRoutes(fastify: FastifyInstance) {
  // Spreadsheet upload. One modest file per request — this endpoint is
  // host-only, but an unbounded upload is still a free denial of service.
  await fastify.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 }
  });

  /**
   * Every route below the login endpoint is host-only. Authoring data carries
   * `correct_answer` for every question in the event, so an open read here
   * would hand the whole night's answers to anyone on the venue wifi.
   */
  const requireHost = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerFrom(req.headers.authorization);
    const hostId = resolveHostToken(token);
    if (!hostId) {
      return reply.status(401).send({ error: 'Host sign-in required' });
    }
    (req as any).hostId = hostId;
  };

  // --- Auth (public) ---
  fastify.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body || {}) as { email?: string; password?: string };
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const host = db.prepare('SELECT id, email, password_hash, display_name FROM hosts WHERE email = ?').get(email) as any;

    // Same response and roughly the same work either way, so the endpoint does
    // not reveal which addresses exist.
    if (!host || !verifyPassword(password, host.password_hash)) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    // Opportunistically upgrade legacy unsalted SHA-256 hashes.
    if (isLegacyHash(host.password_hash)) {
      try {
        db.prepare('UPDATE hosts SET password_hash = ? WHERE id = ?').run(hashPassword(password), host.id);
      } catch (err) {
        console.error('[Auth] Could not upgrade password hash:', err);
      }
    }

    const { token, expiresAt } = issueHostToken(host.id);
    return {
      host: { id: host.id, email: host.email, displayName: host.display_name },
      token,
      expiresAt
    };
  });

  fastify.post('/api/auth/logout', async (req) => {
    const token = bearerFrom(req.headers.authorization);
    if (token) revokeHostToken(token);
    return { ok: true };
  });

  fastify.get('/api/auth/me', { preHandler: requireHost }, async (req) => {
    const hostId = (req as any).hostId as string;
    const host = db.prepare('SELECT id, email, display_name FROM hosts WHERE id = ?').get(hostId) as any;
    return { host: host ? { id: host.id, email: host.email, displayName: host.display_name } : null };
  });

  // --- Events (host only) ---
  fastify.get('/api/events', { preHandler: requireHost }, async (req) => {
    const hostId = (req as any).hostId as string;
    const events = db.prepare(`
      SELECT id, title, event_date, location, answer_mode, created_at
      FROM events WHERE host_id = ? ORDER BY created_at DESC
    `).all(hostId) as any[];

    for (const ev of events) {
      const catCount = db.prepare('SELECT COUNT(*) as c FROM categories WHERE event_id = ?').get(ev.id) as any;
      const qCount = db.prepare(`
        SELECT COUNT(*) as c FROM questions q
        JOIN categories c ON q.category_id = c.id
        WHERE c.event_id = ?
      `).get(ev.id) as any;

      ev.categoryCount = catCount.c;
      ev.questionCount = qCount.c;
    }

    return { events };
  });

  /** Confirms an event belongs to the signed-in host. */
  function ownedEvent(eventId: string, hostId: string) {
    return db.prepare(
      'SELECT id, title, event_date, location, answer_mode, created_at FROM events WHERE id = ? AND host_id = ?'
    ).get(eventId, hostId) as any;
  }

  /** Confirms a category belongs to one of the signed-in host's events. */
  function ownedCategory(categoryId: string, hostId: string) {
    return db.prepare(`
      SELECT c.id, c.event_id, c.title, c.position, c.break_after, c.break_note
      FROM categories c JOIN events e ON c.event_id = e.id
      WHERE c.id = ? AND e.host_id = ?
    `).get(categoryId, hostId) as any;
  }

  /** Confirms a question belongs to one of the signed-in host's events. */
  function ownedQuestion(questionId: string, hostId: string) {
    return db.prepare(`
      SELECT q.id, q.category_id, q.prompt, q.correct_answer, q.points, q.time_limit_seconds, q.position
      FROM questions q
      JOIN categories c ON q.category_id = c.id
      JOIN events e ON c.event_id = e.id
      WHERE q.id = ? AND e.host_id = ?
    `).get(questionId, hostId) as any;
  }

  fastify.get('/api/events/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;

    const event = ownedEvent(id, hostId);
    if (!event) return reply.status(404).send({ error: 'Event not found' });

    const categories = db.prepare(`
      SELECT id, title, position, break_after, break_note
      FROM categories WHERE event_id = ? ORDER BY position ASC
    `).all(id) as any[];

    for (const cat of categories) {
      cat.questions = db.prepare(`
        SELECT id, type, prompt, options_json, correct_answer, points, time_limit_seconds, position
        FROM questions WHERE category_id = ? ORDER BY position ASC
      `).all(cat.id);
    }

    event.categories = categories;
    return { event };
  });

  const clampPoints = (v: unknown) => Math.min(Math.max(Math.trunc(Number(v) || 1), 1), 50);
  const clampSeconds = (v: unknown) => Math.min(Math.max(Math.trunc(Number(v) || 15), 5), 300);

  /** Trims to a maximum length, returning null for an empty result. */
  function text(value: unknown, max: number): string | null {
    const t = String(value ?? '').trim().slice(0, max);
    return t.length > 0 ? t : null;
  }

  fastify.post('/api/events', { preHandler: requireHost }, async (req, reply) => {
    const { title, eventDate, location, answerMode = 'ink' } = (req.body || {}) as any;

    const eventTitle = text(title, 120);
    if (!eventTitle) return reply.status(400).send({ error: 'Event name is required' });

    const hostId = (req as any).hostId as string;
    const eventId = crypto.randomUUID();

    // Date and location are informational — stored as given, never parsed or
    // acted on, so an odd format costs nothing.
    db.prepare(`
      INSERT INTO events (id, host_id, title, event_date, location, answer_mode, settings_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(
      eventId,
      hostId,
      eventTitle,
      text(eventDate, 40),
      text(location, 160),
      answerMode === 'text' ? 'text' : 'ink',
      Date.now()
    );

    return { id: eventId, title: eventTitle };
  });

  fastify.patch('/api/events/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;
    if (!ownedEvent(id, hostId)) return reply.status(404).send({ error: 'Event not found' });

    const body = (req.body || {}) as any;
    const sets: string[] = [];
    const values: any[] = [];

    if (body.title !== undefined) {
      const t = text(body.title, 120);
      if (!t) return reply.status(400).send({ error: 'Event name cannot be empty' });
      sets.push('title = ?'); values.push(t);
    }
    if (body.eventDate !== undefined) { sets.push('event_date = ?'); values.push(text(body.eventDate, 40)); }
    if (body.location !== undefined) { sets.push('location = ?'); values.push(text(body.location, 160)); }
    if (body.answerMode !== undefined) {
      sets.push('answer_mode = ?'); values.push(body.answerMode === 'text' ? 'text' : 'ink');
    }

    if (sets.length === 0) return reply.status(400).send({ error: 'Nothing to update' });

    values.push(id);
    db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return { event: ownedEvent(id, hostId) };
  });

  fastify.delete('/api/events/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;
    if (!ownedEvent(id, hostId)) return reply.status(404).send({ error: 'Event not found' });

    // An event that has been played holds sessions, teams and submissions;
    // deleting it would orphan a night's results.
    const played = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE event_id = ?').get(id) as any;
    if (played.c > 0) {
      return reply.status(400).send({
        error: 'This event has already been run, so its results would be lost. Duplicate it instead.'
      });
    }

    db.exec('BEGIN');
    try {
      db.prepare(`
        DELETE FROM questions WHERE category_id IN (SELECT id FROM categories WHERE event_id = ?)
      `).run(id);
      db.prepare('DELETE FROM categories WHERE event_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { ok: true };
  });

  // --- Categories ---

  /** Creates a category at the end of an event's running order. */
  function createCategory(eventId: string, title: string) {
    const countRow = db.prepare('SELECT COUNT(*) as c FROM categories WHERE event_id = ?').get(eventId) as any;
    if (countRow.c >= MAX_CATEGORIES) return null;

    const catId = crypto.randomUUID();
    const position = countRow.c + 1;
    const catTitle = String(title || `Category ${position}`).trim().slice(0, 60);
    db.prepare('INSERT INTO categories (id, event_id, title, position) VALUES (?, ?, ?, ?)')
      .run(catId, eventId, catTitle, position);
    return { id: catId, title: catTitle, position, break_after: 0, break_note: null };
  }

  fastify.post('/api/events/:id/categories', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title } = (req.body || {}) as any;
    const hostId = (req as any).hostId as string;

    if (!ownedEvent(id, hostId)) return reply.status(404).send({ error: 'Event not found' });

    const created = createCategory(id, title);
    if (!created) return reply.status(400).send({ error: `Maximum ${MAX_CATEGORIES} categories reached` });
    return created;
  });

  /**
   * Renames a category, or sets whether a break follows it. A break sits
   * between two categories: it runs once this category's scores have been
   * shown, and the host decides when to leave it.
   */
  fastify.patch('/api/categories/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;

    const cat = ownedCategory(id, hostId);
    if (!cat) return reply.status(404).send({ error: 'Category not found' });

    const body = (req.body || {}) as any;
    const sets: string[] = [];
    const values: any[] = [];

    if (body.title !== undefined) {
      const t = text(body.title, 60);
      if (!t) return reply.status(400).send({ error: 'Category name cannot be empty' });
      sets.push('title = ?'); values.push(t);
    }
    if (body.breakAfter !== undefined) {
      sets.push('break_after = ?'); values.push(body.breakAfter ? 1 : 0);
    }
    if (body.breakNote !== undefined) {
      sets.push('break_note = ?'); values.push(text(body.breakNote, 80));
    }

    if (sets.length === 0) return reply.status(400).send({ error: 'Nothing to update' });

    values.push(id);
    db.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return { category: ownedCategory(id, hostId) };
  });

  fastify.delete('/api/categories/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;

    const cat = ownedCategory(id, hostId);
    if (!cat) return reply.status(404).send({ error: 'Category not found' });

    const played = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE event_id = ?').get(cat.event_id) as any;
    if (played.c > 0) {
      return reply.status(400).send({
        error: 'This event has active or past sessions and cannot have categories deleted.'
      });
    }

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM questions WHERE category_id = ?').run(id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      // Close the gap so positions stay 1..n and the running order is stable.
      const rest = db.prepare('SELECT id FROM categories WHERE event_id = ? ORDER BY position ASC').all(cat.event_id) as any[];
      rest.forEach((c, idx) => {
        db.prepare('UPDATE categories SET position = ? WHERE id = ?').run(idx + 1, c.id);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { ok: true };
  });

  // Add Question (enforces max 8 per category)
  fastify.post('/api/categories/:id/questions', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { prompt, correctAnswer, points = 1, timeLimitSeconds = 15, type = 'ink' } = (req.body || {}) as any;
    const hostId = (req as any).hostId as string;

    const owns = db.prepare(`
      SELECT c.id FROM categories c JOIN events e ON c.event_id = e.id
      WHERE c.id = ? AND e.host_id = ?
    `).get(id, hostId) as any;
    if (!owns) return reply.status(404).send({ error: 'Category not found' });

    if (!prompt || !correctAnswer) {
      return reply.status(400).send({ error: 'Prompt and correct answer are required' });
    }

    const countRow = db.prepare('SELECT COUNT(*) as c FROM questions WHERE category_id = ?').get(id) as any;
    if (countRow.c >= MAX_QUESTIONS_PER_CATEGORY) {
      return reply.status(400).send({ error: `Maximum ${MAX_QUESTIONS_PER_CATEGORY} questions per category reached` });
    }

    const qId = crypto.randomUUID();
    const position = countRow.c + 1;

    db.prepare(`
      INSERT INTO questions (id, category_id, type, prompt, correct_answer, points, time_limit_seconds, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(qId, id, type, String(prompt), String(correctAnswer), clampPoints(points), clampSeconds(timeLimitSeconds), position);

    return { id: qId, prompt, position };
  });

  /** Edits a question in place - prompt, answer, points or timer. */
  fastify.patch('/api/questions/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;

    const question = ownedQuestion(id, hostId);
    if (!question) return reply.status(404).send({ error: 'Question not found' });

    const body = (req.body || {}) as any;
    const sets: string[] = [];
    const values: any[] = [];

    if (body.prompt !== undefined) {
      const t = text(body.prompt, 500);
      if (!t) return reply.status(400).send({ error: 'The question cannot be empty' });
      sets.push('prompt = ?'); values.push(t);
    }
    if (body.correctAnswer !== undefined) {
      const t = text(body.correctAnswer, 300);
      if (!t) return reply.status(400).send({ error: 'The answer cannot be empty' });
      sets.push('correct_answer = ?'); values.push(t);
    }
    if (body.points !== undefined) { sets.push('points = ?'); values.push(clampPoints(body.points)); }
    if (body.timeLimitSeconds !== undefined) { sets.push('time_limit_seconds = ?'); values.push(clampSeconds(body.timeLimitSeconds)); }

    if (sets.length === 0) return reply.status(400).send({ error: 'Nothing to update' });

    values.push(id);
    db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return { question: ownedQuestion(id, hostId) };
  });

  fastify.delete('/api/questions/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;

    const question = ownedQuestion(id, hostId);
    if (!question) return reply.status(404).send({ error: 'Question not found' });

    const eventRow = db.prepare('SELECT event_id FROM categories WHERE id = ?').get(question.category_id) as any;
    if (eventRow) {
      const played = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE event_id = ?').get(eventRow.event_id) as any;
      if (played.c > 0) {
        return reply.status(400).send({
          error: 'This event has active or past sessions and cannot have questions deleted.'
        });
      }
    }

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM questions WHERE id = ?').run(id);
      const rest = db.prepare('SELECT id FROM questions WHERE category_id = ? ORDER BY position ASC').all(question.category_id) as any[];
      rest.forEach((q, idx) => {
        db.prepare('UPDATE questions SET position = ? WHERE id = ?').run(idx + 1, q.id);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { ok: true };
  });

  // --- Spreadsheet import ---

  /**
   * Imports a category / question / answer / points spreadsheet into an event.
   *
   * `?mode=replace` clears the event's existing questions first (keeping the
   * categories, so their break settings survive a re-upload of a corrected
   * file); the default appends. Every row that cannot be used is reported back
   * with its row number rather than being dropped silently.
   */
  fastify.post('/api/events/:id/import', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;
    const mode = (req.query as any)?.mode === 'replace' ? 'replace' : 'append';

    if (!ownedEvent(id, hostId)) return reply.status(404).send({ error: 'Event not found' });

    if (mode === 'replace') {
      const played = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE event_id = ?').get(id) as any;
      if (played.c > 0) {
        return reply.status(400).send({
          error: 'This event has active or past sessions. Duplicate the event or use append mode instead of replacing questions.'
        });
      }
    }

    const upload = await (req as any).file();
    if (!upload) return reply.status(400).send({ error: 'No file was uploaded' });

    const filename = String(upload.filename || 'upload.xlsx');
    if (!ACCEPTED_UPLOAD.test(filename)) {
      return reply.status(400).send({ error: 'Please upload an .xlsx or .csv file' });
    }

    let buffer: Buffer;
    try {
      buffer = await upload.toBuffer();
    } catch {
      return reply.status(400).send({ error: 'That file is too large (5 MB maximum)' });
    }

    let parsed;
    try {
      parsed = await parseWorkbook(buffer, filename);
    } catch (err: any) {
      console.error('[Import] Could not read workbook:', err);
      return reply.status(400).send({ error: 'That file could not be read as a spreadsheet' });
    }

    if (parsed.rows.length === 0) {
      return reply.status(400).send({
        error: 'No usable rows were found in that file',
        problems: parsed.problems,
        headers: parsed.headers
      });
    }

    const skipped = [...parsed.problems];
    let categoriesCreated = 0;
    let questionsImported = 0;

    db.exec('BEGIN');
    try {
      if (mode === 'replace') {
        db.prepare(`
          DELETE FROM questions WHERE category_id IN (SELECT id FROM categories WHERE event_id = ?)
        `).run(id);
      }

      // Existing categories, keyed case-insensitively so "Movies" and "movies"
      // in the same file land in one category rather than two.
      const existing = db.prepare('SELECT id, title FROM categories WHERE event_id = ?').all(id) as any[];
      const byTitle = new Map<string, string>(existing.map(c => [String(c.title).trim().slice(0, 60).toLowerCase(), c.id]));

      const counts = new Map<string, number>();
      for (const cat of existing) {
        const row = db.prepare('SELECT COUNT(*) as c FROM questions WHERE category_id = ?').get(cat.id) as any;
        counts.set(cat.id, row.c);
      }

      const insertQuestion = db.prepare(`
        INSERT INTO questions (id, category_id, type, prompt, correct_answer, points, time_limit_seconds, position)
        VALUES (?, ?, 'ink', ?, ?, ?, 15, ?)
      `);

      for (const row of parsed.rows) {
        const key = row.category.trim().slice(0, 60).toLowerCase();
        let categoryId = byTitle.get(key);

        if (!categoryId) {
          const created = createCategory(id, row.category);
          if (!created) {
            skipped.push({
              rowNumber: row.rowNumber,
              reason: `Category "${row.category}" would exceed the ${MAX_CATEGORIES}-category limit.`
            });
            continue;
          }
          categoryId = created.id;
          byTitle.set(key, categoryId);
          counts.set(categoryId, 0);
          categoriesCreated++;
        }

        const used = counts.get(categoryId) ?? 0;
        if (used >= MAX_QUESTIONS_PER_CATEGORY) {
          skipped.push({
            rowNumber: row.rowNumber,
            reason: `"${row.category}" already has ${MAX_QUESTIONS_PER_CATEGORY} questions.`
          });
          continue;
        }

        insertQuestion.run(
          crypto.randomUUID(),
          categoryId,
          row.question.slice(0, 500),
          row.answer.slice(0, 300),
          clampPoints(row.points ?? 1),
          used + 1
        );
        counts.set(categoryId, used + 1);
        questionsImported++;
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('[Import] Failed:', err);
      return reply.status(500).send({ error: 'The import could not be saved' });
    }

    return {
      mode,
      filename,
      rowsRead: parsed.rows.length,
      categoriesCreated,
      questionsImported,
      skipped
    };
  });

  // --- Sessions (host only) ---
  fastify.post('/api/sessions', { preHandler: requireHost }, async (req, reply) => {
    const { eventId } = (req.body || {}) as any;
    const hostId = (req as any).hostId as string;

    if (!ownedEvent(eventId, hostId)) return reply.status(404).send({ error: 'Event not found' });

    try {
      const session = sessionStore.createSession(eventId);
      return {
        sessionId: session.sessionId,
        joinCode: session.joinCode,
        eventTitle: session.eventTitle
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/sessions/live', { preHandler: requireHost }, async (req) => {
    const hostId = (req as any).hostId as string;
    const active = db.prepare(`
      SELECT s.id FROM sessions s JOIN events e ON s.event_id = e.id
      WHERE s.status = 'live' AND e.host_id = ?
      ORDER BY s.started_at DESC LIMIT 1
    `).get(hostId) as any;

    if (!active) return { session: null };

    const liveSession = sessionStore.getSessionById(active.id);
    return { session: liveSession ? liveSession.getSnapshot('host') : null };
  });
}
