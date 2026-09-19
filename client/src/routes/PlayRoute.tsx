import React, { useState, useEffect, useRef } from 'react';
import { useSessionSocket } from '../hooks/useSessionSocket';
import { InkCanvas } from '../components/ink/InkCanvas';
import { InkSvg } from '../components/ink/InkSvg';
import type { StrokeInk } from '@trivia/shared';
import { CheckCircle2, ArrowUpRight, Sparkles, Smartphone, RotateCcw } from 'lucide-react';

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

  useEffect(() => {
    const handleOrientation = () => {
      setIsLandscape(window.innerWidth >= window.innerHeight);
    };

    // Attempt screen orientation lock if supported
    try {
      if (screen.orientation && 'lock' in screen.orientation) {
        (screen.orientation as any).lock('landscape').catch(() => {});
      }
    } catch (_) {}

    window.addEventListener('resize', handleOrientation);
    window.addEventListener('orientationchange', handleOrientation);
    return () => {
      window.removeEventListener('resize', handleOrientation);
      window.removeEventListener('orientationchange', handleOrientation);
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
    joinTeam(code.trim(), teamName.trim(), deviceToken);
  };

  const handleRejoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !teamName.trim() || !teamPin.trim()) return;
    clearError();
    rejoinTeam(code.trim(), teamName.trim(), teamPin.trim(), deviceToken);
  };

  const handleSubmitAnswer = () => {
    if (!currentInk || !sessionState?.currentQuestion?.id || isSubmitted || isSubmitting) return;
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

  // Find team & card
  const myTeam = myTeamId ? sessionState?.teams.find(t => t.id === myTeamId) : undefined;
  const myCard = myTeamId ? boardCards.find(c => c.teamId === myTeamId) : undefined;

  const currentQId = sessionState?.currentQuestion?.id;
  const displayInk = myCard?.answerInk || (currentQId ? lockedInkMap[currentQId] : null) || currentInk;
  const displayText = myCard?.answerRaw;

  // --- Render Unjoined State ---
  if (!isJoined) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#EFF2EE] font-sans">
        {/* Force Landscape Prompt */}
        {!isLandscape && (
          <div className="fixed inset-0 z-50 bg-[#0E1211] text-[#E6ECE7] flex flex-col items-center justify-center p-6 text-center select-none">
            <div className="w-16 h-16 rounded-2xl bg-[#1B7A5A]/20 border border-[#1B7A5A]/40 text-[#46C296] flex items-center justify-center mb-4 animate-pulse">
              <Smartphone size={32} className="rotate-90 transition-transform" />
            </div>
            <h2 className="text-xl font-bold mb-1">Rotate to Landscape</h2>
            <p className="text-xs text-[#8C9A93] max-w-xs">
              Turn your phone sideways to landscape mode to play.
            </p>
          </div>
        )}

        <div className="w-full max-w-md bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#1B7A5A]"></span>
            <h1 className="font-bold text-base text-[#14181A]">Trivia Night App</h1>
          </div>
          <p className="text-xs text-[#5C6B64] mb-4">Enter event details to join from your phone.</p>

          {lastError && (
            <div className="mb-3 p-2.5 rounded-lg bg-[#F6DEDB] text-[#B93E33] text-xs font-medium">
              {lastError}
            </div>
          )}

          {!isRejoining ? (
            <form onSubmit={handleJoin} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6B64] mb-1">
                    6-Digit Code
                  </label>
                  <input
                    type="text"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="e.g. 482917"
                    className="w-full px-3 py-2 bg-white border border-[#D2DACF] rounded-xl font-mono text-base font-bold text-center tracking-widest text-[#14181A] focus:outline-none focus:ring-2 focus:ring-[#1B7A5A]"
                    required
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6B64] mb-1">
                    Team Name
                  </label>
                  <input
                    type="text"
                    maxLength={30}
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    placeholder="e.g. The Mangoes"
                    className="w-full px-3 py-2 bg-white border border-[#D2DACF] rounded-xl font-semibold text-sm text-[#14181A] focus:outline-none focus:ring-2 focus:ring-[#1B7A5A]"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={!code || !teamName}
                className="w-full py-2.5 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-semibold text-sm shadow transition-all disabled:opacity-40"
              >
                Join Event
              </button>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => setIsRejoining(true)}
                  className="text-xs text-[#5C6B64] hover:text-[#14181A] underline font-medium"
                >
                  Rejoin with 4-digit PIN
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRejoin} className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-[#5C6B64] mb-1">Code</label>
                  <input
                    type="text"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                    className="w-full px-2 py-1.5 bg-white border border-[#D2DACF] rounded-lg font-mono text-center font-bold text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-[#5C6B64] mb-1">Team</label>
                  <input
                    type="text"
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    className="w-full px-2 py-1.5 bg-white border border-[#D2DACF] rounded-lg font-semibold text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-[#5C6B64] mb-1">PIN</label>
                  <input
                    type="text"
                    maxLength={4}
                    value={teamPin}
                    onChange={e => setTeamPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="4821"
                    className="w-full px-2 py-1.5 bg-white border border-[#D2DACF] rounded-lg font-mono text-center font-bold text-sm"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-[#1B7A5A] text-white rounded-xl font-semibold text-sm shadow"
              >
                Reclaim Team
              </button>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => setIsRejoining(false)}
                  className="text-xs text-[#5C6B64] hover:text-[#14181A] underline font-medium"
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
    <div className="min-h-screen bg-[#EFF2EE] text-[#14181A] flex flex-col font-sans select-none overflow-x-hidden">
      {/* Forced Landscape Lock Overlay */}
      {!isLandscape && (
        <div className="fixed inset-0 z-50 bg-[#0E1211] text-[#E6ECE7] flex flex-col items-center justify-center p-6 text-center select-none animate-fade-in">
          <div className="w-16 h-16 rounded-2xl bg-[#1B7A5A]/20 border border-[#1B7A5A]/40 text-[#46C296] flex items-center justify-center mb-4 animate-pulse">
            <Smartphone size={34} className="rotate-90 transition-transform" />
          </div>
          <h2 className="text-xl font-bold mb-1">Rotate to Landscape</h2>
          <p className="text-xs text-[#8A9891] max-w-xs leading-relaxed">
            Please turn your phone sideways to landscape mode for the digital whiteboard.
          </p>
        </div>
      )}

      {/* Thin Landscape Header */}
      <header className="bg-[#EFF2EE]/95 backdrop-blur border-b border-[#D2DACF] px-4 py-1.5 flex-none z-30">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#1B7A5A]' : 'bg-amber-500'}`} />
            <span className="font-extrabold text-sm tracking-tight truncate max-w-[200px]">{teamName}</span>
          </div>

          <div className="flex items-center gap-2.5 text-xs">
            {teamPin && (
              <span className="px-2 py-0.5 rounded border border-[#D2DACF] bg-white font-mono text-[11px] text-[#5C6B64]" title="4-digit Takeover PIN">
                PIN: {teamPin}
              </span>
            )}
            <span className="px-2.5 py-0.5 rounded-full bg-[#1B7A5A] text-white font-mono font-bold">
              {myTeam?.score ?? 0} pts
            </span>
          </div>
        </div>
      </header>

      {/* Landscape Main Content */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-3 flex flex-col min-h-0">
        {lastError && (
          <div className="mb-2 p-2 rounded-lg bg-[#F6DEDB] text-[#B93E33] text-xs font-semibold flex items-center justify-between flex-none">
            <span>{lastError}</span>
            <button type="button" onClick={clearError} className="underline opacity-70 hover:opacity-100">
              Dismiss
            </button>
          </div>
        )}

        {/* Phase: LOBBY */}
        {phase === 'LOBBY' && (
          <div className="flex-1 flex flex-row items-center justify-around p-5 bg-white border border-[#D2DACF] rounded-2xl shadow-sm">
            <div className="flex flex-col items-center text-center">
              <div className="w-12 h-12 rounded-full bg-[#D9EDE5] text-[#1B7A5A] flex items-center justify-center mb-3">
                <Sparkles size={24} />
              </div>
              <h2 className="text-lg font-bold mb-0.5">You're in!</h2>
              <p className="text-xs text-[#5C6B64] max-w-xs">
                Waiting for the host to start the first category...
              </p>
            </div>

            <div className="bg-[#EFF2EE] border border-[#D2DACF] rounded-xl p-4 text-center max-w-xs w-full">
              <div className="text-[11px] text-[#5C6B64] font-medium mb-1">Your Team Takeover PIN</div>
              <div className="font-mono text-2xl font-extrabold tracking-widest text-[#14181A]">{teamPin}</div>
              <div className="text-[10px] text-[#5C6B64] mt-1">If your battery dies, a teammate can rejoin with this PIN.</div>
            </div>
          </div>
        )}

        {/* Phase: CATEGORY_INTRO */}
        {phase === 'CATEGORY_INTRO' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-5 bg-white border border-[#D2DACF] rounded-2xl shadow-sm">
            <span className="text-[11px] font-bold uppercase tracking-widest text-[#5C6B64] mb-1">Category Round</span>
            <h2 className="text-2xl font-extrabold text-[#14181A] mb-2">
              {sessionState?.currentCategory?.title}
            </h2>
            <p className="text-xs text-[#5C6B64]">
              {sessionState?.currentCategory?.totalQuestions} questions in this category. Get ready to write!
            </p>
          </div>
        )}

        {/* Phase: QUESTION_LIVE or QUESTION_LOCKED (Landscape 2-Column Split) */}
        {(phase === 'QUESTION_LIVE' || phase === 'QUESTION_LOCKED') && sessionState?.currentQuestion && (
          <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
            {/* Left Column: Prompt, Timer, Submit Action */}
            <div className="col-span-4 bg-white border border-[#D2DACF] rounded-2xl p-3.5 shadow-sm flex flex-col justify-between overflow-y-auto">
              <div>
                <div className="flex items-center justify-between text-[11px] font-semibold text-[#5C6B64] mb-1">
                  <span className="truncate max-w-[130px]">{sessionState.currentCategory?.title}</span>
                  <span className="font-mono bg-[#EFF2EE] px-1.5 py-0.5 rounded text-[#14181A] font-bold">
                    {sessionState.currentQuestion.points} {sessionState.currentQuestion.points === 1 ? 'pt' : 'pts'}
                  </span>
                </div>

                <h3 className="text-sm md:text-base font-bold text-[#14181A] leading-snug">
                  {sessionState.currentQuestion.prompt}
                </h3>

                {/* Timer Bar */}
                <div className="w-full h-1.5 bg-[#E3E9E1] rounded-full overflow-hidden mt-3">
                  <div
                    className="h-full bg-[#1B7A5A] transition-all duration-100 ease-linear rounded-full"
                    style={{ width: `${timerPercent}%` }}
                  />
                </div>
              </div>

              {/* Submission Controls */}
              <div className="mt-3 pt-2 border-t border-[#D2DACF]">
                {!isSubmitted && phase === 'QUESTION_LIVE' && (
                  <button
                    type="button"
                    onClick={handleSubmitAnswer}
                    disabled={!currentInk || currentInk.s.length === 0 || isSubmitting}
                    className="w-full py-2.5 bg-[#1B7A5A] hover:bg-[#146046] active:scale-[0.99] text-white rounded-xl font-bold text-xs md:text-sm shadow transition-all disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {isSubmitting ? 'Sending…' : 'Lock it in'}
                  </button>
                )}

                {isSubmitted && (
                  <div className="p-2 bg-[#D9EDE5] border border-[#1B7A5A]/30 rounded-xl text-center text-xs font-bold text-[#1B7A5A] flex items-center justify-center gap-1.5 animate-fade-in">
                    <CheckCircle2 size={15} />
                    <span>Answer locked in</span>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Wide Whiteboard Canvas */}
            <div className="col-span-8 flex flex-col min-h-0">
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
          <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
            {/* Left Side: Notice */}
            <div className="col-span-4 bg-white border border-[#D2DACF] rounded-2xl p-4 shadow-sm flex flex-col justify-center text-center">
              <div className="w-10 h-10 rounded-full bg-[#D9EDE5] text-[#1B7A5A] flex items-center justify-center mx-auto mb-2">
                <ArrowUpRight size={22} />
              </div>
              <h2 className="text-base font-extrabold text-[#14181A] mb-1">Look Up 👆</h2>
              <p className="text-[11px] text-[#5C6B64] leading-relaxed">
                {phase === 'BOARD_ANSWER'
                  ? 'The correct answer is on the big screen! Board will reveal shortly.'
                  : 'Host is marking handwritten answers on the projector.'}
              </p>
            </div>

            {/* Right Side: My Team's Locked Handwritten Card (Always Visible!) */}
            <div className="col-span-8 bg-white border border-[#D2DACF] rounded-2xl p-4 shadow-sm flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider mb-2">
                <span className="text-[#14181A] font-extrabold">{teamName}</span>

                {/* Live Mark Badge */}
                <div>
                  {phase === 'BOARD_CARDS' && (
                    myCard?.isCorrect === true ? (
                      <span className="px-2.5 py-0.5 rounded-full bg-[#D9EDE5] text-[#1B7A5A] font-extrabold text-xs">
                        ✓ Correct
                      </span>
                    ) : myCard?.isCorrect === false ? (
                      <span className="px-2.5 py-0.5 rounded-full bg-[#F6DEDB] text-[#B93E33] font-extrabold text-xs">
                        ✗ Incorrect
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded border border-[#D2DACF] bg-[#EFF2EE] text-[#5C6B64] text-[10px]">
                        Pending mark
                      </span>
                    )
                  )}
                  {phase === 'BOARD_ANSWER' && (
                    <span className="px-2 py-0.5 rounded bg-[#EFF2EE] text-[#5C6B64] text-[10px]">
                      Locked In
                    </span>
                  )}
                </div>
              </div>

              {/* Vector Ink Drawing */}
              <div className="flex-1 w-full aspect-[1000/360] bg-[#EFF2EE] rounded-xl border border-[#D2DACF] overflow-hidden flex items-center justify-center p-2 relative shadow-inner">
                {displayInk ? (
                  <InkSvg ink={displayInk} strokeUnits={18} />
                ) : displayText ? (
                  <span className="font-extrabold text-base uppercase text-[#14181A]">{displayText}</span>
                ) : (
                  <span className="text-xs text-[#5C6B64] font-medium">— no answer —</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Phase: CATEGORY_SCORES or FINISHED */}
        {(phase === 'CATEGORY_SCORES' || phase === 'FINISHED') && (
          <div className="flex-1 flex flex-col bg-white border border-[#D2DACF] rounded-2xl p-4 shadow-sm min-h-0">
            <div className="text-center mb-2 flex-none">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#5C6B64]">
                {phase === 'FINISHED' ? 'Final Standings' : 'Category Standings'}
              </span>
              <h2 className="text-lg font-bold text-[#14181A]">Leaderboard</h2>
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
                          ? 'bg-[#D9EDE5] border-[#1B7A5A] font-bold text-[#1B7A5A]'
                          : 'bg-[#EFF2EE] border-[#D2DACF] text-[#14181A]'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="w-4 font-mono font-bold text-center text-[#5C6B64]">{idx + 1}</span>
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
