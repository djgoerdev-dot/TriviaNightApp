import crypto from 'node:crypto';
import { db } from '../db/client.js';
import { LiveSession } from './session-machine.js';
import type { WebSocket } from 'ws';
import type { ClientRole, ServerMessage } from '@trivia/shared';

interface ClientRecord {
  ws: WebSocket;
  role: ClientRole;
  teamId?: string;
}

export class SessionStore {
  private sessionsById = new Map<string, LiveSession>();
  private sessionsByCode = new Map<string, LiveSession>();

  private clients = new Map<string, Set<ClientRecord>>();
  // Lets a socket be re-registered (or torn down) without leaking its old record.
  private recordsBySocket = new Map<WebSocket, { sessionId: string; record: ClientRecord }>();

  constructor() {
    this.rehydrateLiveSessions();
  }

  public createSession(eventId: string): LiveSession {
    const eventRow = db.prepare('SELECT id, title FROM events WHERE id = ?').get(eventId) as { id: string; title: string } | undefined;
    if (!eventRow) {
      throw new Error(`Event not found: ${eventId}`);
    }

    const sessionId = crypto.randomUUID();
    let joinCode = crypto.randomInt(100000, 1000000).toString();

    // Ensure unique 6-digit code among known sessions
    while (this.sessionsByCode.has(joinCode)) {
      joinCode = crypto.randomInt(100000, 1000000).toString();
    }

    const now = Date.now();
    db.prepare(`
      INSERT INTO sessions (id, event_id, join_code, status, phase, started_at)
      VALUES (?, ?, ?, 'live', 'LOBBY', ?)
    `).run(sessionId, eventId, joinCode, now);

    const session = new LiveSession(sessionId, eventId, eventRow.title, joinCode, this.callbacksFor(sessionId));

    this.sessionsById.set(sessionId, session);
    this.sessionsByCode.set(joinCode, session);

    return session;
  }

  private callbacksFor(sessionId: string) {
    return {
      onStateChange: () => this.broadcastSessionState(sessionId),
      onBoardMark: (teamId: string, isCorrect: boolean | null) =>
        this.broadcast(sessionId, { type: 'board.mark', payload: { teamId, isCorrect } }),
      onBoardMarks: (marks: { teamId: string; isCorrect: boolean | null }[]) =>
        this.broadcast(sessionId, { type: 'board.marks', payload: { marks } }),
      onSpotlight: (teamId: string | null) =>
        this.broadcast(sessionId, { type: 'board.spotlight', payload: { teamId } }, ['host', 'screen'])
    };
  }

  public getSessionById(id: string): LiveSession | undefined {
    return this.sessionsById.get(id);
  }

  public getSessionByCode(code: string): LiveSession | undefined {
    return this.sessionsByCode.get(String(code || '').trim());
  }

  /** Drops any registration this socket already held. */
  public unregisterClient(ws: WebSocket) {
    const existing = this.recordsBySocket.get(ws);
    if (!existing) return;

    this.clients.get(existing.sessionId)?.delete(existing.record);
    this.recordsBySocket.delete(ws);

    const { sessionId, record } = existing;
    if (record.teamId) this.markTeamPresence(sessionId, record.teamId);
  }

  public registerClient(sessionId: string, ws: WebSocket, role: ClientRole, teamId?: string) {
    // A socket that hands over a second handshake replaces its first one,
    // rather than accumulating records and receiving every frame twice.
    this.unregisterClient(ws);

    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }

    const record: ClientRecord = { ws, role, teamId };
    set.add(record);
    this.recordsBySocket.set(ws, { sessionId, record });

    if (teamId) this.markTeamPresence(sessionId, teamId);

    ws.on('close', () => this.unregisterClient(ws));

    // Immediately send a full snapshot to the newly connected client.
    const session = this.sessionsById.get(sessionId);
    if (session) {
      this.send(ws, { type: 'session.state', payload: session.getSnapshot(role) });

      if (session.phase === 'BOARD_ANSWER' || session.phase === 'BOARD_CARDS') {
        const boardQ = session.currentBoardQuestion;
        if (boardQ) {
          if (role === 'host' || role === 'screen') {
            this.send(ws, {
              type: 'board.cards',
              payload: { questionId: boardQ.id, submissions: session.getBoardCards() }
            });
          } else if (role === 'team' && teamId) {
            const mySub = session.getTeamSubmission(boardQ.id, teamId);
            if (mySub) {
              this.send(ws, {
                type: 'board.cards',
                payload: { questionId: boardQ.id, submissions: [mySub] }
              });
            }
          }
        }
      }
    }
  }

  /** A team is connected while it holds at least one open socket. */
  private markTeamPresence(sessionId: string, teamId: string) {
    const session = this.sessionsById.get(sessionId);
    const team = session?.teams.get(teamId);
    if (!session || !team) return;

    let stillOpen = false;
    for (const client of this.clients.get(sessionId) ?? []) {
      if (client.teamId === teamId && client.ws.readyState === client.ws.OPEN) {
        stillOpen = true;
        break;
      }
    }

    const next = stillOpen ? 'connected' : 'disconnected';
    if (team.status !== next) {
      team.status = next;
      this.broadcastSessionState(sessionId);
    }
  }

  public broadcastSessionState(sessionId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const set = this.clients.get(sessionId);
    if (!set || set.size === 0) return;

    // One snapshot per role — a team's copy carries neither the correct
    // answer nor anybody's takeover PIN.
    const byRole: Record<ClientRole, string> = {
      host: JSON.stringify({ type: 'session.state', payload: session.getSnapshot('host') }),
      screen: JSON.stringify({ type: 'session.state', payload: session.getSnapshot('screen') }),
      team: JSON.stringify({ type: 'session.state', payload: session.getSnapshot('team') })
    };

    let boardCardsMsg: string | null = null;
    if (session.phase === 'BOARD_ANSWER' || session.phase === 'BOARD_CARDS') {
      const boardQ = session.currentBoardQuestion;
      if (boardQ) {
        boardCardsMsg = JSON.stringify({
          type: 'board.cards',
          payload: { questionId: boardQ.id, submissions: session.getBoardCards() }
        });
      }
    }

    for (const client of set) {
      if (client.ws.readyState !== client.ws.OPEN) continue;
      client.ws.send(byRole[client.role]);
      if (session.phase === 'BOARD_ANSWER' || session.phase === 'BOARD_CARDS') {
        const boardQ = session.currentBoardQuestion;
        if (boardQ) {
          if (boardCardsMsg && (client.role === 'host' || client.role === 'screen')) {
            client.ws.send(boardCardsMsg);
          } else if (client.role === 'team' && client.teamId) {
            const mySub = session.getTeamSubmission(boardQ.id, client.teamId);
            if (mySub) {
              client.ws.send(JSON.stringify({
                type: 'board.cards',
                payload: { questionId: boardQ.id, submissions: [mySub] }
              }));
            }
          }
        }
      }
    }
  }

  public broadcast(sessionId: string, msg: ServerMessage, roles?: ClientRole[]) {
    const set = this.clients.get(sessionId);
    if (!set) return;

    const json = JSON.stringify(msg);
    for (const client of set) {
      if (client.ws.readyState !== client.ws.OPEN) continue;
      if (roles && !roles.includes(client.role)) continue;
      client.ws.send(json);
    }
  }

  public send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private rehydrateLiveSessions() {
    const rows = db.prepare(`
      SELECT id, event_id, join_code, status, phase,
             current_category_index, current_question_index
      FROM sessions WHERE status = 'live'
    `).all() as any[];

    for (const row of rows) {
      const eventRow = db.prepare('SELECT title FROM events WHERE id = ?').get(row.event_id) as { title: string } | undefined;
      if (!eventRow) continue;

      const session = new LiveSession(row.id, row.event_id, eventRow.title, row.join_code, this.callbacksFor(row.id));

      // Teams
      const teamRows = db.prepare('SELECT id, name, device_token, team_pin, answer_mode, status, joined_at FROM teams WHERE session_id = ?').all(row.id) as any[];
      for (const t of teamRows) {
        session.teams.set(t.id, {
          id: t.id,
          sessionId: row.id,
          name: t.name,
          teamPin: t.team_pin,
          answerMode: t.answer_mode,
          status: 'disconnected',
          score: 0,
          joinedAt: t.joined_at
        });
        session.teamsByToken.set(t.device_token, t.id);
        session.teamsByName.set(String(t.name).toLowerCase(), t.id);
      }

      // Submissions
      const subRows = db.prepare('SELECT id, question_id, team_id, answer_ink, answer_raw, submitted_at, is_correct, is_hidden FROM submissions WHERE session_id = ?').all(row.id) as any[];
      for (const s of subRows) {
        let qSubs = session.submissions.get(s.question_id);
        if (!qSubs) {
          qSubs = new Map();
          session.submissions.set(s.question_id, qSubs);
        }
        const team = session.teams.get(s.team_id);
        qSubs.set(s.team_id, {
          id: s.id,
          sessionId: row.id,
          questionId: s.question_id,
          teamId: s.team_id,
          teamName: team?.name || 'Unknown',
          answerInk: s.answer_ink ? JSON.parse(s.answer_ink) : null,
          answerRaw: s.answer_raw,
          submittedAt: s.submitted_at,
          isCorrect: s.is_correct === null ? null : (s.is_correct === 1),
          isHidden: s.is_hidden === 1
        });
      }

      // Manual score adjustments — the ledger, without which every host
      // correction made before the restart would silently vanish.
      const eventRows = db.prepare('SELECT id, team_id, points, reason FROM score_events WHERE session_id = ? ORDER BY created_at ASC').all(row.id) as any[];
      for (const ev of eventRows) {
        session.scoreEvents.push({ id: ev.id, teamId: ev.team_id, points: ev.points, reason: ev.reason });
      }

      // Where the night had actually got to.
      session.restoreProgress(row);
      session.recalculateScores();

      this.sessionsById.set(row.id, session);
      this.sessionsByCode.set(row.join_code, session);
      console.log(
        `[Rehydrate] Restored session ${row.join_code} at ${session.phase} ` +
        `(category ${session.currentCategoryIndex + 1}, question ${session.currentQuestionIndex + 1}) ` +
        `with ${teamRows.length} teams and ${eventRows.length} score events.`
      );
    }
  }
}

export const sessionStore = new SessionStore();
