import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { sessionStore } from '../state/session-store.js';
import type { ClientMessage } from '@trivia/shared';

export async function registerWebSocketRoutes(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    let currentSessionId: string | null = null;
    let currentRole: 'host' | 'screen' | 'team' = 'team';
    let currentTeamId: string | undefined = undefined;

    socket.on('message', (raw: Buffer) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString('utf-8'));

        switch (msg.type) {
          case 'screen.listen': {
            const session = sessionStore.getSessionByCode(msg.payload.code);
            if (!session) {
              socket.send(JSON.stringify({ type: 'error', payload: { message: 'Session not found for code ' + msg.payload.code } }));
              return;
            }
            currentSessionId = session.sessionId;
            currentRole = 'screen';
            sessionStore.registerClient(session.sessionId, socket, 'screen');
            break;
          }

          case 'join': {
            const session = sessionStore.getSessionByCode(msg.payload.code);
            if (!session) {
              socket.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid 6-digit session code' } }));
              return;
            }

            const team = session.joinTeam(msg.payload.teamName, msg.payload.deviceToken);
            currentSessionId = session.sessionId;
            currentRole = 'team';
            currentTeamId = team.id;

            sessionStore.registerClient(session.sessionId, socket, 'team', team.id);

            socket.send(JSON.stringify({
              type: 'team.registered',
              payload: {
                teamId: team.id,
                teamName: team.name,
                teamPin: team.teamPin,
                deviceToken: msg.payload.deviceToken || team.id
              }
            }));
            break;
          }

          case 'rejoin': {
            const session = sessionStore.getSessionByCode(msg.payload.code);
            if (!session) {
              socket.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid 6-digit session code' } }));
              return;
            }

            const deviceToken = msg.payload.deviceToken || Math.random().toString();
            const team = session.rejoinTeam(msg.payload.teamName, msg.payload.teamPin, deviceToken);
            if (!team) {
              socket.send(JSON.stringify({ type: 'error', payload: { message: 'Team name or 4-digit PIN does not match' } }));
              return;
            }

            currentSessionId = session.sessionId;
            currentRole = 'team';
            currentTeamId = team.id;

            sessionStore.registerClient(session.sessionId, socket, 'team', team.id);

            socket.send(JSON.stringify({
              type: 'team.registered',
              payload: {
                teamId: team.id,
                teamName: team.name,
                teamPin: team.teamPin,
                deviceToken
              }
            }));
            break;
          }

          case 'answer.submit': {
            if (!currentSessionId || !currentTeamId) {
              socket.send(JSON.stringify({ type: 'error', payload: { message: 'Not registered in an active session' } }));
              return;
            }
            const session = sessionStore.getSessionById(currentSessionId);
            if (!session) return;

            const accepted = session.submitAnswer(currentTeamId, msg.payload.ink, msg.payload.text);
            if (!accepted) {
              socket.send(JSON.stringify({ type: 'error', payload: { message: 'Answer submission was rejected (timer expired or locked)' } }));
            }
            break;
          }

          case 'host.auth': {
            // In Milestone 1, host provides session code or ID to manage
            const session = sessionStore.getSessionByCode(msg.payload.token) || sessionStore.getSessionById(msg.payload.token);
            if (!session) {
              socket.send(JSON.stringify({ type: 'error', payload: { message: 'Session not found for host token' } }));
              return;
            }
            currentSessionId = session.sessionId;
            currentRole = 'host';
            sessionStore.registerClient(session.sessionId, socket, 'host');
            break;
          }

          case 'host.start': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.startLobbyToCategoryIntro();
            break;
          }

          case 'host.next_phase': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.nextPhase();
            break;
          }

          case 'host.prev_phase': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.prevPhase();
            break;
          }

          case 'host.lock_question': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.lockCurrentQuestion();
            break;
          }

          case 'host.board_reveal_cards': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            if (session?.phase === 'BOARD_ANSWER') {
              session.nextPhase(); // enters BOARD_CARDS
            }
            break;
          }

          case 'host.mark': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.markAnswer(msg.payload.teamId, msg.payload.isCorrect);
            break;
          }

          case 'host.mark_all': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.markAll(msg.payload.mark);
            break;
          }

          case 'host.toggle_hide_card': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.toggleHideCard(msg.payload.teamId);
            break;
          }

          case 'host.spotlight': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.setSpotlight(msg.payload.teamId);
            break;
          }

          case 'host.adjust_score': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.adjustScore(msg.payload.teamId, msg.payload.deltaPoints, msg.payload.reason);
            break;
          }

          case 'host.rename_team': {
            if (!currentSessionId) return;
            const session = sessionStore.getSessionById(currentSessionId);
            session?.renameTeam(msg.payload.teamId, msg.payload.newName);
            break;
          }

          default:
            break;
        }
      } catch (err: any) {
        console.error('[WS] Error processing message:', err);
        socket.send(JSON.stringify({ type: 'error', payload: { message: err.message || 'Malformed message' } }));
      }
    });
  });
}
