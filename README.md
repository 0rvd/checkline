# Checkline

Tactical football on an 8×12 chessboard pitch. Pieces move like chessmen (with short ranges), the ball carrier dribbles one square at a time, and you have 3 actions a turn to dribble, pass, shoot and tackle. First to three goals wins. If no one gets there, the match clock decides.

You can play locally on one device, against the computer (Easy, Medium or Hard), or online against another person with an Elo leaderboard (through your own Supabase project). The whole interface is in **English and Arabic**, and Arabic uses a right-to-left layout.

## Run it
Requires Node.js 22+.

```bash
npm install      # TypeScript + Node types only (no runtime dependencies)
npm start        # compiles, then serves http://localhost:5173
npm test         # rules, AI, localization, ranks, economy and online-client unit tests (64)
npm run typecheck
```

Local, computer and tutorial play need nothing else. For online play and the leaderboard, follow **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)**:
1. Run `supabase/setup.sql` in your project's SQL Editor.
2. Copy `.env.example` to `.env`.
3. Put `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`.

Optional developer checks:
* `npm run verify:sql` runs `supabase/setup.sql` on a throwaway local PostgreSQL 15+ and checks the server rules against the TypeScript rules action by action, plus security, C-ranks, coins, purchases and admin grants. It then upgrades every earlier database version (fixtures in `supabase/tests/legacy/`) and checks no player, coin or item is lost. It needs `initdb`, `pg_ctl` and `psql`.
* `npm run e2e` runs a headless browser check of every screen in both languages: full matches, all tutorial lessons, the online flows against a fake backend, and the leaderboard states. It needs Playwright with Chromium and a running `npm start`.

## The rules in one minute
* **Turn:** 3 Action Points (AP). A move, pass, shot or tackle costs 1 AP.
* **Movement:** pieces move like chess pieces with short ranges.
  * King: 1 square, and it stays in its own box as goalkeeper.
  * Queen: up to 2 squares in any line or diagonal.
  * Rook: up to 3 along a row or column.
  * Bishop: up to 3 diagonally.
  * Knight: jumps in an L.
  * Pawn: 1 square forward or sideways.
* **Dribble:** whoever has the ball moves only 1 square at a time. A Knight still jumps.
* **Pass:** in a straight line (row, column or diagonal), up to 4 squares, through a clear lane. A teammate with an opponent directly beside it is **marked** and can't receive.
* **Shoot:** in a straight line, up to 5 squares, into an **open** goal-mouth square (B–G on the end row). The keeper covers its own square and every square next to it.
* **Tackle:** move onto the ball carrier. Pawns tackle diagonally forward. The tackled piece is benched until the next kickoff. Only the carrier can be tackled.
* **Surge:** once per rally, each side can take +1 AP during one of its turns. It recharges at every kickoff.
* **Clock:** first to 3 goals wins. After 30 turns the leader wins. If the score is level it goes to golden goal, and a match still level at turn 40 is a draw.

DECISIONS.md explains why each rule exists.

## Modes
* **Play the computer:** choose Easy, Medium or Hard and your side (Ivory, Ebony or random).
* **Local match:** two players on one device, with a hand-off screen between turns.
* **Accounts:** a Log in / Sign up page (email and password), password reset by email, **change password** while signed in, log out, plus optional guest play. Passwords stay in Supabase Auth only. The menu shows who is signed in.
* **C-ranks:** online matches between two email accounts move your rank points (+10 win, −6 loss, never below 0). Tiers: C5 (0–149), C4 (150–299), C3 (300–449), C2 (450–599), C1 (600+). Your tier, points and progress are on the lobby's profile card, and every player's tier is on the leaderboard. Early resigns / forfeits (before turn 6) and more than 3 wins a day against the same opponent give the winner no points.
* **Online match:** a public lobby, private invite codes, and live opponent moves. It also has reconnect and resume, the opponent's online/away status, a 90-second turn timer (you can end an idle opponent's turn), resign, and claim-win after 90 s away.
* **Leaderboard:** rank, player, Elo rating, wins, draws and losses. Ratings are computed on the server, ties break deterministically, and the table shows 15 per page.
* **Shop and coins:** signed in, your coins and items are saved to your account in the database, so they follow you to every device. Online matches pay them (checked by the server): +3 for a win and +5 every 3rd finished online match. Without an account, coins are saved in this browser and also come from matches against the computer. The owner can grant or remove coins with an audited admin function (see SUPABASE_SETUP.md). Spend them on 3 pitch floors (Midnight Pitch, Sunset Arena, Neon Cyber) and 3 piece skins (Obsidian Dark, Neon Glow, Gold Elite). Everything in the shop is cosmetic and never changes the rules. Open it from the coin button or the Shop card on the menu.
* **Guided tutorial:** seven short interactive lessons on the real rules: movement, dribbling, passing and marking, tackling, shooting, Surge and defending lanes.

## Controls
* Click a piece of the side to move to see where it can go:
  * dots are moves
  * a red ring is a tackle
  * a gold glow is a scoring move
  * a faint × is blocked; hover over it or click it to see why
* With the ball carrier selected:
  * Click a gold-ringed teammate to pass. A ⊘ means the teammate is marked.
  * Click a glowing goal square to shoot. The dashed gold line shows the shot.
* When your opponent has the ball, red dashed circles and lines show the shots they could take next turn.
* **Surge** (`S`), **End turn** (`E`), **Undo** (`U` / `Ctrl+Z`). Undo works within your own turn in local, computer and tutorial play.
* On phones and small tablets, **Undo / Resign** and **End turn** (or the lesson buttons) sit in a bar fixed to the bottom of the screen. When the phone is sideways, the bar floats in the bottom-right corner, so the buttons are always reachable without scrolling.
* Keyboard: Tab onto the board, move the cursor with the arrow keys, and press Enter or Space to act. `Esc` deselects.
* Settings in the side panel:
  * Language: switch it here or on the menu. Your choice is remembered.
  * Sound effects: synthesized in the browser, no audio files.
  * Reduce motion: the OS setting is respected too.

## Structure
```
src/rules/      Rules engine: pure and data-driven (config.ts holds board, AP, ranges, pass/shot reach, clock, formation)
src/ai/         Computer opponent: Easy / Medium / Hard on top of the real rules
src/i18n/       en.ts, ar.ts (all UI text) + helpers for rule reasons, pieces, events
src/online/     config.ts (reads public settings), backend.ts (OnlineBackend + Supabase implementation), ranks.ts (C-rank tiers), wire.ts
src/tutorial/   Lesson positions and success checks
src/ui/         app.ts (controller), board.ts, views.ts, motion.ts, pieces.ts (original vector art), sound.ts, economy.ts (coins, shop, themes), styles.css
supabase/       setup.sql (complete database setup + in-place upgrades), reset-everything.sql, admin-queries.sql, tests/ (local auth stub and legacy fixtures, verify:sql only)
scripts/        serve.mjs (dev server, serves /config.js from .env), write-config.mjs, verify-sql.mjs, verify-upgrade.mjs
tests/          node:test suites; tests/e2e/ browser check + in-memory fake backend (test only)
```

Design decisions, the rule changes and the balance data are in **DECISIONS.md**.

## License
Copyright © 2026 Mohammed Khalid. All rights reserved.

Checkline is proprietary software. The code, rules, designs, artwork and text may not be copied, modified, distributed or hosted without written permission. See [LICENSE](LICENSE). Third-party components are listed in [NOTICE](NOTICE).
