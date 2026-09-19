import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  LiveSessionState,
  Submission,
  ServerMessage,
  ClientMessage,
  StrokeInk
} from '@trivia/shared';

interface UseSessionSocketOptions {
  role: 'host' | 'screen' | 'team';
  code?: string;
  hostToken?: string;
  autoConnect?: boolean;
}

export function useSessionSocket({
  role,
  code,
  hostToken,
  autoConnect = true
}: UseSessionSocketOptions) {
  const [sessionState, setSessionState] = useState<LiveSessionState | null>(null);
  const [boardCards, setBoardCards] = useState<Submission[]>([]);
  const [spotlightTeamId, setSpotlightTeamId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const registeredTeamRef = useRef<{ id: string; name: string; pin: string; token: string } | null>(null);

  const getWsUrl = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // In Vite dev proxy or production
    const host = window.location.host;
    return `${protocol}//${host}/ws`;
  };

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const socket = new WebSocket(getWsUrl());
      wsRef.current = socket;

      socket.onopen = () => {
        setIsConnected(true);
        setLastError(null);

        // Send role-specific handshake
        if (role === 'screen' && code) {
          socket.send(JSON.stringify({ type: 'screen.listen', payload: { code } }));
        } else if (role === 'host' && (hostToken || code)) {
          socket.send(JSON.stringify({ type: 'host.auth', payload: { token: hostToken || code } }));
        } else if (role === 'team' && registeredTeamRef.current && code) {
          // Re-associate on reconnect
          socket.send(JSON.stringify({
            type: 'rejoin',
            payload: {
              code,
              teamName: registeredTeamRef.current.name,
              teamPin: registeredTeamRef.current.pin,
              deviceToken: registeredTeamRef.current.token
            }
          }));
        }
      };

      socket.onmessage = (event) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);

          switch (msg.type) {
            case 'session.state':
              setSessionState(msg.payload);
              setSpotlightTeamId(msg.payload.spotlightTeamId || null);
              break;

            case 'board.cards':
              setBoardCards(msg.payload.submissions);
              break;

            case 'board.mark':
              setBoardCards(prev =>
                prev.map(card =>
                  card.teamId === msg.payload.teamId
                    ? { ...card, isCorrect: msg.payload.isCorrect }
                    : card
                )
              );
              break;

            case 'board.spotlight':
              setSpotlightTeamId(msg.payload.teamId);
              break;

            case 'team.registered':
              registeredTeamRef.current = {
                id: msg.payload.teamId,
                name: msg.payload.teamName,
                pin: msg.payload.teamPin,
                token: msg.payload.deviceToken
              };
              try {
                localStorage.setItem('trivia.deviceToken', msg.payload.deviceToken);
                localStorage.setItem('trivia.teamPin', msg.payload.teamPin);
                localStorage.setItem('trivia.teamName', msg.payload.teamName);
              } catch (_) {}
              break;

            case 'error':
              setLastError(msg.payload.message);
              break;

            default:
              break;
          }
        } catch (err) {
          console.error('[WS Hook] Malformed message', err);
        }
      };

      socket.onclose = () => {
        setIsConnected(false);
        // Automatic reconnect after 2 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 2000);
      };

      socket.onerror = () => {
        setIsConnected(false);
      };
    } catch (err: any) {
      setLastError(err.message || 'Connection failed');
    }
  }, [role, code, hostToken]);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [autoConnect, connect]);

  // Client actions
  const joinTeam = useCallback((joinCode: string, teamName: string, deviceToken?: string) => {
    send({
      type: 'join',
      payload: { code: joinCode, teamName, deviceToken }
    });
  }, [send]);

  const rejoinTeam = useCallback((joinCode: string, teamName: string, teamPin: string, deviceToken?: string) => {
    send({
      type: 'rejoin',
      payload: { code: joinCode, teamName, teamPin, deviceToken }
    });
  }, [send]);

  const submitAnswer = useCallback((questionId: string, ink?: StrokeInk, text?: string) => {
    send({
      type: 'answer.submit',
      payload: { questionId, ink, text }
    });
  }, [send]);

  // Host actions
  const hostStart = useCallback(() => send({ type: 'host.start' }), [send]);
  const hostNextPhase = useCallback(() => send({ type: 'host.next_phase' }), [send]);
  const hostPrevPhase = useCallback(() => send({ type: 'host.prev_phase' }), [send]);
  const hostLockQuestion = useCallback(() => send({ type: 'host.lock_question' }), [send]);
  const hostBoardRevealCards = useCallback(() => send({ type: 'host.board_reveal_cards' }), [send]);
  const hostMark = useCallback((teamId: string, isCorrect: boolean | null) => {
    send({ type: 'host.mark', payload: { teamId, isCorrect } });
  }, [send]);
  const hostMarkAll = useCallback((mark: 'correct' | 'wrong' | 'clear') => {
    send({ type: 'host.mark_all', payload: { mark } });
  }, [send]);
  const hostToggleHide = useCallback((teamId: string) => {
    send({ type: 'host.toggle_hide_card', payload: { teamId } });
  }, [send]);
  const hostSpotlight = useCallback((teamId: string | null) => {
    send({ type: 'host.spotlight', payload: { teamId } });
  }, [send]);
  const hostAdjustScore = useCallback((teamId: string, deltaPoints: number, reason: string) => {
    send({ type: 'host.adjust_score', payload: { teamId, deltaPoints, reason } });
  }, [send]);
  const hostRenameTeam = useCallback((teamId: string, newName: string) => {
    send({ type: 'host.rename_team', payload: { teamId, newName } });
  }, [send]);

  return {
    isConnected,
    sessionState,
    boardCards,
    spotlightTeamId,
    lastError,
    registeredTeam: registeredTeamRef.current,
    joinTeam,
    rejoinTeam,
    submitAnswer,
    hostStart,
    hostNextPhase,
    hostPrevPhase,
    hostLockQuestion,
    hostBoardRevealCards,
    hostMark,
    hostMarkAll,
    hostToggleHide,
    hostSpotlight,
    hostAdjustScore,
    hostRenameTeam,
    reconnect: connect
  };
}
