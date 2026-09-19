import crypto from 'node:crypto';
import { db } from '../db/client.js';
import type {
  LiveSessionState,
  SessionPhase,
  Team,
  Submission,
  Question,
  Category,
  TriviaEvent,
  StrokeInk,
  QuestionType
} from '@trivia/shared';

export interface InternalQuestion extends Question {
  categoryTitle: string;
}

export class LiveSession {
  sessionId: string;
  eventId: string;
  eventTitle: string;
  joinCode: string;
  status: 'draft' | 'live' | 'ended' = 'live';
  phase: SessionPhase = 'LOBBY';

  categories: Category[] = [];
  flatQuestions: InternalQuestion[] = [];
  currentCategoryIndex = 0;
  currentQuestionIndex = 0;
  boardQuestionIndex = 0; // index within current category being marked on answer board

  questionEndsAt: number | null = null;
  timerHandle: NodeJS.Timeout | null = null;
  spotlightTeamId: string | null = null;

  teams: Map<string, Team> = new Map(); // teamId -> Team
  teamsByToken: Map<string, string> = new Map(); // deviceToken -> teamId
  teamsByName: Map<string, string> = new Map(); // lower(name) -> teamId

  // questionId -> teamId -> Submission
  submissions: Map<string, Map<string, Submission>> = new Map();
  scoreEvents: { id: string; teamId: string; points: number; reason: string }[] = [];

  onStateChange: () => void;
  onBoardMark: (teamId: string, isCorrect: boolean | null) => void;
  onSpotlight: (teamId: string | null) => void;

  constructor(
    sessionId: string,
    eventId: string,
    eventTitle: string,
    joinCode: string,
    callbacks: {
      onStateChange: () => void;
      onBoardMark: (teamId: string, isCorrect: boolean | null) => void;
      onSpotlight: (teamId: string | null) => void;
    }
  ) {
    this.sessionId = sessionId;
    this.eventId = eventId;
    this.eventTitle = eventTitle;
    this.joinCode = joinCode;
    this.onStateChange = callbacks.onStateChange;
    this.onBoardMark = callbacks.onBoardMark;
    this.onSpotlight = callbacks.onSpotlight;

    this.loadEventData();
  }

  private loadEventData() {
    const catRows = db.prepare(`
      SELECT id, title, position FROM categories WHERE event_id = ? ORDER BY position ASC
    `).all(this.eventId) as { id: string; title: string; position: number }[];

    this.categories = [];
    this.flatQuestions = [];

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
        this.submissions.set(q.id, new Map());
      });
    }
  }

  get currentCategory(): Category | undefined {
    return this.categories[this.currentCategoryIndex];
  }

  get currentQuestion(): Question | undefined {
    if (!this.currentCategory) return undefined;
    return this.currentCategory.questions[this.currentQuestionIndex];
  }

  get currentBoardQuestion(): Question | undefined {
    if (!this.currentCategory) return undefined;
    return this.currentCategory.questions[this.boardQuestionIndex];
  }

  // --- Session Control Actions ---

  public startLobbyToCategoryIntro() {
    if (this.categories.length === 0) return;
    this.currentCategoryIndex = 0;
    this.currentQuestionIndex = 0;
    this.boardQuestionIndex = 0;
    this.phase = 'CATEGORY_INTRO';
    this.persistSession();
    this.onStateChange();
  }

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
        // If more questions exist in this category, move to next question live
        if (this.currentCategory && this.currentQuestionIndex + 1 < this.currentCategory.questions.length) {
          this.currentQuestionIndex++;
          this.openCurrentQuestion();
        } else {
          // Category questions finished -> enter ANSWER BOARD for Q1 of this category
          this.boardQuestionIndex = 0;
          this.phase = 'BOARD_ANSWER'; // Stage 1: Official answer displayed, cards face-down
          this.persistSession();
          this.onStateChange();
        }
        break;

      case 'BOARD_ANSWER':
        // Stage 2: Reveal all cards
        this.phase = 'BOARD_CARDS';
        this.persistSession();
        this.onStateChange();
        break;

      case 'BOARD_CARDS':
        // Confirm & advance to next question's board or Category Leaderboard
        if (this.currentCategory && this.boardQuestionIndex + 1 < this.currentCategory.questions.length) {
          this.boardQuestionIndex++;
          this.phase = 'BOARD_ANSWER';
          this.persistSession();
          this.onStateChange();
        } else {
          // All questions in category have been marked -> show Category Scores
          this.phase = 'CATEGORY_SCORES';
          this.recalculateScores();
          this.persistSession();
          this.onStateChange();
        }
        break;

      case 'CATEGORY_SCORES':
        // Next category or finished
        if (this.currentCategoryIndex + 1 < this.categories.length) {
          this.currentCategoryIndex++;
          this.currentQuestionIndex = 0;
          this.boardQuestionIndex = 0;
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

  public prevPhase() {
    // Back navigation safety override
    if (this.phase === 'BOARD_CARDS') {
      this.phase = 'BOARD_ANSWER';
      this.onStateChange();
    } else if (this.phase === 'BOARD_ANSWER' && this.boardQuestionIndex > 0) {
      this.boardQuestionIndex--;
      this.phase = 'BOARD_CARDS';
      this.onStateChange();
    } else if (this.phase === 'QUESTION_LOCKED' && this.currentQuestionIndex > 0) {
      this.currentQuestionIndex--;
      this.phase = 'QUESTION_LOCKED';
      this.onStateChange();
    }
  }

  public openCurrentQuestion() {
    const q = this.currentQuestion;
    if (!q) return;

    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }

    this.phase = 'QUESTION_LIVE';
    const durationMs = (q.timeLimitSeconds || 15) * 1000;
    this.questionEndsAt = Date.now() + durationMs;

    // Pre-create blank submission entries for all teams so accounted for
    const qSubmissions = this.submissions.get(q.id) || new Map<string, Submission>();
    for (const team of this.teams.values()) {
      if (!qSubmissions.has(team.id)) {
        qSubmissions.set(team.id, {
          id: crypto.randomUUID(),
          sessionId: this.sessionId,
          questionId: q.id,
          teamId: team.id,
          teamName: team.name,
          answerInk: null,
          answerRaw: null,
          submittedAt: 0,
          isCorrect: null,
          isHidden: false
        });
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

  public lockCurrentQuestion() {
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.phase = 'QUESTION_LOCKED';
    this.questionEndsAt = null;

    // Pre-mark blank submissions as incorrect (overridable)
    const q = this.currentQuestion;
    if (q) {
      const qSubs = this.submissions.get(q.id);
      if (qSubs) {
        for (const sub of qSubs.values()) {
          const hasContent = (sub.answerInk && sub.answerInk.s && sub.answerInk.s.length > 0) ||
                             (sub.answerRaw && sub.answerRaw.trim().length > 0);
          if (!hasContent) {
            sub.isCorrect = false; // Blank pre-marks as incorrect
          }
        }
      }
    }

    this.persistSession();
    this.onStateChange();
  }

  // --- Submissions ---

  public submitAnswer(teamId: string, ink?: StrokeInk, text?: string): boolean {
    const q = this.currentQuestion;
    if (!q || this.phase !== 'QUESTION_LIVE') return false;

    // Enforce grace window of 1.5s
    const graceWindowMs = 1500;
    if (this.questionEndsAt && Date.now() > this.questionEndsAt + graceWindowMs) {
      return false; // rejected as too late
    }

    const team = this.teams.get(teamId);
    if (!team) return false;

    let qSubs = this.submissions.get(q.id);
    if (!qSubs) {
      qSubs = new Map();
      this.submissions.set(q.id, qSubs);
    }

    const submission: Submission = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      questionId: q.id,
      teamId,
      teamName: team.name,
      answerInk: ink || null,
      answerRaw: text || null,
      submittedAt: Date.now(),
      isCorrect: null,
      isHidden: false
    };

    qSubs.set(teamId, submission);

    // Save to database
    try {
      db.prepare(`
        INSERT INTO submissions (id, session_id, question_id, team_id, answer_ink, answer_raw, submitted_at, is_correct, is_hidden)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, question_id, team_id) DO UPDATE SET
          answer_ink = excluded.answer_ink,
          answer_raw = excluded.answer_raw,
          submitted_at = excluded.submitted_at
      `).run(
        submission.id,
        this.sessionId,
        q.id,
        teamId,
        ink ? JSON.stringify(ink) : null,
        text || null,
        submission.submittedAt,
        null,
        0
      );
    } catch (err) {
      console.error('[DB] Error saving submission:', err);
    }

    this.onStateChange();
    return true;
  }

  // --- Marking on the Answer Board ---

  public markAnswer(teamId: string, isCorrect: boolean | null) {
    const q = this.currentBoardQuestion;
    if (!q) return;

    const qSubs = this.submissions.get(q.id);
    if (!qSubs) return;

    const sub = qSubs.get(teamId);
    if (!sub) return;

    sub.isCorrect = isCorrect;

    try {
      db.prepare(`
        UPDATE submissions SET is_correct = ? WHERE session_id = ? AND question_id = ? AND team_id = ?
      `).run(isCorrect === null ? null : (isCorrect ? 1 : 0), this.sessionId, q.id, teamId);
    } catch (err) {
      console.error('[DB] Error updating mark:', err);
    }

    this.onBoardMark(teamId, isCorrect);
    this.recalculateScores();
  }

  public markAll(mode: 'correct' | 'wrong' | 'clear') {
    const q = this.currentBoardQuestion;
    if (!q) return;

    const qSubs = this.submissions.get(q.id);
    if (!qSubs) return;

    for (const sub of qSubs.values()) {
      const hasContent = (sub.answerInk && sub.answerInk.s.length > 0) || (sub.answerRaw && sub.answerRaw.length > 0);
      if (mode === 'clear') {
        sub.isCorrect = hasContent ? null : false;
      } else if (mode === 'correct') {
        if (hasContent) sub.isCorrect = true;
      } else if (mode === 'wrong') {
        sub.isCorrect = false;
      }

      this.markAnswer(sub.teamId, sub.isCorrect ?? null);
    }
    this.onStateChange();
  }

  public toggleHideCard(teamId: string) {
    const q = this.currentBoardQuestion;
    if (!q) return;
    const qSubs = this.submissions.get(q.id);
    if (!qSubs) return;
    const sub = qSubs.get(teamId);
    if (!sub) return;

    sub.isHidden = !sub.isHidden;
    try {
      db.prepare(`
        UPDATE submissions SET is_hidden = ? WHERE session_id = ? AND question_id = ? AND team_id = ?
      `).run(sub.isHidden ? 1 : 0, this.sessionId, q.id, teamId);
    } catch (err) {
      console.error('[DB] Error toggling card hide:', err);
    }
    this.onStateChange();
  }

  public setSpotlight(teamId: string | null) {
    this.spotlightTeamId = teamId;
    this.onSpotlight(teamId);
    this.onStateChange();
  }

  // --- Team Management ---

  public joinTeam(name: string, deviceToken?: string): Team {
    const cleanName = name.trim();
    const token = deviceToken || crypto.randomUUID();

    // Check if device already registered
    if (this.teamsByToken.has(token)) {
      const existingId = this.teamsByToken.get(token)!;
      const existingTeam = this.teams.get(existingId);
      if (existingTeam) {
        existingTeam.status = 'connected';
        return existingTeam;
      }
    }

    // Disambiguate duplicate name
    let finalName = cleanName;
    let counter = 2;
    while (this.teamsByName.has(finalName.toLowerCase())) {
      finalName = `${cleanName} (${counter++})`;
    }

    const teamId = crypto.randomUUID();
    const pin = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit PIN

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
    if (!team || team.teamPin !== pin.trim()) return null;

    // Associate new device token
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

    this.scoreEvents.push({
      id: crypto.randomUUID(),
      teamId,
      points: deltaPoints,
      reason
    });

    try {
      db.prepare(`
        INSERT INTO score_events (id, session_id, team_id, question_id, points, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), this.sessionId, teamId, null, deltaPoints, reason, Date.now());
    } catch (err) {
      console.error('[DB] Error recording score event:', err);
    }

    this.recalculateScores();
    this.onStateChange();
  }

  public renameTeam(teamId: string, newName: string) {
    const team = this.teams.get(teamId);
    if (!team) return;

    const oldLower = team.name.toLowerCase();
    this.teamsByName.delete(oldLower);

    team.name = newName.trim();
    this.teamsByName.set(team.name.toLowerCase(), teamId);

    try {
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(team.name, teamId);
    } catch (err) {
      console.error('[DB] Error renaming team:', err);
    }

    this.onStateChange();
  }

  public recalculateScores() {
    for (const team of this.teams.values()) {
      let total = 0;

      // Sum correct submissions
      for (const q of this.flatQuestions) {
        const qSubs = this.submissions.get(q.id);
        const sub = qSubs?.get(team.id);
        if (sub && sub.isCorrect === true) {
          total += q.points;
        }
      }

      // Sum manual score adjustment events
      for (const ev of this.scoreEvents) {
        if (ev.teamId === team.id) {
          total += ev.points;
        }
      }

      team.score = total;
    }
  }

  public getBoardCards(): Submission[] {
    const q = this.currentBoardQuestion;
    if (!q) return [];

    const qSubs = this.submissions.get(q.id);
    const result: Submission[] = [];

    // Return in order of joined teams
    for (const team of this.teams.values()) {
      const sub = qSubs?.get(team.id);
      if (sub) {
        result.push(sub);
      } else {
        result.push({
          id: 'blank-' + team.id,
          sessionId: this.sessionId,
          questionId: q.id,
          teamId: team.id,
          teamName: team.name,
          answerInk: null,
          answerRaw: null,
          submittedAt: 0,
          isCorrect: false,
          isHidden: false
        });
      }
    }

    return result;
  }

  public getSnapshot(): LiveSessionState {
    const q = (this.phase === 'BOARD_ANSWER' || this.phase === 'BOARD_CARDS')
      ? this.currentBoardQuestion
      : this.currentQuestion;

    const qSubs = q ? this.submissions.get(q.id) : null;
    let answeredCount = 0;
    if (qSubs) {
      for (const sub of qSubs.values()) {
        if ((sub.answerInk && sub.answerInk.s.length > 0) || (sub.answerRaw && sub.answerRaw.length > 0)) {
          answeredCount++;
        }
      }
    }

    return {
      sessionId: this.sessionId,
      eventId: this.eventId,
      eventTitle: this.eventTitle,
      joinCode: this.joinCode,
      status: this.status,
      phase: this.phase,
      currentCategoryIndex: this.currentCategoryIndex,
      currentQuestionIndex: (this.phase === 'BOARD_ANSWER' || this.phase === 'BOARD_CARDS')
        ? this.boardQuestionIndex
        : this.currentQuestionIndex,
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
        correctAnswer: q.correctAnswer,
        points: q.points,
        timeLimitSeconds: q.timeLimitSeconds,
        position: q.position
      } : null,
      questionEndsAt: this.questionEndsAt,
      spotlightTeamId: this.spotlightTeamId,
      answerCount: {
        answered: answeredCount,
        total: this.teams.size
      },
      teams: Array.from(this.teams.values()),
      serverTime: Date.now()
    };
  }

  private persistSession() {
    try {
      db.prepare(`
        UPDATE sessions SET
          status = ?, phase = ?, current_category_id = ?, current_question_id = ?,
          question_ends_at = ?, spotlight_team_id = ?
        WHERE id = ?
      `).run(
        this.status,
        this.phase,
        this.currentCategory?.id || null,
        this.currentQuestion?.id || null,
        this.questionEndsAt,
        this.spotlightTeamId,
        this.sessionId
      );
    } catch (err) {
      console.error('[DB] Error updating session row:', err);
    }
  }
}
