import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { db, verifyPassword, hashPassword, isLegacyHash } from '../db/client.js';
import { sessionStore } from '../state/session-store.js';
import { issueHostToken, resolveHostToken, revokeHostToken, bearerFrom } from '../auth/tokens.js';

export async function registerApiRoutes(fastify: FastifyInstance) {
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
      SELECT id, title, answer_mode, created_at FROM events WHERE host_id = ? ORDER BY created_at DESC
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
    return db.prepare('SELECT id, title, answer_mode, created_at FROM events WHERE id = ? AND host_id = ?')
      .get(eventId, hostId) as any;
  }

  fastify.get('/api/events/:id', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hostId = (req as any).hostId as string;

    const event = ownedEvent(id, hostId);
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

  fastify.post('/api/events', { preHandler: requireHost }, async (req, reply) => {
    const { title, answerMode = 'ink' } = (req.body || {}) as any;
    if (!title) return reply.status(400).send({ error: 'Title required' });

    const hostId = (req as any).hostId as string;
    const eventId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO events (id, host_id, title, answer_mode, settings_json, created_at)
      VALUES (?, ?, ?, ?, '{}', ?)
    `).run(eventId, hostId, title, answerMode === 'text' ? 'text' : 'ink', Date.now());

    return { id: eventId, title };
  });

  // Add Category (enforces max 9)
  fastify.post('/api/events/:id/categories', { preHandler: requireHost }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title } = (req.body || {}) as any;
    const hostId = (req as any).hostId as string;

    if (!ownedEvent(id, hostId)) return reply.status(404).send({ error: 'Event not found' });

    const countRow = db.prepare('SELECT COUNT(*) as c FROM categories WHERE event_id = ?').get(id) as any;
    if (countRow.c >= 9) {
      return reply.status(400).send({ error: 'Maximum 9 categories reached' });
    }

    const catId = crypto.randomUUID();
    const position = countRow.c + 1;
    const catTitle = String(title || `Category ${position}`).trim().slice(0, 60);
    db.prepare('INSERT INTO categories (id, event_id, title, position) VALUES (?, ?, ?, ?)').run(catId, id, catTitle, position);

    return { id: catId, title: catTitle, position };
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
    if (countRow.c >= 8) {
      return reply.status(400).send({ error: 'Maximum 8 questions per category reached' });
    }

    const qId = crypto.randomUUID();
    const position = countRow.c + 1;
    const safePoints = Math.min(Math.max(Math.trunc(Number(points) || 1), 1), 50);
    const safeSeconds = Math.min(Math.max(Math.trunc(Number(timeLimitSeconds) || 15), 5), 300);

    db.prepare(`
      INSERT INTO questions (id, category_id, type, prompt, correct_answer, points, time_limit_seconds, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(qId, id, type, String(prompt), String(correctAnswer), safePoints, safeSeconds, position);

    return { id: qId, prompt, position };
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
