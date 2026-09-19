# Trivia Night App — Design

A system for running live trivia events where the host authors questions ahead of time and
teams **write their answers on a phone with a finger**, exactly as they write on a
whiteboard now. After every question the handwritten answers go up on the big screen and the
host marks each one by hand. The app replaces the whiteboards and the tally sheet, not the
judgement.

**Status:** design draft, rev 4 — 2026-09-19
**Author:** philip.nis@nwtf.org.ph

---

## 1. Scope, fixed

| Parameter | Value |
|---|---|
| Teams per event | 16 target, **24 maximum** |
| Categories per event | **9 maximum** |
| Questions per category | **8 maximum** |
| Questions per event | 72 maximum |
| Default points per question | **1**, host raises for difficulty |
| Default answer time | 15 seconds |
| Answer input | **Finger handwriting**, typed text as fallback |
| Answer checking | **100% manual.** No automated grading of any kind |
| Submissions | One per team, per question |
| Connectivity | Always venue wifi or mobile data. No offline mode |

A maximum event is 9 × 8 = 72 questions with 24 teams. That's the number every design
decision below is sized against.

### The constraint that drives everything
The event is live, in a room, with people watching. **Every mechanism needs a manual
override.** If a phone dies, if a team drops off wifi, if a mark was wrong — the host must
be able to push through with a button and fix it afterwards.

---

## 2. The three surfaces

| Surface | Who | Device | Purpose |
|---|---|---|---|
| **Host Console** | Trivia Master | Laptop browser | Author events; run the game; mark answers |
| **Team App** | One phone per team | Phone browser (PWA) | Join, write answers, see own results |
| **Big Screen** | Output only | Projector / TV, browser | Question, timer, the answer board, leaderboard |

The Big Screen is a read-only view of the same session, opened from the console in a second
window and dragged to the projector. No login.

---

## 3. The night, end to end

```
LOBBY
  └ teams scan QR → enter 6-digit code → nominate team name → wait

CATEGORY: "Philippine History"           ← intro card on the big screen
  │
  ├ Q1  question on phones + big screen · 15s · team writes answer · locked
  │  └ ANSWER BOARD, in this order:
  │      ① correct answer in the header, cards up but face-down
  │      ② host reveals → all 16–24 handwritten answers appear at once
  │      ③ host marks each ✓ / ✗ — cards flip live on the projector
  │      ④ confirm → the next question opens
  │
  ├ Q2  … and so on, up to 8 questions, each with its own board
  │
  └ CATEGORY SCORES → running leaderboard

CATEGORY: "Movies"  →  ... → FINAL LEADERBOARD
```

**One question, one board.** A question closes, its answer goes up, everyone's handwriting is
revealed and marked, and only then does the next question open. Teams find out how they did
straight away rather than waiting out a whole category.

The trade is pacing against suspense, and it favours pacing. Eight questions then eight
boards makes the room sit through a long unbroken marking block at the end of every category,
and by the seventh board nobody remembers what they wrote for question two. Marking right
after the question is asked keeps each board short, keeps the answer fresh, and gives the
night a steady rhythm of small payoffs instead of one long one. Nothing is lost on integrity:
the question is already closed and locked before its answer is shown.

---

## 4. Handwritten answers — yes, and not via screenshots

> *"It would be great if teams answer by writing the answers on their screens with their
> fingers... this might mean taking a screenshot, is this doable?"*

Doable, and the screenshot route is the wrong one. Two reasons: a web page cannot screenshot
itself on a phone (`getDisplayMedia` doesn't exist on iOS Safari, and where it does exist it
throws an intrusive permission prompt), and a screenshot is a fixed-resolution image that
gets soft when the projector scales it.

### What to do instead: capture the strokes, not the pixels

The writing area is an HTML5 `<canvas>`. As a finger moves across it, the Pointer Events API
reports a stream of coordinates. **Store that stream — the actual pen strokes — rather than
the resulting picture.** Render it back as SVG paths.

```
  phone                     server                    big screen
  ┌──────────┐              ┌────────┐                ┌──────────┐
  │ ~~~~~~~  │  strokes as  │ JSONB  │  same strokes  │ ~~~~~~~  │
  │ Aguinaldo│ ───JSON───►  │ column │ ───────────►   │ Aguinaldo│
  └──────────┘   ~2 KB      └────────┘                └──────────┘
   360 px wide                                     rendered as SVG,
                                                  crisp at any size
```

Why this beats an image, concretely:

| | Stroke JSON | PNG screenshot |
|---|---|---|
| Payload per answer | **~2–6 KB** (1–2 KB gzipped) | 15–40 KB |
| Whole 24-team board | **~50–150 KB** | 400 KB – 1 MB |
| Scaled to projector | Vector — stays sharp | Soft and pixelated |
| Stroke thickness | Adjustable at render time | Baked in |
| Draw-on replay | Free (it's timestamped) | Impossible |
| Works on iOS Safari | Yes | No |

The payload difference is the one that matters most: venue wifi is your main engineering
risk, and a whole board of handwriting moves less data than a single photo.

Adjustable stroke thickness is the second. Handwriting shrunk into a small card gets thin
and faint — but because it's vector, the renderer **thickens the strokes as the card gets
smaller**, so a 24-team board stays legible where a scaled-down screenshot wouldn't.

A working prototype of this mechanism lives in [`prototype/ink-board.html`](prototype/ink-board.html),
published at <https://claude.ai/artifact/3GH9VPwjJRhdABv4fX5M9H> — stroke capture, SVG
rendering, the two-stage reveal, and keyboard marking, with live sync between a phone and a
projector view.

### The writing surface

```
┌─────────────────────────────┐
│  Q3 · Philippine History    │
│  2 points          ▓▓▓▓░░░░ │
│                             │
│  Who was the first          │
│  president of the           │
│  Philippine Republic?       │
│                             │
│  ┌───────────────────────┐  │   ← canvas, 1000×360 units
│  │                       │  │     ruled baseline, full width
│  │   ~~~~~~~~~~~         │  │
│  │   Aguinaldo           │  │
│  └───────────────────────┘  │
│    [↶ Undo]      [Clear]    │
│                             │
│      [   Lock it in   ]     │
└─────────────────────────────┘
```

Implementation notes that matter:

- **`touch-action: none` on the canvas.** Without it the browser steals the gesture to
  scroll or zoom and writing is impossible. This is the single most common way finger-drawing
  gets broken.
- **Pointer Events, not touch events** — `pointerdown` / `pointermove` / `pointerup`, with
  `getCoalescedEvents()` to catch the full sample rate between frames. Fingers move fast; a
  naive handler at 60 Hz produces visibly polygonal writing.
- **One active pointer at a time.** First finger down wins, others ignored. That's cheap
  palm rejection and prevents two teammates writing at once.
- **Variable stroke width by velocity** — the [`perfect-freehand`](https://github.com/steveruiz/perfect-freehand)
  approach. Fast strokes thin out, slow ones thicken. It's the difference between writing
  that looks like a marker and writing that looks like MS Paint, and it costs almost nothing.
- **Normalize to a fixed 1000 × 360 viewBox** on capture, so the same strokes render
  identically on a 360 px phone, a 280 px card, and a full-screen spotlight.
- **Simplify before sending** — Ramer–Douglas–Peucker at a low tolerance drops 60–70% of the
  points with no visible change.
- **Undo (last stroke) and Clear.** Both essential — this is a whiteboard, and people cross
  things out.
- **Cap at ~80 strokes** per answer. Not a limit anyone writing a word will ever hit; it
  stops a bored team from scribbling a 300 KB payload.
- **Portrait, wide canvas, ruled baseline.** Most trivia answers are one to three words. No
  rotate-your-phone prompt — asking a room to turn their phones sideways mid-round costs more
  than the extra width is worth.

### Typed fallback

A per-event setting, `answer_mode: ink | text`, defaulting to `ink`. Keep the typed path
because handwriting genuinely doesn't work for everyone — motor difficulty, a cracked screen,
a team that just finds it fiddly. A team can also be switched to typed mode individually from
the host console mid-event. Typed answers render on the board in a clean font, visibly
different from ink, which is fine — nobody's confused about which is which.

---

## 5. The answer board

### The reveal order

1. **Question and correct answer** in the header, and the full grid of team cards already on
   screen — named, but blank. Each card shows a ruled baseline, like a whiteboard held face
   down. A beat for the room to react to the answer.
2. **Host reveals.** Every team's handwriting appears at once, across the whole grid. This is
   the raise-your-boards moment, and it wants to be simultaneous.
3. **Host marks.** Each tap flips a card green or red on the projector, live.
4. **Confirm**, scores commit, and the next question opens straight away.

The board belongs to the question that just closed, and runs after every question rather than
being batched to the end of a category.

The correct answer does not get a full-screen splash of its own. It's a line under the
question, where it stays visible for the whole marking pass — the host is reading it
constantly while marking, and the room wants to compare it against each card. A splash
screen would duplicate that line and leave most of a 1920 × 1080 projector empty. Keeping the
named-but-blank grid up during stage 1 also means the reveal is a change of *content*, not a
change of *layout*: nothing jumps, and all 24 answers land in the same instant.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PHILIPPINE HISTORY · Q1 of 8                                  2 pts │
│  Who was the first president of the Philippine Republic?             │
│  Answer:  EMILIO AGUINALDO                                           │
│  ─────────────────────────────────────────────────────────────────── │
│  ┌────────────┐┌────────────┐┌────────────┐┌────────────┐┌─────────┐ │
│  │QUIZZY RASC.││THE MANGOES ││TEAM 5      ││BRAIN CELLS ││NO IDEA  │ │
│  │ ~Emilio~   ││ ~aguinaldo~││ ~E. Aguin~ ││ ~Quezon~   ││~Aguin!!~│ │
│  │     ✓      ││     ✓      ││            ││     ✗      ││    ✓    │ │
│  └────────────┘└────────────┘└────────────┘└────────────┘└─────────┘ │
│  ┌────────────┐┌────────────┐┌────────────┐┌────────────┐┌─────────┐ │
│  │THE ALPHAS  ││SIX PACK    ││LATE ENTRY  ││...         ││...      │ │
│  │ ~emilio a.~││—no answer— ││ ~Aguinaldo~││            ││         │ │
│  └────────────┘└────────────┘└────────────┘└────────────┘└─────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### Grid sizing — no pagination needed

At a 24-team ceiling, everything fits on one 1920 × 1080 screen. Pagination drops out of the
design entirely, which is a real simplification.

| Teams | Grid | Card | Ink area |
|---|---|---|---|
| up to 12 | 4 × 3 | 460 × 300 | 420 × 150 px |
| 13–16 | 4 × 4 | 460 × 225 | 420 × 115 px |
| 17–24 | 6 × 4 | 305 × 225 | 280 × 105 px |

At the 24-team end the ink area is 280 px wide, which is narrower than the 360 px phone
canvas it was written on. Vector rendering plus velocity-scaled stroke thickening handles
most of that — but expect handwriting at 24 teams to be noticeably harder to read from the
back of a room than at 16. Which is one more reason 16 is the right target.

### Spotlight

Tap any card on the console and it fills the projector at full size, ink redrawn crisply.
Two uses: settling an argument about an ambiguous scrawl, and making a moment out of a team
that wrote something funny. Escape returns to the grid.

### Other board details

- **Blank submissions** render as a greyed "— no answer —" card, pre-marked incorrect, so
  every team is visibly accounted for.
- **Hide toggle per card.** Teams draw things. One tap blanks a card on the projector while
  the host still sees and marks it. Have it before you need it.
- **Draw-on animation**, optional: because strokes are timestamped, cards can replay the
  writing as they appear rather than popping in finished. Genuinely striking on the first
  category; set it to fade-in after that or it slows the night down.

---

## 6. Marking — and the volume problem

**This is the biggest risk in the design, so it gets its own numbers.**

A maximum event is 72 questions × 24 teams = **1,728 individual marks**. At two seconds each
that's 58 minutes of pure tapping. At your 16-team target it's 1,152 marks — still far too
many to do one at a time.

Automated grading is off the table, and with handwriting there's nothing to group by
(no two hand-drawn answers are the same string). So the fix has to be in the interaction:

**Default every card to unmarked, and tap only the exceptions.**

```
┌───────────────────────────────────────────────────────────────┐
│ ANSWER BOARD · Philippine History · Q1 of 8 · 2 pts           │
│ Correct: Emilio Aguinaldo                                     │
├───────────────────────────────────────────────────────────────┤
│  1 QUIZZY RASC. │ 2 THE MANGOES │ 3 TEAM 5      │ 4 BRAIN CEL │
│    ~Emilio~  ✓  │   ~aguinaldo~✓│   ~E. Aguin~  │   ~Quezon~  │
│  5 NO IDEA INC  │ 6 THE ALPHAS  │ 7 SIX PACK    │ 8 LATE ENTRY│
│    ~Aguin!!~ ✓  │   ~emilio a.~ │   —no answer— │   ~Aguinal~ │
├───────────────────────────────────────────────────────────────┤
│  A = all correct    Z = all wrong    1–9,Q–P = toggle one     │
│  Marked 3 of 8         [Spotlight]      [Confirm & next ▶]    │
└───────────────────────────────────────────────────────────────┘
```

- `A` marks every card correct, `Z` marks every card wrong, then you flip the exceptions.
- Number and letter keys toggle individual cards; the key is printed on each card.
- Most questions are lopsided — an easy question is `A` then flip two, a hard one is `Z` then
  flip three.

That turns a typical question from 16–24 taps into **3–6**, and a maximum event from 1,728
marks into roughly **300–450 keystrokes** across the whole night. That is the difference
between workable and unworkable, so it belongs in Milestone 1, not as a later optimization.

**Rough runtime for a full 9 × 8 event:** ~25 s per question live (read it, 15 s timer, lock),
~20 s on its board (reveal, mark, confirm), plus banter — about 8–10 minutes per category, so
**75–90 minutes** for a maximum night. Worth knowing before you author 72 questions.

Running the board after every question doesn't change that total — the same 72 boards happen
either way. What changes is the shape: 45-second beats spread through the category instead of
a five-minute marking block at the end of it. That's easier on the room and easier on you,
since you are marking an answer the room heard fifteen seconds ago rather than one from eight
questions back.

### Corrections
Scores are an **append-only ledger** — a mark, a host adjustment, a tiebreak award — never a
mutable total. Totals are summed on read. So re-opening category 2 in the middle of category
5 to flip a mark is safe: nothing is overwritten, everything downstream recalculates, and you
can always explain why a team has 34 points.

---

## 7. Teams

### Joining

```
  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
  │   [QR scan]   │   │   ENTER CODE  │   │  TEAM NAME    │
  │       ↓       │ → │               │ → │               │
  │  trivia.app   │   │   4 8 2 9 1 7 │   │  The Mangoes  │
  │    /join      │   │               │   │               │
  └───────────────┘   │   [ Enter ]   │   │  [ We're in ] │
                      └───────────────┘   └───────────────┘
```

1. **Scan the QR code** on the table tent. It points at one fixed join URL.
2. **Enter the six-digit code** given out on site. This is the real gate — a QR code can be
   photographed and passed around, but the code only goes to people in the room and changes
   every event.
3. **Nominate a team name.** Profanity-filtered, duplicates auto-disambiguated.

**The team name is fixed at join and cannot be changed by the team.** Once they're in, the
name is locked for the whole event — it's the label on every card on the big screen and the
row on the leaderboard, and a name that changes mid-event breaks both. The host can still
rename any team from the console (for a duplicate, a typo, or something that shouldn't be
projected), but that is a host action, never a team one. A team taking over on a new phone
after a dead battery rejoins *into the existing name*; it never gets to pick a new one.

Because the QR is a fixed URL and only the code changes, **print the table tents once and
reuse them forever.**

### One device per team

The phone that creates the team *is* the team — it's the whiteboard, and the team huddles
around it. One submission per question, no ambiguity about whose answer counts, no sync
problem. It also means each team is a single point of failure, so:

- Identity is a signed device token in local storage. A refresh, an accidental tab close or a
  browser crash puts them straight back in with their answers and score intact.
- **Team takeover:** on creation the phone shows a 4-digit team PIN. If that phone dies, a
  teammate scans, enters the session code, taps *rejoin an existing team*, picks the name and
  enters the PIN.
- **Host override:** the host can hand a team over from the console, or draw/type an answer
  on their behalf for one question.

### What teams see
Only their own locked answers — never other teams', never the full board. During the board
their phone shows a quiet *"look up 👆"* alongside their own ink for that question, flipping
green or red as the host marks it. Eyes stay on the projector; the phone is just confirmation.

### Submitting locks the screen — it never clears it
**The writing surface is never wiped on submit.** The ink the team drew stays exactly where
they drew it, at the size they drew it, and the surface goes read-only: no more strokes, no
undo, no edit. A small *Answer locked* badge is the only thing that changes.

Clearing the canvas on submit would be a small betrayal. A team that has just committed an
answer wants to look at it — to check they wrote what they meant, to argue about it among
themselves, to see it again when the board goes up. Wiping it says the answer is gone;
freezing it says the answer is *in*. It also makes the confirm step honest: what stays on
their screen is exactly what will appear on the projector.

The surface stays frozen until the host opens the next question, which is the only thing
that clears it. A team that wants to re-read Q3's answer during Q4 can't — but they have
already seen it stay put, which is what builds the trust.

---

## 8. Questions and points

| Type | Team does | On the board |
|---|---|---|
| `ink` | Writes with a finger | Their handwriting, redrawn as vector |
| `text` | Types (fallback mode) | Their text, verbatim — never normalized |
| `multiple_choice` | Taps an option | The option they chose |
| `numeric` | Number pad | The number entered |

`ink` is the default and the point of the product. Every type flows through the same manual
board — the host marks all of them.

Questions can carry an **image or audio clip**, shown on the phone and the big screen, and
pre-cached onto team devices during the lobby so nothing stalls mid-round.

**Points:** default 1, raised per question for difficulty. The value is shown to teams on the
question screen so they know what's at stake, and questions worth more than 1 are badged in
the authoring run order so you can see a category's shape at a glance. Marks are binary — for
half credit, author a 2-pointer and mark generously. A numeric **tiebreak** question sits in
reserve, fired from the panic menu whenever you need it.

No speed bonuses, no multipliers, no wagers. Deferred manual marking rules them out anyway,
and the format doesn't want them.

---

## 9. Session state machine

The server owns the state. Clients render what they're told; they never decide.

```
 DRAFT → LOBBY ──► CATEGORY_INTRO
                        ↓
                ┌─► QUESTION_LIVE     (timer running, phones writing)
                │        ↓            (timer ends, or host locks)
                │   QUESTION_LOCKED
                │        ↓            (host opens the board)
                │   BOARD_ANSWER      (answer in the header, cards face-down)
                │        ↓            (host reveals)
                │   BOARD_CARDS       (handwriting up, host marks)
                │        ↓            (host confirms)
                └──── next question in category
                         │
                         └─ after the last one → CATEGORY_SCORES
                                                     ↓
                                    next category ... → FINISHED

            PAUSED — reachable from any state
```

**One board per question.** `BOARD_ANSWER` and `BOARD_CARDS` always belong to the question
that just locked, so there is no separate board cursor to keep in step with the question
cursor — `currentQuestionIndex` is the only position the session tracks inside a category.

**`prevPhase` walks the cycle backwards**, so a host who needs to fix a mark can step back
through `BOARD_CARDS → BOARD_ANSWER → QUESTION_LOCKED` and then into the *previous* question's
board, rather than re-opening a timer that has already closed.

**The timer is server-authoritative.** The server stores `question_ends_at` as an absolute
timestamp; clients count down against a clock offset measured at join, so a phone that sleeps
and wakes shows the right time remaining. A submission landing after `question_ends_at` plus
a ~1.5 s grace window is rejected — a slow connection shouldn't cost a team a point, but a
late answer can't win one.

**Nothing auto-advances.** The timer expiring locks answers; it never moves on by itself.

---

## 10. Realtime transport

WebSocket, one room per session.

**Server → clients**

| Event | To | Payload |
|---|---|---|
| `session.state` | all | full snapshot — on connect and on every change |
| `question.open` | teams, screen | prompt, options, points, `ends_at` |
| `question.locked` | all | — |
| `answer.count` | host, screen | `{ answered: 14, total: 16 }` |
| `board.answer` | all | the correct answer, alone |
| `board.cards` | host, screen | every team's stroke data for this question |
| `board.mark` | all | `{ team_id, is_correct }` — drives the live card flip |
| `board.spotlight` | screen | `{ team_id }` or null |
| `leaderboard.update` | all | standings |
| `team.joined` / `left` | host, screen | team summary |

**Clients → server**

| Event | From | Payload |
|---|---|---|
| `join` | team | code, team name, device token |
| `rejoin` | team | code, team name, team PIN |
| `answer.submit` | team | question id, **stroke JSON** or raw text |
| `host.*` | host | `start`, `lock`, `board_answer`, `board_cards`, `mark`, `spotlight`, `confirm`, `next`, `prev`, `adjust_score`, `rename_team`, `hide_card` |

Host commands carry an idempotency key — double-tapping Next in a loud room must not skip a
question.

`board.cards` is the only fat message in the system, at roughly 50–150 KB for 24 teams. It
goes to the host console and the big screen only — never to phones, which only ever receive
their own ink back.

**Reconnection:** a client resends its device token and gets a full `session.state` snapshot.
Never assume every intermediate message arrived; snapshots make the system self-healing,
which is what venue wifi demands.

---

## 11. Venue reality

Everything runs over venue wifi or mobile data, so connection quality is the main engineering
risk.

| Failure | Design response |
|---|---|
| Team drops mid-question | Strokes are captured locally and submitted on reconnect; accepted if inside the original window. Host sees a "reconnecting" badge on that team. |
| Team's phone dies | Team takeover via the 4-digit PIN on another phone, or the host answers on their behalf. |
| Wifi is slow | Payloads are tiny — a question is a few hundred bytes, an ink answer 1–2 KB gzipped. Media pre-caches during the lobby, never mid-question. The PWA shell caches on first load. |
| Big board message is slow | `board.cards` goes only to the console and projector, both of which are usually on better connections than the phones. |
| Projector dies | The game continues; the host can read the board aloud from the console. Degraded, not dead. |
| Host laptop dies | Session state is durable server-side. Reopen the console anywhere, log in, resume in place. |
| Team joins late | Allowed by default; they miss earlier points. Host can lock joins once the event starts. |
| A mark was wrong | Re-open any category's board, flip the mark, everything downstream recalculates. |

---

## 12. Integrity

Proportionate measures for a friendly event — not a proctoring system.

- **Short timers are the real defence.** Fifteen seconds is not enough to search, especially
  with a team talking over each other and one person writing.
- **An answer is only revealed once its question is closed.** Submissions lock before the
  board opens, so there is never a window where the answer is visible and the question is
  still live.
- **Handwriting is its own protection.** Writing an answer with a finger is slower than
  pasting one, and there's nothing to paste into.
- **Randomize multiple-choice option order per team.**
- **Submit once, no edits** after lock-in.
- **One device token per team.** A second join with the same token takes over and notifies
  the first.
- **Rate-limit join attempts by IP.** Six digits is only a million combinations — throttle
  hard after a handful of failures, and expire the code when the session ends.

### Role is a server-side fact

The socket's role is decided by the server at handshake and checked on every command;
nothing a client sends can promote it. Three rules follow, and they are what keep the
join code from doubling as a master key:

- **Host commands require a host token**, issued by a real password sign-in — never the
  six-digit join code, which every contestant in the room has.
- **A team's snapshot is redacted.** It carries no `correctAnswer` and nobody's `teamPin`,
  so neither is readable from a phone's devtools while the timer runs. The screen receives
  the correct answer only once the board is up.
- **The big screen sends nothing.** It is output only: fullscreen and ink weight are local
  display settings, and every state change — spotlight included — comes from the console.

Authoring data carries every answer for the night, so the whole authoring API is host-only
too. An open read there would hand out the answers before the event starts.

Not doing: camera monitoring, full-screen lockdown, tab-blur snitching, fingerprinting.

---

## 13. Technical architecture

```
   Host Console  ──┐
   Big Screen    ──┼── HTTPS + WSS ──► App Server ──► Postgres
   Team phones   ──┘                    (Node/TS)     (+ object storage
                                                        for question media)
                                     - REST: auth, authoring
                                     - WS:   live session rooms
                                     - in-memory session state,
                                       journalled to Postgres on every change
```

- **Frontend:** React + TypeScript + Vite. One codebase, three routes — `/host`, `/play`,
  `/screen`. Tailwind. PWA manifest scoped to `/play`.
- **Ink:** `perfect-freehand` for stroke geometry, rendered as SVG paths. No canvas library
  needed on the display side — the board is just SVG.
- **Backend:** Node + TypeScript; Fastify for REST, `ws` for WebSocket.
- **Database:** Postgres, with stroke data in a `JSONB` column.
- **Auth:** host accounts only. Teams are anonymous.
- **Hosting:** a single always-on VM or container (Fly.io, Railway, Render), in a region
  close to your venues. Deliberately *not* serverless — live WebSocket rooms holding
  in-memory state want a long-lived process.

Session state lives in memory for speed and is journalled to Postgres on every transition, so
a process restart mid-event resumes rather than losing the night.

### Schema sketch

```sql
hosts       (id, email, password_hash, display_name, created_at)
events      (id, host_id, title, answer_mode, settings_json, created_at)
categories  (id, event_id, title, intro_media_url, position)   -- max 9 per event
questions   (id, category_id, type, prompt, options_json, correct_answer,
             points DEFAULT 1, time_limit_seconds DEFAULT 15,
             explanation, media_url, position)                 -- max 8 per category

sessions    (id, event_id, join_code CHAR(6), status, current_category_id,
             current_question_id, phase, question_ends_at, spotlight_team_id,
             settings_json, started_at, ended_at)
teams       (id, session_id, name, device_token, team_pin,
             answer_mode, status, joined_at)                   -- max 24 per session
submissions (id, session_id, question_id, team_id,
             answer_ink JSONB,       -- stroke data; the primary answer format
             answer_raw TEXT,        -- typed fallback / MC choice; never normalized
             submitted_at,
             is_correct BOOLEAN,     -- NULL until the host marks it
             marked_by, marked_at, is_hidden BOOLEAN DEFAULT false)
score_events(id, session_id, team_id, question_id, points, reason, created_at)
```

Stroke JSON shape — compact on purpose:

```jsonc
{
  "v": 1,
  "box": [1000, 360],           // viewBox the coordinates are normalized to
  "s": [                         // one entry per stroke
    { "t": 1240,                 // ms from question start, for draw-on replay
      "p": [120,80, 134,76, 151,79, ...] }   // flat x,y pairs, integers
  ]
}
```

Notes:
- `answer_ink` and `answer_raw` are written once and read many, and **neither is ever passed
  through a normalizer** — that's what makes §4's verbatim promise hold.
- A unique constraint on `submissions(session_id, question_id, team_id)` enforces one
  submission per team per question at the database level, not just in the UI.
- Indexes: `submissions(session_id, question_id)` to build a board,
  `teams(session_id, device_token)` for reconnects, and a partial index on
  `sessions(join_code) WHERE status = 'live'`.
- Rendering answers to PNG for a post-event export is a server-side job, run on demand — not
  something that happens on the capture path.

---

## 14. Host authoring screen

```
┌─────────────────────────────────────────────────────────────┐
│  NWTF Trivia Night — September            [Preview] [Host ▶]│
├──────────────┬──────────────────────────────────────────────┤
│ CATEGORIES   │  Q3 · Philippine History                     │
│  History  ▾  │  ┌────────────────────────────────────────┐  │
│   Q1 ✓  1pt  │  │ Who was the first president of the     │  │
│   Q2 ✓  1pt  │  │ Philippine Republic?                   │  │
│   Q3 ●  2pt  │  └────────────────────────────────────────┘  │
│   + question │                                              │
│  Movies   ▸  │  Type [Ink ▾]    Points [2]   Timer [15s]    │
│  Music    ▸  │  Correct answer: Emilio Aguinaldo            │
│ 6 of 9 cats  │  (shown to you while marking, not to teams)  │
│ + category   │  Media [+ image]                             │
└──────────────┴──────────────────────────────────────────────┘
```

- **The left rail is the run order.** Drag to reorder questions or categories; what you see
  top to bottom is what happens on the night. Points show inline, and the rail shows how
  close you are to the 9-category / 8-question ceilings.
- **Autosave.** No save button, just a quiet "saved 2s ago".
- **Bulk import** — paste a spreadsheet block or CSV:
  `category, type, prompt, options, answer, points, seconds`. Authoring 72 questions one form
  at a time is the fastest route to abandoning the app; this matters more than it sounds.
- **Preview** walks the whole event with simulated teams and sample handwriting, so you can
  rehearse the board before a live room sees it.
- **Events are reusable.** Duplicate one, get a fresh session and a fresh code.

---

## 15. Build order

**Milestone 1 — the spine.** Host auth. Author an event: categories, ink questions, points.
Six-digit session code. Teams join by QR + code + name. Question → 15 s timer → lock.
**Ink capture and SVG rendering.** Answer board with the two-stage reveal and manual marking,
**including `A` / `Z` / toggle keyboard marking** — the volume maths in §6 makes that a
Milestone 1 feature, not an optimization. Leaderboard. Big Screen view.

**Milestone 2 — survive a real event.** Reconnection and state snapshots. Team takeover by
PIN. Panic controls: re-open a board, adjust scores, extend timer, rename/remove a team, hide
a card. Spotlight. Answered counter. Blank-answer handling. Typed fallback mode.

**Milestone 3 — make it good.** Multiple choice and numeric. Media upload and lobby
pre-caching. Draw-on replay animation. CSV bulk import. Preview mode. Tiebreak. Post-event
export with rendered handwriting.

**Milestone 4 — polish.** Event duplication, question bank across events, per-category stats,
ink smoothing refinements.

Ship Milestone 1, run one real night with a forgiving crowd, then build Milestone 2 out of
whatever actually broke.

---

## 16. Settled decisions

| Question | Answer |
|---|---|
| Team count | 16 target, 24 max — so the board never paginates |
| Event size | 9 categories × 8 questions max |
| Reveal order | Correct answer first, then host toggles to show all teams' answers |
| What teams see | Only their own locked answers |
| Answer input | Finger handwriting, captured as strokes, typed fallback available |
| Answer checking | Entirely manual |

### Still open

1. **Does ink at 24 teams read from the back of your usual room?** The 6 × 4 grid gives each
   answer a 280 px-wide strip. Worth a physical test with your actual projector before
   committing to 24 as a real ceiling rather than a theoretical one.
2. **Draw-on replay — on or off by default?** Striking the first time, slow by the ninth
   category.
3. ~~Should the spotlight be reachable from the big screen's own keyboard?~~ **Settled: no.**
   The projector is output only — it holds no host credential, so anyone who could open the
   screen URL could otherwise drive the board. Spotlight is a console control. The screen
   keeps `F` for fullscreen and `[` / `]` to tune ink weight, both purely local.
