import React, { useState, useEffect, useRef } from 'react';
import { useSessionSocket } from '../hooks/useSessionSocket';
import { InkCanvas } from '../components/ink/InkCanvas';
import { InkSvg } from '../components/ink/InkSvg';
import type { StrokeInk } from '@trivia/shared';
import { CheckCircle2, ArrowUpRight, Sparkles, Smartphone, Maximize2, Minimize2 } from 'lucide-react';

export const PlayRoute: React.FC = () => {
  // Query parameters: ?code=123456
  const params = new URLSearchParams(window.location.search);
  const initialCode = params.get('code') || '';

  const [code, setCode] = useState(initialCode);
  const [teamName, setTeamName] = useState(() => {
    try {
      return localStorage.getItem('trivia.teamName') || '';
    } catch {
      return '';
    }
  });
  const [teamPin, setTeamPin] = useState(() => {
    try {
      return localStorage.getItem('trivia.teamPin') || '';
    } catch {
      return '';
    }
  });
  const [deviceToken] = useState(() => {
    try {
      let token = localStorage.getItem('trivia.deviceToken');
      if (!token) {
        token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        localStorage.setItem('trivia.deviceToken', token);
      }
      return token;
    } catch {
      return 'token-' + Date.now();
    }
  });

  const [isJoined, setIsJoined] = useState(false);
  const [isRejoining, setIsRejoining] = useState(false);
  const [currentInk, setCurrentInk] = useState<StrokeInk | null>(null);
  const [lockedInkMap, setLockedInkMap] = useState<Record<string, StrokeInk>>({});
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Time remaining percentage for timer bar
  const [timerPercent, setTimerPercent] = useState(100);

  // Orientation state for forced landscape
  const [isLandscape, setIsLandscape] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= window.innerHeight;
    }
    return true;
  });

  // Fullscreen state tracking
  const [isFullscreen, setIsFullscreen] = useState(() => {
    if (typeof document !== 'undefined') {
      return Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement);
    }
    return false;
  });

  const requestFullscreen = async () => {
    try {
      const docEl = document.documentElement as any;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }
      if (screen.orientation && 'lock' in screen.orientation) {
        await (screen.orientation as any).lock('landscape').catch(() => {});
      }
    } catch (_) {}
  };

  const exitFullscreen = async () => {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        await (document as any).webkitExitFullscreen();
      }
    } catch (_) {}
  };

  const toggleFullscreen = () => {
    if (isFullscreen) {
      exitFullscreen();
    } else {
      requestFullscreen();
    }
  };

  useEffect(() => {
    const handleOrientation = () => {
      setIsLandscape(window.innerWidth >= window.innerHeight);
    };

    const updateFs = () => {
      setIsFullscreen(Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement));
    };

    // Attempt screen orientation lock if supported
    try {
      if (screen.orientation && 'lock' in screen.orientation) {
        (screen.orientation as any).lock('landscape').catch(() => {});
      }
    } catch (_) {}

    window.addEventListener('resize', handleOrientation);
    window.addEventListener('orientationchange', handleOrientation);
    document.addEventListener('fullscreenchange', updateFs);
    document.addEventListener('webkitfullscreenchange', updateFs);

    return () => {
      window.removeEventListener('resize', handleOrientation);
      window.removeEventListener('orientationchange', handleOrientation);
      document.removeEventListener('fullscreenchange', updateFs);
      document.removeEventListener('webkitfullscreenchange', updateFs);
    };
  }, []);

  const {
    isConnected,
    sessionState,
    boardCards,
    lastError,
    clearError,
    registeredTeam,
    answerAck,
    serverNow,
    joinTeam,
    rejoinTeam,
    submitAnswer
  } = useSessionSocket({
    role: 'team',
    code: code.trim(),
    autoConnect: true
  });

  const myTeamId = registeredTeam?.id ?? null;

  useEffect(() => {
    if (!registeredTeam) return;
    setIsJoined(true);
    setIsRejoining(false);
    setTeamName(registeredTeam.name);
    setTeamPin(registeredTeam.pin);
  }, [registeredTeam]);

  // Handle timer countdown against server clock
  useEffect(() => {
    if (!sessionState?.questionEndsAt || sessionState.phase !== 'QUESTION_LIVE') {
      setTimerPercent(100);
      return;
    }

    const endsAt = sessionState.questionEndsAt;
    const totalDuration = (sessionState.currentQuestion?.timeLimitSeconds || 15) * 1000;

    const tick = () => {
      const remaining = endsAt - serverNow();
      setTimerPercent(Math.max(0, Math.min(100, (remaining / totalDuration) * 100)));
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [sessionState?.questionEndsAt, sessionState?.phase, sessionState?.currentQuestion?.timeLimitSeconds, serverNow]);

  // Reset submission state on next question
  const lastQuestionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessionState?.currentQuestion?.id && sessionState.currentQuestion.id !== lastQuestionIdRef.current) {
      lastQuestionIdRef.current = sessionState.currentQuestion.id;
      setIsSubmitted(false);
      setIsSubmitting(false);
      setCurrentInk(null);
      clearError();
    }
  }, [sessionState?.currentQuestion?.id, clearError]);

  // Handle server acknowledgment
  useEffect(() => {
    if (!answerAck) return;
    setIsSubmitting(false);
    if (answerAck.accepted && answerAck.questionId) {
      setIsSubmitted(answerAck.questionId === sessionState?.currentQuestion?.id);
      if (currentInk) {
        setLockedInkMap(prev => ({
          ...prev,
          [answerAck.questionId]: currentInk
        }));
      }
    }
  }, [answerAck, sessionState?.currentQuestion?.id, currentInk]);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !teamName.trim()) return;
    clearError();
    requestFullscreen();
    joinTeam(code.trim(), teamName.trim(), deviceToken);
  };

  const handleRejoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !teamName.trim() || !teamPin.trim()) return;
    clearError();
    requestFullscreen();
    rejoinTeam(code.trim(), teamName.trim(), teamPin.trim(), deviceToken);
  };

  const handleSubmitAnswer = () => {
    if (!currentInk || !currentInk.s || currentInk.s.length === 0 || !sessionState?.currentQuestion?.id || isSubmitted || isSubmitting) return;
    clearError();
    const qId = sessionState.currentQuestion.id;
    setLockedInkMap(prev => ({ ...prev, [qId]: currentInk }));
    const sent = submitAnswer(qId, currentInk);
    if (sent) {
      setIsSubmitting(true);
    } else {
      setIsSubmitting(false);
    }
  };

  // Auto-lock drawn strokes on question lock/timeout so whatever is on screen is locked in
  useEffect(() => {
    if (sessionState?.phase === 'QUESTION_LOCKED' && sessionState.currentQuestion?.id) {
      if (!isSubmitted && !isSubmitting && currentInk && currentInk.s && currentInk.s.length > 0) {
        clearError();
        const qId = sessionState.currentQuestion.id;
        setLockedInkMap(prev => ({ ...prev, [qId]: currentInk }));
        setIsSubmitting(true);
        submitAnswer(qId, currentInk);
      }
    }
  }, [sessionState?.phase, sessionState?.currentQuestion?.id, currentInk, isSubmitted, isSubmitting, clearError, submitAnswer]);

  // Find team & card
  const myTeam = myTeamId ? sessionState?.teams.find(t => t.id === myTeamId) : undefined;
  const myCard = myTeamId ? boardCards.find(c => c.teamId === myTeamId) : undefined;

  const currentQId = sessionState?.currentQuestion?.id;
  const rawCardInk = myCard?.answerInk;
  const cardHasStrokes = rawCardInk && rawCardInk.s && rawCardInk.s.length > 0;
  const lockedInk = currentQId ? lockedInkMap[currentQId] : null;
  const lockedHasStrokes = lockedInk && lockedInk.s && lockedInk.s.length > 0;
  const currentHasStrokes = currentInk && currentInk.s && currentInk.s.length > 0;
  const displayInk = (cardHasStrokes ? rawCardInk : null) || (lockedHasStrokes ? lockedInk : null) || (currentHasStrokes ? currentInk : null);
  const displayText = myCard?.answerRaw;

  // --- Render Unjoined State ---
  if (!isJoined) {
    return (
      <div className="min-h-screen h-[100dvh] flex items-center justify-center p-4 bg-[#0E1311] text-[#E6ECE8] font-sans overflow-hidden">
        {/* Force Landscape Prompt */}
        {!isLandscape && (
          <div className="fixed inset-0 z-50 bg-[#0C100E] text-[#E6ECE7] flex flex-col items-center justify-center p-6 text-center select-none animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-[#172D24] border border-[#2EA572]/40 text-[#42DB99] flex items-center justify-center mb-4 animate-pulse">
              <Smartphone size={34} className="rotate-90 transition-transform" />
            </div>
            <h2 className="text-xl font-bold mb-1.5 text-white">Rotate to Landscape</h2>
            <p className="text-xs text-[#8A9F97] max-w-xs leading-relaxed mb-4">
              Turn your phone sideways to landscape mode for the chalkboard whiteboard.
            </p>
            <button
              type="button"
              onClick={requestFullscreen}
              className="px-4 py-2 bg-[#238B5E] hover:bg-[#1C754E] text-white rounded-xl text-xs font-bold shadow transition-all flex items-center gap-1.5"
            >
              <Maximize2 size={14} />
              <span>Enter Fullscreen</span>
            </button>
          </div>
        )}

        <div className="w-full max-w-md bg-[#18231F] border border-[#2B3A33] rounded-2xl p-5 shadow-2xl">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#2EA572]"></span>
            <h1 className="font-bold text-base text-white">Trivia Night App</h1>
          </div>
          <p className="text-xs text-[#8A9F97] mb-4">Enter event details to join the chalkboard.</p>

          {lastError && (
            <div className="mb-3 p-2.5 rounded-lg bg-[#341816] text-[#FFA399] border border-[#D2564A]/40 text-xs font-medium">
              {lastError}
            </div>
          )}

          {!isRejoining ? (
            <form onSubmit={handleJoin} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#8A9F97] mb-1">
                    6-Digit Code
                  </label>
                  <input
                    type="text"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="e.g. 482917"
                    className="w-full px-3 py-2 bg-[#121A17] border border-[#2B3A33] rounded-xl font-mono text-base font-bold text-center tracking-widest text-white focus:outline-none focus:ring-2 focus:ring-[#2EA572]"
                    required
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#8A9F97] mb-1">
                    Team Name
                  </label>
                  <input
                    type="text"
                    maxLength={30}
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    placeholder="e.g. The Mangoes"
                    className="w-full px-3 py-2 bg-[#121A17] border border-[#2B3A33] rounded-xl font-semibold text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#2EA572]"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={!code || !teamName}
                className="w-full py-2.5 bg-[#238B5E] hover:bg-[#1C754E] text-white rounded-xl font-semibold text-sm shadow transition-all disabled:opacity-40"
              >
                Join Event
              </button>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => setIsRejoining(true)}
                  className="text-xs text-[#8A9F97] hover:text-white underline font-medium"
                >
                  Rejoin with 4-digit PIN
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRejoin} className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-[#8A9F97] mb-1">Code</label>
                  <input
                    type="text"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                    className="w-full px-2 py-1.5 bg-[#121A17] border border-[#2B3A33] rounded-lg font-mono text-center font-bold text-sm text-white"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-[#8A9F97] mb-1">Team</label>
                  <input
                    type="text"
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    className="w-full px-2 py-1.5 bg-[#121A17] border border-[#2B3A33] rounded-lg font-semibold text-xs text-white"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-[#8A9F97] mb-1">PIN</label>
                  <input
                    type="text"
                    maxLength={4}
                    value={teamPin}
                    onChange={e => setTeamPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="4821"
                    className="w-full px-2 py-1.5 bg-[#121A17] border border-[#2B3A33] rounded-lg font-mono text-center font-bold text-sm text-white"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-[#238B5E] text-white rounded-xl font-semibold text-sm shadow"
              >
                Reclaim Team
              </button>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => setIsRejoining(false)}
                  className="text-xs text-[#8A9F97] hover:text-white underline font-medium"
                >
                  Back to join
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  // --- Joined Team View ---
  const phase = sessionState?.phase || 'LOBBY';

  return (
    <div className="min-h-screen h-[100dvh] bg-[#0E1311] text-[#E6ECE8] flex flex-col font-sans select-none overflow-hidden">
      {/* Forced Landscape Lock Overlay */}
      {!isLandscape && (
        <div className="fixed inset-0 z-50 bg-[#0C100E] text-[#E6ECE7] flex flex-col items-center justify-center p-6 text-center select-none animate-fade-in">
          <div className="w-16 h-16 rounded-2xl bg-[#172D24] border border-[#2EA572]/40 text-[#42DB99] flex items-center justify-center mb-4 animate-pulse">
            <Smartphone size={34} className="rotate-90 transition-transform" />
          </div>
          <h2 className="text-xl font-bold mb-1.5 text-white">Rotate to Landscape</h2>
          <p className="text-xs text-[#8A9F97] max-w-xs leading-relaxed mb-4">
            Please turn your phone sideways to landscape mode for the chalkboard whiteboard.
          </p>
          <button
            type="button"
            onClick={requestFullscreen}
            className="px-4 py-2 bg-[#238B5E] hover:bg-[#1C754E] text-white rounded-xl text-xs font-bold shadow transition-all flex items-center gap-1.5"
          >
            <Maximize2 size={14} />
            <span>Enter Fullscreen</span>
          </button>
        </div>
      )}

      {/* Chalkboard Landscape Header */}
      <header className="bg-[#141C19]/95 backdrop-blur border-b border-[#25332C] px-4 py-1.5 flex-none z-30">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#2EA572]' : 'bg-amber-500'}`} />
            <span className="font-extrabold text-sm tracking-tight text-white truncate max-w-[200px]">{teamName}</span>
          </div>

          <div className="flex items-center gap-2 text-xs">
            {teamPin && (
              <span className="px-2 py-0.5 rounded border border-[#2B3A33] bg-[#18231F] font-mono text-[11px] text-[#8A9F97]" title="4-digit Takeover PIN">
                PIN: {teamPin}
              </span>
            )}
            <span className="px-2.5 py-0.5 rounded-full bg-[#132A20] border border-[#2EA572]/40 text-[#42DB99] font-mono font-bold">
              {myTeam?.score ?? 0} pts
            </span>

            {/* Fullscreen Toggle Button */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="p-1 rounded-lg border border-[#2B3A33] bg-[#18231F] text-[#8A9F97] hover:text-white hover:border-[#3E5249] transition-all ml-1"
              title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>
      </header>

      {/* Landscape Main Content */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-2 md:p-3 flex flex-col min-h-0">
        {lastError && (
          <div className="mb-2 p-2 rounded-lg bg-[#341816] border border-[#D2564A]/40 text-[#FFA399] text-xs font-semibold flex items-center justify-between flex-none">
            <span>{lastError}</span>
            <button type="button" onClick={clearError} className="underline opacity-70 hover:opacity-100">
              Dismiss
            </button>
          </div>
        )}

        {/* Phase: LOBBY */}
        {phase === 'LOBBY' && (
          <div className="flex-1 flex flex-row items-center justify-around p-5 bg-[#18231F] border border-[#2B3A33] rounded-2xl shadow-xl text-white">
            <div className="flex flex-col items-center text-center">
              <div className="w-12 h-12 rounded-full bg-[#132A20] border border-[#2EA572]/40 text-[#42DB99] flex items-center justify-center mb-3">
                <Sparkles size={24} />
              </div>
              <h2 className="text-lg font-bold mb-0.5">You're in!</h2>
              <p className="text-xs text-[#8A9F97] max-w-xs">
                Waiting for the host to start the first category...
              </p>
            </div>

            <div className="bg-[#121A17] border border-[#25332C] rounded-xl p-4 text-center max-w-xs w-full">
              <div className="text-[11px] text-[#8A9F97] font-medium mb-1">Your Team Takeover PIN</div>
              <div className="font-mono text-2xl font-extrabold tracking-widest text-white">{teamPin}</div>
              <div className="text-[10px] text-[#6A7D75] mt-1">If your battery dies, a teammate can rejoin with this PIN.</div>
            </div>
          </div>
        )}

        {/* Phase: CATEGORY_INTRO */}
        {phase === 'CATEGORY_INTRO' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-5 bg-[#18231F] border border-[#2B3A33] rounded-2xl shadow-xl text-white">
            <span className="text-[11px] font-bold uppercase tracking-widest text-[#8A9F97] mb-1">Category Round</span>
            <h2 className="text-2xl font-extrabold text-white mb-2">
              {sessionState?.currentCategory?.title}
            </h2>
            <p className="text-xs text-[#8A9F97]">
              {sessionState?.currentCategory?.totalQuestions} questions in this category. Get your chalkboard ready!
            </p>
          </div>
        )}

        {/* Phase: QUESTION_LIVE or QUESTION_LOCKED (Question at the TOP, Canvas below) */}
        {(phase === 'QUESTION_LIVE' || phase === 'QUESTION_LOCKED') && sessionState?.currentQuestion && (
          <div className="flex-1 flex flex-col min-h-0 gap-2">
            {/* Top Bar: Question Box & Action */}
            <div className="bg-[#18231F] border border-[#2B3A33] rounded-2xl p-2.5 md:p-3 shadow-md flex-none">
              <div className="flex items-center justify-between gap-3 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#8A9F97] truncate max-w-[200px]">
                    {sessionState.currentCategory?.title}
                  </span>
                  <span className="font-mono bg-[#212E28] text-[#42DB99] border border-[#2EA572]/40 px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap">
                    {sessionState.currentQuestion.points} {sessionState.currentQuestion.points === 1 ? 'pt' : 'pts'}
                  </span>
                </div>

                {/* Submission Controls in Top Right */}
                <div className="flex-none">
                  {!isSubmitted && !isSubmitting && phase === 'QUESTION_LIVE' && (
                    <button
                      type="button"
                      onClick={handleSubmitAnswer}
                      disabled={!currentInk || !currentInk.s || currentInk.s.length === 0}
                      className="px-4 py-1.5 bg-[#238B5E] hover:bg-[#1C754E] active:scale-[0.98] text-white rounded-xl font-bold text-xs md:text-sm shadow transition-all disabled:opacity-35 disabled:pointer-events-none"
                    >
                      Lock it in
                    </button>
                  )}

                  {(isSubmitted || isSubmitting) && (
                    <div className="px-3 py-1 bg-[#132A20] border border-[#2EA572] rounded-xl text-center text-xs font-bold text-[#42DB99] flex items-center gap-1.5 animate-fade-in shadow-sm">
                      <CheckCircle2 size={14} />
                      <span>{isSubmitting ? 'Locking in…' : 'Answer locked in'}</span>
                    </div>
                  )}

                  {!isSubmitted && !isSubmitting && phase === 'QUESTION_LOCKED' && (
                    <div className="px-3 py-1 bg-[#1E2623] border border-[#3A4843] rounded-xl text-center text-xs font-semibold text-[#8C9F97] flex items-center gap-1.5 animate-fade-in">
                      <span>— No answer recorded —</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Question Prompt */}
              <h3 className="text-sm md:text-base font-bold text-[#F2F7F4] leading-snug">
                {sessionState.currentQuestion.prompt}
              </h3>

              {/* Sleek Timer Bar */}
              <div className="w-full h-1.5 bg-[#121A17] rounded-full overflow-hidden mt-2 border border-[#25332C]">
                <div
                  className="h-full bg-[#2EA572] shadow-[0_0_6px_rgba(46,165,114,0.6)] transition-all duration-100 ease-linear rounded-full"
                  style={{ width: `${timerPercent}%` }}
                />
              </div>
            </div>

            {/* Bottom: Full-Width Digital Blackboard */}
            <div className="flex-1 flex flex-col min-h-0 justify-center">
              <InkCanvas
                key={sessionState.currentQuestion.id}
                isLocked={isSubmitted || isSubmitting || phase === 'QUESTION_LOCKED'}
                onStrokeChange={ink => setCurrentInk(ink)}
              />
            </div>
          </div>
        )}

        {/* Phase: BOARD_ANSWER or BOARD_CARDS (Look Up 👆 and Show Locked Answer) */}
        {(phase === 'BOARD_ANSWER' || phase === 'BOARD_CARDS') && (
          <div className="flex-1 flex flex-col min-h-0 gap-2">
            {/* Top Bar: Notice & Live Mark */}
            <div className="bg-[#18231F] border border-[#2B3A33] rounded-2xl px-4 py-2 shadow-sm flex items-center justify-between flex-none">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded-lg bg-[#132A20] text-[#42DB99] border border-[#2EA572]/40 flex items-center justify-center flex-none">
                  <ArrowUpRight size={16} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-xs font-extrabold text-[#F2F7F4] leading-tight">Look Up 👆</h2>
                  <p className="text-[11px] text-[#8C9F97] leading-tight truncate">
                    {phase === 'BOARD_ANSWER'
                      ? 'The correct answer is on the big screen! Cards will reveal shortly.'
                      : 'Host is marking handwritten answers on the projector.'}
                  </p>
                </div>
              </div>

              {/* Live Mark Badge */}
              <div className="flex-none">
                {phase === 'BOARD_CARDS' && (
                  myCard?.isCorrect === true ? (
                    <span className="px-3 py-1 rounded-full bg-[#132A20] border border-[#2EA572] text-[#42DB99] font-extrabold text-xs">
                      ✓ Correct
                    </span>
                  ) : myCard?.isCorrect === false ? (
                    <span className="px-3 py-1 rounded-full bg-[#341816] border border-[#D2564A] text-[#FFA399] font-extrabold text-xs">
                      ✗ Incorrect
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded-lg border border-[#3A4843] bg-[#1E2623] text-[#8C9F97] text-[11px]">
                      Pending mark
                    </span>
                  )
                )}
                {phase === 'BOARD_ANSWER' && (
                  <span className="px-2.5 py-1 rounded-lg bg-[#1E2623] border border-[#3A4843] text-[#8C9F97] text-[11px]">
                    Locked In
                  </span>
                )}
              </div>
            </div>

            {/* Blackboard Card: White Chalk on Slate */}
            <div className="flex-1 bg-[#18231F] border-2 border-[#2B3A33] rounded-2xl p-2.5 shadow-inner flex flex-col justify-between min-h-0">
              <div className="text-[11px] font-bold uppercase tracking-wider text-[#8C9F97] mb-1 px-1 flex items-center justify-between">
                <span>Team: <b className="text-white font-extrabold">{teamName}</b></span>
                <span className="font-mono text-[10px] text-[#6A7D75]">Your Chalkboard</span>
              </div>

              {/* Vector Chalk Drawing */}
              <div className="flex-1 w-full aspect-[1000/360] bg-[#121916] rounded-xl border border-[#25332C] overflow-hidden flex items-center justify-center p-2 relative shadow-[inset_0_2px_8px_rgba(0,0,0,0.6)]">
                {displayInk && displayInk.s && displayInk.s.length > 0 ? (
                  <InkSvg ink={displayInk} strokeUnits={18} className="w-full h-full block text-white" />
                ) : displayText && displayText.trim() ? (
                  <span className="font-extrabold text-base uppercase text-white tracking-wider">{displayText}</span>
                ) : (
                  <span className="text-xs text-[#5D6F68] font-mono italic">— no answer —</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Phase: CATEGORY_SCORES or FINISHED */}
        {(phase === 'CATEGORY_SCORES' || phase === 'FINISHED') && (
          <div className="flex-1 flex flex-col bg-[#18231F] border border-[#2B3A33] rounded-2xl p-4 shadow-sm min-h-0 text-white">
            <div className="text-center mb-2 flex-none">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#8A9F97]">
                {phase === 'FINISHED' ? 'Final Standings' : 'Category Standings'}
              </span>
              <h2 className="text-lg font-bold text-white">Leaderboard</h2>
            </div>

            <div className="grid grid-cols-2 gap-2 flex-1 overflow-y-auto pr-1">
              {sessionState?.teams
                .slice()
                .sort((a, b) => b.score - a.score)
                .map((team, idx) => {
                  const isMe = team.id === myTeam?.id;
                  return (
                    <div
                      key={team.id}
                      className={`flex items-center justify-between p-2.5 rounded-xl border text-xs ${
                        isMe
                          ? 'bg-[#132A20] border-[#2EA572] font-bold text-[#42DB99]'
                          : 'bg-[#121A17] border-[#25332C] text-[#D3DFDA]'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="w-4 font-mono font-bold text-center text-[#7E9189]">{idx + 1}</span>
                        <span className="truncate">{team.name} {isMe && '(You)'}</span>
                      </div>
                      <span className="font-mono font-bold">{team.score} pts</span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
