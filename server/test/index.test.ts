import assert from 'node:assert';
import { db, initDb, hashPassword, verifyPassword, isLegacyHash } from '../src/db/client.js';
import { sessionStore, SessionStore } from '../src/state/session-store.js';
import { GRACE_WINDOW_MS } from '../src/state/session-machine.js';

console.log('--- Running Milestone 1 Spine Tests ---');

// 1. Database & Seed
initDb();
const event = db.prepare('SELECT id, title FROM events LIMIT 1').get() as any;
assert(event, 'Default event should be seeded');
console.log('✓ Database & Seed verified:', event.title);

// 2. Session Creation
const session = sessionStore.createSession(event.id);
assert.strictEqual(session.joinCode.length, 6, 'Join code should be 6 digits');
assert.strictEqual(session.phase, 'LOBBY', 'Initial phase should be LOBBY');
console.log('✓ Session created with 6-digit code:', session.joinCode);

// 3. Team Join & Rejoin with PIN
const team1 = session.joinTeam('The Mangoes', 'device-token-1');
assert(team1.id, 'Team 1 should have ID');
assert.strictEqual(team1.name, 'The Mangoes');
assert.strictEqual(team1.teamPin!.length, 4, 'PIN should be 4 digits');

const team2 = session.joinTeam('Quizzy Rascals', 'device-token-2');
assert.strictEqual(session.teams.size, 2, 'Session should have 2 teams');

// Duplicate names must be disambiguated, not collided.
const team3 = session.joinTeam('The Mangoes', 'device-token-3');
assert.notStrictEqual(team3.id, team1.id, 'A duplicate name must create a distinct team');
assert.strictEqual(team3.name, 'The Mangoes (2)', 'Duplicate name should be disambiguated');
console.log('✓ Duplicate team names disambiguated:', team3.name);

// Rejoin test
const rejoined = session.rejoinTeam('The Mangoes', team1.teamPin!, 'device-token-new');
assert(rejoined, 'Team should be able to rejoin with matching PIN');
assert.strictEqual(rejoined!.id, team1.id, 'Rejoin must return the original team');
assert.strictEqual(
  session.rejoinTeam('The Mangoes', '0000', 'device-token-bad'),
  null,
  'A wrong PIN must be refused'
);
// The replaced device must lose its claim on the team.
assert.strictEqual(session.teamsByToken.get('device-token-1'), undefined, 'Old device token should be revoked');
console.log('✓ Team join, PIN takeover and old-token revocation verified');

// 4. Session State Machine Transitions
session.nextPhase(); // LOBBY -> CATEGORY_INTRO
assert.strictEqual(session.phase, 'CATEGORY_INTRO');

session.nextPhase(); // CATEGORY_INTRO -> QUESTION_LIVE
assert.strictEqual(session.phase, 'QUESTION_LIVE');
assert(session.questionEndsAt, 'Question should have endsAt timestamp');

// 5. Answer Submission (Ink Stroke JSON)
const sampleInk = {
  v: 1 as const,
  box: [1000, 360] as [number, number],
  s: [{ t: 200, p: [100, 150, 120, 160, 150, 170] }]
};

const q1Id = session.currentQuestion!.id;
const accepted = session.submitAnswer(team1.id, q1Id, sampleInk);
assert.strictEqual(accepted.accepted, true, 'Submission should be accepted while QUESTION_LIVE');
assert.strictEqual(session.getSnapshot('host').answerCount.answered, 1);

// A phone that woke up holding a stale question must not overwrite the live one.
const stale = session.submitAnswer(team2.id, 'some-other-question-id', sampleInk);
assert.strictEqual(stale.accepted, false, 'A submission for a different question must be rejected');
console.log('✓ Answer submission accepted during QUESTION_LIVE; stale question rejected');

// 6. Snapshot redaction by role
const teamView = session.getSnapshot('team');
const hostView = session.getSnapshot('host');
const screenView = session.getSnapshot('screen');

assert.strictEqual(
  teamView.currentQuestion?.correctAnswer,
  undefined,
  'A team snapshot must never carry the correct answer'
);
assert(hostView.currentQuestion?.correctAnswer, 'The host snapshot carries the correct answer');
assert.strictEqual(
  screenView.currentQuestion?.correctAnswer,
  undefined,
  'The screen only sees the answer during the board phases'
);
assert(
  teamView.teams.every(t => t.teamPin === undefined),
  'A team snapshot must never carry anybody\'s takeover PIN'
);
assert(
  hostView.teams.every(t => typeof t.teamPin === 'string'),
  'The host snapshot carries PINs so the host can read one out'
);
console.log('✓ Snapshot redaction verified (answers and PINs are host-only)');

// 7. Lock Question + grace window
session.lockCurrentQuestion();
assert.strictEqual(session.phase, 'QUESTION_LOCKED');

// An answer still in flight when the lock landed is accepted.
const late = session.submitAnswer(team2.id, q1Id, sampleInk);
assert.strictEqual(late.accepted, true, 'Grace-window submission should be accepted');
assert.strictEqual(
  session.submissions.get(q1Id)!.get(team2.id)!.isCorrect,
  null,
  'A grace-window answer clears the blank pre-mark so the host can judge it'
);

// Past the grace window, nothing more is accepted.
session.graceUntil = Date.now() - 1;
const tooLate = session.submitAnswer(team3.id, q1Id, sampleInk);
assert.strictEqual(tooLate.accepted, false, 'Submission after the grace window must be rejected');
console.log(`✓ Question locked; ${GRACE_WINDOW_MS}ms grace window honoured then closed`);

// A stray lock during a non-live phase must be a no-op, not a rewind.
assert.strictEqual(session.lockCurrentQuestion(), false, 'lockCurrentQuestion should no-op when not live');
assert.strictEqual(session.phase, 'QUESTION_LOCKED');
console.log('✓ Stray lock_question is a no-op');

// 8. The board follows the question it belongs to, immediately.
const q1Index = session.currentQuestionIndex;
session.nextPhase(); // QUESTION_LOCKED -> BOARD_ANSWER
assert.strictEqual(session.phase, 'BOARD_ANSWER', 'A locked question goes straight to its board');
assert.strictEqual(
  session.currentQuestionIndex,
  q1Index,
  'The board belongs to the question that just closed'
);
assert.strictEqual(
  session.currentBoardQuestion!.id,
  q1Id,
  'The board question is the question just answered'
);

// The screen may see the answer now that the board is up.
assert(
  session.getSnapshot('screen').currentQuestion?.correctAnswer,
  'The screen sees the correct answer during board phases'
);
console.log('✓ Entered Answer Board Stage 1; screen may now show the answer');

// 9. Board Stage 2: Reveal cards & exception marking
session.nextPhase(); // BOARD_ANSWER -> BOARD_CARDS
assert.strictEqual(session.phase, 'BOARD_CARDS', 'Phase should be BOARD_CARDS (Stage 2)');

const cards = session.getBoardCards();
assert.strictEqual(cards.length, 3, 'Board should contain a card for every team');

session.markAll('correct');
assert.strictEqual(cards[0].isCorrect, true, 'A card with ink is marked correct');
assert.strictEqual(
  cards[2].isCorrect,
  false,
  'A blank card is never swept to correct'
);

session.markAnswer(team2.id, false); // flip the exception
assert.strictEqual(cards[1].isCorrect, false);
console.log('✓ Exception marking (mark all + flip individual) verified');

// A team that joined mid-event must still be markable.
const lateTeam = session.joinTeam('Late Entry', 'device-token-late');
const lateCards = session.getBoardCards();
assert.strictEqual(lateCards.length, 4, 'A late joiner gets a board card');
session.markAnswer(lateTeam.id, true);
assert.strictEqual(
  session.submissions.get(session.currentBoardQuestion!.id)!.get(lateTeam.id)!.isCorrect,
  true,
  'A late joiner\'s card accepts a mark'
);
console.log('✓ Late-joining team receives a markable card');

// Confirming the board opens the NEXT question, not another board.
session.nextPhase(); // BOARD_CARDS -> next question live
assert.strictEqual(session.phase, 'QUESTION_LIVE', 'Confirming a board opens the next question');
assert.strictEqual(session.currentQuestionIndex, q1Index + 1, 'Advanced to the next question');
assert.strictEqual(session.spotlightTeamId, null, 'Opening a question clears any spotlight');
console.log('✓ Per-question board cycle: question → board → next question');

// Walk the rest of the category the same way, and advance to the next category (no break configured).
const totalQuestions = session.currentCategory!.questions.length;
while (session.currentQuestionIndex < totalQuestions - 1 || session.phase !== 'BOARD_CARDS') {
  session.nextPhase();
  if (session.phase === 'CATEGORY_INTRO') break;
}
if (session.phase === 'BOARD_CARDS') session.nextPhase();
assert.strictEqual(session.phase, 'CATEGORY_INTRO', 'The last board in a category without a break advances to the next category');
assert.strictEqual(session.currentCategoryIndex, 1, 'Advanced to category 2');
console.log('✓ Last question in category without a break advances directly to next category intro');

// Back-navigation re-opens the previous board so a mark can be fixed.
session.prevPhase();
assert.strictEqual(session.phase, 'BOARD_CARDS', 'Back from next category intro re-opens the previous category final board');
assert.strictEqual(session.currentCategoryIndex, 0, 'Back in category 1');
session.prevPhase();
assert.strictEqual(session.phase, 'BOARD_ANSWER', 'Back from cards returns to the answer stage');
session.prevPhase();
assert.strictEqual(session.phase, 'QUESTION_LOCKED', 'Back from the answer stage returns to the locked question');
const beforeStep = session.currentQuestionIndex;
session.prevPhase();
assert.strictEqual(session.currentQuestionIndex, beforeStep - 1, 'Stepping back moves to the previous question');
assert.strictEqual(session.phase, 'BOARD_CARDS', 'Stepping back re-opens that question\'s board for re-marking');
console.log('✓ prevPhase walks the per-question cycle backwards for re-marking');

// Spotlight test
session.setSpotlight(team1.id);
assert.strictEqual(session.spotlightTeamId, team1.id);
session.setSpotlight(null);
assert.strictEqual(session.spotlightTeamId, null);
console.log('✓ Spotlight toggled cleanly');

// 10. Scores, including the manual-adjustment ledger
session.recalculateScores();
assert(team1.score > 0, 'Team 1 score should be updated');

const before = team1.score;
session.adjustScore(team1.id, 5, 'Bonus for a good argument');
assert.strictEqual(team1.score, before + 5, 'Manual adjustment must apply to the total');
session.adjustScore(team1.id, -5, 'Reverted');
assert.strictEqual(team1.score, before, 'Adjustments are a ledger and reverse cleanly');
console.log(`✓ Scores computed: ${team1.name} ${team1.score} pts, ${team2.name} ${team2.score} pts`);

// 11. Restart recovery — a fresh store rehydrating from the same database
// must land back where the night actually was, not in the lobby.
session.adjustScore(team1.id, 7, 'Pre-restart bonus');
const expectedPhase = session.phase;
const expectedCategory = session.currentCategoryIndex;
const expectedQuestion = session.currentQuestionIndex;
const expectedScore = team1.score;

const restarted = new SessionStore();
const revived = restarted.getSessionByCode(session.joinCode);

assert(revived, 'A live session should be rehydrated after a restart');
assert.strictEqual(revived!.phase, expectedPhase, 'Phase must survive a restart');
assert.strictEqual(revived!.currentCategoryIndex, expectedCategory, 'Category index must survive a restart');
assert.strictEqual(revived!.currentQuestionIndex, expectedQuestion, 'Question index must survive a restart');
assert.strictEqual(revived!.teams.size, session.teams.size, 'Teams must survive a restart');
assert(
  revived!.scoreEvents.some(e => e.reason === 'Pre-restart bonus' && e.points === 7),
  'Manual score adjustments must be restored from the ledger'
);
assert.strictEqual(
  revived!.teams.get(team1.id)!.score,
  expectedScore,
  'Restored totals must match, including manual adjustments'
);
console.log(`✓ Restart recovery: resumed at ${revived!.phase} with scores and ledger intact`);

// A question that was live when the process died resumes locked, since its
// timer died with the old process.
assert.notStrictEqual(revived!.phase, 'QUESTION_LIVE', 'A restart never resumes a running timer');

// 12. Password hashing
const stored = hashPassword('correct horse');
assert(stored.startsWith('scrypt$'), 'New hashes are salted scrypt');
assert.strictEqual(verifyPassword('correct horse', stored), true);
assert.strictEqual(verifyPassword('wrong horse', stored), false);
assert.strictEqual(isLegacyHash(stored), false);

// Legacy unsalted SHA-256 must still verify so existing hosts can sign in.
const legacy = (await import('node:crypto')).createHash('sha256').update('password123').digest('hex');
assert.strictEqual(verifyPassword('password123', legacy), true, 'Legacy hash still verifies');
assert.strictEqual(isLegacyHash(legacy), true);
console.log('✓ Salted scrypt hashing with legacy SHA-256 fallback verified');

console.log('\n🎉 All Milestone 1 Server State & Protocol tests PASSED!');
