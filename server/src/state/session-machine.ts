import crypto from 'node:crypto';
import { db } from '../db/client.js';
import type {
  ClientRole,
  LiveSessionState,
  SessionPhase,
  Team,
  Submission,
  Question,
  Category,
  StrokeInk,
  QuestionType
} from '@trivia/shared';

export interface InternalQuestion extends Question {
  categoryTitle: string;
}

export interface SubmitResult {
  accepted: boolean;
  reason?: string;
}

/** Late answers are still accepted this long after the timer expires. */
export const GRACE_WINDOW_MS = 1500;

export class LiveSession {
  sessionId: string;
  eventId: string;
  eventTitle: string;
  joinCode: string;
  status: 'draft' | 'live' | 'ended' = 'live';
  phase: SessionPhase = 'LOBBY';

  categories: Category[] = [];
  flatQuestions: InternalQuestion[] = [];
  questionPoints: Map<string, number> = new Map();
  currentCategoryIndex = 0;
  currentQuestionIndex = 0;

  questionEndsAt: number | null = null;
  timerHandle: NodeJS.Timeout | null = null;
  spotlightTeamId: string | null = null;

  // A question stays submittable for GRACE_WINDOW_MS after it locks, so an
  // answer sent on time but delayed in flight is not thrown away.
  graceQuestionId: string | null = null;
  graceUntil: number | null = null;

  teams: Map<string, Team> = new Map(); // teamId -> Team
  teamsByToken: Map<string, string> = new Map(); // deviceToken -> teamId
  teamsByName: Map<string, string> = new Map(); // lower(name) -> teamId

  // questionId -> teamId -> Submission
  submissions: Map<string, Map<string, Submission>> = new Map();
  scoreEvents: { id: string; teamId: string; points: number; reason: string }[] = [];

  onStateChange: () => void;
  onBoardMark: (teamId: string, isCorrect: boolean | null) => void;
  onBoardMarks: (marks: { teamId: string; isCorrect: boolean | null }[]) => void;
  onSpotlight: (teamId: string | null) => void;

  constructor(
    sessionId: string,
    eventId: string,
    eventTitle: string,
    joinCode: string,
    callbacks: {
      onStateChange: () => void;
      onBoardMark: (teamId: string, isCorrect: boolean | null) => void;
      onBoardMarks: (marks: { teamId: string; isCorrect: boolean | null }[]) => void;
      onSpotlight: (teamId: string | null) => void;
    }
  ) {
    this.sessionId = sessionId;
    this.eventId = eventId;
    this.eventTitle = eventTitle;
    this.joinCode = joinCode;
    this.onStateChange = callbacks.onStateChange;
    this.onBoardMark = callbacks.onBoardMark;
    this.onBoardMarks = callbacks.onBoardMarks;
    this.onSpotlight = callbacks.onSpotlight;

    this.loadEventData();
  }

  private loadEventData() {
    const catRows = db.prepare(`
      SELECT id, title, position FROM categories WHERE event_id = ? ORDER BY position ASC
    `).all(this.eventId) as { id: string; title: string; position: number }[];

    this.categories = [];
    this.flatQuestions = [];
    this.questionPoints.clear();

    for (const cat of catRows) {
      const qRows = db.prepare(`
        SELECT id, category_id, type, prompt, options_json, correct_answer, points, time_limit_seconds, position
        FROM questions WHERE category_id = ? ORDER BY position ASC
      `).all(cat.id) as any[];

      const questions: Question[] = qRows.map(q => ({
        id: q.id,
        categoryId: q.category_id,
        type: q.type as QuestionType,
        prompt: q.prompt,
        options: q.options_json ? JSON.parse(q.options_json) : undefined,
        correctAnswer: q.correct_answer,
        points: q.points,
        timeLimitSeconds: q.time_limit_seconds,
        position: q.position
      }));

      this.categories.push({
        id: cat.id,
        eventId: this.eventId,
        title: cat.title,
        position: cat.position,
        questions
      });

      questions.forEach(q => {
        this.flatQuestions.push({ ...q, categoryTitle: cat.title });
        this.questionPoints.set(q.id, q.points);
        this.submissions.set(q.id, new Map());
      });
    }
  }

  /**
   * Restores live progress after a process restart. Without this every
   * rehydrated session would resume at the constructor defaults — LOBBY,
   * category 0 — and drop a room mid-event back to the start.
   */
  public restoreProgress(row: {
    phase?: string | null;
    status?: string | null;
    current_category_index?: number | null;
    current_question_index?: number | null;
  }) {
    const clamp = (n: number | null | undefined, max: number) =>
      Math.min(Math.max(Number(n) || 0, 0), Math.max(max, 0));

    if (row.status === 'draft' || row.status === 'live' || row.status === 'ended') {
      this.status = row.status;
    }
    if (row.phase) this.phase = row.phase as SessionPhase;

    this.currentCategoryIndex = clamp(row.current_category_index, this.categories.length - 1);
    const catQuestions = this.currentCategory?.questions.length ?? 1;
    this.currentQuestionIndex = clamp(row.current_question_index, catQuestions - 1);

    // A question cannot still be "live" across a restart: its timer died with
    // the old process. Resume it locked so the host decides what happens next.
    if (this.phase === 'QUESTION_LIVE') {
      this.phase = 'QUESTION_LOCKED';
      this.questionEndsAt = null;
    }
  }

  get currentCategory(): Category | undefined {
    return this.categories[this.currentCategoryIndex];
  }

  get currentQuestion(): Question | undefined {
    if (!this.currentCategory) return undefined;
    return this.currentCategory.questions[this.currentQuestionIndex];
  }

  /**
   * The board always shows the question that just closed, so it is simply the
   * current question. Kept as a named getter because the board phases read
   * better through it, and callers elsewhere already use it.
   */
  get currentBoardQuestion(): Question | undefined {
    return this.currentQuestion;
  }

  // --- Session Control Actions ---

  public startLobbyToCategoryIntro() {
    if (this.categories.length === 0) return;
    this.currentCategoryIndex = 0;
    this.currentQuestionIndex = 0;
    this.phase = 'CATEGORY_INTRO';
    this.persistSession();
    this.onStateChange();
  }

  private get isLastQuestionInCategory(): boolean {
    const cat = this.currentCategory;
    return !cat || this.currentQuestionIndex + 1 >= cat.questions.length;
  }

  /**
   * One question, one board. Each question closes, its answer goes up, the
   * cards are revealed and marked, and only then does the next question open:
   *
   *   CATEGORY_INTRO
   *     └─ QUESTION_LIVE → QUESTION_LOCKED → BOARD_ANSWER → BOARD_CARDS ─┐
   *          ↑                                                           │
   *          └──────────────── next question in category ────────────────┘
   *     └─ after the last question → CATEGORY_SCORES → next category
   */
  public nextPhase() {
    switch (this.phase) {
      case 'LOBBY':
        this.startLobbyToCategoryIntro();
        break;

      case 'CATEGORY_INTRO':
        this.openCurrentQuestion();
        break;

      case 'QUESTION_LIVE':
        this.lockCurrentQuestion();
        break;

      case 'QUESTION_LOCKED':
        // The board follows immediately: answer up, cards still face-down.
        this.phase = 'BOARD_ANSWER';
        this.persistSession();
        this.onStateChange();
        break;

      case 'BOARD_ANSWER':
        // Stage 2: reveal every team's handwriting at once.
        this.phase = 'BOARD_CARDS';
        this.persistSession();
        this.onStateChange();
        break;

      case 'BOARD_CARDS':
        // Marking confirmed. Next question, or the category leaderboard.
        this.recalculateScores();
        if (!this.isLastQuestionInCategory) {
          this.currentQuestionIndex++;
          this.openCurrentQuestion();
        } else {
          this.phase = 'CATEGORY_SCORES';
          this.persistSession();
          this.onStateChange();
        }
        break;

      case 'CATEGORY_SCORES':
        // Next category or finished
        if (this.currentCategoryIndex + 1 < this.categories.length) {
          this.currentCategoryIndex++;
          this.currentQuestionIndex = 0;
          this.phase = 'CATEGORY_INTRO';
          this.persistSession();
          this.onStateChange();
        } else {
          this.phase = 'FINISHED';
          this.status = 'ended';
          this.persistSession();
          this.onStateChange();
        }
        break;

      default:
        break;
    }
  }

  /**
   * Back navigation, so the host can re-open a board and fix a mark. Walks the
   * per-question cycle in reverse; from a question's board it steps back into
   * the previous question's board rather than re-opening a closed timer.
   */
  public prevPhase() {
    switch (this.phase) {
      case 'BOARD_CARDS':
        this.phase = 'BOARD_ANSWER';
        break;

      case 'BOARD_ANSWER':
        this.phase = 'QUESTION_LOCKED';
        break;

      case 'QUESTION_LIVE':
      case 'QUESTION_LOCKED': {
        if (this.currentQuestionIndex === 0) return;
        if (this.timerHandle) {
          clearTimeout(this.timerHandle);
          this.timerHandle = null;
        }
        this.questionEndsAt = null;
        this.graceQuestionId = null;
        this.graceUntil = null;
        this.currentQuestionIndex--;
        this.phase = 'BOARD_CARDS'; // re-open the previous question's board
        break;
      }

      case 'CATEGORY_SCORES':
        // Back into the board for the category's final question.
        this.phase = 'BOARD_CARDS';
        break;

      default:
        return;
    }

    this.spotlightTeamId = null;
    this.persistSession();
    this.onStateChange();
  }

  public openCurrentQuestion() {
    const q = this.currentQuestion;
    if (!q) return;

    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }

    this.phase = 'QUESTION_LIVE';
    this.graceQuestionId = null;
    this.graceUntil = null;
    this.spotlightTeamId = null; // a spotlight belongs to the board just closed
    const durationMs = (q.timeLimitSeconds || 15) * 1000;
    this.questionEndsAt = Date.now() + durationMs;

    // Blank placeholders so every team is accounted for on the board.
    const qSubmissions = this.submissions.get(q.id) || new Map<string, Submission>();
    for (const team of this.teams.values()) {
      if (!qSubmissions.has(team.id)) {
        qSubmissions.set(team.id, this.blankSubmission(q.id, team));
      }
    }
    this.submissions.set(q.id, qSubmissions);

    // Auto lock when timer expires
    this.timerHandle = setTimeout(() => {
      if (this.phase === 'QUESTION_LIVE') {
        this.lockCurrentQuestion();
      }
    }, durationMs);

    this.persistSession();
    this.onStateChange();
  }

  /**
   * Locks the live question. Guarded on phase: a stray `host.lock_question`
   * during a board phase must not rewind the session and re-run the blank
   * pre-marking pass over marks the host has already set.
   */
  public lockCurrentQuestion(): boolean {
    if (this.phase !== 'QUESTION_LIVE') return false;

    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.phase = 'QUESTION_LOCKED';

    const q = this.currentQuestion;
    if (q) {
      // Keep accepting in-flight answers for a moment after the cutoff, where
      // the cutoff is whichever came first: the timer expiring, or the host
      // locking early. Anchoring on questionEndsAt alone would hand a manual
      // early lock the whole remaining countdown as grace.
      const cutoff = Math.min(this.questionEndsAt ?? Date.now(), Date.now());
      this.graceQuestionId = q.id;
      this.graceUntil = cutoff + GRACE_WINDOW_MS;

      // Pre-mark blank submissions as incorrect (overridable by the host, and
      // cleared again if a grace-window answer lands for that team).
      const qSubs = this.submissions.get(q.id);
      if (qSubs) {
        const touched: Submission[] = [];
        for (const sub of qSubs.values()) {
          if (!this.hasContent(sub) && sub.isCorrect !== false) {
            sub.isCorrect = false;
            touched.push(sub);
          }
        }
        this.persistSubmissions(touched);
      }
    }

    this.questionEndsAt = null;
    this.persistSession();
    this.onStateChange();
    return true;
  }

  // --- Submissions ---

  private hasContent(sub: Submission): boolean {
    return Boolean(
      (sub.answerInk && sub.answerInk.s && sub.answerInk.s.length > 0) ||
      (sub.answerRaw && sub.answerRaw.trim().length > 0)
    );
  }

  private blankSubmission(questionId: string, team: Team): Submission {
    return {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      questionId,
      teamId: team.id,
      teamName: team.name,
      answerInk: null,
      answerRaw: null,
      submittedAt: 0,
      isCorrect: null,
      isHidden: false
    };
  }

  /** Returns the submission record for a team, creating a blank one if absent. */
  private ensureSubmission(questionId: string, teamId: string): Submission | null {
    const team = this.teams.get(teamId);
    if (!team) return null;

    let qSubs = this.submissions.get(questionId);
    if (!qSubs) {
      qSubs = new Map();
      this.submissions.set(questionId, qSubs);
    }

    let sub = qSubs.get(teamId);
    if (!sub) {
      sub = this.blankSubmission(questionId, team);
      qSubs.set(teamId, sub);
    }
    return sub;
  }

  public submitAnswer(teamId: string, questionId: string, ink?: StrokeInk, text?: string): SubmitResult {
    const team = this.teams.get(teamId);
    if (!team) return { accepted: false, reason: 'Team is not registered in this session' };

    const now = Date.now();
    const live = this.currentQuestion;

    // Accept either the open question, or the one that just locked while this
    // answer was still in flight.
    let targetId: string | null = null;
    if (this.phase === 'QUESTION_LIVE' && live) {
      if (this.questionEndsAt && now > this.questionEndsAt + GRACE_WINDOW_MS) {
        return { accepted: false, reason: 'The timer for this question has closed' };
      }
      targetId = live.id;
    } else if (
      this.phase === 'QUESTION_LOCKED' &&
      this.graceQuestionId &&
      this.graceUntil &&
      now <= this.graceUntil
    ) {
      targetId = this.graceQuestionId;
    }

    if (!targetId) {
      return { accepted: false, reason: 'The timer for this question has closed' };
    }

    // Guard against a phone that woke up holding a stale question.
    if (questionId && questionId !== targetId) {
      return { accepted: false, reason: 'That answer was for a previous question' };
    }

    const sub = this.ensureSubmission(targetId, teamId);
    if (!sub) return { accepted: false, reason: 'Team is not registered in this session' };

    const hasInk = Boolean(ink && ink.s && ink.s.length > 0);
    const hasText = Boolean(text && text.trim().length > 0);

    sub.answerInk = hasInk ? ink! : null;
    sub.answerRaw = hasText ? text!.trim() : null;
    sub.submittedAt = now;
    sub.teamName = team.name;
    sub.isHidden = false;
    // A grace-window answer arrives after lock() pre-marked the blank card
    // incorrect; hand it back to the host unmarked if it contains an answer.
    if (hasInk || hasText) {
      sub.isCorrect = null;
    }

    this.persistSubmissions([sub]);
    this.onStateChange();
    return { accepted: true };
  }

  // --- Marking on the Answer Board ---

  public markAnswer(teamId: string, isCorrect: boolean | null) {
    const q = this.currentBoardQuestion;
    if (!q) return;

    const sub = this.ensureSubmission(q.id, teamId);
    if (!sub) return;

    sub.isCorrect = isCorrect;
    this.persistSubmissions([sub]);

    this.onBoardMark(teamId, isCorrect);
    this.recalculateScores();
    this.onStateChange();
  }

  /**
   * Sweeps every card on the current board question. Does the whole pass in
   * one place — one transaction, one rescore, one broadcast — rather than
   * routing each team through markAnswer, which used to cost a DB write, a
   * full rescore and a separate frame per team.
   */
  public markAll(mode: 'correct' | 'wrong' | 'clear') {
    const q = this.currentBoardQuestion;
    if (!q) return;

    const touched: Submission[] = [];
    const marks: { teamId: string; isCorrect: boolean | null }[] = [];

    for (const team of this.teams.values()) {
      const sub = this.ensureSubmission(q.id, team.id);
      if (!sub) continue;

      const content = this.hasContent(sub);
      let next: boolean | null;
      if (mode === 'clear') {
        next = content ? null : false;
      } else if (mode === 'correct') {
        next = content ? true : false; // a blank card is never "correct"
      } else {
        next = false;
      }

      if (sub.isCorrect !== next) {
        sub.isCorrect = next;
        touched.push(sub);
      }
      marks.push({ teamId: team.id, isCorrect: next });
    }

    this.persistSubmissions(touched);
    this.recalculateScores();
    this.onBoardMarks(marks);
    this.onStateChange();
  }

  public toggleHideCard(teamId: string) {
    const q = this.currentBoardQuestion;
    if (!q) return;
    const sub = this.ensureSubmission(q.id, teamId);
    if (!sub) return;

    sub.isHidden = !sub.isHidden;
    this.persistSubmissions([sub]);
    this.onStateChange();
  }

  public setSpotlight(teamId: string | null) {
    this.spotlightTeamId = teamId;
    this.onSpotlight(teamId);
    this.onStateChange();
  }

  // --- Team Management ---

  public joinTeam(name: string, deviceToken?: string): Team {
    const cleanName = name.trim().slice(0, 30);
    const token = deviceToken || crypto.randomUUID();

    // Check if device already registered
    if (this.teamsByToken.has(token)) {
      const existingId = this.teamsByToken.get(token)!;
      const existingTeam = this.teams.get(existingId);
      if (existingTeam) {
        existingTeam.status = 'connected';
        this.onStateChange();
        return existingTeam;
      }
    }

    // Disambiguate duplicate name
    let finalName = cleanName || 'Team';
    let counter = 2;
    while (this.teamsByName.has(finalName.toLowerCase())) {
      finalName = `${cleanName || 'Team'} (${counter++})`;
    }

    const teamId = crypto.randomUUID();
    const pin = crypto.randomInt(1000, 10000).toString(); // 4-digit PIN

    const team: Team = {
      id: teamId,
      sessionId: this.sessionId,
      name: finalName,
      teamPin: pin,
      answerMode: 'ink',
      status: 'connected',
      score: 0,
      joinedAt: Date.now()
    };

    this.teams.set(teamId, team);
    this.teamsByToken.set(token, teamId);
    this.teamsByName.set(finalName.toLowerCase(), teamId);

    try {
      db.prepare(`
        INSERT INTO teams (id, session_id, name, device_token, team_pin, answer_mode, status, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(teamId, this.sessionId, finalName, token, pin, 'ink', 'connected', team.joinedAt);
    } catch (err) {
      console.error('[DB] Error inserting team:', err);
    }

    this.onStateChange();
    return team;
  }

  public rejoinTeam(name: string, pin: string, newDeviceToken: string): Team | null {
    const lower = name.trim().toLowerCase();
    const teamId = this.teamsByName.get(lower);
    if (!teamId) return null;

    const team = this.teams.get(teamId);
    if (!team || !team.teamPin) return null;

    // Constant-time compare so the PIN cannot be probed by timing.
    const given = Buffer.from(pin.trim());
    const expected = Buffer.from(team.teamPin);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

    // The takeover device replaces the old one: drop every previous token so a
    // dead phone that comes back cannot keep acting as this team.
    for (const [tok, id] of this.teamsByToken.entries()) {
      if (id === teamId) this.teamsByToken.delete(tok);
    }
    this.teamsByToken.set(newDeviceToken, teamId);
    team.status = 'connected';

    try {
      db.prepare(`
        UPDATE teams SET device_token = ?, status = 'connected' WHERE id = ?
      `).run(newDeviceToken, teamId);
    } catch (err) {
      console.error('[DB] Error updating team device token:', err);
    }

    this.onStateChange();
    return team;
  }

  public adjustScore(teamId: string, deltaPoints: number, reason: string) {
    const team = this.teams.get(teamId);
    if (!team) return;

    const delta = Math.trunc(Number(deltaPoints) || 0);
    const id = crypto.randomUUID();

    this.scoreEvents.push({ id, teamId, points: delta, reason });

    try {
      db.prepare(`
        INSERT INTO score_events (id, session_id, team_id, question_id, points, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, this.sessionId, teamId, null, delta, reason, Date.now());
    } catch (err) {
      console.error('[DB] Error recording score event:', err);
    }

    this.recalculateScores();
    this.onStateChange();
  }

  public renameTeam(teamId: string, newName: string) {
    const team = this.teams.get(teamId);
    if (!team) return;

    const cleaned = newName.trim().slice(0, 30);
    if (!cleaned) return;

    const existing = this.teamsByName.get(cleaned.toLowerCase());
    if (existing && existing !== teamId) return; // refuse to create a duplicate

    this.teamsByName.delete(team.name.toLowerCase());
    team.name = cleaned;
    this.teamsByName.set(cleaned.toLowerCase(), teamId);

    // Cards carry a denormalized team name; keep them in step.
    for (const qSubs of this.submissions.values()) {
      const sub = qSubs.get(teamId);
      if (sub) sub.teamName = cleaned;
    }

    try {
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(cleaned, teamId);
    } catch (err) {
      console.error('[DB] Error renaming team:', err);
    }

    this.onStateChange();
  }

  /**
   * Totals are derived, never stored. Walks the submissions once per team
   * rather than the whole question list, so a mark-all sweep on a 24-team
   * board stays linear instead of quadratic.
   */
  public recalculateScores() {
    const totals = new Map<string, number>();
    for (const teamId of this.teams.keys()) totals.set(teamId, 0);

    for (const [questionId, qSubs] of this.submissions.entries()) {
      const points = this.questionPoints.get(questionId) ?? 0;
      if (!points) continue;
      for (const sub of qSubs.values()) {
        if (sub.isCorrect === true && totals.has(sub.teamId)) {
          totals.set(sub.teamId, totals.get(sub.teamId)! + points);
        }
      }
    }

    for (const ev of this.scoreEvents) {
      if (totals.has(ev.teamId)) {
        totals.set(ev.teamId, totals.get(ev.teamId)! + ev.points);
      }
    }

    for (const team of this.teams.values()) {
      team.score = totals.get(team.id) ?? 0;
    }
  }

  public getBoardCards(): Submission[] {
    const q = this.currentBoardQuestion;
    if (!q) return [];

    const result: Submission[] = [];
    for (const team of this.teams.values()) {
      const sub = this.ensureSubmission(q.id, team.id);
      if (sub) result.push(sub);
    }
    return result;
  }

  public getTeamSubmission(questionId: string, teamId: string): Submission | null {
    return this.ensureSubmission(questionId, teamId);
  }

  /**
   * Builds the snapshot for one role. The host sees everything; the big screen
   * sees the correct answer only once the board is up; a team never sees the
   * correct answer or anybody's takeover PIN.
   */
  public getSnapshot(role: ClientRole = 'team'): LiveSessionState {
    const onBoard = this.phase === 'BOARD_ANSWER' || this.phase === 'BOARD_CARDS';
    const q = this.currentQuestion;

    const qSubs = q ? this.submissions.get(q.id) : null;
    let answeredCount = 0;
    if (qSubs) {
      for (const sub of qSubs.values()) {
        if (this.hasContent(sub)) answeredCount++;
      }
    }

    let connected = 0;
    for (const team of this.teams.values()) {
      if (team.status === 'connected') connected++;
    }

    const maySeeAnswer = role === 'host' || (role === 'screen' && onBoard);
    const maySeePins = role === 'host';

    const teams: Team[] = Array.from(this.teams.values()).map(t => ({
      id: t.id,
      sessionId: t.sessionId,
      name: t.name,
      ...(maySeePins ? { teamPin: t.teamPin } : {}),
      answerMode: t.answerMode,
      status: t.status,
      score: t.score,
      joinedAt: t.joinedAt
    }));

    return {
      sessionId: this.sessionId,
      eventId: this.eventId,
      eventTitle: this.eventTitle,
      joinCode: this.joinCode,
      status: this.status,
      phase: this.phase,
      currentCategoryIndex: this.currentCategoryIndex,
      currentQuestionIndex: this.currentQuestionIndex,
      currentCategory: this.currentCategory ? {
        id: this.currentCategory.id,
        title: this.currentCategory.title,
        totalQuestions: this.currentCategory.questions.length
      } : null,
      currentQuestion: q ? {
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        ...(maySeeAnswer ? { correctAnswer: q.correctAnswer } : {}),
        points: q.points,
        timeLimitSeconds: q.timeLimitSeconds,
        position: q.position
      } : null,
      questionEndsAt: this.questionEndsAt,
      graceUntil: this.graceUntil,
      spotlightTeamId: this.spotlightTeamId,
      answerCount: {
        answered: answeredCount,
        connected,
        total: this.teams.size
      },
      teams,
      serverTime: Date.now()
    };
  }

  private persistSubmissions(subs: Submission[]) {
    if (subs.length === 0) return;
    try {
      const stmt = db.prepare(`
        INSERT INTO submissions (id, session_id, question_id, team_id, answer_ink, answer_raw, submitted_at, is_correct, is_hidden)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, question_id, team_id) DO UPDATE SET
          answer_ink = excluded.answer_ink,
          answer_raw = excluded.answer_raw,
          submitted_at = excluded.submitted_at,
          is_correct = excluded.is_correct,
          is_hidden = excluded.is_hidden
      `);

      db.exec('BEGIN');
      try {
        for (const sub of subs) {
          stmt.run(
            sub.id,
            this.sessionId,
            sub.questionId,
            sub.teamId,
            sub.answerInk ? JSON.stringify(sub.answerInk) : null,
            sub.answerRaw ?? null,
            sub.submittedAt,
            sub.isCorrect == null ? null : (sub.isCorrect ? 1 : 0),
            sub.isHidden ? 1 : 0
          );
        }
        db.exec('COMMIT');
      } catch (inner) {
        db.exec('ROLLBACK');
        throw inner;
      }
    } catch (err) {
      console.error('[DB] Error persisting submissions:', err);
    }
  }

  private persistSession() {
    try {
      db.prepare(`
        UPDATE sessions SET
          status = ?, phase = ?, current_category_id = ?, current_question_id = ?,
          current_category_index = ?, current_question_index = ?,
          question_ends_at = ?, spotlight_team_id = ?, ended_at = ?
        WHERE id = ?
      `).run(
        this.status,
        this.phase,
        this.currentCategory?.id || null,
        (this.phase === 'BOARD_ANSWER' || this.phase === 'BOARD_CARDS'
          ? this.currentBoardQuestion?.id
          : this.currentQuestion?.id) || null,
        this.currentCategoryIndex,
        this.currentQuestionIndex,
        this.questionEndsAt,
        this.spotlightTeamId,
        this.status === 'ended' ? Date.now() : null,
        this.sessionId
      );
    } catch (err) {
      console.error('[DB] Error updating session row:', err);
    }
  }
}
