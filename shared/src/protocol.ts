export type AnswerMode = 'ink' | 'text';

export type SessionPhase =
  | 'DRAFT'
  | 'LOBBY'
  | 'CATEGORY_INTRO'
  | 'QUESTION_LIVE'
  | 'QUESTION_LOCKED'
  | 'BOARD_ANSWER'
  | 'BOARD_CARDS'
  | 'CATEGORY_SCORES'
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
  teamPin: string;
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
  currentQuestionIndex: number;
  currentCategory?: {
    id: string;
    title: string;
    totalQuestions: number;
  } | null;
  currentQuestion?: {
    id: string;
    type: QuestionType;
    prompt: string;
    options?: string[];
    correctAnswer: string;
    points: number;
    timeLimitSeconds: number;
    position: number;
  } | null;
  questionEndsAt?: number | null; // epoch ms
  spotlightTeamId?: string | null;
  answerCount: {
    answered: number;
    total: number;
  };
  teams: Team[];
  serverTime: number; // epoch ms for clock offset synchronization
}

// WebSocket Message Types
export type ClientMessage =
  | { type: 'join'; payload: { code: string; teamName: string; deviceToken?: string } }
  | { type: 'rejoin'; payload: { code: string; teamName: string; teamPin: string; deviceToken?: string } }
  | { type: 'answer.submit'; payload: { questionId: string; ink?: StrokeInk; text?: string } }
  | { type: 'host.auth'; payload: { token: string } }
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
  | { type: 'board.answer'; payload: { questionId: string; prompt: string; correctAnswer: string; points: number } }
  | { type: 'board.cards'; payload: { questionId: string; submissions: Submission[] } }
  | { type: 'board.mark'; payload: { teamId: string; isCorrect: boolean | null } }
  | { type: 'board.spotlight'; payload: { teamId: string | null } }
  | { type: 'leaderboard.update'; payload: { standings: { teamId: string; name: string; score: number; rank: number }[] } }
  | { type: 'team.registered'; payload: { teamId: string; teamName: string; teamPin: string; deviceToken: string } }
  | { type: 'error'; payload: { message: string; code?: string } };
