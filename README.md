🏟️ CHECKLINE

<div align="center">

### ⚽ Tactical football. Chess-powered.

**Read the board. Build the play. Find the goal.**

Checkline is a turn-based football strategy game on an **8 × 12 chessboard pitch**. Move chess-inspired players, create passing lanes, defend your goal, and race to **three goals**.

<br>

![Version 0.3.0](https://img.shields.io/badge/version-0.3.0-d4a84f?style=for-the-badge)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6%2B-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![8 by 12 pitch](https://img.shields.io/badge/pitch-8%C3%9712-176b4d?style=for-the-badge)
![English and Arabic](https://img.shields.io/badge/languages-English%20%2B%20العربية-7C4DFF?style=for-the-badge)
![Online play](https://img.shields.io/badge/online-Supabase%20(optional)-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)

**🤖 Computer opponent** &nbsp; · &nbsp; **👥 Local matches** &nbsp; · &nbsp; **🌐 Online play** &nbsp; · &nbsp; **🛍️ Cosmetic shop**

<br>

[✨ Discover Checkline](#discover-checkline) &nbsp;·&nbsp;
[🚀 Quick start](#quick-start) &nbsp;·&nbsp;
[🎮 Game modes](#game-modes) &nbsp;·&nbsp;
[📖 Rules](#the-rules) &nbsp;·&nbsp;
[🕹️ Controls](#controls) &nbsp;·&nbsp;
[🪙 Coins & shop](#coins--shop) &nbsp;·&nbsp;
[☁️ Online setup](#online-setup) &nbsp;·&nbsp;
[🧰 Project map](#project-map)

</div>

---

<a id="discover-checkline"></a>
## ✨ Discover Checkline

This is football with a chessboard brain. Each turn gives you **3 Action Points**. Move, pass, shoot, or tackle—but every action changes the shape of the pitch.

🌱 **Tactical by design** — short-range chess movement, one-square dribbles, clear passing lanes, marking, and goalkeeper coverage make positioning matter.

🏟️ **A night-match atmosphere** — floodlit grass, chalk lines, goal nets, an illuminated scoreboard, and original vector-art pieces.

🎬 **A little drama in every play** — sliding pieces, arcing passes, fast shots, tackles, goal celebrations, and synthesized sound effects. Reduce-motion settings are respected.

🌍 **Built for English and Arabic** — the complete interface is translated, with right-to-left layout for Arabic. The pitch and its square names keep the same orientation in both languages.

🧩 **Choose how you play** — face the computer, share one device, or connect to online matches using your own Supabase project.

> 💡 **The objective:** score 3 goals first. If neither team gets there, the match clock decides.

---

<a id="quick-start"></a>
## 🚀 Quick start

**You’ll need [Node.js 22 or newer](https://nodejs.org/).**

```bash
npm install
npm start
```

Then open **[http://localhost:5173](http://localhost:5173)** and get on the pitch! ⚽

```bash
npm test          # Rules, AI, localization, and online-client tests (57)
npm run typecheck
```

> ✅ Local matches, computer games, and the tutorial need no Supabase account or backend. Online matches and the leaderboard are optional.

The project has no runtime npm dependencies; npm installs TypeScript and Node.js type definitions for building the game.

---

<a id="game-modes"></a>
## 🎮 Game modes

| Mode | Step onto the pitch |
| --- | --- |
| 🤖 **Play the computer** | Take on Easy, Medium, or Hard. Choose Ivory, Ebony, or a random side. |
| 👥 **Local match** | Play head-to-head on one device, with a hand-off screen between turns. |
| 🌐 **Online match** | Create or join a public lobby, use a private invite code, and follow live opponent moves. Reconnect and resume, check online/away status, resign, or claim a win after an opponent has been away for 90 seconds. |
| 🏅 **Leaderboard** | Compare Elo ratings, wins, draws, and losses. The table shows 15 players per page, with deterministic tie-breaking. |
| 🎓 **Guided tutorial** | Learn the real rules in seven short, interactive lessons. |
| 🔑 **Accounts** | Sign up or log in with email and password, reset a password by email, or continue as a guest if guest sign-in is enabled in Supabase. |

Online turns have a **90-second timer**. When time expires, the waiting player can end the idle player’s turn; the server checks the timeout.

---

<a id="the-rules"></a>
## 📖 The rules

### ⏱️ Three actions. One turn.

You start each turn with **3 Action Points (AP)**. A move, pass, shot, or tackle costs **1 AP**. Each side can use **Surge** once per rally to gain **+1 AP** during a turn. Surge refreshes at kickoff.

### ♟️ Chess-inspired movement

| Player | How they move |
| --- | --- |
| 👑 **King** | 1 square in any direction. The goalkeeper stays in its own box. |
| 👸 **Queen** | Up to 2 squares in a line or diagonal. |
| 🏰 **Rook** | Up to 3 squares along a row or column. |
| 🔺 **Bishop** | Up to 3 squares diagonally. |
| 🐴 **Knight** | Jumps in an L shape. |
| 🛡️ **Pawn** | 1 square forward or sideways. |

Sliding pieces cannot move through another piece.

### ⚽ Make the play

- **Dribble** — the ball carrier moves only **1 square at a time**. A Knight still jumps.
- **Pass** — send the ball in a straight line (row, column, or diagonal), up to **4 squares**, through a clear lane. A teammate with an opponent directly beside them is **marked** and cannot receive.
- **Shoot** — shoot in a straight line, up to **5 squares**, into an **open goal-mouth square (B–G on the end row)**. Pieces block the lane; the goalkeeper covers its own square and every neighboring square.
- **Tackle** — move onto the ball carrier. Pawns tackle diagonally forward. Only the carrier can be tackled; the tackled player is benched until the next kickoff.
- **Score** — carry the ball into an open goal square, or tackle a goalkeeper holding the ball in its own goal mouth.

### 🏁 The match clock

First to **3 goals** wins. After **30 turns**, the leader wins. If the score is level, play continues as **golden goal**. If it is still level at turn **40**, the match is a draw.

Curious why a rule works this way? **[DECISIONS.md](DECISIONS.md)** explains the design and balancing choices.

---

<a id="controls"></a>
## 🕹️ Controls

### 🧭 Read the board

- Click one of your pieces to see its legal moves.
- **Dots** show moves · **red rings** show tackles · **gold glow** marks a scoring move.
- A faint **×** means a square is blocked. Hover over it or click it to see why.
- With the ball carrier selected, click a **gold-ringed teammate** to pass or a **glowing goal square** to shoot.
- **⊘** marks a teammate who cannot receive because an opponent is nearby.
- Red dashed circles and lines preview shots your opponent could take next turn.

### ⌨️ Keyboard shortcuts

| Key | Action |
| --- | --- |
| `S` | Surge |
| `E` | End turn |
| `U` / `Ctrl+Z` | Undo within your turn in local, computer, and tutorial play |
| `Tab` | Focus the board |
| `↑` `↓` `←` `→` | Move the board cursor |
| `Enter` / `Space` | Act |
| `Esc` | Deselect |

### 📱 Phone and tablet controls

On phones and small tablets, **Undo / Resign** and **End turn** (or the lesson buttons) stay in a fixed bar at the bottom of the screen. Turn your phone sideways and the bar moves to the bottom-right, keeping the controls within reach without scrolling.

### ⚙️ Settings

Switch languages from the menu or side panel; the choice is remembered. Sound effects are synthesized in the browser, with no audio files. The game also follows your operating system’s reduce-motion setting.

---

<a id="coins--shop"></a>
## 🪙 Coins & shop

Earn coins as you play and give your pitch a look of its own. Your wallet is saved in this browser.

- 🏆 **+3 coins** for each win against the computer or an online opponent.
- 🎟️ **+5 coins** for every 3 finished matches. Tutorial lessons do not count.
- 🌿 **Pitch floors:** Midnight Pitch, Sunset Arena, and Neon Cyber.
- ✨ **Piece skins:** Obsidian Dark, Neon Glow, and Gold Elite.

The shop is available from the coin button or the Shop card on the menu. Every item is **cosmetic only** and never changes the rules.

---

<a id="online-setup"></a>
## ☁️ Online setup

Online matches and the leaderboard connect to **your own Supabase project**. Local, computer, and tutorial play work without this setup.

1. Create a Supabase project and follow **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)**.
2. Run `supabase/setup.sql` in the project’s SQL Editor.
3. Copy `.env.example` to `.env`.
4. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`.
5. Start the game with `npm start`.

🔒 Use the public **anon** or **publishable** client key. Never use a `service_role` or secret key in the browser, and don’t commit your `.env` file.

The Supabase setup guide also explains authentication, Realtime, security rules, and troubleshooting.

---

<a id="deploy"></a>
## 🚀 Deploy to GitHub Pages

The supplied GitHub Actions workflow builds and deploys the site to **GitHub Pages** when you push to `main`; you can also start a deployment manually.

To enable online features on the deployed site, add these repository **Actions variables**:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` — use the public anon or publishable key.

The workflow writes only the public browser configuration into the site. Configure the Supabase project for your Pages URL by following **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)**.

For a different static host, the setup guide covers building the site and uploading `index.html`, `config.js`, `build/`, and `src/ui/styles.css` with their paths preserved.

---

<a id="project-map"></a>
## 🧰 Project map

```text
src/
├── rules/       Core football rules and board configuration
├── ai/          Easy / Medium / Hard computer opponent
├── i18n/        English, Arabic, RTL, and translated rule messages
├── online/      Supabase client, config, and match sync
├── tutorial/    Seven lessons built on the real rules engine
└── ui/          App, board, views, vector pieces, motion, sound, shop, styles
supabase/        Database setup and migration
scripts/         Local server, browser config, and SQL verification
tests/           Rules, AI, localization, economy, and online-client tests
```

### 🧪 Optional developer checks

- `npm run verify:sql` runs the database rules against the TypeScript engine, action by action, and checks security rules. It needs a local PostgreSQL 15+ install with `initdb`, `pg_ctl`, and `psql`.
- `npm run e2e` checks every screen in both languages, full matches, all tutorial lessons, online flows against a fake backend, and leaderboard states in a headless browser. It needs Playwright with Chromium and a running `npm start`.

---

<a id="project-notes"></a>
## 📝 Project notes

- **[DECISIONS.md](DECISIONS.md)** — game design, rule changes, and balance data.
- **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** — configure your own online backend and host the game.
- **[LICENSE](LICENSE)** — proprietary software license.
- **[NOTICE](NOTICE)** — third-party component notices.

---

<div align="center">

### 🥅 One pitch. Three actions. One opening.

**Think like a chess player. Finish like a striker.** ⚽

© 2026 Mohammed Khalid · **Checkline is proprietary software.**  
The code, rules, designs, artwork, and text may not be copied, modified, distributed, or hosted without written permission. See [LICENSE](LICENSE).

</div>
