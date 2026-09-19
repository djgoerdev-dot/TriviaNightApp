import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { sessionStore } from '../state/session-store.js';
import { resolveHostToken } from '../auth/tokens.js';
import type { ClientMessage, ClientRole } from '@trivia/shared';

/** Commands only an authenticated host socket may run. */
const HOST_COMMANDS = new Set([
  'host.start',
  'host.next_phase',
  'host.prev_phase',
  'host.lock_question',
  'host.board_reveal_cards',
  'host.mark',
  'host.mark_all',
  'host.toggle_hide_card',
  'host.spotlight',
  'host.confirm_question',
  'host.adjust_score',
  'host.rename_team'
]);

export async function registerWebSocketRoutes(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true }, (socket: WebSocket, _req) => {
    let currentSessionId: string | null = null;
    let currentRole: ClientRole | null = null;
    let currentTeamId: string | undefined = undefined;

    const fail = (message: string, code?: string) => {
      try {
        socket.send(JSON.stringify({ type: 'error', payload: { message, code } }));
      } catch { /* socket already gone */ }
    };

    socket.on('close', () => sessionStore.unregisterClient(socket));

    socket.on('message', (raw: Buffer) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString('utf-8'));
        if (!msg || typeof msg.type !== 'string') return;

        // --- Authorization gate -------------------------------------------
        // Every host command requires a socket that authenticated with a real
        // host token. Without this check any contestant who joined could mark
        // their own card correct or drive the whole session.
        if (HOST_COMMANDS.has(msg.type) && currentRole !== 'host') {
          fail('That action requires the host console.', 'forbidden');
          return;
        }

        const session = currentSessionId ? sessionStore.getSessionById(currentSessionId) : undefined;

        switch (msg.type) {
          case 'screen.listen': {
            const s = sessionStore.getSessionByCode(msg.payload?.code);
            if (!s) {
              fail('No live session for that code.', 'not_found');
              return;
            }
            currentSessionId = s.sessionId;
            currentRole = 'screen';
            currentTeamId = undefined;
            sessionStore.registerClient(s.sessionId, socket, 'screen');
            break;
          }

          case 'host.auth': {
            const hostId = resolveHostToken(msg.payload?.token);
            if (!hostId) {
              fail('Host sign-in has expired. Please sign in again.', 'unauthorized');
              return;
            }
            const s = sessionStore.getSessionByCode(msg.payload?.code) ||
                      sessionStore.getSessionById(msg.payload?.code);
            if (!s) {
              fail('No live session for that code.', 'not_found');
              return;
            }
            currentSessionId = s.sessionId;
            currentRole = 'host';
            currentTeamId = undefined;
            sessionStore.registerClient(s.sessionId, socket, 'host');
            break;
          }

          case 'join': {
            const s = sessionStore.getSessionByCode(msg.payload?.code);
            if (!s) {
              fail('That 6-digit code does not match a live session.', 'not_found');
              return;
            }
            const name = String(msg.payload?.teamName || '').trim();
            if (!name) {
              fail('Please enter a team name.', 'bad_request');
              return;
            }

            const team = s.joinTeam(name, msg.payload?.deviceToken);
            currentSessionId = s.sessionId;
            currentRole = 'team';
            currentTeamId = team.id;

            sessionStore.registerClient(s.sessionId, socket, 'team', team.id);

            sessionStore.send(socket, {
              type: 'team.registered',
              payload: {
                teamId: team.id,
                teamName: team.name,
                teamPin: team.teamPin || '',
                deviceToken: msg.payload?.deviceToken || team.id
              }
            });
            break;
          }

          case 'rejoin': {
            const s = sessionStore.getSessionByCode(msg.payload?.code);
            if (!s) {
              fail('That 6-digit code does not match a live session.', 'not_found');
              return;
            }

            const deviceToken = msg.payload?.deviceToken || crypto.randomUUID();
            const team = s.rejoinTeam(
              String(msg.payload?.teamName || ''),
              String(msg.payload?.teamPin || ''),
              deviceToken
            );
            if (!team) {
              fail('That team name and PIN do not match.', 'unauthorized');
              return;
            }

            currentSessionId = s.sessionId;
            currentRole = 'team';
            currentTeamId = team.id;

            sessionStore.registerClient(s.sessionId, socket, 'team', team.id);

            sessionStore.send(socket, {
              type: 'team.registered',
              payload: {
                teamId: team.id,
                teamName: team.name,
                teamPin: team.teamPin || '',
                deviceToken
              }
            });
            break;
          }

          case 'answer.submit': {
            if (currentRole !== 'team' || !currentTeamId || !session) {
              fail('You are not registered in this session.', 'unauthorized');
              return;
            }

            const questionId = String(msg.payload?.questionId || '');
            const result = session.submitAnswer(
              currentTeamId,
              questionId,
              msg.payload?.ink,
              msg.payload?.text
            );

            // The phone waits on this before it shows "Answer locked".
            sessionStore.send(socket, {
              type: 'answer.ack',
              payload: {
                questionId,
                accepted: result.accepted,
                reason: result.reason
              }
            });
            break;
          }

          // --- Host commands (role already verified above) -----------------

          case 'host.start':
            session?.startLobbyToCategoryIntro();
            break;

          case 'host.next_phase':
            session?.nextPhase();
            break;

          case 'host.prev_phase':
            session?.prevPhase();
            break;

          case 'host.lock_question':
            // No-op unless a question is actually live; lockCurrentQuestion
            // guards the phase itself so a stray command cannot rewind a board.
            session?.lockCurrentQuestion();
            break;

          case 'host.board_reveal_cards':
            if (session?.phase === 'BOARD_ANSWER') session.nextPhase();
            break;

          case 'host.mark':
            session?.markAnswer(msg.payload.teamId, msg.payload.isCorrect);
            break;

          case 'host.mark_all':
            session?.markAll(msg.payload.mark);
            break;

          case 'host.toggle_hide_card':
            session?.toggleHideCard(msg.payload.teamId);
            break;

          case 'host.spotlight':
            session?.setSpotlight(msg.payload.teamId);
            break;

          case 'host.confirm_question':
            session?.nextPhase();
            break;

          case 'host.adjust_score':
            session?.adjustScore(msg.payload.teamId, msg.payload.deltaPoints, msg.payload.reason);
            break;

          case 'host.rename_team':
            session?.renameTeam(msg.payload.teamId, msg.payload.newName);
            break;

          default:
            break;
        }
      } catch (err: any) {
        // Never echo an internal error message back to an untrusted socket.
        console.error('[WS] Error processing message:', err);
        fail('That message could not be processed.', 'bad_request');
      }
    });
  });
}
