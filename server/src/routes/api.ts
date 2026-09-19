import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { db } from '../db/client.js';
import { sessionStore } from '../state/session-store.js';

export async function registerApiRoutes(fastify: FastifyInstance) {
  // --- Auth ---
  fastify.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body as any;
    const host = db.prepare('SELECT id, email, password_hash, display_name FROM hosts WHERE email = ?').get(email) as any;

    if (!host) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (hash !== host.password_hash) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    return {
      host: {
        id: host.id,
        email: host.email,
        displayName: host.display_name
      },
      token: host.id
    };
  });

  // --- Events ---
  fastify.get('/api/events', async () => {
    const events = db.prepare(`
      SELECT id, title, answer_mode, created_at FROM events ORDER BY created_at DESC
    `).all() as any[];

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

  fastify.get('/api/events/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const event = db.prepare('SELECT id, title, answer_mode, created_at FROM events WHERE id = ?').get(id) as any;
    if (!event) return reply.status(404).send({ error: 'Event not found' });

    const categories = db.prepare(`
      SELECT id, title, position FROM categories WHERE event_id = ? ORDER BY position ASC
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

  fastify.post('/api/events', async (req, reply) => {
    const { title, answerMode = 'ink' } = req.body as any;
    if (!title) return reply.status(400).send({ error: 'Title required' });

    const host = db.prepare('SELECT id FROM hosts LIMIT 1').get() as any;
    const eventId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO events (id, host_id, title, answer_mode, settings_json, created_at)
      VALUES (?, ?, ?, ?, '{}', ?)
    `).run(eventId, host.id, title, answerMode, Date.now());

    return { id: eventId, title };
  });

  // Add Category (enforces max 9)
  fastify.post('/api/events/:id/categories', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title } = req.body as any;

    const countRow = db.prepare('SELECT COUNT(*) as c FROM categories WHERE event_id = ?').get(id) as any;
    if (countRow.c >= 9) {
      return reply.status(400).send({ error: 'Maximum 9 categories reached' });
    }

    const catId = crypto.randomUUID();
    const position = countRow.c + 1;
    db.prepare('INSERT INTO categories (id, event_id, title, position) VALUES (?, ?, ?, ?)').run(catId, id, title || `Category ${position}`, position);

    return { id: catId, title, position };
  });

  // Add Question (enforces max 8 per cat)
  fastify.post('/api/categories/:id/questions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { prompt, correctAnswer, points = 1, timeLimitSeconds = 15, type = 'ink' } = req.body as any;

    const countRow = db.prepare('SELECT COUNT(*) as c FROM questions WHERE category_id = ?').get(id) as any;
    if (countRow.c >= 8) {
      return reply.status(400).send({ error: 'Maximum 8 questions per category reached' });
    }

    const qId = crypto.randomUUID();
    const position = countRow.c + 1;
    db.prepare(`
      INSERT INTO questions (id, category_id, type, prompt, correct_answer, points, time_limit_seconds, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(qId, id, type, prompt, correctAnswer, points, timeLimitSeconds, position);

    return { id: qId, prompt, position };
  });

  // --- Sessions ---
  fastify.post('/api/sessions', async (req, reply) => {
    const { eventId } = req.body as any;
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

  fastify.get('/api/sessions/live', async () => {
    const active = db.prepare("SELECT id, join_code, event_id FROM sessions WHERE status = 'live' ORDER BY started_at DESC LIMIT 1").get() as any;
    if (!active) return { session: null };

    const liveSession = sessionStore.getSessionById(active.id);
    return {
      session: liveSession ? liveSession.getSnapshot() : null
    };
  });
}
