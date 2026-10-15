# Checkline: decisions and assumptions

Sources:
* The user's briefs. The v0.3 "master creative brief" gave creative ownership of the rules.
* *Checkline Game Design Document v1.0*.
* The *Investor Pitch Deck* (vision and palette).

The pre-redesign version is saved as git tag `v0.2-checkpoint`.

---

# v0.3: the redesign

## Why the rules had to change
In v0.2, attackers moved only up and down their column and defenders only sideways along their row. Pieces could not pass each other, and only the ball carrier could be captured. That created a **structural stalemate**:
* The order of pieces in a column never changed.
* The side without the ball could never lose a piece.
* A careful carrier never had to come within reach.

Two good players, or two good AIs, could stay at 0–0 indefinitely. There was also no clock and no draw. The redesign keeps the GDD's core (8×12 pitch, one ball, 3 AP, chess pieces as footballers, only the carrier can be tackled). It replaces the lane system with rules that create real football decisions.

## The rules (v3)
| Rule | What it is | Why |
|---|---|---|
| **Chess movement, short range** | King 1 (any direction), Queen ≤2 (lines and diagonals), Rook ≤3 (orthogonal), Bishop ≤3 (diagonal), Knight L-jump, Pawn 1 forward or sideways. Sliders are blocked by pieces. | Everyone already knows the chess shapes, so the game is instantly readable. Short ranges keep a 12-row pitch from being crossed in one move. |
| **Dribble** | The ball carrier moves only 1 square at a time. A Knight still jumps. | This is the key balance lever. Running with the ball is slow, so passing and shooting matter. It also stopped "kickoff → two Queen slides → goal". It gives the Knight a clear identity as the best carrier in traffic. |
| **Pass** | A straight line (row, column or diagonal), ≤4 squares, clear lane, 1 AP. | Lines and diagonals match the chess feel. Lanes make positioning matter. |
| **Marking** | A teammate with an opponent *orthogonally* adjacent cannot receive. | Without it, the side in possession kept the ball almost forever (the kickoff side scored the next goal about 92% of the time in Hard-vs-Hard tests). Marking is the defender's main tool other than tackling, and it is easy to see on the board (⊘). |
| **Shoot** | A straight line, ≤5 squares, into an *open* goal-mouth square (B–G on the end row), 1 AP. Any piece in the lane blocks it. | Goals need a finishing action. It creates the satisfying moment of finding the open corner, and it makes defensive lane-blocking a skill. |
| **Keeper coverage** | The King stays in its box (B–G × 2 rows) and covers its own square plus every square next to it. Only the keeper may stand in its own goal mouth; only the carrier may enter the opponent's. | A one-square keeper is a real goalkeeper: it narrows the goal, but it can't cover all six squares, so attackers work the ball to the far side. It also stops "park every piece on the goal line". |
| **Dribble goals and keeper tackles** | Dribbling into an open goal square scores. Tackling the keeper while it holds the ball in its own goal mouth is a goal. | This keeps the GDD's "carry it in" goal. It also punishes a lazy back-pass to the keeper. |
| **Pawn tackles diagonally** | Pawns move straight but tackle diagonally forward. | This is the chess capture rule. It makes pawns a pressing screen. |
| **Surge** (signature mechanic) | +1 AP once per rally per side, refreshed at each kickoff. | A tempo decision every rally: spend it now to finish an attack, or hold it to defend. The AI values holding it, and the tutorial teaches it. |
| **First to 3, clock** | First to 3 goals. After 30 turns the leader wins; if level, golden goal; a draw at 40. | Every match ends, at the latest on turn 40. Draws are possible, so the Elo handles them (S = 0.5). |
| **Formation and kickoff** | K D1, Rooks C2/F2, Bishop E2, Pawns B4/G4, Queen D4, Knight E4. The kicking side's Queen starts with the ball on D6 (A) or D7 (B). The side that conceded kicks off; the opening kickoff is a coin toss. | A compact shape. With the dribble rule, the kickoff side can't score instantly. |

All values live in `src/rules/config.ts`. The tests (`tests/engine.test.ts`) check that the ranges and costs are read from config rather than hard-coded.

## How I tuned it
The rules were tuned by running AI-vs-AI matches with the engine, changing one parameter at a time, and reading match traces. The final configuration produced:

| Pairing | Matches | Result (W-D-L) | Goals | Kickoff side scored next goal |
|---|---|---|---|---|
| Hard vs Hard | 10 | 5-0-5 | 10–12 | 17 of 22 |
| Medium vs Medium | 16 | 10-0-6 | 24–17 | 21 of 41 |
| Hard vs Medium | 6 | 6-0-0 for Hard | 17–0 | n/a |
| Medium vs Easy | 8 | 8-0-0 for Medium | 23–0 | n/a |
| Easy vs Easy | 78 | 14 first-to-3, 14 golden goal, 38 clock win, 12 draws | 2.8 per match | n/a |

What the changes fixed along the way:
* The dribble rule and the compact formation removed instant kickoff goals.
* Marking cut possession dominance from about 92% to a range where defending pays off.
* Moving shot range from 4 to 5, and widening the goal mouth from C–F to B–G, raised scoring from "rare" to about 2–3 goals per match.

A remaining asymmetry: in Hard-vs-Hard play the kickoff side still scores the next goal more often than not (17/22). The conceding side kicks off, so this works as a natural comeback mechanic. To flatten it, tune `passRange` or the kickoff square.

## AI (`src/ai/ai.ts`)
Every candidate action comes from `legalActions` (built on the engine's own previews) and is applied with `applyAction`. The AI uses the same rules as the player and sees nothing hidden; Checkline has no hidden information anyway.

* **Easy:** random legal actions with a forward lean. It takes an open shot about 60% of the time and sometimes ends its turn early.
* **Medium:** greedy, one action at a time, on a positional evaluation. The evaluation includes score, clock, material, Surge held, possession, ball progress, AP-to-goal by a BFS over dribbles, passes and shots, open shots, and tackle threats. It adds small noise and makes occasional near-tie slips. It only spends Surge when it clearly pays off.
* **Hard:** a beam search over the whole turn, including Surge. Each line is checked against the opponent's best reply and then Hard's own follow-up. It also checks multi-move tackle threats against its carrier. The time budget is 0.9 s in the UI; the slowest observed plan is about 1 s.
* **Measured:** on 40 sampled positions, the carrier was left punishable on the next turn in 33 (Easy), 20 (Medium) and 5 (Hard). Medium and Hard beat Easy as either side, and Hard beats Medium (see the table above).
* **Pacing:** the computer "thinks" for about 0.4 s, highlights each piece before acting, and leaves about 0.65 s between actions so a person can follow. Under reduced motion it is faster.

## Consistency across the game
The same rules run in five places:
1. The TypeScript engine (`src/rules`).
2. The AI, which uses the engine directly.
3. The tutorial, which runs on real engine positions.
4. The UI, which only renders engine previews.
5. The server, which has a PL/pgSQL mirror in `supabase/setup.sql`.

`npm run verify:sql` replays seeded games through both engines and compares every result. The last run compared 11,537 actions: 4,957 accepted (138 goals) and 6,580 rejections with identical reason codes. 70 security and flow checks also passed.

## Presentation
* **Look:** a night-match stadium, with floodlight haze, mown grass bands, chalk lines, goal boxes and drawn goal nets above and below the pitch. The scoreboard is broadcast-style (team crests, big digits, the clock, golden goal). The palette is the deck's: emerald, ivory, ebony and gold, plus "electric" blue for Surge only.
* **Pieces:** original vector silhouettes for all six chess pieces, with gradients, on ivory and ebony discs. Each piece also shows a letter (localized), so team and role never depend on colour alone. The rules sheet has movement diagrams.
* **Tactical overlays:**
  * moves, tackles and scoring squares
  * pass targets, and marked receivers (⊘)
  * shot targets with dashed shot lines
  * keeper-covered squares (hatched)
  * threats against your carrier
  * the opponent's open shots against you (red)
* **Motion:**
  * pieces slide (FLIP), and passes arc
  * shots fly fast and low with a trail into a rippling net
  * tackles get a burst and a shake
  * Surge sweeps the pitch
  * the ball drops in at kickoff
  * GOAL is stamped with confetti
  * banners announce turns, Surge and golden goal
* **Sound and reduced motion:** sound is synthesized with Web Audio; there are no audio files, so there are no licensing questions. "Reduce motion" and the OS preference turn off every animation, including the menu's animated mini-pitch.
* **Assets:** no third-party images, fonts or sounds are bundled. The web fonts are IBM Plex Sans, IBM Plex Sans Arabic and Outfit, loaded from Google Fonts; all three are under the SIL Open Font License. System fonts are the fallback offline.

## Language support
* All UI text lives in `src/i18n/en.ts` and `src/i18n/ar.ts`. The compiler enforces that Arabic has every English key. Tests check the placeholders and that no Arabic entry was left in English.
* Engine messages are codes plus parameters, so every "why can't I…" message is translated, including the server's rejection reasons.
* Arabic uses `dir="rtl"` and IBM Plex Sans Arabic, with the browser's shaping. **The pitch is never mirrored:** files A→H and ranks 1–12 keep their meaning, and square names stay Latin (D6). The scoreboard keeps A on the left so "2 – 1" always means Ivory 2, Ebony 1. Panels, menus and arrows mirror.
* Team names are Ivory/Ebony (العاج/الأبنوس). In v0.2 the English name was "Obsidian"; it was renamed to match the Arabic. Piece names follow Arabic chess usage (جندي، وزير، حصان، قلعة، فيل، ملك).
* The choice is saved in `localStorage` (`checkline.lang`). On the first visit, the game follows the browser language.
* Layout was checked at desktop and phone widths in both languages (`npm run e2e`): no sideways scrolling and no clipped controls.

## Online play
* **Accounts:** Supabase Auth with email and password, from the game's own Log in / Sign up page.
  * The display name chosen at sign-up is stored with the account and becomes the public profile on first login, so it also works when email confirmation is on.
  * Password reset goes by email and lands on a "choose a new password" screen in the game.
  * Guests (anonymous sign-in) are optional.
  * Emails never appear in the game's tables; profiles hold only a name and the record.
  * Sessions persist in the browser, which makes resume work.
* **Authority:** the server re-validates every action with `checkline_private.apply_action`. Clients submit actions, never board states.
* **Concurrency:** optimistic versioning plus a row lock.
* **Sync:** Realtime `postgres_changes` plus presence, with a polling fallback, heartbeats, and a resync on focus or reconnect.
* **Turn timer:** 90 s per turn online. When it runs out, the waiting player can end the idle player's turn (`cl_claim_timeout`); the server checks the time. A player away for over 90 s can be claimed against for the win.
* **Ratings:** Elo with K = 32, including draws (score 1, ½ or 0). The update is zero-sum, written in the same transaction as the result, and happens exactly once per match.
* **Upgrade from v0.2:** `setup.sql` adds the new columns in place. Matches that were active under the old rules are marked `rules_version 2`; they can be viewed and resigned but not played. The app shows "Old rules" in the lobby.
* **Library:** supabase-js 2.45.4 is loaded at runtime from a pinned jsDelivr ESM URL, and only when online features are used. Set `SUPABASE_JS_URL` to self-host it.

## Accounts, C-ranks and coins (v0.4)
* **One player table, `public."user"`.** It replaces `cl_profiles` (renamed in place, so ids and foreign keys are kept) and absorbs the v0.3 coin tables. Email is copied from Auth for the owner's convenience but readable only by the player; public screens get names, Elo and tier through functions. Passwords are never copied: Supabase Auth is the only place they exist.
* **Elo and C-rank are separate.** Elo (K = 32) keeps ordering the leaderboard and is untouched, so v0.3 behaviour is preserved. The C-rank ladder is the visible progression: fixed +10 / −6 / 0 steps are easy to understand and make the 150-point tiers a predictable 15+ wins each.
* **Anti-abuse beyond the proposal.** A flat +10 per win is easy to farm with a second account that resigns at once. So: guests are never ranked (anonymous accounts cost nothing), a win that ended before turn 6 by resign / forfeit gives the winner 0 while the quitter still loses 6 (no free points, no dodging a loss), and points from the same opponent are capped at 3 wins per 24 hours. Losses are never capped.
* **Tiers are derived, never stored.** `rank_tiers` holds the thresholds; every read computes the tier from `rank_points`, so editing points (or the table) can never leave a stale tier.
* **Coins only from what the server can verify.** Online results are produced by the server, so it pays them in the same transaction as the result. Matches against the computer run only in the browser; paying an account for them would mean trusting a client report, so they pay only the signed-out browser wallet. The browser wallet never syncs up to an account.
* **Every coin change is in `coin_transactions`.** Server functions write the row themselves; a trigger records direct edits (Table Editor) as `manual_edit`, so balances always equal the sum of their history. Admin grants go through `cl_admin_adjust_coins` (owner / service role only, note required, never below zero).

## Interpretations to review
1. **Golden goal** applies only after a level score at turn 30. A goal then wins immediately, even if the score isn't 3.
2. **Turn counting:** the clock counts turns (one side's 3 AP), not rounds. 30 turns is 15 each.
3. **Benched pieces** return at the next kickoff, as in v0.2.
4. **Tutorial positions** use a no-clock scenario mode: goals don't reset the pitch, so each lesson stays on screen after it is solved.

## Not done / out of scope
* **Online play is not tested against a real Supabase project.** No credentials were available. The SQL was run and checked on local PostgreSQL 16 with a minimal stand-in for Supabase Auth. The browser client was tested against an in-memory fake backend. SUPABASE_SETUP.md lists the live checks to run.
* No chat, purchases, ads or store (not requested).
