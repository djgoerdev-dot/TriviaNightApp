import React, { useState, useEffect, useRef } from 'react';
import { useSessionSocket } from '../hooks/useSessionSocket';
import { InkCanvas } from '../components/ink/InkCanvas';
import { InkSvg } from '../components/ink/InkSvg';
import type { StrokeInk } from '@trivia/shared';
import { CheckCircle2, XCircle, ArrowUpRight, Shield, Sparkles, RefreshCw } from 'lucide-react';

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
  const [isSubmitted, setIsSubmitted] = useState(false);

  // Time remaining percentage for timer bar
  const [timerPercent, setTimerPercent] = useState(100);

  const {
    isConnected,
    sessionState,
    boardCards,
    lastError,
    joinTeam,
    rejoinTeam,
    submitAnswer
  } = useSessionSocket({
    role: 'team',
    code: code.trim(),
    autoConnect: true
  });

  // Track active team ID
  const [myTeamId, setMyTeamId] = useState<string | null>(null);

  useEffect(() => {
    if (sessionState && !myTeamId) {
      // Find my team by token or name
      const team = sessionState.teams.find(t => t.name.toLowerCase() === teamName.trim().toLowerCase());
      if (team) {
        setMyTeamId(team.id);
        setTeamPin(team.teamPin);
        setIsJoined(true);
      }
    }
  }, [sessionState, teamName, myTeamId]);

  // Handle timer countdown
  useEffect(() => {
    if (!sessionState?.questionEndsAt || sessionState.phase !== 'QUESTION_LIVE') {
      setTimerPercent(100);
      return;
    }

    const totalDuration = (sessionState.currentQuestion?.timeLimitSeconds || 15) * 1000;
    const interval = setInterval(() => {
      const remaining = sessionState.questionEndsAt! - Date.now();
      const pct = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
      setTimerPercent(pct);
    }, 100);

    return () => clearInterval(interval);
  }, [sessionState?.questionEndsAt, sessionState?.phase, sessionState?.currentQuestion?.timeLimitSeconds]);

  // Reset submission state on next question
  const lastQuestionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessionState?.currentQuestion?.id && sessionState.currentQuestion.id !== lastQuestionIdRef.current) {
      lastQuestionIdRef.current = sessionState.currentQuestion.id;
      setIsSubmitted(false);
      setCurrentInk(null);
    }
  }, [sessionState?.currentQuestion?.id]);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !teamName.trim()) return;
    joinTeam(code.trim(), teamName.trim(), deviceToken);
    setIsJoined(true);
  };

  const handleRejoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !teamName.trim() || !teamPin.trim()) return;
    rejoinTeam(code.trim(), teamName.trim(), teamPin.trim(), deviceToken);
    setIsJoined(true);
    setIsRejoining(false);
  };

  const handleSubmitAnswer = () => {
    if (!currentInk || !sessionState?.currentQuestion?.id || isSubmitted) return;
    submitAnswer(sessionState.currentQuestion.id, currentInk);
    setIsSubmitted(true);
  };

  // Find my team and submission
  const myTeam = sessionState?.teams.find(t => t.id === myTeamId || t.name.toLowerCase() === teamName.toLowerCase());
  const myCard = boardCards.find(c => c.teamId === myTeam?.id || c.teamName.toLowerCase() === teamName.toLowerCase());

  // --- Render Unjoined State ---
  if (!isJoined) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#EFF2EE]">
        <div className="w-full max-w-sm bg-white border border-[#D2DACF] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#1B7A5A]"></span>
            <h1 className="font-bold text-lg text-[#14181A]">Trivia Night App</h1>
          </div>
          <p className="text-xs text-[#5C6B64] mb-6">Enter the event details given by your host to join.</p>

          {lastError && (
            <div className="mb-4 p-3 rounded-lg bg-[#F6DEDB] text-[#B93E33] text-xs font-medium">
              {lastError}
            </div>
          )}

          {!isRejoining ? (
            <form onSubmit={handleJoin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#5C6B64] mb-1.5">
                  6-Digit Session Code
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 482917"
                  className="w-full px-3.5 py-2.5 bg-white border border-[#D2DACF] rounded-xl font-mono text-lg font-bold text-center tracking-widest text-[#14181A] focus:outline-none focus:ring-2 focus:ring-[#1B7A5A]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#5C6B64] mb-1.5">
                  Team Name
                </label>
                <input
                  type="text"
                  maxLength={30}
                  value={teamName}
                  onChange={e => setTeamName(e.target.value)}
                  placeholder="e.g. The Mangoes"
                  className="w-full px-3.5 py-2.5 bg-white border border-[#D2DACF] rounded-xl font-semibold text-[#14181A] focus:outline-none focus:ring-2 focus:ring-[#1B7A5A]"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={!code || !teamName}
                className="w-full py-3 bg-[#1B7A5A] hover:bg-[#146046] text-white rounded-xl font-semibold text-sm shadow transition-all disabled:opacity-40"
              >
                Join Event
              </button>

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => setIsRejoining(true)}
                  className="text-xs text-[#5C6B64] hover:text-[#14181A] underline font-medium"
                >
                  Rejoin an existing team with PIN
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRejoin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#5C6B64] mb-1.5">
                  6-Digit Session Code
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full px-3.5 py-2.5 bg-white border border-[#D2DACF] rounded-xl font-mono text-center font-bold"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#5C6B64] mb-1.5">
                  Team Name
                </label>
                <input
                  type="text"
                  value={teamName}
                  onChange={e => setTeamName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-white border border-[#D2DACF] rounded-xl font-semibold"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#5C6B64] mb-1.5">
                  4-Digit Team PIN
                </label>
                <input
                  type="text"
                  maxLength={4}
                  value={teamPin}
                  onChange={e => setTeamPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 4821"
                  className="w-full px-3.5 py-2.5 bg-white border border-[#D2DACF] rounded-xl font-mono text-center font-bold tracking-widest"
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 bg-[#1B7A5A] text-white rounded-xl font-semibold text-sm shadow"
              >
                Reclaim Team
              </button>

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => setIsRejoining(false)}
                  className="text-xs text-[#5C6B64] hover:text-[#14181A] underline font-medium"
                >
                  Back to new join
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
    <div className="min-h-screen bg-[#EFF2EE] text-[#14181A] flex flex-col">
      {/* Sticky Team Status Bar */}
      <header className="sticky top-0 z-30 bg-[#EFF2EE]/90 backdrop-blur border-b border-[#D2DACF] px-4 py-2.5">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#1B7A5A]' : 'bg-amber-500'}`} />
            <span className="font-bold text-sm tracking-tight truncate max-w-[160px]">{teamName}</span>
          </div>

          <div className="flex items-center gap-2">
            {teamPin && (
              <span className="px-2 py-0.5 rounded border border-[#D2DACF] bg-white font-mono text-[11px] text-[#5C6B64]" title="4-digit Takeover PIN">
                PIN: {teamPin}
              </span>
            )}
            <span className="px-2.5 py-0.5 rounded-full bg-[#1B7A5A] text-white font-mono font-bold text-xs">
              {myTeam?.score ?? 0} pts
            </span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-md w-full mx-auto p-4 flex flex-col">
        {/* Phase: LOBBY */}
        {phase === 'LOBBY' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-white border border-[#D2DACF] rounded-2xl shadow-sm">
            <div className="w-12 h-12 rounded-full bg-[#D9EDE5] text-[#1B7A5A] flex items-center justify-center mb-4">
              <Sparkles size={24} />
            </div>
            <h2 className="text-xl font-bold mb-1">You're in!</h2>
            <p className="text-sm text-[#5C6B64] mb-6">
              Waiting for the host to start the trivia night...
            </p>

            <div className="w-full bg-[#EFF2EE] rounded-xl p-3 mb-6 border border-[#D2DACF]">
              <div className="text-xs text-[#5C6B64] mb-1 font-medium">Your Team Takeover PIN</div>
              <div className="font-mono text-2xl font-bold tracking-widest text-[#14181A]">{teamPin}</div>
              <div className="text-[11px] text-[#5C6B64] mt-1">If your battery dies, a teammate can rejoin with this PIN.</div>
            </div>

            <div className="text-xs font-mono text-[#5C6B64]">
              {sessionState?.teams.length || 1} {sessionState?.teams.length === 1 ? 'team' : 'teams'} in the room
            </div>
          </div>
        )}

        {/* Phase: CATEGORY_INTRO */}
        {phase === 'CATEGORY_INTRO' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-white border border-[#D2DACF] rounded-2xl shadow-sm">
            <span className="text-xs font-bold uppercase tracking-widest text-[#5C6B64] mb-2">Next Category</span>
            <h2 className="text-2xl font-bold text-[#14181A] mb-3">
              {sessionState?.currentCategory?.title}
            </h2>
            <p className="text-sm text-[#5C6B64]">
              {sessionState?.currentCategory?.totalQuestions} questions in this round. Get ready!
            </p>
          </div>
        )}

        {/* Phase: QUESTION_LIVE or QUESTION_LOCKED */}
        {(phase === 'QUESTION_LIVE' || phase === 'QUESTION_LOCKED') && sessionState?.currentQuestion && (
          <div className="flex-1 flex flex-col gap-3">
            {/* Question Card */}
            <div className="bg-white border border-[#D2DACF] rounded-2xl p-4 shadow-sm relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-[#5C6B64] mb-1.5">
                <span>{sessionState.currentCategory?.title}</span>
                <span className="font-mono bg-[#EFF2EE] px-2 py-0.5 rounded text-[#14181A]">
                  {sessionState.currentQuestion.points} {sessionState.currentQuestion.points === 1 ? 'pt' : 'pts'}
                </span>
              </div>

              <h3 className="text-lg font-bold text-[#14181A] leading-snug">
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

            {/* Drawing Pad */}
            <div className="flex-1 flex flex-col">
              <InkCanvas
                isLocked={isSubmitted || phase === 'QUESTION_LOCKED'}
                onStrokeChange={ink => setCurrentInk(ink)}
              />

              {/* Submit Button */}
              {!isSubmitted && phase === 'QUESTION_LIVE' && (
                <button
                  type="button"
                  onClick={handleSubmitAnswer}
                  disabled={!currentInk || currentInk.s.length === 0}
                  className="mt-3 w-full py-3.5 bg-[#1B7A5A] hover:bg-[#146046] active:scale-[0.99] text-white rounded-xl font-bold text-sm shadow-md transition-all disabled:opacity-40 disabled:pointer-events-none"
                >
                  Lock it in
                </button>
              )}

              {isSubmitted && (
                <div className="mt-3 p-3 bg-[#D9EDE5] border border-[#1B7A5A]/30 rounded-xl text-center text-xs font-bold text-[#1B7A5A] flex items-center justify-center gap-2 animate-fade-in">
                  <CheckCircle2 size={16} />
                  <span>Answer locked in — waiting for category board...</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Phase: BOARD_ANSWER or BOARD_CARDS */}
        {(phase === 'BOARD_ANSWER' || phase === 'BOARD_CARDS') && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 bg-white border border-[#D2DACF] rounded-2xl shadow-sm text-center">
            <div className="w-12 h-12 rounded-full bg-[#E3E9E1] flex items-center justify-center text-[#14181A] mb-3">
              <ArrowUpRight size={26} className="text-[#1B7A5A]" />
            </div>

            <h2 className="text-xl font-bold text-[#14181A] mb-1">Look Up 👆</h2>
            <p className="text-xs text-[#5C6B64] mb-6 max-w-[280px]">
              {phase === 'BOARD_ANSWER'
                ? 'Official answer is up on the projector!'
                : 'Host is marking the whiteboard answers now.'}
            </p>

            {/* My Team's Card Preview */}
            <div className="w-full max-w-xs p-3 bg-[#EFF2EE] border border-[#D2DACF] rounded-xl text-left">
              <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-[#5C6B64] mb-2">
                <span>{teamName}</span>
                {phase === 'BOARD_CARDS' && myCard && (
                  <span>
                    {myCard.isCorrect === true && <span className="text-[#1B7A5A] font-bold">✓ Correct</span>}
                    {myCard.isCorrect === false && <span className="text-[#B93E33] font-bold">✗ Incorrect</span>}
                    {myCard.isCorrect == null && <span className="text-[#5C6B64]">Pending</span>}
                  </span>
                )}
              </div>

              <div className="w-full aspect-[1000/360] bg-white rounded-lg border border-[#D2DACF] overflow-hidden flex items-center justify-center">
                {myCard?.answerInk ? (
                  <InkSvg ink={myCard.answerInk} strokeUnits={20} />
                ) : (
                  <span className="text-xs text-[#5C6B64] font-medium">— no answer —</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Phase: CATEGORY_SCORES or FINISHED */}
        {(phase === 'CATEGORY_SCORES' || phase === 'FINISHED') && (
          <div className="flex-1 flex flex-col bg-white border border-[#D2DACF] rounded-2xl p-5 shadow-sm">
            <div className="text-center mb-4">
              <span className="text-xs font-bold uppercase tracking-widest text-[#5C6B64]">
                {phase === 'FINISHED' ? 'Final Standings' : 'Category Scores'}
              </span>
              <h2 className="text-xl font-bold text-[#14181A] mt-1">Leaderboard</h2>
            </div>

            <div className="space-y-2 flex-1 overflow-y-auto">
              {sessionState?.teams
                .slice()
                .sort((a, b) => b.score - a.score)
                .map((team, idx) => {
                  const isMe = team.id === myTeam?.id;
                  return (
                    <div
                      key={team.id}
                      className={`flex items-center justify-between p-3 rounded-xl border text-sm ${
                        isMe
                          ? 'bg-[#D9EDE5] border-[#1B7A5A] font-bold text-[#1B7A5A]'
                          : 'bg-[#EFF2EE] border-[#D2DACF] text-[#14181A]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-5 text-center font-mono font-bold text-xs text-[#5C6B64]">{idx + 1}</span>
                        <span>{team.name} {isMe && '(You)'}</span>
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
