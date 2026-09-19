import crypto from 'node:crypto';
import { db } from '../db/client.js';
import { LiveSession } from './session-machine.js';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '@trivia/shared';

export class SessionStore {
  private sessionsById = new Map<string, LiveSession>();
  private sessionsByCode = new Map<string, LiveSession>();

  // WebSocket connections: sessionId -> Set<{ ws: WebSocket, role: 'host' | 'screen' | 'team', teamId?: string }>
  private clients = new Map<string, Set<{ ws: WebSocket; role: 'host' | 'screen' | 'team'; teamId?: string }>>();

  constructor() {
    this.rehydrateLiveSessions();
  }

  public createSession(eventId: string): LiveSession {
    const eventRow = db.prepare('SELECT id, title FROM events WHERE id = ?').get(eventId) as { id: string; title: string } | undefined;
    if (!eventRow) {
      throw new Error(`Event not found: ${eventId}`);
    }

    const sessionId = crypto.randomUUID();
    let joinCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Ensure unique 6-digit code among live sessions
    while (this.sessionsByCode.has(joinCode)) {
      joinCode = Math.floor(100000 + Math.random() * 900000).toString();
    }

    const now = Date.now();
    db.prepare(`
      INSERT INTO sessions (id, event_id, join_code, status, phase, started_at)
      VALUES (?, ?, ?, 'live', 'LOBBY', ?)
    `).run(sessionId, eventId, joinCode, now);

    const session = new LiveSession(sessionId, eventId, eventRow.title, joinCode, {
      onStateChange: () => this.broadcastSessionState(sessionId),
      onBoardMark: (teamId, isCorrect) => this.broadcastBoardMark(sessionId, teamId, isCorrect),
      onSpotlight: (teamId) => this.broadcastSpotlight(sessionId, teamId)
    });

    this.sessionsById.set(sessionId, session);
    this.sessionsByCode.set(joinCode, session);

    return session;
  }

  public getSessionById(id: string): LiveSession | undefined {
    return this.sessionsById.get(id);
  }

  public getSessionByCode(code: string): LiveSession | undefined {
    return this.sessionsByCode.get(code.trim());
  }

  public registerClient(sessionId: string, ws: WebSocket, role: 'host' | 'screen' | 'team', teamId?: string) {
    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }

    const clientRecord = { ws, role, teamId };
    set.add(clientRecord);

    ws.on('close', () => {
      set?.delete(clientRecord);
      const session = this.sessionsById.get(sessionId);
      if (session && teamId) {
        const team = session.teams.get(teamId);
        if (team) {
          team.status = 'disconnected';
          session.onStateChange();
        }
      }
    });

    // Immediately send full snapshot to newly connected client
    const session = this.sessionsById.get(sessionId);
    if (session) {
      this.send(ws, { type: 'session.state', payload: session.getSnapshot() });

      // If in BOARD_CARDS or BOARD_ANSWER, send current board cards
      if (session.phase === 'BOARD_ANSWER' || session.phase === 'BOARD_CARDS') {
        const boardQ = session.currentBoardQuestion;
        if (boardQ) {
          this.send(ws, {
            type: 'board.cards',
            payload: { questionId: boardQ.id, submissions: session.getBoardCards() }
          });
        }
      }
    }
  }

  public broadcastSessionState(sessionId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    const snapshot = session.getSnapshot();
    const set = this.clients.get(sessionId);
    if (!set) return;

    const stateMsg: ServerMessage = { type: 'session.state', payload: snapshot };
    const json = JSON.stringify(stateMsg);

    // Also prepare board.cards if in board phases
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
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(json);
        if (boardCardsMsg && (client.role === 'host' || client.role === 'screen')) {
          client.ws.send(boardCardsMsg);
        }
      }
    }
  }

  public broadcastBoardMark(sessionId: string, teamId: string, isCorrect: boolean | null) {
    const set = this.clients.get(sessionId);
    if (!set) return;

    const msg: ServerMessage = { type: 'board.mark', payload: { teamId, isCorrect } };
    const json = JSON.stringify(msg);

    for (const client of set) {
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(json);
      }
    }
  }

  public broadcastSpotlight(sessionId: string, teamId: string | null) {
    const set = this.clients.get(sessionId);
    if (!set) return;

    const msg: ServerMessage = { type: 'board.spotlight', payload: { teamId } };
    const json = JSON.stringify(msg);

    for (const client of set) {
      if (client.ws.readyState === client.ws.OPEN && (client.role === 'screen' || client.role === 'host')) {
        client.ws.send(json);
      }
    }
  }

  public send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private rehydrateLiveSessions() {
    const rows = db.prepare("SELECT id, event_id, join_code FROM sessions WHERE status = 'live'").all() as {
      id: string;
      event_id: string;
      join_code: string;
    }[];

    for (const row of rows) {
      const eventRow = db.prepare('SELECT title FROM events WHERE id = ?').get(row.event_id) as { title: string } | undefined;
      if (eventRow) {
        const session = new LiveSession(row.id, row.event_id, eventRow.title, row.join_code, {
          onStateChange: () => this.broadcastSessionState(row.id),
          onBoardMark: (teamId, isCorrect) => this.broadcastBoardMark(row.id, teamId, isCorrect),
          onSpotlight: (teamId) => this.broadcastSpotlight(row.id, teamId)
        });

        // Rehydrate teams
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
          session.teamsByName.set(t.name.toLowerCase(), t.id);
        }

        // Rehydrate submissions
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

        session.recalculateScores();
        this.sessionsById.set(row.id, session);
        this.sessionsByCode.set(row.join_code, session);
        console.log(`[Rehydrate] Restored live session ${row.id} (${row.join_code}) with ${teamRows.length} teams.`);
      }
    }
  }
}

export const sessionStore = new SessionStore();
