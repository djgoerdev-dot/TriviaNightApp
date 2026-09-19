import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { useSessionSocket } from '../hooks/useSessionSocket';
import { InkSvg } from '../components/ink/InkSvg';
import { calculateStrokeUnits } from '../components/ink/ink-utils';
import type { Submission } from '@trivia/shared';
import { Trophy, Maximize2, X } from 'lucide-react';

// Must stay identical to the host console's list, or the key printed on a
// card here would not be the key that toggles it there.
const SHORTCUT_KEYS = '123456789QWERTYUIOPSDFGHJKLXVBNM'.split('');

export const ScreenRoute: React.FC = () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code') || '';

  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  // Target on-screen ink thickness in CSS pixels. Tuned per venue with [ and ]
  // and remembered per projector.
  const [strokeWeight, setStrokeWeight] = useState<number>(() => {
    try {
      const saved = parseFloat(localStorage.getItem('trivia.strokeWeight') || '');
      return Number.isFinite(saved) && saved >= 2 && saved <= 11 ? saved : 5;
    } catch {
      return 5;
    }
  });
  const [weightToast, setWeightToast] = useState(false);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const [cardInkWidth, setCardInkWidth] = useState(0);

  const {
    sessionState,
    boardCards,
    spotlightTeamId,
    isConnected
  } = useSessionSocket({
    role: 'screen',
    code,
    autoConnect: true
  });

  // Generate QR Code on Lobby
  useEffect(() => {
    if (code) {
      const joinUrl = `${window.location.origin}/play?code=${code}`;
      QRCode.toDataURL(joinUrl, {
        width: 320,
        margin: 1,
        color: {
          dark: theme === 'dark' ? '#E6ECE7' : '#14181A',
          light: theme === 'dark' ? '#171C1A' : '#FFFFFF'
        }
      }).then(setQrDataUrl).catch(console.error);
    }
  }, [code, theme]);

  // The projector is output only: it no longer sends host commands (the
  // server refuses them from a screen socket). Fullscreen and ink weight are
  // purely local display concerns.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toUpperCase();

      if (key === 'F') {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
        return;
      }

      if (e.key === '[' || e.key === ']') {
        setStrokeWeight(prev => {
          const next = Math.min(11, Math.max(2, prev + (e.key === ']' ? 0.5 : -0.5)));
          try { localStorage.setItem('trivia.strokeWeight', String(next)); } catch { /* ignore */ }
          return next;
        });
        setWeightToast(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Hide the weight readout shortly after the last adjustment.
  useEffect(() => {
    if (!weightToast) return;
    const t = setTimeout(() => setWeightToast(false), 1600);
    return () => clearTimeout(t);
  }, [weightToast, strokeWeight]);

  // Measure a real card so ink thickens as the grid gets denser: at 24 teams
  // the cards are ~280px wide against ~420px at 16, and a fixed viewBox stroke
  // would render proportionally thinner exactly where it is hardest to read.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) {
      setCardInkWidth(0);
      return;
    }
    const measure = () => {
      const box = el.querySelector('[data-inkbox]') as HTMLElement | null;
      setCardInkWidth(box ? box.getBoundingClientRect().width : 0);
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [sessionState?.phase, boardCards.length]);

  const phase = sessionState?.phase || 'LOBBY';
  const teams = sessionState?.teams || [];

  // Determine grid layout based on team count (Section 5)
  const teamCount = Math.max(teams.length, 1);
  const gridCols = teamCount <= 12 ? 'grid-cols-4' : teamCount <= 16 ? 'grid-cols-4' : 'grid-cols-6';

  const isDark = theme === 'dark';
  const bgClass = isDark ? 'bg-[#111614] text-[#F4F7F3]' : 'bg-[#FBFCFA] text-[#14181A]';
  const cardBorderClass = isDark ? 'border-[#2C3531]' : 'border-[#DEE4DA]';
  const mutedClass = isDark ? 'text-[#8A9891]' : 'text-[#6B7772]';

  // Find spotlighted submission if any
  const spotlightCard = spotlightTeamId ? boardCards.find(c => c.teamId === spotlightTeamId) : null;

  // Ink thickness in viewBox units, derived from the measured card width so
  // the rendered line lands at `strokeWeight` CSS pixels at any grid density.
  const inkStrokeUnits = calculateStrokeUnits(strokeWeight, cardInkWidth);
  const spotlightStrokeUnits = calculateStrokeUnits(
    strokeWeight,
    typeof window !== 'undefined' ? window.innerWidth * 0.9 : 0
  );

  return (
    <div className={`w-screen h-screen overflow-hidden flex flex-col ${bgClass} select-none relative font-sans`}>
      {/* Top Banner */}
      <div className={`px-8 py-3.5 flex items-center justify-between border-b ${cardBorderClass} flex-none`}>
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full bg-[#1B7A5A]" />
          <span className="font-bold tracking-wider uppercase text-sm">{sessionState?.eventTitle || 'Trivia Night'}</span>
        </div>

        <div className="flex items-center gap-4 text-sm font-mono">
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className={`px-3 py-1 rounded-lg border ${cardBorderClass} text-xs uppercase font-bold`}
          >
            {isDark ? '☀️ Light' : '🌙 Dark'}
          </button>
          <div className="px-3.5 py-1 rounded-full border border-[#1B7A5A]/40 text-[#1B7A5A] font-bold">
            JOIN CODE: {code || '—'}
          </div>
        </div>
      </div>

      {/* Main Screen Container */}
      <div className="flex-1 flex flex-col min-h-0 p-8">
        {/* --- 1. LOBBY --- */}
        {phase === 'LOBBY' && (
          <div className="flex-1 flex items-center justify-around">
            {/* Left: Join Instructions & Big QR */}
            <div className="flex flex-col items-center text-center max-w-lg">
              <span className={`text-sm font-bold uppercase tracking-widest ${mutedClass} mb-2`}>Scan to Play</span>
              <div className="p-4 bg-white rounded-3xl shadow-xl mb-4 border border-[#D2DACF]">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Join QR Code" className="w-64 h-64 block rounded-xl" />
                ) : (
                  <div className="w-64 h-64 flex items-center justify-center text-[#14181A]">Generating QR...</div>
                )}
              </div>
              <div className="text-4xl font-mono font-extrabold tracking-widest text-[#1B7A5A] mb-2">
                {code}
              </div>
              <p className={`text-sm ${mutedClass}`}>
                Scan the QR code or go to <b className="text-current">trivia.app/play</b>
              </p>
            </div>

            {/* Right: Joined Teams Roster */}
            <div className="w-full max-w-md flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <span className="font-bold text-lg">Teams Joined ({teams.length})</span>
                <span className={`font-mono text-xs ${mutedClass}`}>Max 24 teams</span>
              </div>
              <div className="grid grid-cols-2 gap-2.5 max-h-[500px] overflow-y-auto pr-2">
                {teams.map((t, idx) => (
                  <div
                    key={t.id}
                    className={`p-3 rounded-xl border ${cardBorderClass} flex items-center gap-2.5 font-semibold text-sm ${
                      isDark ? 'bg-[#171C1A]' : 'bg-white shadow-sm'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-[#1B7A5A]" />
                    <span className="truncate">{t.name}</span>
                  </div>
                ))}
                {teams.length === 0 && (
                  <div className={`col-span-2 p-8 text-center border border-dashed ${cardBorderClass} rounded-2xl ${mutedClass}`}>
                    Waiting for teams to scan and enter...
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* --- 2. CATEGORY INTRO --- */}
        {phase === 'CATEGORY_INTRO' && sessionState?.currentCategory && (
          <div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-in">
            <span className={`text-xl font-bold uppercase tracking-[0.2em] ${mutedClass} mb-4`}>Category Round</span>
            <h1 className="text-6xl font-extrabold tracking-tight mb-6 max-w-4xl text-balance">
              {sessionState.currentCategory.title}
            </h1>
            <div className="px-5 py-2 rounded-full bg-[#1B7A5A]/20 text-[#1B7A5A] font-mono font-bold text-lg">
              {sessionState.currentCategory.totalQuestions} Questions · Get Your Whiteboards Ready
            </div>
          </div>
        )}

        {/* --- 3. QUESTION LIVE / LOCKED --- */}
        {(phase === 'QUESTION_LIVE' || phase === 'QUESTION_LOCKED') && sessionState?.currentQuestion && (
          <div className="flex-1 flex flex-col justify-between py-6">
            <div className="flex items-center justify-between text-lg font-bold">
              <span className={`uppercase tracking-widest ${mutedClass}`}>
                {sessionState.currentCategory?.title} · Q{sessionState.currentQuestionIndex + 1} of {sessionState.currentCategory?.totalQuestions}
              </span>
              <span className="px-4 py-1.5 rounded-full bg-[#1B7A5A] text-white font-mono">
                {sessionState.currentQuestion.points} {sessionState.currentQuestion.points === 1 ? 'Point' : 'Points'}
              </span>
            </div>

            <div className="my-auto text-center px-12">
              <h2 className="text-5xl font-extrabold leading-tight text-balance mb-8">
                {sessionState.currentQuestion.prompt}
              </h2>

              {/* Submissions counter */}
              <div className="inline-flex items-center gap-3 px-6 py-2.5 rounded-full border border-current/20 font-mono text-xl">
                <span>Answers In:</span>
                <b className="text-[#1B7A5A]">{sessionState.answerCount.answered}</b> / <span>{sessionState.answerCount.total}</span>
              </div>
            </div>

            {/* Timer or Locked Bar */}
            <div className="w-full">
              <div className={`h-3 rounded-full overflow-hidden ${isDark ? 'bg-[#212824]' : 'bg-[#E3E9E1]'}`}>
                {phase === 'QUESTION_LIVE' ? (
                  <div className="h-full bg-[#1B7A5A] animate-pulse transition-all" style={{ width: '100%' }} />
                ) : (
                  <div className="h-full bg-[#B93E33]" style={{ width: '100%' }} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* --- 4. ANSWER BOARD (STAGE 1 & STAGE 2) --- */}
        {(phase === 'BOARD_ANSWER' || phase === 'BOARD_CARDS') && sessionState?.currentQuestion && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Header: Question & Official Answer */}
            <div className={`pb-4 border-b ${cardBorderClass} mb-4 flex-none`}>
              <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest mb-1">
                <span className={mutedClass}>
                  {sessionState.currentCategory?.title} · Q{sessionState.currentQuestionIndex + 1}
                </span>
                <span className="font-mono text-[#1B7A5A]">
                  {sessionState.currentQuestion.points} {sessionState.currentQuestion.points === 1 ? 'Point' : 'Points'}
                </span>
              </div>
              <h3 className="text-2xl font-bold leading-tight mb-2">
                {sessionState.currentQuestion.prompt}
              </h3>

              {/* Official Answer Banner (Always visible in Board phase) */}
              <div className="flex items-center gap-3 text-xl font-extrabold tracking-wide">
                <span className={`text-xs uppercase tracking-widest font-semibold px-2.5 py-1 rounded ${
                  isDark ? 'bg-[#212824] text-[#8A9891]' : 'bg-[#E3E9E1] text-[#5C6B64]'
                }`}>
                  Answer
                </span>
                <span className="text-[#1B7A5A] uppercase">{sessionState.currentQuestion.correctAnswer}</span>
              </div>
            </div>

            {/* The 16–24 Team Cards Grid */}
            <div ref={gridRef} className={`flex-1 grid ${gridCols} gap-3 min-h-0`}>
              {boardCards.map((card, idx) => {
                const keyShortcut = SHORTCUT_KEYS[idx] || '';
                const isRevealed = phase === 'BOARD_CARDS';
                const isBlank = !card.answerInk && !card.answerRaw;

                let cardStatusClass = '';
                if (isRevealed) {
                  if (card.isCorrect === true) {
                    cardStatusClass = 'border-[#2FA879] bg-[#2FA879]/15';
                  } else if (card.isCorrect === false) {
                    cardStatusClass = 'border-[#D2564A] bg-[#D2564A]/15';
                  }
                }

                return (
                  <div
                    key={card.teamId}
                    className={`relative rounded-xl border ${cardBorderClass} p-3 flex flex-col justify-between transition-all ${cardStatusClass} ${
                      isDark ? 'bg-[#171C1A]' : 'bg-white shadow-sm'
                    }`}
                  >
                    {/* Card Team Name & Key Indicator */}
                    <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider mb-1">
                      <span className="truncate max-w-[80%]">{card.teamName}</span>
                      <span className={`font-mono text-[10px] ${mutedClass}`}>{keyShortcut}</span>
                    </div>

                    {/* Card Answer Content */}
                    <div data-inkbox className="flex-1 w-full flex items-center justify-center overflow-hidden min-h-0 relative">
                      {!isRevealed ? (
                        // Stage 1: Face-down ruled whiteboard placeholder
                        <div
                          className="w-full h-full rounded opacity-30"
                          style={{
                            backgroundImage: 'linear-gradient(to bottom, transparent calc(70% - 1px), #8A9891 calc(70% - 1px), #8A9891 70%, transparent 70%)'
                          }}
                        />
                      ) : card.isHidden ? (
                        <div className={`text-xs font-mono uppercase ${mutedClass}`}>[ Hidden by Host ]</div>
                      ) : card.answerInk ? (
                        <InkSvg ink={card.answerInk} strokeUnits={inkStrokeUnits} />
                      ) : card.answerRaw ? (
                        <span className="font-bold text-lg uppercase truncate">{card.answerRaw}</span>
                      ) : (
                        <span className={`text-xs font-mono ${mutedClass}`}>— no answer —</span>
                      )}

                      {/* Live Mark Symbol (✓ or ✗) */}
                      {isRevealed && card.isCorrect !== null && (
                        <div className="absolute right-1 bottom-1 text-3xl font-black">
                          {card.isCorrect ? (
                            <span className="text-[#2FA879]">✓</span>
                          ) : (
                            <span className="text-[#D2564A]">✗</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* --- 5. CATEGORY SCORES / FINISHED LEADERBOARD --- */}
        {(phase === 'CATEGORY_SCORES' || phase === 'FINISHED') && (
          <div className="flex-1 flex flex-col items-center justify-center max-w-4xl mx-auto w-full">
            <div className="text-center mb-6">
              <span className={`text-sm font-bold uppercase tracking-[0.2em] ${mutedClass}`}>
                {phase === 'FINISHED' ? 'Final Standings' : 'Category Leaderboard'}
              </span>
              <h2 className="text-4xl font-extrabold mt-1">Scores</h2>
            </div>

            <div className="w-full grid grid-cols-2 gap-3 max-h-[550px] overflow-y-auto pr-2">
              {teams
                .slice()
                .sort((a, b) => b.score - a.score)
                .map((t, idx) => (
                  <div
                    key={t.id}
                    className={`flex items-center justify-between p-4 rounded-xl border ${cardBorderClass} ${
                      idx === 0
                        ? 'border-[#1B7A5A] bg-[#1B7A5A]/15 font-extrabold text-lg'
                        : isDark ? 'bg-[#171C1A]' : 'bg-white shadow-sm'
                    }`}
                  >
                    <div className="flex items-center gap-3 truncate">
                      <span className="w-6 text-center font-mono font-bold text-[#1B7A5A]">{idx + 1}</span>
                      <span className="truncate">{t.name}</span>
                    </div>
                    <span className="font-mono font-extrabold text-xl">{t.score} pts</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Transient ink-weight readout — [ and ] tune it for the room. */}
      {weightToast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full bg-black/70 text-white font-mono text-sm tracking-wide">
          ink {strokeWeight.toFixed(1)}px
          {cardInkWidth > 0 && <span className="opacity-60"> · card {Math.round(cardInkWidth)}px</span>}
        </div>
      )}

      {/* --- FULLSCREEN SPOTLIGHT OVERLAY --- */}
      {spotlightCard && (
        <div className="absolute inset-0 z-50 bg-black/95 backdrop-blur-md flex flex-col p-12 text-white animate-fade-in">
          <div className="flex items-center justify-between mb-6">
            <div>
              <span className="text-xs font-bold uppercase tracking-widest text-[#1B7A5A]">Spotlight Review</span>
              <h2 className="text-3xl font-extrabold">{spotlightCard.teamName}</h2>
            </div>
            {/* Dismissed from the host console — the projector never drives
                session state. */}
            <span className="px-3 py-1.5 rounded-full bg-white/10 text-xs font-semibold uppercase tracking-wider">
              <X size={14} className="inline mr-1.5 -mt-0.5" />
              Close from host console
            </span>
          </div>

          <div className="flex-1 flex items-center justify-center p-8 bg-[#171C1A] border border-white/10 rounded-3xl overflow-hidden">
            {spotlightCard.answerInk ? (
              <InkSvg ink={spotlightCard.answerInk} strokeUnits={spotlightStrokeUnits} className="w-full h-full max-h-[80vh]" />
            ) : (
              <span className="text-2xl text-gray-500 font-mono">— no answer —</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
