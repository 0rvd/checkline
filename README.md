🏟️ CHECKLINE

<div align="center">

### ⚽ Tactical football. Chess-powered.

**Think three moves ahead. Find the pass. Take the shot.**

A tactical football game played on an **8 × 12 chessboard pitch**. Build a move, protect your goal, and race to three.

<br>

![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-game-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![English and Arabic](https://img.shields.io/badge/English-%2B%20العربية-7C4DFF?style=for-the-badge)
![Optional online play](https://img.shields.io/badge/Online-Supabase%20(optional)-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)

**🤖 Play the computer** &nbsp; · &nbsp; **👥 Local matches** &nbsp; · &nbsp; **🌐 Online play**

<br>

[✨ Why Checkline?](#why-checkline) &nbsp;·&nbsp;
[🚀 Quick start](#quick-start) &nbsp;·&nbsp;
[🎮 Modes](#game-modes) &nbsp;·&nbsp;
[📖 Rules](#rules-at-a-glance) &nbsp;·&nbsp;
[🕹️ Controls](#controls) &nbsp;·&nbsp;
[☁️ Online setup](#online-setup) &nbsp;·&nbsp;
[🧰 Development](#project-map)

</div>

---

<a id="why-checkline"></a>
## ✨ Why Checkline?

Most football games ask you to react. **Checkline asks you to plan.** Your pieces move like chessmen, the ball carrier dribbles one square at a time, and every turn gives you **3 Action Points** to make something happen.

🔐 **Your local games stay local.** Computer, local, and tutorial play need no backend. Online matches and the leaderboard connect to your own Supabase project.

🌍 **Made for two reading directions.** The complete interface is available in **English and Arabic**, with a right-to-left layout for Arabic.

🏆 **Easy to learn, hard to rush.** Pass through a clear lane, pull a defender out of position, and turn one opening into a goal.

> 💡 **The objective:** score 3 goals before your opponent—or lead when the match clock runs out.

---

<a id="quick-start"></a>
## 🚀 Quick start

**Requirements:** [Node.js 22 or newer](https://nodejs.org/)

```bash
npm install
npm start
```

Open **[http://localhost:5173](http://localhost:5173)** and kick off! ⚽

```bash
npm test          # Rules, AI, localization, and online-client tests (57)
npm run typecheck
```

> ✅ Local, computer, and tutorial play are ready without any extra service. To enable online play and the leaderboard, see [☁️ Online setup](#online-setup).

---

<a id="game-modes"></a>
## 🎮 Game modes

| Mode | What you get |
| --- | --- |
| 🤖 **Play the computer** | Choose Easy, Medium, or Hard—and play as Ivory, Ebony, or a random side. |
| 👥 **Local match** | Two players share one device, with a hand-off screen between turns. |
| 🌐 **Online match** | Public lobby, private invite codes, live moves, reconnect and resume, online/away status, a 90-second turn timer, resign, and claim-win after 90 seconds away. |
| 🏅 **Leaderboard** | Elo ratings, wins, draws, and losses. See 15 players per page; ties break deterministically. |
| 🎓 **Guided tutorial** | Seven interactive lessons covering the real rules—from movement to defending lanes. |
| 🔑 **Accounts** | Sign up or log in with email and password, reset a password by email, log out, or choose guest play. |

The menu shows who is signed in. Online matches and rankings use the Supabase configuration you provide.

---

<a id="rules-at-a-glance"></a>
## 📖 The rules at a glance

### ⏱️ Your turn
Each turn gives you **3 Action Points (AP)**. A move, pass, shot, or tackle costs **1 AP**. Once per rally, each side can use **Surge** for **+1 AP** during a turn; it recharges at every kickoff.

### ♟️ The pieces

| Piece | Movement |
| --- | --- |
| 👑 **King** | 1 square. Stays in its own box as goalkeeper. |
| 👸 **Queen** | Up to 2 squares in any line or diagonal. |
| 🏰 **Rook** | Up to 3 squares along a row or column. |
| 🔺 **Bishop** | Up to 3 squares diagonally. |
| 🐴 **Knight** | Jumps in an L shape. |
| 🛡️ **Pawn** | 1 square forward or sideways. |

### ⚽ With the ball

- **Dribble** — the ball carrier moves only **1 square at a time**. Knights still jump.
- **Pass** — send the ball in a straight line, up to **4 squares**, through a clear lane. A teammate marked by an opponent directly beside them cannot receive.
- **Shoot** — shoot in a straight line, up to **5 squares**, into an **open goal-mouth square (B–G on the end row)**. The keeper covers its own square and every neighboring square.
- **Tackle** — move onto the ball carrier. Pawns tackle diagonally forward. A tackled player sits out until the next kickoff; only the carrier can be tackled.

### 🏁 Match clock

First to **3 goals** wins. After **30 turns**, the leader wins. A tied score goes to golden goal; if the match is still tied at turn **40**, it ends in a draw.

Want to know *why* a rule works this way? **[DECISIONS.md](DECISIONS.md)** explains the design choices.

---

<a id="controls"></a>
## 🕹️ Controls & board hints

### 🧭 Find your move

- Click one of your pieces to reveal its legal moves.
- **Dots** mark moves · **red rings** mark tackles · **gold glow** marks a scoring move.
- A faint **×** marks a blocked square. Hover over it or click it to see why.
- Select the ball carrier, then click a **gold-ringed teammate** to pass or a **glowing goal square** to shoot.
- **⊘** means a teammate is marked and cannot receive a pass.
- Red dashed circles and lines preview the shots your opponent could take next turn.

### ⌨️ Keyboard

| Key | Action |
| --- | --- |
| `S` | Surge |
| `E` | End turn |
| `U` or `Ctrl+Z` | Undo within your turn in local, computer, and tutorial games |
| `Tab` | Move focus to the board |
| `↑` `↓` `←` `→` | Move the board cursor |
| `Enter` or `Space` | Act |
| `Esc` | Deselect |

### ⚙️ Settings

Change language from the menu or side panel; your choice is remembered. Sound effects are synthesized in the browser, so no audio files are needed. The game also respects your operating system’s reduce-motion setting.

---

<a id="online-setup"></a>
## ☁️ Online setup

Online matches and the leaderboard run through **your own Supabase project**. Local, computer, and tutorial games do not need this setup.

1. Open **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** and create a Supabase project.
2. Run `supabase/setup.sql` in the project’s SQL Editor.
3. Copy `.env.example` to `.env`.
4. Add your `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`.

Then start the game with `npm start` and sign in to play online. 🔗

---

<a id="project-map"></a>
## 🧰 Project map

```text
src/
├── rules/       Rules engine: pure, data-driven, and configurable
├── ai/          Easy / Medium / Hard computer opponent
├── i18n/        English and Arabic UI text, RTL, and rule explanations
├── online/      Online client and Supabase implementation
├── tutorial/    Lesson positions and success checks
└── ui/          App, board, views, motion, original vector pieces, sound, styles
supabase/        Database setup and local SQL verification stub
scripts/         Local server, runtime config, and SQL verification
tests/           node:test suites and browser end-to-end checks
```

The board, action points, movement ranges, pass and shot reach, clock, and starting formation are configured in `src/rules/config.ts`.

### 🧪 Optional developer checks

- `npm run verify:sql` starts a throwaway local PostgreSQL 15+ database and checks server rules against the TypeScript rules action by action, including security rules. Requires `initdb`, `pg_ctl`, and `psql`.
- `npm run e2e` checks every screen in both languages, full matches, all tutorial lessons, online flows against a fake backend, and leaderboard states in a headless browser. Requires Playwright with Chromium and a running `npm start`.

---

<a id="project-notes"></a>
## 📝 Project notes

- **[DECISIONS.md](DECISIONS.md)** — design decisions, rule changes, and balance data.
- **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** — configure your own online backend.
- **[LICENSE](LICENSE)** — proprietary license.
- **[NOTICE](NOTICE)** — third-party component notices.

---

<div align="center">

### 👟 One pitch. Three actions. One opening.

**Read the board. Make the move. Score the goal.** ⚽

© 2026 Mohammed Khalid · Checkline is proprietary software.  
The code, rules, designs, artwork, and text may not be copied, modified, distributed, or hosted without written permission. See [LICENSE](LICENSE).

</div>