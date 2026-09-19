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

const HOST_EMAIL = 'host@trivia.app';
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'password123';

async function runE2ETest() {
  initDb();

  const app = Fastify();
  await app.register(corsPlugin);
  await app.register(websocketPlugin);
  await registerApiRoutes(app);
  await registerWebSocketRoutes(app);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  console.log(`✓ Test server running on port ${port}`);

  // --- API authorization -------------------------------------------------
  const unauth = await app.inject({ method: 'GET', url: '/api/events' });
  assert.strictEqual(unauth.statusCode, 401, 'Authoring data must require a host token');
  console.log('✓ Unauthenticated API read rejected (401)');

  const badLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: HOST_EMAIL, password: 'not-the-password' }
  });
  assert.strictEqual(badLogin.statusCode, 401, 'A wrong password must be refused');

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: HOST_EMAIL, password: HOST_PASSWORD }
  });
  assert.strictEqual(login.statusCode, 200, 'Host should be able to sign in');
  const hostToken = login.json().token as string;
  assert(hostToken && hostToken.length >= 32, 'Login returns a real random token, not the host id');

  const event = db.prepare('SELECT id, title FROM events LIMIT 1').get() as any;
  assert.notStrictEqual(hostToken, event.host_id, 'Token must not be the host id');

  const authed = await app.inject({
    method: 'GET',
    url: '/api/events',
    headers: { authorization: `Bearer ${hostToken}` }
  });
  assert.strictEqual(authed.statusCode, 200, 'Signed-in host can read their events');
  console.log('✓ Host sign-in issues a bearer token that unlocks the API');

  const session = sessionStore.createSession(event.id);
  const code = session.joinCode;
  console.log(`✓ Created test session with code: ${code}`);

  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const createClient = (): Promise<WebSocket> => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

  /** Collects every message a socket receives, for later assertions. */
  const collect = (ws: WebSocket) => {
    const seen: any[] = [];
    ws.on('message', (data) => {
      try { seen.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    return seen;
  };

  const hostWs = await createClient();
  const screenWs = await createClient();
  const teamWs = await createClient();

  const hostSeen = collect(hostWs);
  const teamSeen = collect(teamWs);
  collect(screenWs);

  // 1. Handshakes
  screenWs.send(JSON.stringify({ type: 'screen.listen', payload: { code } }));
  hostWs.send(JSON.stringify({ type: 'host.auth', payload: { token: hostToken, code } }));
  teamWs.send(JSON.stringify({
    type: 'join',
    payload: { code, teamName: 'E2E Champions', deviceToken: 'token-e2e' }
  }));

  await new Promise((r) => setTimeout(r, 150));

  const registered = teamSeen.find(m => m.type === 'team.registered');
  assert(registered, 'Team should receive team.registered');
  assert.strictEqual(registered.payload.teamName, 'E2E Champions');
  assert.strictEqual(registered.payload.teamPin.length, 4);
  console.log(`✓ Team registered with 4-digit PIN: ${registered.payload.teamPin}`);

  // 2. A bad host token must not produce a host socket.
  const impostorWs = await createClient();
  const impostorSeen = collect(impostorWs);
  impostorWs.send(JSON.stringify({ type: 'host.auth', payload: { token: 'not-a-real-token', code } }));
  await new Promise((r) => setTimeout(r, 100));
  assert(
    impostorSeen.some(m => m.type === 'error' && m.payload.code === 'unauthorized'),
    'host.auth with a bogus token must be refused'
  );
  console.log('✓ host.auth rejects an invalid token');

  // 3. Host starts Category 1
  hostWs.send(JSON.stringify({ type: 'host.start' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'CATEGORY_INTRO');
  console.log('✓ Host transitioned to CATEGORY_INTRO');

  // 4. A contestant socket must not be able to drive the session.
  const phaseBefore = session.phase;
  teamSeen.length = 0;
  teamWs.send(JSON.stringify({ type: 'host.next_phase' }));
  teamWs.send(JSON.stringify({
    type: 'host.adjust_score',
    payload: { teamId: registered.payload.teamId, deltaPoints: 1000, reason: 'cheating' }
  }));
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(session.phase, phaseBefore, 'A team socket must not advance the phase');
  assert.strictEqual(
    session.teams.get(registered.payload.teamId)!.score,
    0,
    'A team socket must not be able to adjust its own score'
  );
  assert(
    teamSeen.filter(m => m.type === 'error' && m.payload.code === 'forbidden').length === 2,
    'Both host commands from a team socket should be refused'
  );
  console.log('✓ Host commands from a contestant socket are refused');

  // 5. Host opens Question 1
  hostWs.send(JSON.stringify({ type: 'host.next_phase' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'QUESTION_LIVE');
  console.log('✓ Host opened Question 1 (QUESTION_LIVE)');

  // 6. The live question's answer must not reach the team socket.
  const teamState = [...teamSeen].reverse().find(m => m.type === 'session.state');
  assert(teamState, 'Team receives session.state');
  assert.strictEqual(
    teamState.payload.currentQuestion?.correctAnswer,
    undefined,
    'A team must never receive the correct answer over the wire'
  );
  assert(
    teamState.payload.teams.every((t: any) => t.teamPin === undefined),
    'A team must never receive other teams\' PINs'
  );

  const hostState = [...hostSeen].reverse().find(m => m.type === 'session.state');
  assert(hostState.payload.currentQuestion?.correctAnswer, 'The host does receive the answer');
  console.log('✓ Correct answer and PINs are redacted from the team socket');

  // 7. Team submits finger ink stroke data
  const inkPayload = {
    v: 1 as const,
    box: [1000, 360] as [number, number],
    s: [
      { t: 150, p: [200, 250, 220, 240, 260, 250] },
      { t: 300, p: [300, 250, 310, 210, 320, 250] }
    ]
  };

  teamSeen.length = 0;
  teamWs.send(JSON.stringify({
    type: 'answer.submit',
    payload: { questionId: session.currentQuestion!.id, ink: inkPayload }
  }));

  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(session.getSnapshot('host').answerCount.answered, 1);

  const ack = teamSeen.find(m => m.type === 'answer.ack');
  assert(ack, 'The phone receives an explicit acknowledgement');
  assert.strictEqual(ack.payload.accepted, true, 'Submission accepted');
  console.log('✓ Ink answer submitted, recorded, and acknowledged');

  // 8. Host locks question
  hostWs.send(JSON.stringify({ type: 'host.lock_question' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'QUESTION_LOCKED');
  console.log('✓ Host locked question (QUESTION_LOCKED)');

  // 9. The board for this question follows immediately.
  const answeredQuestionId = session.currentQuestion!.id;
  hostWs.send(JSON.stringify({ type: 'host.next_phase' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'BOARD_ANSWER');
  assert.strictEqual(
    session.currentBoardQuestion!.id,
    answeredQuestionId,
    'The board shows the question that just closed'
  );
  console.log('✓ Entered Stage 1: BOARD_ANSWER for the question just answered');

  // A stray lock here must not rewind the board.
  hostWs.send(JSON.stringify({ type: 'host.lock_question' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'BOARD_ANSWER', 'lock_question must not rewind a board phase');
  console.log('✓ Stray lock_question during the board is ignored');

  // 10. Host reveals all cards (Stage 2)
  hostWs.send(JSON.stringify({ type: 'host.board_reveal_cards' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.phase, 'BOARD_CARDS');
  console.log('✓ Entered Stage 2: BOARD_CARDS (handwriting revealed)');

  // 11. Exception marking via host WebSocket
  const team = Array.from(session.teams.values())[0];
  hostSeen.length = 0;
  hostWs.send(JSON.stringify({
    type: 'host.mark',
    payload: { teamId: team.id, isCorrect: true }
  }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.getBoardCards()[0].isCorrect, true);
  console.log('✓ Marked submission as Correct (✓)');

  // A mark-all sweep is one batched frame, not one per team.
  hostSeen.length = 0;
  hostWs.send(JSON.stringify({ type: 'host.mark_all', payload: { mark: 'wrong' } }));
  await new Promise((r) => setTimeout(r, 150));
  const batched = hostSeen.filter(m => m.type === 'board.marks');
  const perTeam = hostSeen.filter(m => m.type === 'board.mark');
  assert.strictEqual(batched.length, 1, 'mark_all emits exactly one batched frame');
  assert.strictEqual(perTeam.length, 0, 'mark_all does not emit a frame per team');
  assert.strictEqual(batched[0].payload.marks.length, session.teams.size);
  console.log('✓ mark_all sends a single batched board.marks frame');

  // 12. Host spotlights a team card
  hostWs.send(JSON.stringify({ type: 'host.spotlight', payload: { teamId: team.id } }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.spotlightTeamId, team.id);
  console.log('✓ Card spotlighted on the Big Screen');

  hostWs.send(JSON.stringify({ type: 'host.spotlight', payload: { teamId: null } }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(session.spotlightTeamId, null);
  console.log('✓ Card un-spotlighted');

  // 13. Single-device enforcement: when another device rejoins with the PIN,
  // the previous device must be notified with team.taken_over and closed.
  const takeoverWs = await createClient();
  const takeoverSeen = collect(takeoverWs);
  let oldSocketClosed = false;
  teamWs.on('close', () => { oldSocketClosed = true; });

  takeoverWs.send(JSON.stringify({
    type: 'rejoin',
    payload: { code, teamName: 'E2E Champions', teamPin: registered.payload.teamPin, deviceToken: 'token-takeover' }
  }));
  await new Promise((r) => setTimeout(r, 150));

  const takeoverRegistered = takeoverSeen.find(m => m.type === 'team.registered');
  assert(takeoverRegistered, 'Takeover device should register as the team');

  const takenOverMsg = teamSeen.find(m => m.type === 'team.taken_over');
  assert(takenOverMsg, 'Previous device socket should receive team.taken_over');
  assert.strictEqual(oldSocketClosed, true, 'Previous device socket should be closed by server');
  console.log('✓ Single device takeover: old socket received team.taken_over and was closed');

  // Clean up
  hostWs.close();
  screenWs.close();
  teamWs.close();
  takeoverWs.close();
  impostorWs.close();
  await app.close();

  console.log('\n🎉 End-to-End WebSocket Integration Test PASSED successfully!');
}

runE2ETest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
