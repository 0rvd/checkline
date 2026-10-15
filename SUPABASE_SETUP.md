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
4. **Guests (optional):** turn on **Allow anonymous sign-ins** under Sign In / Providers. A guest account lives only in that browser, and guest games never count for C-rank points. If you leave this off, the game explains it and offers sign-up instead.
5. Optional but recommended for a public deployment: CAPTCHA protection under Authentication → **Attack Protection**.

**Passwords** live only in Supabase Auth (stored as a one-way hash). The game's tables never have a password column, and nobody, including you, can read a password.
* **Forgot password:** on the Log in page, *Forgot password?* emails a reset link (needs step 2.2). The link opens the game on a "Choose a new password" form.
* **Change password:** signed-in players (email accounts) click **Change password** on the online lobby's profile card, type their current password and the new one twice. The game checks the current password with Supabase first, then saves the new one. This also works with Supabase's optional *Secure password change* setting.
* **Helping a player:** Authentication → **Users** → the player → **Send password recovery**.

## 3. Run the database script
One file does everything, for a new project **and** for upgrades: [`supabase/setup.sql`](supabase/setup.sql).

1. Dashboard → **SQL Editor** → **New query**.
2. Paste the whole file and click **Run**. It should finish with "Success. No rows returned". If Supabase shows a "Potential issue detected" dialog about row-level security, choose **Run and enable RLS** (the script turns it on for every table itself).

You can run it again at any time; it is repeatable. It creates:

| Table | What it holds | Who can read it |
|---|---|---|
| `public."user"` | One row per player: Auth user id, username, email (copied from Auth), guest flag, coins, equipped skin and pitch floor, C-rank points, Elo rating, wins / draws / losses / games, timestamps | Only the player themself |
| `public.rank_tiers` | C5 0 · C4 150 · C3 300 · C2 450 · C1 600 points | Everyone |
| `public.cosmetics` | The shop: pitch floors and piece skins with prices (`active` hides an item from the shop) | Everyone |
| `public.user_cosmetics` | What each player owns (starter, purchase, admin or migration) | Only the owner |
| `public.coin_transactions` | Every coin change: match rewards, purchases, admin grants and removals, hand edits | Only the owner |
| `public.cl_matches` | Online matches: the two participants (`player_a` Ivory host, `player_b` Ebony), invite `code`, `is_public` lobby flag, status, game state, version, turn timer | The two participants; open public matches for everyone signed in |
| `public.cl_match_moves` | Every accepted action | The two participants |
| `public.cl_match_results` | One row per finished match: score, Elo before/after, C-rank points before/after, coins paid, `ranked` and why not | The two participants |

Plus a private schema `checkline_private` (server copy of the game rules and helpers, not reachable from the browser) and the `cl_*` functions the game calls. Nobody can write to any table directly from the game; every change goes through those functions, which check who is calling.

**Upgrading?** Run the same file. Earlier versions are upgraded in place and nothing is lost:
* `cl_profiles` (v0.3) is renamed to `public."user"`; every player keeps their id, name, Elo and record.
* Coins and items from `cl_users` / `cl_wallets`, and from the step-by-step test table `public.users`, are copied into `public."user"`, `public.user_cosmetics` and `public.coin_transactions` (as a `migration` entry). The old table is then moved out of reach as `checkline_private.legacy_…`, or removed if it was empty. The script prints a notice for each.
* Coins earned against the computer are no longer paid to accounts (see *C-ranks and coins* below).

To start completely from zero instead, run [`supabase/reset-everything.sql`](supabase/reset-everything.sql) first (it deletes the game tables **and every account**), then `setup.sql`.

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
  6. Click **Resign** in one browser. Both see the result, the Elo change, and the C-rank points (an early resign gives the winner no points; see below).
  7. Open **Leaderboard**. Both players appear with their C-rank and W / D / L.
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
* **Results, ratings, points and coins:** a finished match is written to `cl_match_results` exactly once (primary key on `match_id`). Elo, C-rank points, the record and the coin rewards are applied in the same transaction, so a reconnect, retry or double click can never score or pay a match twice (coin rewards also have their own unique index per player and match). Results come only from the server's own game state; the browser never reports a result.
* **Coins:** only server functions change `coins`, each time writing a `coin_transactions` row. Purchases (`cl_buy_item`) lock the player row, read the price from `public.cosmetics`, refuse if the balance is too low (`too_poor`), and add + equip the item in one transaction. Coins can never go below 0 (also a table constraint). Equipped items must be owned.
* **Privacy:** players can read only their own row in `public."user"` (with their email and coins), their own items and coin history, and their own matches, moves and results, plus public matches waiting for an opponent. The leaderboard and match screens get names, Elo, C-rank and record through functions that never return emails or coins.

### C-ranks and coins
* **Tiers:** C5 0–149 · C4 150–299 · C3 300–449 · C2 450–599 · C1 600+ (`public.rank_tiers`). The tier is always worked out from `rank_points` when it is read, so it can never be out of date, and players cannot change their points.
* **Ranked matches:** online matches between two players with **email accounts** (guests are never ranked).
  * Win **+10**, loss **−6** (never below 0), draw 0.
  * Anti-farming: the winner gets **no points** if the match ended (resign / forfeit) **before turn 6**, but the player who quit still loses 6, so quitting never dodges a loss. And the winner gets points from the **same opponent at most 3 times in 24 hours**. The result row says why (`rank_note`: `short_match`, `repeat_opponent`, `guest`).
* **Elo stays separate:** the hidden Elo rating (below) still orders the leaderboard and is updated for every finished online match, guests included, exactly as before. C-rank is the visible ladder shown next to it.
* **Coins (signed in):** online matches pay **+3 for a win** and **+5 on every 3rd** finished online match, but only for matches that were really played (ended by goals, the clock or a draw, or reached turn 6). Matches against the computer happen only in the browser, so the server cannot check them; they pay coins only to the signed-out browser wallet, never to an account. The browser wallet never overwrites an account balance.

### Giving or taking coins (admin)
Only you (the project owner) can do this; the game's players cannot call it.
* **Recommended:** SQL Editor →
  ```sql
  select public.cl_admin_adjust_coins('ORVD', 100, 'Tournament prize');   -- give 100
  select public.cl_admin_adjust_coins('ORVD', -20, 'Correction');         -- take 20
  ```
  The first value can be a username, an email or a user id. A note is required. Taking more than the player has is refused. Each call adds a `coin_transactions` row (`admin_grant` / `admin_remove`) with your note.
* **Table Editor:** editing the `coins` cell in `public."user"` also works; a trigger records the difference as a `manual_edit` entry so the history always adds up.
* From your own server you could call the same function with the **service-role** key. Never put that key in the game, in `config.js` or on GitHub.
* More ready-made queries (coin history, inventory, giving items, prices, rank points): [`supabase/admin-queries.sql`](supabase/admin-queries.sql).

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
| "Your current password is not right" | Changing the password needs the current one. Forgot it? Log out and use *Forgot password?* |
| Editing `equipped_skin` / `equipped_floor` by hand fails with `CL:not_owned` | Give the item first (admin-queries block 9), then equip it. |
| Opponent moves only appear after a few seconds | Realtime is not delivering. The game polls every 8 s as a fallback. Check step 3's publication. |
| "A secret (service role) key was supplied" | Replace it with the anon or publishable key. |

## Known limitations
* Guest (anonymous) accounts are cheap to create. They never earn C-rank points, but they still move Elo. Email accounts are cheap too if **Confirm email** is off; the turn-6 and 3-wins-a-day rules limit point farming, but for a competitive launch keep **Confirm email** on with custom SMTP and consider CAPTCHA.
* The turn timer ends an idle turn but doesn't forfeit the match. An opponent who keeps stalling can be left; a player who disconnects for 90 s forfeits on claim.
* Presence ("Online" / "Away") uses a public Realtime channel named after the match id. It carries only user ids and timestamps.
