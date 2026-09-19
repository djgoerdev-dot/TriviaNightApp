import React, { useState, useEffect } from 'react';
import { useSessionSocket } from '../hooks/useSessionSocket';
import { InkSvg } from '../components/ink/InkSvg';
import {
  Play,
  Check,
  X,
  Lock,
  Eye,
  EyeOff,
  Maximize2,
  ExternalLink,
  Plus,
  KeyRound,
  Sliders,
  ChevronRight
} from 'lucide-react';

// A, Z and C are reserved for mark-all-correct / mark-all-wrong / clear, so
// they must not also be card shortcuts — pressing the key printed on a card
// used to sweep the entire board instead of toggling that one answer.
const SHORTCUT_KEYS = '123456789QWERTYUIOPSDFGHJKLXVBNM'.split('');
const RESERVED_KEYS = new Set(['A', 'Z', 'C', 'ENTER']);

export const HostRoute: React.FC = () => {
  const [hostToken, setHostToken] = useState<string>(() => {
    try { return localStorage.getItem('trivia.hostToken') || ''; } catch { return ''; }
  });
  const [loginEmail, setLoginEmail] = useState('host@trivia.app');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [activeTab, setActiveTab] = useState<'live' | 'author'>('live');
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [sessionCode, setSessionCode] = useState<string>('');
  const [showPinDrawer, setShowPinDrawer] = useState<boolean>(false);
  const [scoreAdjustModal, setScoreAdjustModal] = useState<{ teamId: string; teamName: string } | null>(null);
  const [adjustPoints, setAdjustPoints] = useState<number>(1);
  const [adjustReason, setAdjustReason] = useState<string>('Bonus / manual adjustment');

  // New Event Form State
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newCatTitle, setNewCatTitle] = useState('');
  const [newQPrompt, setNewQPrompt] = useState('');
  const [newQAnswer, setNewQAnswer] = useState('');
  const [newQPts, setNewQPts] = useState(1);
  const [selectedCatId, setSelectedCatId] = useState<string>('');

  const {
    sessionState,
    boardCards,
    spotlightTeamId,
    isConnected,
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
    hostRenameTeam
  } = useSessionSocket({
    role: 'host',
    code: sessionCode,
    hostToken,
    autoConnect: !!sessionCode && !!hostToken
  });

  const signOut = () => {
    try { localStorage.removeItem('trivia.hostToken'); } catch { /* ignore */ }
    setHostToken('');
    setSessionCode('');
    setEvents([]);
  };

  /** fetch() with the host bearer token; a 401 drops us back to sign-in. */
  const authFetch = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${hostToken}`
      }
    });
    if (res.status === 401) {
      signOut();
      throw new Error('Session expired — please sign in again.');
    }
    return res;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword })
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        setLoginError(data.error || 'Invalid email or password');
        return;
      }
      try { localStorage.setItem('trivia.hostToken', data.token); } catch { /* ignore */ }
      setHostToken(data.token);
      setLoginPassword('');
    } catch {
      setLoginError('Could not reach the server.');
    } finally {
      setLoggingIn(false);
    }
  };

  // Load authored events and check for active live session
  const refreshEvents = async () => {
    if (!hostToken) return;
    try {
      const res = await authFetch('/api/events');
      const data = await res.json();
      setEvents(data.events || []);
      if (data.events?.length > 0 && !selectedEventId) {
        setSelectedEventId(data.events[0].id);
      }

      // Check for running live session
      const liveRes = await authFetch('/api/sessions/live');
      const liveData = await liveRes.json();
      if (liveData.session) {
        setSessionCode(liveData.session.joinCode);
      }
    } catch (err) {
      console.error('Error fetching events:', err);
    }
  };

  useEffect(() => {
    refreshEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToken]);

  const handleLaunchSession = async (eventId: string) => {
    try {
      const res = await authFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ eventId })
      });
      const data = await res.json();
      if (data.joinCode) {
        setSessionCode(data.joinCode);
        setActiveTab('live');
      }
    } catch (err) {
      console.error('Error launching session:', err);
    }
  };

  // Keyboard Shortcuts on Answer Board (§5 & §6)
  useEffect(() => {
    if (activeTab !== 'live') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      const key = e.key.toUpperCase();
      const phase = sessionState?.phase;

      if (phase === 'BOARD_CARDS') {
        if (key === 'A') {
          e.preventDefault();
          hostMarkAll('correct');
          return;
        }
        if (key === 'Z') {
          e.preventDefault();
          hostMarkAll('wrong');
          return;
        }
        if (key === 'C') {
          e.preventDefault();
          hostMarkAll('clear');
          return;
        }
        if (key === 'ENTER') {
          e.preventDefault();
          hostNextPhase();
          return;
        }

        // Individual card toggles. RESERVED_KEYS are handled above and are
        // deliberately absent from SHORTCUT_KEYS; the guard keeps the two
        // sets from drifting back into collision.
        if (RESERVED_KEYS.has(key)) return;
        const idx = SHORTCUT_KEYS.indexOf(key);
        if (idx >= 0 && idx < boardCards.length) {
          e.preventDefault();
          const card = boardCards[idx];
          const nextState = card.isCorrect === true ? false : card.isCorrect === false ? null : true;
          hostMark(card.teamId, nextState);
        }
      } else if (phase === 'BOARD_ANSWER' && key === 'ENTER') {
        e.preventDefault();
        hostBoardRevealCards();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, sessionState?.phase, boardCards, hostMark, hostMarkAll, hostNextPhase, hostBoardRevealCards]);

  const phase = sessionState?.phase || 'LOBBY';
  const currentCategory = sessionState?.currentCategory;
  const currentQuestion = sessionState?.currentQuestion;

  // --- Sign-in gate -------------------------------------------------------
  // The console reads authoring data, which carries every correct answer, so
  // it is host-only. Without a token the API returns 401 and the WebSocket
  // refuses to register this socket as a host.
  if (!hostToken) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#EFF2EE]">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm bg-white border border-[#D2DACF] rounded-2xl p-6 shadow-sm"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#1B7A5A]" />
            <h1 className="font-extrabold text-lg text-[#14181A]">Host Console</h1>
          </div>
          <p className="text-xs text-[#5C6B64] mb-6">Sign in to author events and run a night.</p>

          {loginError && (
            <div className="mb-4 p-3 rounded-lg bg-[#F6DEDB] text-[#B93E33] text-xs font-semibold">
              {loginError}
            </div>
          )}

          <label className="block text-xs font-semibold uppercase tracking-wider text-[#5C6B64] mb-1.5" htmlFor="host-email">
            Email
          </label>
          <input
            id="host-email"
            type="email"
            autoComplete="username"
            value={loginEmail}
            onChange={e => setLoginEmail(e.target.value)}
            className="w-full mb-4 px-3.5 py-2.5 bg-white border border-[#D2DACF] rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#1B7A5A]"
            required
          />

          <label className="block text-xs font-semibold uppercase tracking-wider text-[#5C6B64] mb-1.5" htmlFor="host-password">
            Password
          </label>
          <input
            id="host-password"
            type="password"
            autoComplete="current-password"
            value={loginPassword}
            onChange={e => setLoginPassword(e.target.value)}
            className="w-full mb-6 px-3.5 py-2.5 bg-white border border-[#D2DACF] rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#1B7A5A]"
            required
          />

          <button
            type="submit"
            disabled={loggingIn || !loginEmail || !loginPassword}
            className="w-full py-3 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-semibold text-sm shadow transition-all disabled:opacity-40"
          >
            {loggingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#EFF2EE] text-[#14181A] flex flex-col font-sans">
      {/* Host Navigation Bar */}
      <header className="bg-white border-b border-[#D2DACF] px-6 py-3 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#1B7A5A]" />
            <span className="font-extrabold text-base tracking-tight">Host Console</span>
          </div>

          <div className="flex bg-[#E3E9E1] p-1 rounded-lg text-xs font-bold gap-1">
            <button
              onClick={() => setActiveTab('live')}
              className={`px-3 py-1.5 rounded-md transition-all ${
                activeTab === 'live' ? 'bg-white shadow-sm text-[#14181A]' : 'text-[#5C6B64]'
              }`}
            >
              Live Session {sessionCode && `(${sessionCode})`}
            </button>
            <button
              onClick={() => setActiveTab('author')}
              className={`px-3 py-1.5 rounded-md transition-all ${
                activeTab === 'author' ? 'bg-white shadow-sm text-[#14181A]' : 'text-[#5C6B64]'
              }`}
            >
              Author Events
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {sessionCode && (
            <a
              href={`/screen?code=${sessionCode}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D2DACF] bg-white text-xs font-bold text-[#14181A] hover:bg-[#EFF2EE]"
            >
              <ExternalLink size={14} />
              <span>Open Big Screen</span>
            </a>
          )}

          <button
            onClick={() => setShowPinDrawer(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D2DACF] bg-white text-xs font-bold text-[#5C6B64] hover:text-[#14181A]"
          >
            <KeyRound size={14} />
            <span>Team PINs</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      {activeTab === 'live' ? (
        sessionCode ? (
          <div className="flex-1 p-6 max-w-7xl mx-auto w-full flex flex-col gap-5">
            {/* Live Controller Card */}
            <div className="bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-2.5 py-0.5 rounded-full bg-[#D9EDE5] text-[#1B7A5A] text-xs font-bold font-mono uppercase tracking-wider">
                    {phase}
                  </span>
                  <span className="text-xs text-[#5C6B64] font-medium">
                    Code: <b className="font-mono text-[#14181A]">{sessionCode}</b>
                  </span>
                </div>
                <h2 className="text-xl font-bold">
                  {currentCategory?.title || sessionState?.eventTitle || 'Trivia Event'}
                </h2>
              </div>

              {/* Action Controls */}
              <div className="flex items-center gap-3">
                {phase === 'LOBBY' && (
                  <button
                    onClick={hostStart}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-bold text-sm shadow transition-all"
                  >
                    <Play size={16} />
                    <span>Start Category 1</span>
                  </button>
                )}

                {phase === 'CATEGORY_INTRO' && (
                  <button
                    onClick={hostNextPhase}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-bold text-sm shadow transition-all"
                  >
                    <Play size={16} />
                    <span>Open Question 1</span>
                  </button>
                )}

                {phase === 'QUESTION_LIVE' && (
                  <button
                    onClick={hostLockQuestion}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[#B93E33] hover:bg-[#973229] text-white rounded-xl font-bold text-sm shadow transition-all"
                  >
                    <Lock size={16} />
                    <span>Lock Answers Early</span>
                  </button>
                )}

                {phase === 'QUESTION_LOCKED' && (
                  <button
                    onClick={hostNextPhase}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-bold text-sm shadow transition-all"
                  >
                    {/* Every question goes straight to its own board. */}
                    <Eye size={16} />
                    <span>Open Answer Board ▶</span>
                  </button>
                )}

                {phase === 'BOARD_ANSWER' && (
                  <button
                    onClick={hostBoardRevealCards}
                    className="flex items-center gap-2 px-6 py-2.5 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-bold text-sm shadow transition-all"
                  >
                    <Eye size={16} />
                    <span>Reveal All Answers (Enter)</span>
                  </button>
                )}

                {phase === 'BOARD_CARDS' && (
                  <button
                    onClick={hostNextPhase}
                    className="flex items-center gap-2 px-6 py-2.5 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-bold text-sm shadow transition-all"
                  >
                    <span>
                      {sessionState && sessionState.currentQuestionIndex + 1 < (currentCategory?.totalQuestions || 0)
                        ? 'Confirm & Next Question (Enter)'
                        : 'Confirm & Category Scores (Enter)'}
                    </span>
                  </button>
                )}

                {phase === 'CATEGORY_SCORES' && (
                  <button
                    onClick={hostNextPhase}
                    className="flex items-center gap-2 px-6 py-2.5 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-bold text-sm shadow transition-all"
                  >
                    <span>Next Category ▶</span>
                  </button>
                )}
              </div>
            </div>

            {/* Answer Board Marking Station */}
            {(phase === 'BOARD_ANSWER' || phase === 'BOARD_CARDS') && currentQuestion && (
              <div className="bg-white border border-[#D2DACF] rounded-2xl p-6 shadow-sm flex flex-col gap-4">
                {/* Board Header */}
                <div className="flex items-center justify-between pb-4 border-b border-[#D2DACF]">
                  <div>
                    <span className="text-xs font-bold uppercase tracking-widest text-[#5C6B64]">
                      {currentCategory?.title} · Q{sessionState?.currentQuestionIndex + 1}
                    </span>
                    <h3 className="text-xl font-bold mt-0.5">{currentQuestion.prompt}</h3>
                    <div className="flex items-center gap-2 mt-1 text-sm">
                      <span className="text-[#5C6B64] font-semibold">Correct Answer:</span>
                      <b className="text-[#1B7A5A] uppercase">{currentQuestion.correctAnswer}</b>
                    </div>
                  </div>

                  {phase === 'BOARD_CARDS' && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => hostMarkAll('correct')}
                        className="px-3 py-1.5 bg-[#D9EDE5] text-[#1B7A5A] hover:bg-[#c2e5d7] rounded-lg text-xs font-bold transition-all"
                        title="Keyboard: A"
                      >
                        [A] All Correct
                      </button>
                      <button
                        onClick={() => hostMarkAll('wrong')}
                        className="px-3 py-1.5 bg-[#F6DEDB] text-[#B93E33] hover:bg-[#f0c9c5] rounded-lg text-xs font-bold transition-all"
                        title="Keyboard: Z"
                      >
                        [Z] All Wrong
                      </button>
                    </div>
                  )}
                </div>

                {/* Team Answer Cards Grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
                  {boardCards.map((card, idx) => {
                    const keyShortcut = SHORTCUT_KEYS[idx] || '';
                    const isOk = card.isCorrect === true;
                    const isNo = card.isCorrect === false;

                    return (
                      <div
                        key={card.teamId}
                        className={`p-3 rounded-xl border flex flex-col justify-between transition-all ${
                          isOk
                            ? 'border-[#2FA879] bg-[#2FA879]/10'
                            : isNo
                            ? 'border-[#D2564A] bg-[#D2564A]/10'
                            : 'border-[#D2DACF] bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-bold text-xs uppercase tracking-wider truncate max-w-[140px]">
                            {card.teamName}
                          </span>
                          <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-[#E3E9E1] font-bold">
                            {keyShortcut}
                          </span>
                        </div>

                        {/* Ink Drawing Container */}
                        <div className="w-full aspect-[1000/360] bg-[#EFF2EE] rounded-lg border border-[#D2DACF] overflow-hidden flex items-center justify-center relative my-1">
                          {card.isHidden ? (
                            <span className="text-xs text-[#5C6B64] font-mono">[ HIDDEN ]</span>
                          ) : card.answerInk ? (
                            <InkSvg ink={card.answerInk} strokeUnits={18} />
                          ) : card.answerRaw ? (
                            <span className="font-bold text-sm uppercase">{card.answerRaw}</span>
                          ) : (
                            <span className="text-xs text-[#5C6B64] font-mono">— no answer —</span>
                          )}
                        </div>

                        {/* Marking Actions */}
                        {phase === 'BOARD_CARDS' && (
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-current/10">
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => hostMark(card.teamId, true)}
                                className={`p-1.5 rounded-lg text-xs font-bold transition-all ${
                                  isOk ? 'bg-[#2FA879] text-white shadow-sm' : 'bg-[#E3E9E1] hover:bg-[#2FA879]/20 text-[#14181A]'
                                }`}
                                title="Mark Correct"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={() => hostMark(card.teamId, false)}
                                className={`p-1.5 rounded-lg text-xs font-bold transition-all ${
                                  isNo ? 'bg-[#D2564A] text-white shadow-sm' : 'bg-[#E3E9E1] hover:bg-[#D2564A]/20 text-[#14181A]'
                                }`}
                                title="Mark Wrong"
                              >
                                <X size={14} />
                              </button>
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => hostToggleHide(card.teamId)}
                                className="p-1.5 text-[#5C6B64] hover:text-[#14181A] rounded"
                                title="Toggle Hide on Big Screen"
                              >
                                {card.isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                              <button
                                onClick={() => hostSpotlight(spotlightTeamId === card.teamId ? null : card.teamId)}
                                className="p-1.5 text-[#5C6B64] hover:text-[#14181A] rounded"
                                title="Spotlight on Projector"
                              >
                                <Maximize2 size={14} />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Standings Summary & Roster */}
            <div className="bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm">
              <h3 className="font-bold text-base mb-3">Live Standings ({sessionState?.teams.length || 0} Teams)</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {sessionState?.teams
                  .slice()
                  .sort((a, b) => b.score - a.score)
                  .map((t, idx) => (
                    <div
                      key={t.id}
                      className="flex items-center justify-between p-3 rounded-xl border border-[#D2DACF] bg-[#EFF2EE]"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-mono font-bold text-xs text-[#5C6B64] w-5">{idx + 1}</span>
                        <span className="font-semibold text-sm truncate">{t.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-bold text-sm">{t.score} pts</span>
                        <button
                          onClick={() => setScoreAdjustModal({ teamId: t.id, teamName: t.name })}
                          className="text-xs text-[#5C6B64] hover:text-[#1B7A5A] p-1"
                          title="Adjust Score"
                        >
                          <Sliders size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="max-w-md w-full bg-white border border-[#D2DACF] rounded-2xl p-6 shadow-sm">
              <h2 className="text-xl font-bold mb-2">No Active Live Session</h2>
              <p className="text-xs text-[#5C6B64] mb-6">Select an event below to launch a new session code.</p>

              <div className="space-y-3">
                {events.map(ev => (
                  <button
                    key={ev.id}
                    onClick={() => handleLaunchSession(ev.id)}
                    className="w-full p-4 rounded-xl border border-[#D2DACF] hover:border-[#1B7A5A] hover:bg-[#D9EDE5]/30 text-left flex items-center justify-between transition-all"
                  >
                    <div>
                      <div className="font-bold text-sm">{ev.title}</div>
                      <div className="text-xs text-[#5C6B64]">
                        {ev.categoryCount || 0} categories · {ev.questionCount || 0} questions
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-[#1B7A5A]" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      ) : (
        /* --- Event Authoring Screen (§14) --- */
        <div className="flex-1 p-6 max-w-5xl mx-auto w-full flex flex-col gap-6">
          <div className="bg-white border border-[#D2DACF] rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-bold mb-4">Authored Events</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {events.map(ev => (
                <div key={ev.id} className="p-4 rounded-xl border border-[#D2DACF] flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold text-base">{ev.title}</h3>
                    <p className="text-xs text-[#5C6B64] mt-1">
                      Mode: <b className="uppercase">{ev.answer_mode}</b>
                    </p>
                  </div>
                  <button
                    onClick={() => handleLaunchSession(ev.id)}
                    className="mt-4 w-full py-2 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-lg font-bold text-xs shadow"
                  >
                    Launch Live Night
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Team PIN Drawer Modal */}
      {showPinDrawer && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#D2DACF] p-6 max-w-lg w-full shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-bold text-lg">Team Takeover PIN Roster</h3>
                <p className="text-xs text-[#5C6B64]">Give these to teams whose phones died so they can rejoin.</p>
              </div>
              <button
                onClick={() => setShowPinDrawer(false)}
                className="p-1 rounded-lg text-[#5C6B64] hover:text-[#14181A]"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {sessionState?.teams.map(t => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-3 rounded-xl border border-[#D2DACF] bg-[#EFF2EE]"
                >
                  <span className="font-semibold text-sm">{t.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#5C6B64]">Takeover PIN:</span>
                    <span className="font-mono font-bold text-sm tracking-widest bg-white px-2 py-0.5 rounded border border-[#D2DACF]">
                      {t.teamPin}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Manual Score Adjustment Modal */}
      {scoreAdjustModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#D2DACF] p-6 max-w-sm w-full shadow-2xl">
            <h3 className="font-bold text-base mb-1">Adjust Score: {scoreAdjustModal.teamName}</h3>
            <p className="text-xs text-[#5C6B64] mb-4">Add or deduct points via the append-only ledger.</p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold uppercase text-[#5C6B64] mb-1">Points Delta (+/-)</label>
                <input
                  type="number"
                  value={adjustPoints}
                  onChange={e => setAdjustPoints(parseInt(e.target.value, 10) || 0)}
                  className="w-full p-2 border border-[#D2DACF] rounded-lg font-mono font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-[#5C6B64] mb-1">Reason</label>
                <input
                  type="text"
                  value={adjustReason}
                  onChange={e => setAdjustReason(e.target.value)}
                  className="w-full p-2 border border-[#D2DACF] rounded-lg text-sm"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3">
                <button
                  onClick={() => setScoreAdjustModal(null)}
                  className="px-4 py-2 text-xs font-bold text-[#5C6B64]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    hostAdjustScore(scoreAdjustModal.teamId, adjustPoints, adjustReason);
                    setScoreAdjustModal(null);
                  }}
                  className="px-4 py-2 bg-[#1B7A5A] text-white rounded-lg text-xs font-bold"
                >
                  Apply Score Event
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
