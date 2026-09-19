import assert from 'node:assert';
import Fastify from 'fastify';
import ExcelJS from 'exceljs';
import { initDb, db } from '../src/db/client.js';
import { registerApiRoutes } from '../src/routes/api.js';
import { sessionStore } from '../src/state/session-store.js';
import { parseWorkbook } from '../src/import/workbook.js';

console.log('--- Running Host Authoring Tests ---');

const HOST_EMAIL = 'host@trivia.app';
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'password123';

/** Builds a multipart/form-data body carrying one file. */
function multipart(filename: string, content: Buffer) {
  const boundary = '----triviaboundary' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, content, tail])
  };
}

async function buildXlsx(rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Questions');
  rows.forEach(r => sheet.addRow(r));
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function run() {
  initDb();

  const app = Fastify();
  await registerApiRoutes(app);
  await app.ready();

  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: HOST_EMAIL, password: HOST_PASSWORD }
  });
  assert.strictEqual(login.statusCode, 200, 'Host should sign in');
  const token = login.json().token as string;
  const auth = { authorization: `Bearer ${token}` };

  // ---------------------------------------------------------- 1. Create event
  const created = await app.inject({
    method: 'POST', url: '/api/events', headers: auth,
    payload: { title: 'NWTF Trivia Night — September', eventDate: '2026-09-25', location: 'Bacolod canteen' }
  });
  assert.strictEqual(created.statusCode, 200);
  const eventId = created.json().id as string;

  const detail1 = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: auth });
  assert.strictEqual(detail1.json().event.event_date, '2026-09-25', 'Date is stored');
  assert.strictEqual(detail1.json().event.location, 'Bacolod canteen', 'Location is stored');
  console.log('✓ Event created with name, date and location');

  const noTitle = await app.inject({
    method: 'POST', url: '/api/events', headers: auth, payload: { title: '   ' }
  });
  assert.strictEqual(noTitle.statusCode, 400, 'An event needs a name');

  const patched = await app.inject({
    method: 'PATCH', url: `/api/events/${eventId}`, headers: auth,
    payload: { location: 'Iloilo branch hall' }
  });
  assert.strictEqual(patched.statusCode, 200);
  assert.strictEqual(patched.json().event.location, 'Iloilo branch hall', 'Location can be edited');
  console.log('✓ Event details can be edited after creation');

  // ------------------------------------------------------ 2. Nominate categories
  const catA = await app.inject({
    method: 'POST', url: `/api/events/${eventId}/categories`, headers: auth,
    payload: { title: 'Philippine History' }
  });
  assert.strictEqual(catA.statusCode, 200);
  const catAId = catA.json().id as string;

  await app.inject({
    method: 'POST', url: `/api/events/${eventId}/categories`, headers: auth,
    payload: { title: 'World Geography' }
  });
  console.log('✓ Categories nominated for the event');

  // The 9-category ceiling still holds. Done on a throwaway event so the
  // import checks below still have room to create categories.
  const capEventId = (await app.inject({
    method: 'POST', url: '/api/events', headers: auth, payload: { title: 'Cap check' }
  })).json().id as string;

  for (let i = 1; i <= 9; i++) {
    const res = await app.inject({
      method: 'POST', url: `/api/events/${capEventId}/categories`, headers: auth,
      payload: { title: `Filler ${i}` }
    });
    assert.strictEqual(res.statusCode, 200, `Category ${i} should be accepted`);
  }
  const tenth = await app.inject({
    method: 'POST', url: `/api/events/${capEventId}/categories`, headers: auth,
    payload: { title: 'One too many' }
  });
  assert.strictEqual(tenth.statusCode, 400, 'The 9-category cap is enforced');
  console.log('✓ Category cap of 9 enforced');

  // ------------------------------------------------------------- 3. Breaks
  const withBreak = await app.inject({
    method: 'PATCH', url: `/api/categories/${catAId}`, headers: auth,
    payload: { breakAfter: true, breakNote: 'Dinner — 20 minutes' }
  });
  assert.strictEqual(withBreak.statusCode, 200);
  assert.strictEqual(withBreak.json().category.break_after, 1, 'Break flag is set');
  assert.strictEqual(withBreak.json().category.break_note, 'Dinner — 20 minutes', 'Break note is stored');

  const cleared = await app.inject({
    method: 'PATCH', url: `/api/categories/${catAId}`, headers: auth,
    payload: { breakAfter: false }
  });
  assert.strictEqual(cleared.json().category.break_after, 0, 'Break can be turned off again');
  console.log('✓ Breaks can be placed after any category and removed');

  // -------------------------------------------------- 4. Spreadsheet import
  const xlsx = await buildXlsx([
    ['Category', 'Question', 'Answer', 'Allocated Points'],
    ['Philippine History', 'Who was the first president of the Philippine Republic?', 'Emilio Aguinaldo', 2],
    ['Philippine History', 'In which year did Magellan arrive?', '1521', 1],
    ['Movies', 'Who directed Jaws?', 'Steven Spielberg', 1],
    ['Movies', '', 'Missing question', 1],
    ['Music', 'Which band recorded Abbey Road?', 'The Beatles', '']
  ]);

  const up = multipart('questions.xlsx', xlsx);
  const imported = await app.inject({
    method: 'POST', url: `/api/events/${eventId}/import`, headers: { ...auth, ...up.headers }, payload: up.payload
  });
  assert.strictEqual(imported.statusCode, 200, 'Import should succeed');
  const report = imported.json();

  assert.strictEqual(report.questionsImported, 4, 'Four usable rows imported');
  assert.strictEqual(report.categoriesCreated, 2, 'Movies and Music were created');
  assert.strictEqual(report.skipped.length, 1, 'The row with no question is reported');
  assert.match(report.skipped[0].reason, /question/i, 'The reason names the missing column');
  console.log(`✓ Excel import: ${report.questionsImported} questions, ${report.categoriesCreated} new categories, ${report.skipped.length} row reported`);

  // Rows land under the right category, with points carried across and
  // defaulted to 1 when the cell is blank.
  const detail2 = (await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: auth })).json().event;
  const history = detail2.categories.find((c: any) => c.title === 'Philippine History');
  const music = detail2.categories.find((c: any) => c.title === 'Music');
  assert.strictEqual(history.questions.length, 2, 'Existing category received its rows');
  assert.strictEqual(history.questions[0].points, 2, 'Allocated points carried across');
  assert.strictEqual(music.questions[0].points, 1, 'Blank points defaults to 1');
  console.log('✓ Imported rows land in the right category with their points');

  // Header synonyms and column order are tolerated.
  const reordered = await buildXlsx([
    ['pts', 'answer', 'topic', 'prompt'],
    [3, 'Canberra', 'World Geography', 'Capital of Australia?']
  ]);
  const up2 = multipart('reordered.xlsx', reordered);
  const imported2 = await app.inject({
    method: 'POST', url: `/api/events/${eventId}/import`, headers: { ...auth, ...up2.headers }, payload: up2.payload
  });
  assert.strictEqual(imported2.json().questionsImported, 1, 'Synonym headers in any order still import');
  console.log('✓ Column order and header synonyms tolerated');

  // CSV works too.
  const csv = Buffer.from(
    'category,question,answer,points\r\n' +
    'Science,"Which element has the symbol Fe, exactly?",Iron,1\r\n'
  );
  const up3 = multipart('questions.csv', csv);
  const imported3 = await app.inject({
    method: 'POST', url: `/api/events/${eventId}/import`, headers: { ...auth, ...up3.headers }, payload: up3.payload
  });
  assert.strictEqual(imported3.json().questionsImported, 1, 'CSV imports');
  console.log('✓ CSV upload supported, including quoted commas');

  // A file with no recognisable headers is refused with an explanation.
  const junk = await buildXlsx([['foo', 'bar'], ['a', 'b']]);
  const up4 = multipart('junk.xlsx', junk);
  const refused = await app.inject({
    method: 'POST', url: `/api/events/${eventId}/import`, headers: { ...auth, ...up4.headers }, payload: up4.payload
  });
  assert.strictEqual(refused.statusCode, 400, 'An unusable file is refused');
  assert.match(refused.json().problems[0].reason, /missing/i, 'The host is told which columns are missing');
  console.log('✓ A file with the wrong headers is refused with a readable reason');

  // Replace mode clears questions but keeps categories and their breaks.
  await app.inject({
    method: 'PATCH', url: `/api/categories/${catAId}`, headers: auth,
    payload: { breakAfter: true, breakNote: 'Dinner' }
  });
  const replaceFile = await buildXlsx([
    ['category', 'question', 'answer', 'points'],
    ['Philippine History', 'Only question now', 'Yes', 1]
  ]);
  const up5 = multipart('replace.xlsx', replaceFile);
  const replaced = await app.inject({
    method: 'POST', url: `/api/events/${eventId}/import?mode=replace`,
    headers: { ...auth, ...up5.headers }, payload: up5.payload
  });
  assert.strictEqual(replaced.json().mode, 'replace');

  const detail3 = (await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: auth })).json().event;
  const totalQs = detail3.categories.reduce((n: number, c: any) => n + c.questions.length, 0);
  assert.strictEqual(totalQs, 1, 'Replace clears every previous question');
  const historyAfter = detail3.categories.find((c: any) => c.title === 'Philippine History');
  assert.strictEqual(historyAfter.break_after, 1, 'Replace keeps the category break settings');
  console.log('✓ Replace mode clears questions but preserves categories and breaks');

  // ------------------------------------------------ 5. Edit questions in place
  const qId = historyAfter.questions[0].id as string;
  const edited = await app.inject({
    method: 'PATCH', url: `/api/questions/${qId}`, headers: auth,
    payload: { prompt: 'Edited prompt?', correctAnswer: 'Edited answer', points: 4 }
  });
  assert.strictEqual(edited.statusCode, 200);
  assert.strictEqual(edited.json().question.prompt, 'Edited prompt?');
  assert.strictEqual(edited.json().question.correct_answer, 'Edited answer');
  assert.strictEqual(edited.json().question.points, 4);

  const blanked = await app.inject({
    method: 'PATCH', url: `/api/questions/${qId}`, headers: auth, payload: { prompt: '  ' }
  });
  assert.strictEqual(blanked.statusCode, 400, 'A question cannot be blanked');

  const outOfRange = await app.inject({
    method: 'PATCH', url: `/api/questions/${qId}`, headers: auth, payload: { points: 9999 }
  });
  assert.strictEqual(outOfRange.json().question.points, 50, 'Points are clamped to the allowed range');
  console.log('✓ Questions can be edited in place, with validation');

  const removed = await app.inject({ method: 'DELETE', url: `/api/questions/${qId}`, headers: auth });
  assert.strictEqual(removed.statusCode, 200);
  const detail4 = (await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: auth })).json().event;
  assert.strictEqual(
    detail4.categories.find((c: any) => c.title === 'Philippine History').questions.length,
    0,
    'Question deleted'
  );
  console.log('✓ Questions can be deleted');

  // Authoring stays host-only.
  const anon = await app.inject({ method: 'PATCH', url: `/api/questions/${qId}`, payload: { points: 1 } });
  assert.strictEqual(anon.statusCode, 401, 'Editing requires a host token');
  console.log('✓ Authoring endpoints remain host-only');

  // ------------------------------------------- 6. Breaks run in the live game
  const breakEventId = (await (async () => {
    const ev = await app.inject({
      method: 'POST', url: '/api/events', headers: auth, payload: { title: 'Break flow' }
    });
    const id = ev.json().id as string;
    const c1 = await app.inject({
      method: 'POST', url: `/api/events/${id}/categories`, headers: auth, payload: { title: 'One' }
    });
    const c2 = await app.inject({
      method: 'POST', url: `/api/events/${id}/categories`, headers: auth, payload: { title: 'Two' }
    });
    for (const cid of [c1.json().id, c2.json().id]) {
      await app.inject({
        method: 'POST', url: `/api/categories/${cid}/questions`, headers: auth,
        payload: { prompt: 'Q?', correctAnswer: 'A', points: 1 }
      });
    }
    await app.inject({
      method: 'PATCH', url: `/api/categories/${c1.json().id}`, headers: auth,
      payload: { breakAfter: true, breakNote: 'Stretch your legs' }
    });
    return id;
  })());

  const session = sessionStore.createSession(breakEventId);
  session.nextPhase(); // LOBBY -> CATEGORY_INTRO
  session.nextPhase(); // -> QUESTION_LIVE
  session.nextPhase(); // -> QUESTION_LOCKED
  session.nextPhase(); // -> BOARD_ANSWER
  session.nextPhase(); // -> BOARD_CARDS
  session.nextPhase(); // -> BREAK, directly because category One has breakAfter
  assert.strictEqual(session.phase, 'BREAK', 'An authored break runs directly after the category question board');
  assert.strictEqual(
    session.getSnapshot('team').currentCategory?.breakNote,
    'Stretch your legs',
    'The break note reaches the room'
  );

  session.prevPhase();
  assert.strictEqual(session.phase, 'BOARD_CARDS', 'A break can be stepped back out of to the final question board');
  session.nextPhase(); // back to BREAK
  assert.strictEqual(session.phase, 'BREAK');

  session.nextPhase(); // BREAK -> next CATEGORY_INTRO, when the host is ready
  assert.strictEqual(session.phase, 'CATEGORY_INTRO', 'The host decides when the break ends');
  assert.strictEqual(session.currentCategoryIndex, 1, 'The next category follows the break');
  console.log('✓ Authored breaks pause the night between categories until the host resumes');

  // A break on the LAST category has nothing to come back to, so it is skipped.
  const lastCat = db.prepare(
    'SELECT id FROM categories WHERE event_id = ? ORDER BY position DESC LIMIT 1'
  ).get(breakEventId) as any;
  db.prepare('UPDATE categories SET break_after = 1 WHERE id = ?').run(lastCat.id);

  const session2 = sessionStore.createSession(breakEventId);
  while (session2.phase !== 'FINISHED') {
    session2.nextPhase();
  }
  assert.strictEqual(session2.phase, 'FINISHED', 'A trailing break does not strand the night');
  console.log('✓ A break on the final category is skipped rather than stranding the event');

  // ---------------------------------------------------- 7. Parser unit checks
  const messy = await buildXlsx([
    ['NWTF Trivia — September'],            // a title row above the headers
    [],
    ['Category', 'Question', 'Answer', 'Points'],
    ['Movies', 'Who directed Alien?', 'Ridley Scott', 2]
  ]);
  const parsed = await parseWorkbook(messy, 'messy.xlsx');
  assert.strictEqual(parsed.rows.length, 1, 'A title row above the headers is skipped');
  assert.strictEqual(parsed.rows[0].category, 'Movies');
  assert.strictEqual(parsed.rows[0].points, 2);
  console.log('✓ Parser finds the header row beneath a title row');

  // Category inheritance (vertically merged cells or omitted repeated round names)
  const merged = await buildXlsx([
    ['Category:', 'Question:', 'Answer:', 'Points:'],
    ['Science', 'What is H2O?', 'Water', 1],
    ['', 'What is NaCl?', 'Salt', 'N/A'], // category omitted, points is 'N/A'
    ['', 'What is CO2?', 'Carbon Dioxide', 'None'] // category omitted, points is 'None'
  ]);
  const parsedMerged = await parseWorkbook(merged, 'merged.xlsx');
  assert.strictEqual(parsedMerged.rows.length, 3, 'All 3 rows parsed');
  assert.strictEqual(parsedMerged.rows[1].category, 'Science', 'Inherited category from merged row above');
  assert.strictEqual(parsedMerged.rows[2].category, 'Science', 'Inherited category from merged row above');
  assert.strictEqual(parsedMerged.rows[1].points, null, 'Non-numeric points N/A safely parsed as null instead of 0');
  assert.strictEqual(parsedMerged.rows[2].points, null, 'Non-numeric points None safely parsed as null instead of 0');
  console.log('✓ Category inheritance and non-numeric points handled gracefully');

  // Played event deletion protection
  // eventId has already been played via breakEventId / sessions
  const playedDel = await app.inject({
    method: 'DELETE', url: `/api/categories/${lastCat.id}`, headers: auth
  });
  assert.strictEqual(playedDel.statusCode, 400, 'Cannot delete categories from an event with sessions');

  // Session creation requires at least 1 question
  const emptyEvent = (await app.inject({
    method: 'POST', url: '/api/events', headers: auth, payload: { title: 'Empty event' }
  })).json().id;
  assert.throws(
    () => sessionStore.createSession(emptyEvent),
    /no questions/i,
    'Cannot start a session for an event with no questions'
  );
  console.log('✓ Played events and empty events protected by safeguards');

  await app.close();

  console.log('\n🎉 All Host Authoring tests PASSED!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
