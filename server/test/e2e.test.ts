import assert from 'node:assert';
import { WebSocket } from 'ws';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import corsPlugin from '@fastify/cors';
import { initDb, db } from '../src/db/client.js';
import { registerApiRoutes } from '../src/routes/api.js';
import { registerWebSocketRoutes } from '../src/routes/ws.js';
import { sessionStore } from '../src/state/session-store.js';

console.log('--- Running Milestone 1 End-to-End WebSocket Test ---');

async function runE2ETest() {
  initDb();

  const app = Fastify();
  await app.register(corsPlugin);
  await app.register(websocketPlugin);
  await registerApiRoutes(app);
  await registerWebSocketRoutes(app);

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  console.log(`✓ Test server running on port ${port}`);

  const event = db.prepare('SELECT id, title FROM events LIMIT 1').get() as any;
  const session = sessionStore.createSession(event.id);
  const code = session.joinCode;
  console.log(`✓ Created test session with code: ${code}`);

  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  // Helper to connect and wait for open
  const createClient = (): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  };

  const hostWs = await createClient();
  const screenWs = await createClient();
  const teamWs = await createClient();

  // 1. Handshakes
  screenWs.send(JSON.stringify({ type: 'screen.listen', payload: { code } }));
  hostWs.send(JSON.stringify({ type: 'host.auth', payload: { token: code } }));
  teamWs.send(JSON.stringify({
    type: 'join',
    payload: { code, teamName: 'E2E Champions', deviceToken: 'token-e2e' }
  }));

  // Wait for team registration message
  await new Promise<void>((resolve) => {
    teamWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'team.registered') {
        assert.strictEqual(msg.payload.teamName, 'E2E Champions');
        assert.strictEqual(msg.payload.teamPin.length, 4);
        console.log(`✓ Team registered with 4-digit PIN: ${msg.payload.teamPin}`);
        resolve();
      }
    });
  });

  // 2. Host starts Category 1
  hostWs.send(JSON.stringify({ type: 'host.start' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'CATEGORY_INTRO');
  console.log('✓ Host transitioned to CATEGORY_INTRO');

  // 3. Host opens Question 1
  hostWs.send(JSON.stringify({ type: 'host.next_phase' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'QUESTION_LIVE');
  console.log('✓ Host opened Question 1 (QUESTION_LIVE)');

  // 4. Team submits finger ink stroke data
  const inkPayload = {
    v: 1 as const,
    box: [1000, 360] as [number, number],
    s: [
      { t: 150, p: [200, 250, 220, 240, 260, 250] },
      { t: 300, p: [300, 250, 310, 210, 320, 250] }
    ]
  };

  teamWs.send(JSON.stringify({
    type: 'answer.submit',
    payload: {
      questionId: session.currentQuestion!.id,
      ink: inkPayload
    }
  }));

  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.getSnapshot().answerCount.answered, 1);
  console.log('✓ Ink answer submitted and recorded on server');

  // 5. Host locks question
  hostWs.send(JSON.stringify({ type: 'host.lock_question' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'QUESTION_LOCKED');
  console.log('✓ Host locked question (QUESTION_LOCKED)');

  // 6. Fast forward through category questions to Answer Board
  while (session.phase !== 'BOARD_ANSWER') {
    session.nextPhase();
  }
  assert.strictEqual(session.phase, 'BOARD_ANSWER');
  console.log('✓ Entered Stage 1: BOARD_ANSWER (Official answer alone, cards face-down)');

  // 7. Host reveals all cards (Stage 2)
  hostWs.send(JSON.stringify({ type: 'host.board_reveal_cards' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'BOARD_CARDS');
  console.log('✓ Entered Stage 2: BOARD_CARDS (Handwritten answers revealed)');

  // 8. Exception marking via host WebSocket
  const team = Array.from(session.teams.values())[0];
  hostWs.send(JSON.stringify({
    type: 'host.mark',
    payload: { teamId: team.id, isCorrect: true }
  }));
  await new Promise((r) => setTimeout(r, 100));

  assert.strictEqual(session.getBoardCards()[0].isCorrect, true);
  console.log('✓ Marked submission as Correct (✓)');

  // 9. Host spotlights team card
  hostWs.send(JSON.stringify({
    type: 'host.spotlight',
    payload: { teamId: team.id }
  }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.spotlightTeamId, team.id);
  console.log('✓ Card spotlighted on Big Screen');

  hostWs.send(JSON.stringify({
    type: 'host.spotlight',
    payload: { teamId: null }
  }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.spotlightTeamId, null);
  console.log('✓ Card un-spotlighted');

  // Clean up
  hostWs.close();
  screenWs.close();
  teamWs.close();
  await app.close();

  console.log('\n🎉 End-to-End WebSocket Integration Test PASSED successfully!');
}

runE2ETest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
