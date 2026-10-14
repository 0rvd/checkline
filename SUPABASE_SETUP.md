# Connecting Checkline to your Supabase project

Online matches and the leaderboard use **your own** Supabase project. Local and computer matches
work without it. When Supabase is not configured, the online screens say so and everything else keeps working.

## 1. Create or pick a project
1. Go to https://supabase.com/dashboard and sign in.
2. Click **New project**, or open an existing one. Any plan works. Note the region and keep the database password somewhere safe (the game does not need it).

## 2. Set up accounts (Authentication)
Players create an account with **email and password** on the game's Log in / Sign up page. They can also play as a **guest** if you allow it.

1. **Email provider:** Dashboard → **Authentication** → **Sign In / Providers** → **Email** should be enabled. It is by default.
2. **Where email links go:** Dashboard → **Authentication** → **URL Configuration**:
   * set **Site URL** to `http://localhost:5173` (or your hosted address later)
   * under **Redirect URLs**, add `http://localhost:5173/**`

   Confirmation and password-reset emails then bring players back into the game.
3. **Confirm email:** hosted projects require new accounts to click a link in a confirmation email before they can log in. Supabase's built-in email service only sends to the **members of your Supabase team**, and only a few emails per hour. So:
   * To test by yourself, sign up with your own email and it works.
   * To let other people sign up, either set up custom SMTP (Authentication → **SMTP Settings**, e.g. Resend, Brevo or Postmark), or turn **Confirm email** off under Sign In / Providers → Email. With it off, accounts work immediately. Password reset still needs email.
4. **Guests (optional):** turn on **Allow anonymous sign-ins** under Sign In / Providers. A guest account lives only in that browser. If you leave this off, the game explains it and offers sign-up instead.
5. Optional but recommended for a public deployment: CAPTCHA protection under Authentication → **Attack Protection**.

## 3. Run the database script
1. Dashboard → **SQL Editor** → **New query**.
2. Paste the whole of [`supabase/setup.sql`](supabase/setup.sql) and click **Run**. It should finish with "Success. No rows returned".

The script is safe to review and re-run. It:

* creates `cl_profiles`, `cl_matches`, `cl_match_moves` and `cl_match_results`. The `cl_` prefix avoids clashes with your own tables.
* creates a private schema `checkline_private` that holds the server-side copy of the game rules,
* creates the `cl_*` RPC functions the game calls,
* enables row-level security, grants clients read-only access, and adds `cl_matches` to the `supabase_realtime` publication.

It never drops tables or data. The only `DROP` statements remove its own named RLS policies and its own check constraints, so they can be recreated.

**Upgrading from the v0.2 script?** Run the new `setup.sql` the same way. It adds the new columns in place: draws, the turn timer, the rules version, and the new result columns. Existing players, ratings and finished results are kept. Matches that were *in progress* under the old rules are marked `rules_version 2`. They can be opened and resigned, but not played, because the old rules no longer exist in the game. The lobby shows them as "Old rules".

To check Realtime afterwards: Dashboard → **Database** → **Publications** → `supabase_realtime` should list `cl_matches`. In the Table Editor, `cl_matches` should show "Realtime on".

## 4. Put your public URL and key in `.env`
1. Dashboard → **Project Settings** → **API** (or the **Connect** button). Copy:
   * **Project URL**, for example `https://abcdefghijklmno.supabase.co`
   * the **public** client key: either the `anon` key (`eyJ...`) or the `publishable` key (`sb_publishable_...`).
   **Do not use the `service_role` / secret key.** The game refuses it, and the server will not send it to the browser.
2. In the project folder:

   ```bash
   cp .env.example .env      # on Windows: copy .env.example .env
   ```

   Then edit `.env`:

   ```ini
   SUPABASE_URL=https://abcdefghijklmno.supabase.co
   SUPABASE_ANON_KEY=eyJhbGciOi...   # or sb_publishable_...
   ```

   `.env` is git-ignored, so don't commit it. The server serves only these two public values (as `/config.js`), and it never serves dotfiles.

## 5. Start the game and confirm
```bash
npm install
npm start
```
* The terminal prints `Online play: Supabase project https://…`. If it says "not configured", check `.env`.
* Open http://localhost:5173. On the menu, **Online match** and **Leaderboard** no longer say "Needs Supabase setup".
* End-to-end test with two browsers (for example a normal window and a private window, or two devices on your network):
  1. In each, open **Online match** (or the **Log in** button on the menu). Sign up with an email in one window; in the other, sign up with a second email or **Continue as guest**.
  2. In browser 1, click **Create private match** and copy the code.
  3. In browser 2, enter the code under **Join with a code**. Both screens open the match, and the coin toss decides who kicks off.
  4. Play a few turns. Moves appear on the other screen right away (Realtime), and the opponent card shows Online.
  5. Optional, to test the turn timer: in the browser whose turn it is, wait 90 seconds without moving. The other browser shows **End their turn**. Click it, and the turn passes back.
  6. Click **Resign** in one browser. Both see the result and the Elo change.
  7. Open **Leaderboard**. Both players appear with W / D / L.
  8. Optional: start another match and close one browser. After about 90 seconds the other player can **Claim win**.

## 6. Hosting on a static site (optional)
```bash
npm run build
npm run config        # writes config.js from .env (git-ignored)
```
Upload `index.html`, `config.js`, the `build/` folder and `src/ui/styles.css`, keeping the same paths.

The browser loads supabase-js 2.45.4 from jsDelivr. To self-host it, set `SUPABASE_JS_URL` to your own copy of the ESM build before running `npm run config` / `npm start`.

## What is enforced on the server
* **Rules:** every move, pass, shot, tackle, Surge and end-turn is re-validated by `checkline_private.apply_action`, a PL/pgSQL mirror of `src/rules/engine.ts`. The same goes for the match clock, golden goal and draw. Clients cannot submit a board state, only an action.
* **Turn timer:** each online turn lasts 90 seconds (`turn_started_at`). After that the waiting player may call `cl_claim_timeout`, which ends the idle player's turn. The server checks the time.
* **Turns and overwrites:** only the player whose turn it is can act. Each action carries the match `version` it was based on, and a stale version is rejected (`stale_state`). The match row is locked during each action.
* **Results and ratings:** a finished match is written to `cl_match_results` exactly once (primary key on `match_id`), and Elo is updated in the same transaction. Clients have no write access to any table and cannot call the private functions.
* **Privacy:** players can read only their own matches, moves and results, plus public matches that are waiting for an opponent. Profiles (display name, rating and record) are public because they make up the leaderboard.

**Elo:** everyone starts at 1200.
* Player A's expected score is E = 1 / (1 + 10^((R_B − R_A)/400)).
* The result S is 1 for a win, ½ for a draw and 0 for a loss.
* A's rating changes by round(32 × (S − E)), and B's changes by the opposite amount (zero-sum).
* Two equal players move ±16 for a win, and 0 for a draw. A draw moves points toward the lower-rated player.
* Leaderboard ties break on more wins, then fewer losses, then whoever reached the rating first, then player id.

## Troubleshooting
| What you see | Fix |
|---|---|
| "Guest play is turned off…" | Turn on anonymous sign-ins (step 2.4), or sign up with email instead. |
| "Confirm your email first" | Open the confirmation email (check spam). Or turn off **Confirm email** (step 2.3). |
| "This game can't email that address yet" | The built-in email service only sends to your Supabase team. Set up custom SMTP or turn off **Confirm email** (step 2.3). |
| An email link opens the wrong page or says it's invalid | Set the Site URL and Redirect URLs (step 2.2). Links expire after a while, so request a new one. |
| "Couldn't load the Supabase library" | The browser cannot reach cdn.jsdelivr.net. Allow it, or self-host via `SUPABASE_JS_URL`. |
| "Unexpected error: … permission denied / function … does not exist" | `supabase/setup.sql` was not run, or failed. Run it again. |
| Opponent moves only appear after a few seconds | Realtime is not delivering. The game polls every 8 s as a fallback. Check step 3's publication. |
| "A secret (service role) key was supplied" | Replace it with the anon or publishable key. |

## Known limitations
* Guest (anonymous) accounts are cheap to create, so one person could play themselves on two accounts to farm rating. For a competitive launch, turn guests off so everyone needs an email account, keep **Confirm email** on with custom SMTP, and consider CAPTCHA.
* The turn timer ends an idle turn but doesn't forfeit the match. An opponent who keeps stalling can be left; a player who disconnects for 90 s forfeits on claim.
* Presence ("Online" / "Away") uses a public Realtime channel named after the match id. It carries only user ids and timestamps.
