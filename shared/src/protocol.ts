export type AnswerMode = 'ink' | 'text';

/** Which surface a socket is acting as. The server decides this, never the client. */
export type ClientRole = 'host' | 'screen' | 'team';

export type SessionPhase =
  | 'DRAFT'
  | 'LOBBY'
  | 'CATEGORY_INTRO'
  | 'QUESTION_LIVE'
  | 'QUESTION_LOCKED'
  | 'BOARD_ANSWER'
  | 'BOARD_CARDS'
  | 'CATEGORY_SCORES'
  | 'BREAK'
  | 'FINISHED'
  | 'PAUSED';

export type QuestionType = 'ink' | 'text' | 'multiple_choice' | 'numeric';

export interface Stroke {
  t: number; // ms from question start
  p: number[]; // flat [x0, y0, x1, y1, ...] coordinates normalized to viewBox
}

export interface StrokeInk {
  v: 1;
  box: [number, number]; // e.g. [1000, 360]
  s: Stroke[];
}

export interface Question {
  id: string;
  categoryId: string;
  type: QuestionType;
  prompt: string;
  options?: string[]; // for multiple choice
  correctAnswer: string;
  points: number; // default 1
  timeLimitSeconds: number; // default 15
  position: number;
}

export interface Category {
  id: string;
  eventId: string;
  title: string;
  position: number;
  /** When true, the night pauses on a BREAK screen after this category's scores. */
  breakAfter: boolean;
  /** Optional label for that break, e.g. "Dinner" or "15 minutes". */
  breakNote?: string | null;
  questions: Question[];
}

export interface TriviaEvent {
  id: string;
  title: string;
  answerMode: AnswerMode;
  categories: Category[];
}

export interface Team {
  id: string;
  sessionId: string;
  name: string;
  /**
   * The 4-digit takeover credential. NEVER present in a snapshot sent to a
   * team or to the big screen — only the host console receives it, and a team
   * learns its own PIN once, from `team.registered`.
   */
  teamPin?: string;
  answerMode: AnswerMode;
  status: 'connected' | 'disconnected';
  score: number;
  joinedAt: number;
}

export interface Submission {
  id: string;
  sessionId: string;
  questionId: string;
  teamId: string;
  teamName: string;
  answerInk?: StrokeInk | null;
  answerRaw?: string | null;
  submittedAt: number;
  isCorrect?: boolean | null; // null = unmarked, true = ✓, false = ✗
  isHidden?: boolean;
}

export interface LiveSessionState {
  sessionId: string;
  eventId: string;
  eventTitle: string;
  joinCode: string;
  status: 'draft' | 'live' | 'ended';
  phase: SessionPhase;
  currentCategoryIndex: number;
  totalCategories?: number;
  currentQuestionIndex: number;
  currentCategory?: {
    id: string;
    title: string;
    totalQuestions: number;
    breakAfter: boolean;
    breakNote?: string | null;
  } | null;
  currentQuestion?: {
    id: string;
    type: QuestionType;
    prompt: string;
    options?: string[];
    /**
     * Only sent to the host, and to the big screen during the board phases.
     * A team's snapshot never carries it — the answer must not be readable
     * from a contestant's device while the timer is running.
     */
    correctAnswer?: string;
    points: number;
    timeLimitSeconds: number;
    position: number;
  } | null;
  questionEndsAt?: number | null; // epoch ms
  /** While set, late submissions for `graceQuestionId` are still accepted. */
  graceUntil?: number | null;
  spotlightTeamId?: string | null;
  answerCount: {
    answered: number;
    connected: number;
    total: number;
  };
  teams: Team[];
  serverTime: number; // epoch ms — clients derive a clock offset from this
}

// WebSocket Message Types
export type ClientMessage =
  | { type: 'join'; payload: { code: string; teamName: string; deviceToken?: string } }
  | { type: 'rejoin'; payload: { code: string; teamName: string; teamPin: string; deviceToken?: string } }
  | { type: 'answer.submit'; payload: { questionId: string; ink?: StrokeInk; text?: string } }
  | { type: 'host.auth'; payload: { token: string; code: string } }
  | { type: 'host.start'; payload?: { idempotencyKey?: string } }
  | { type: 'host.next_phase'; payload?: { idempotencyKey?: string } }
  | { type: 'host.prev_phase'; payload?: { idempotencyKey?: string } }
  | { type: 'host.lock_question'; payload?: { idempotencyKey?: string } }
  | { type: 'host.board_reveal_cards'; payload?: { idempotencyKey?: string } }
  | { type: 'host.mark'; payload: { teamId: string; isCorrect: boolean | null; idempotencyKey?: string } }
  | { type: 'host.mark_all'; payload: { mark: 'correct' | 'wrong' | 'clear'; idempotencyKey?: string } }
  | { type: 'host.toggle_hide_card'; payload: { teamId: string } }
  | { type: 'host.spotlight'; payload: { teamId: string | null } }
  | { type: 'host.confirm_question'; payload?: { idempotencyKey?: string } }
  | { type: 'host.adjust_score'; payload: { teamId: string; deltaPoints: number; reason: string } }
  | { type: 'host.rename_team'; payload: { teamId: string; newName: string } }
  | { type: 'screen.listen'; payload: { code: string } };

export type ServerMessage =
  | { type: 'session.state'; payload: LiveSessionState }
  | { type: 'question.open'; payload: { prompt: string; type: QuestionType; points: number; endsAt: number; options?: string[] } }
  | { type: 'question.locked'; payload: { timestamp: number } }
  | { type: 'answer.count'; payload: { answered: number; total: number } }
  /** Server's verdict on a submission. The phone stays unlocked until this says accepted. */
  | { type: 'answer.ack'; payload: { questionId: string; accepted: boolean; reason?: string } }
  | { type: 'board.answer'; payload: { questionId: string; prompt: string; correctAnswer: string; points: number } }
  | { type: 'board.cards'; payload: { questionId: string; submissions: Submission[] } }
  | { type: 'board.mark'; payload: { teamId: string; isCorrect: boolean | null } }
  /** Batched form of `board.mark` — one frame for a whole mark-all sweep. */
  | { type: 'board.marks'; payload: { marks: { teamId: string; isCorrect: boolean | null }[] } }
  | { type: 'board.spotlight'; payload: { teamId: string | null } }
  | { type: 'leaderboard.update'; payload: { standings: { teamId: string; name: string; score: number; rank: number }[] } }
  | { type: 'team.registered'; payload: { teamId: string; teamName: string; teamPin: string; deviceToken: string } }
  | { type: 'team.taken_over'; payload: { message: string } }
  | { type: 'error'; payload: { message: string; code?: string } };
