import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  LiveSessionState,
  Submission,
  ServerMessage,
  ClientMessage,
  ClientRole,
  StrokeInk
} from '@trivia/shared';

interface UseSessionSocketOptions {
  role: ClientRole;
  code?: string;
  hostToken?: string;
  autoConnect?: boolean;
}

export interface RegisteredTeam {
  id: string;
  name: string;
  pin: string;
  token: string;
}

export interface AnswerAck {
  questionId: string;
  accepted: boolean;
  reason?: string;
  at: number;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

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
  // State, not a ref: a component has to re-render when registration lands,
  // and the server-corrected team name arrives with it.
  const [registeredTeam, setRegisteredTeam] = useState<RegisteredTeam | null>(null);
  const [answerAck, setAnswerAck] = useState<AnswerAck | null>(null);
  const [isTakenOver, setIsTakenOver] = useState(false);
  const [takenOverMessage, setTakenOverMessage] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const closedByUsRef = useRef(false);
  const takenOverRef = useRef(false);

  // The handshake to (re)send whenever a socket opens. Holding it in a ref is
  // what keeps the connection independent of the code input: typing in the
  // join field no longer tears the socket down and rebuilds it per keystroke.
  const handshakeRef = useRef<ClientMessage | null>(null);

  // serverTime - Date.now(), so a phone with a skewed clock still counts down
  // against the server's idea of when the question closes.
  const clockOffsetRef = useRef(0);

  const getWsUrl = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  };

  const rawSend = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const connect = useCallback(() => {
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(getWsUrl());
    } catch (err: any) {
      setLastError(err?.message || 'Connection failed');
      return;
    }
    wsRef.current = socket;

    socket.onopen = () => {
      setIsConnected(true);
      setLastError(null);
      attemptsRef.current = 0;
      if (handshakeRef.current) socket.send(JSON.stringify(handshakeRef.current));
    };

    socket.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);

        switch (msg.type) {
          case 'session.state':
            clockOffsetRef.current = msg.payload.serverTime - Date.now();
            setSessionState(msg.payload);
            setSpotlightTeamId(msg.payload.spotlightTeamId || null);
            break;

          case 'board.cards':
            setBoardCards(msg.payload.submissions);
            break;

          case 'board.mark':
            setBoardCards(prev => prev.map(card =>
              card.teamId === msg.payload.teamId
                ? { ...card, isCorrect: msg.payload.isCorrect }
                : card
            ));
            break;

          case 'board.marks': {
            const byTeam = new Map(msg.payload.marks.map(m => [m.teamId, m.isCorrect]));
            setBoardCards(prev => prev.map(card =>
              byTeam.has(card.teamId)
                ? { ...card, isCorrect: byTeam.get(card.teamId)! }
                : card
            ));
            break;
          }

          case 'board.spotlight':
            setSpotlightTeamId(msg.payload.teamId);
            break;

          case 'answer.ack':
            setAnswerAck({ ...msg.payload, at: Date.now() });
            if (!msg.payload.accepted && msg.payload.reason) {
              setLastError(msg.payload.reason);
            }
            break;

          case 'team.registered': {
            const team: RegisteredTeam = {
              id: msg.payload.teamId,
              name: msg.payload.teamName,
              pin: msg.payload.teamPin,
              token: msg.payload.deviceToken
            };
            setRegisteredTeam(team);
            setLastError(null);

            // Reconnects go through rejoin, which is validated by name + PIN.
            handshakeRef.current = {
              type: 'rejoin',
              payload: {
                code: (handshakeRef.current?.payload as any)?.code || code || '',
                teamName: team.name,
                teamPin: team.pin,
                deviceToken: team.token
              }
            };

            try {
              localStorage.setItem('trivia.deviceToken', team.token);
              localStorage.setItem('trivia.teamPin', team.pin);
              localStorage.setItem('trivia.teamName', team.name);
            } catch { /* private mode */ }
            break;
          }

          case 'team.taken_over': {
            takenOverRef.current = true;
            setIsTakenOver(true);
            setTakenOverMessage(msg.payload.message);
            setRegisteredTeam(null);
            handshakeRef.current = null;
            try {
              localStorage.removeItem('trivia.deviceToken');
              localStorage.removeItem('trivia.teamPin');
              localStorage.removeItem('trivia.teamName');
            } catch { /* private mode */ }
            break;
          }

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

    socket.onclose = (event) => {
      setIsConnected(false);
      if (closedByUsRef.current || takenOverRef.current || event?.code === 4001) return;

      // Exponential backoff, so a server that is down is not hammered every 2s
      // by every phone in the room.
      const attempt = attemptsRef.current++;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
      const jittered = delay * (0.7 + Math.random() * 0.6);

      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(connect, jittered);
    };

    socket.onerror = () => setIsConnected(false);
  }, [code]);

  // The socket itself depends only on whether we should be connected at all.
  useEffect(() => {
    if (!autoConnect) return;
    closedByUsRef.current = false;
    connect();

    return () => {
      closedByUsRef.current = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);

  // Screen and host handshakes follow their props; a team's is set by joining.
  useEffect(() => {
    if (role === 'screen' && code) {
      handshakeRef.current = { type: 'screen.listen', payload: { code } };
      rawSend(handshakeRef.current);
    } else if (role === 'host' && hostToken && code) {
      handshakeRef.current = { type: 'host.auth', payload: { token: hostToken, code } };
      rawSend(handshakeRef.current);
    }
  }, [role, code, hostToken, rawSend, isConnected]);

  /** Server-corrected wall clock. */
  const serverNow = useCallback(() => Date.now() + clockOffsetRef.current, []);

  // --- Team actions ---
  const joinTeam = useCallback((joinCode: string, teamName: string, deviceToken?: string) => {
    handshakeRef.current = { type: 'join', payload: { code: joinCode, teamName, deviceToken } };
    rawSend(handshakeRef.current);
  }, [rawSend]);

  const rejoinTeam = useCallback((joinCode: string, teamName: string, teamPin: string, deviceToken?: string) => {
    handshakeRef.current = { type: 'rejoin', payload: { code: joinCode, teamName, teamPin, deviceToken } };
    rawSend(handshakeRef.current);
  }, [rawSend]);

  const submitAnswer = useCallback((questionId: string, ink?: StrokeInk, text?: string) => {
    return rawSend({ type: 'answer.submit', payload: { questionId, ink, text } });
  }, [rawSend]);

  const clearError = useCallback(() => setLastError(null), []);

  // --- Host actions ---
  const hostStart = useCallback(() => rawSend({ type: 'host.start' }), [rawSend]);
  const hostNextPhase = useCallback(() => rawSend({ type: 'host.next_phase' }), [rawSend]);
  const hostPrevPhase = useCallback(() => rawSend({ type: 'host.prev_phase' }), [rawSend]);
  const hostLockQuestion = useCallback(() => rawSend({ type: 'host.lock_question' }), [rawSend]);
  const hostBoardRevealCards = useCallback(() => rawSend({ type: 'host.board_reveal_cards' }), [rawSend]);
  const hostMark = useCallback((teamId: string, isCorrect: boolean | null) => {
    rawSend({ type: 'host.mark', payload: { teamId, isCorrect } });
  }, [rawSend]);
  const hostMarkAll = useCallback((mark: 'correct' | 'wrong' | 'clear') => {
    rawSend({ type: 'host.mark_all', payload: { mark } });
  }, [rawSend]);
  const hostToggleHide = useCallback((teamId: string) => {
    rawSend({ type: 'host.toggle_hide_card', payload: { teamId } });
  }, [rawSend]);
  const hostSpotlight = useCallback((teamId: string | null) => {
    rawSend({ type: 'host.spotlight', payload: { teamId } });
  }, [rawSend]);
  const hostAdjustScore = useCallback((teamId: string, deltaPoints: number, reason: string) => {
    rawSend({ type: 'host.adjust_score', payload: { teamId, deltaPoints, reason } });
  }, [rawSend]);
  const hostRenameTeam = useCallback((teamId: string, newName: string) => {
    rawSend({ type: 'host.rename_team', payload: { teamId, newName } });
  }, [rawSend]);

  const resetTakenOver = useCallback(() => {
    takenOverRef.current = false;
    setIsTakenOver(false);
    setTakenOverMessage(null);
  }, []);

  return {
    isConnected,
    sessionState,
    boardCards,
    spotlightTeamId,
    lastError,
    clearError,
    isTakenOver,
    takenOverMessage,
    resetTakenOver,
    registeredTeam,
    answerAck,
    serverNow,
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
