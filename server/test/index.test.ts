import assert from 'node:assert';
import { db, initDb } from '../src/db/client.js';
import { sessionStore } from '../src/state/session-store.js';

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
assert.strictEqual(team1.teamPin.length, 4, 'PIN should be 4 digits');

const team2 = session.joinTeam('Quizzy Rascals', 'device-token-2');
assert.strictEqual(session.teams.size, 2, 'Session should have 2 teams');

// Rejoin test
const rejoined = session.rejoinTeam('The Mangoes', team1.teamPin, 'device-token-new');
assert(rejoined, 'Team should be able to rejoin with matching PIN');
console.log('✓ Team join & PIN takeover verified');

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

const accepted = session.submitAnswer(team1.id, sampleInk);
assert.strictEqual(accepted, true, 'Submission should be accepted while QUESTION_LIVE');
assert.strictEqual(session.getSnapshot().answerCount.answered, 1);
console.log('✓ Answer submission accepted during QUESTION_LIVE');

// 6. Lock Question
session.lockCurrentQuestion();
assert.strictEqual(session.phase, 'QUESTION_LOCKED');
console.log('✓ Question locked');

// 7. Advance through remaining questions in Category 1
session.nextPhase(); // Q2 live
assert.strictEqual(session.phase, 'QUESTION_LIVE');
session.lockCurrentQuestion();

session.nextPhase(); // Q3 live
assert.strictEqual(session.phase, 'QUESTION_LIVE');
session.lockCurrentQuestion();

session.nextPhase(); // All questions in Cat 1 answered -> BOARD_ANSWER
assert.strictEqual(session.phase, 'BOARD_ANSWER', 'Phase should be BOARD_ANSWER (Stage 1)');
console.log('✓ Entered Answer Board Stage 1 (Official answer alone, cards face-down)');

// 8. Board Stage 2: Reveal cards & Exception Marking
session.nextPhase(); // BOARD_ANSWER -> BOARD_CARDS
assert.strictEqual(session.phase, 'BOARD_CARDS', 'Phase should be BOARD_CARDS (Stage 2)');

const cards = session.getBoardCards();
assert.strictEqual(cards.length, 2, 'Board should contain cards for both teams');

// Exception-based marking: mark all correct, then flip team2
session.markAll('correct');
assert.strictEqual(cards[0].isCorrect, true);

session.markAnswer(team2.id, false); // Team 2 wrong
assert.strictEqual(cards[1].isCorrect, false);
console.log('✓ Exception marking (mark all + flip individual) verified');

// Spotlight test
session.setSpotlight(team1.id);
assert.strictEqual(session.spotlightTeamId, team1.id);
session.setSpotlight(null);
assert.strictEqual(session.spotlightTeamId, null);
console.log('✓ Spotlight toggled cleanly');

// Check scores
session.recalculateScores();
assert(team1.score > 0, 'Team 1 score should be updated');
console.log(`✓ Scores computed: Team 1 (${team1.name}): ${team1.score} pts, Team 2 (${team2.name}): ${team2.score} pts`);

console.log('\n🎉 All Milestone 1 Server State & Protocol tests PASSED!');
