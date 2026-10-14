// Test-only in-memory stand-in for the Supabase backend (implements OnlineBackend).
// Injected by tests/e2e/ui-check.mjs through window.__CHECKLINE_TEST_BACKEND__ so the online
// screens can be exercised headlessly. It uses the real rules engine for move validation.
// Never shipped to players: the app only uses it when a test page defines that global first.
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const rules = () => import('/build/src/rules/index.js');
  const wire = () => import('/build/src/online/wire.js');
  const cfg = (window.__fakeCfg = Object.assign({ lb: 'ok', latency: 120, lobbyError: false }, window.__fakeCfg || {}));

  // ---- accounts (mirrors Supabase Auth behaviour the app relies on)
  let session = null; // { userId, email, isGuest, displayName }
  const users = new Map(); // email -> { id, password, confirmed, name }
  const authListeners = new Set();
  let idSeq = 0;
  const newId = () => (idSeq++ === 0 ? 'me' : `me${idSeq}`);
  const ME = () => session?.userId ?? 'me';
  const authErr = (code, message) => Object.assign(new Error(message), { code });
  const emit = (e) => authListeners.forEach((cb) => cb(e));
  const startSession = (u, email) => (session = { userId: u.id, email, isGuest: !email, displayName: u.name ?? null });
  const profiles = new Map([
    ['opp', { id: 'opp', displayName: 'ليلى', rating: 1234, wins: 3, draws: 1, losses: 1, games: 5 }],
    ['host2', { id: 'host2', displayName: 'Marco', rating: 1180, wins: 1, draws: 0, losses: 2, games: 3 }],
  ]);
  const matches = new Map();
  const subs = new Map();
  const lobbySubs = new Set();
  const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
  matches.set('open1', { id: 'open1', code: 'MARC22', status: 'waiting', isPublic: true, a: 'host2', b: null, state: null, version: 0, createdAt: iso(4 * 60000), aSeen: iso(), bSeen: null });

  const err = (code) => Object.assign(new Error(`CL:${code}`), { message: `CL:${code}` });
  const view = (m) => ({
    id: m.id, code: m.code, status: m.status, isPublic: m.isPublic,
    playerA: { id: m.a, name: profiles.get(m.a).displayName, rating: profiles.get(m.a).rating },
    playerB: m.b ? { id: m.b, name: profiles.get(m.b).displayName, rating: profiles.get(m.b).rating } : null,
    state: m.state, version: m.version, lastAction: m.lastAction ?? null, lastEvents: m.lastEvents ?? null, lastActor: m.lastActor ?? null,
    winnerId: m.winnerId ?? null, endReason: m.endReason ?? null, aSeenAt: m.aSeen, bSeenAt: m.bSeen,
    rulesVersion: m.rulesVersion ?? 3, turnStartedAt: m.turnStartedAt ?? null,
    createdAt: m.createdAt, serverNow: iso(), result: m.result ?? null,
  });
  const notify = (m) => {
    for (const h of subs.get(m.id) ?? []) h.onChange({ id: m.id, status: m.status, version: m.version, a_seen_at: m.aSeen, b_seen_at: m.bSeen, turn_started_at: m.turnStartedAt ?? null });
    for (const cb of lobbySubs) cb();
  };
  // Elo with draws (K = 32), zero-sum, same formula as supabase/setup.sql.
  const finish = (m, winner, reason) => {
    m.status = 'finished';
    m.winnerId = winner;
    m.endReason = reason;
    const A = profiles.get(m.a), B = profiles.get(m.b);
    const sA = winner === null ? 0.5 : winner === m.a ? 1 : 0;
    const expA = 1 / (1 + Math.pow(10, (B.rating - A.rating) / 400));
    const d = Math.round(32 * (sA - expA));
    m.result = { winnerId: winner, reason, aRatingBefore: A.rating, aRatingAfter: A.rating + d, bRatingBefore: B.rating, bRatingAfter: B.rating - d };
    A.rating += d; B.rating -= d; A.games++; B.games++;
    if (winner === null) { A.draws++; B.draws++; } else if (winner === m.a) { A.wins++; B.losses++; } else { B.wins++; A.losses++; }
  };
  async function apply(m, actor, action) {
    const R = await rules();
    const W = await wire();
    const state = W.fromWire(m.state);
    const team = actor === m.a ? 'A' : 'B';
    if (state.turn !== team) throw err('not_your_turn');
    const r = R.applyAction(state, action);
    if (!r.ok) throw err(`illegal:${r.why.code}`);
    m.state = W.toWire(r.state);
    m.version++;
    m.lastAction = action;
    m.lastEvents = r.events;
    m.lastActor = actor;
    if (team === 'A') m.aSeen = iso(); else m.bSeen = iso();
    if (r.state.turn !== state.turn) m.turnStartedAt = iso();
    if (r.state.phase === 'finished') {
      const w = r.state.winner === null ? null : r.state.winner === 'A' ? m.a : m.b;
      const byGoal = r.events.some((e) => e.type === 'win');
      finish(m, w, w === null ? 'draw' : byGoal ? 'goals' : 'clock');
    }
  }
  async function start(m, joiner, first) {
    const R = await rules();
    const W = await wire();
    m.b = joiner;
    m.status = 'active';
    m.state = W.toWire(R.createMatch({ firstTeam: first }));
    m.version = 1;
    m.bSeen = iso();
    m.turnStartedAt = iso();
    m.lastEvents = [{ type: 'kickoff', team: first, carrierId: `${first}-Q` }];
  }

  const backend = {
    async init() { await delay(cfg.latency); },
    userId: () => session?.userId ?? null,
    session: () => (session ? { ...session } : null),
    async signUp(email, password, name) {
      await delay(cfg.latency);
      email = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authErr('email_address_invalid', 'Unable to validate email address: invalid format');
      if (String(password).length < 6) throw authErr('weak_password', 'Password should be at least 6 characters.');
      if (users.has(email)) throw authErr('user_already_exists', 'User already registered');
      const u = { id: newId(), password, confirmed: !cfg.confirmEmail, name };
      users.set(email, u);
      if (cfg.confirmEmail) return { needsConfirmation: true };
      startSession(u, email);
      emit('signed_in');
      return { needsConfirmation: false };
    },
    async logIn(email, password) {
      await delay(cfg.latency);
      const u = users.get(String(email).trim().toLowerCase());
      if (!u || u.password !== password) throw authErr('invalid_credentials', 'Invalid login credentials');
      if (!u.confirmed) throw authErr('email_not_confirmed', 'Email not confirmed');
      startSession(u, String(email).trim().toLowerCase());
      emit('signed_in');
    },
    async guestSignIn() {
      await delay(cfg.latency);
      if (cfg.anonDisabled) throw authErr('anonymous_provider_disabled', 'Anonymous sign-ins are disabled');
      startSession({ id: newId(), name: null }, null);
      emit('signed_in');
    },
    async logOut() { await delay(cfg.latency / 2); session = null; emit('signed_out'); },
    async requestPasswordReset(email) { await delay(cfg.latency); window.__fake.resetRequestedFor = String(email).trim().toLowerCase(); },
    async updatePassword(password) {
      await delay(cfg.latency);
      if (!session) throw err('not_signed_in');
      if (String(password).length < 6) throw authErr('weak_password', 'Password should be at least 6 characters.');
      const u = users.get(session.email);
      if (u.password === password) throw authErr('same_password', 'New password should be different from the old password.');
      u.password = password;
    },
    onAuthEvent(cb) { authListeners.add(cb); return () => authListeners.delete(cb); },
    async nameAvailable(name) {
      await delay(cfg.latency / 2);
      const n = String(name).trim().toLowerCase();
      return ![...profiles.values()].some((p) => p.id !== session?.userId && p.displayName.trim().toLowerCase() === n);
    },
    async saveProfile(name) {
      await delay(cfg.latency);
      if (!session) throw err('not_signed_in');
      const n = String(name).trim();
      if (n.length < 2 || n.length > 24) throw err('invalid_name');
      if (!(await this.nameAvailable(n))) throw err('name_taken');
      const p = profiles.get(ME()) ?? { id: ME(), rating: 1200, wins: 0, draws: 0, losses: 0, games: 0 };
      p.displayName = n;
      profiles.set(ME(), p);
      return { ...p };
    },
    async myProfile() { await delay(cfg.latency / 2); return session && profiles.get(ME()) ? { ...profiles.get(ME()) } : null; },
    async createMatch(isPublic) {
      await delay(cfg.latency);
      const m = { id: 'm-' + Math.random().toString(36).slice(2, 8), code: 'K7M2QX', status: 'waiting', isPublic, a: ME(), b: null, state: null, version: 0, createdAt: iso(), aSeen: iso(), bSeen: null };
      matches.set(m.id, m);
      notify(m);
      return view(m);
    },
    async joinMatch(code) {
      await delay(cfg.latency);
      const m = [...matches.values()].find((x) => x.code === code);
      if (!m) throw err('match_not_found');
      if (m.a === ME() && m.status === 'waiting') throw err('own_match');
      if (m.status !== 'waiting') throw err('match_unavailable');
      await start(m, ME(), window.__fakeCfg.firstTeam ?? 'B');
      notify(m);
      return view(m);
    },
    async getMatch(id) { await delay(cfg.latency / 2); const m = matches.get(id); if (!m) throw err('match_not_found'); return view(m); },
    async listOpenMatches() {
      await delay(cfg.latency);
      if (cfg.lobbyError) throw new Error('Failed to fetch');
      return [...matches.values()].filter((m) => m.status === 'waiting' && m.isPublic && m.a !== ME()).map(view);
    },
    async listMyMatches() { await delay(cfg.latency); return [...matches.values()].filter((m) => (m.a === ME() || m.b === ME()) && (m.status === 'active' || m.status === 'waiting')).map(view); },
    async submitAction(id, v, action) {
      await delay(cfg.latency);
      const m = matches.get(id);
      if (m.status !== 'active') throw err('match_not_active');
      if (v !== m.version) throw err('stale_state');
      await apply(m, ME(), action);
      setTimeout(() => notify(m), 10);
      return view(m);
    },
    async heartbeat(id) { const m = matches.get(id); if (m) { if (m.a === ME()) m.aSeen = iso(); else m.bSeen = iso(); } },
    async resign(id) { await delay(cfg.latency); const m = matches.get(id); finish(m, m.a === ME() ? m.b : m.a, 'resign'); notify(m); return view(m); },
    async claimForfeit(id) {
      await delay(cfg.latency);
      const m = matches.get(id);
      const oppSeen = m.a === ME() ? m.bSeen : m.aSeen;
      if (Date.now() - Date.parse(oppSeen) < 90000) throw err('opponent_still_connected');
      finish(m, ME(), 'forfeit');
      notify(m);
      return view(m);
    },
    async claimTimeout(id) {
      await delay(cfg.latency);
      const m = matches.get(id);
      const R = await rules();
      const W = await wire();
      const state = W.fromWire(m.state);
      const myTeam = m.a === ME() ? 'A' : 'B';
      if (state.turn === myTeam) throw err('not_your_turn');
      if (Date.now() - Date.parse(m.turnStartedAt) < 90000) throw err('turn_time_left');
      const r = R.applyAction(state, { type: 'endTurn' });
      m.state = W.toWire(r.state);
      m.version++;
      m.lastAction = { type: 'endTurn' };
      m.lastEvents = r.events;
      m.lastActor = ME();
      m.turnStartedAt = iso();
      notify(m);
      return view(m);
    },
    async cancelMatch(id) { await delay(cfg.latency); const m = matches.get(id); m.status = 'cancelled'; notify(m); return view(m); },
    async leaderboard(offset, limit) {
      await delay(cfg.lb === 'slow' ? 1500 : cfg.latency);
      if (cfg.lb === 'error') throw new Error('Failed to fetch');
      if (cfg.lb === 'empty') return { total: 0, rows: [], me: null };
      const names = ['ليلى', 'Marco', 'Aisha Al-Harbi', 'Tomás', 'Noor', 'Kenji', 'فهد', 'Priya', 'Ola', 'Sven', 'Mariam', 'Diego', 'سارة', 'Lena', 'Omar', 'Yuki', 'Ivan', 'Zara', 'Hamza', 'Elif', 'Chen', 'Rana'];
      const all = names.map((n, i) => ({ rank: i + 1, id: i === 4 ? ME() : 'p' + i, displayName: n, rating: 1460 - i * 13, wins: 20 - i, draws: i % 3, losses: 3 + (i % 5), games: 23 - i + (i % 5) + (i % 3) }));
      return { total: all.length, rows: all.slice(offset, offset + limit), me: session ? all[4] : null };
    },
    subscribeMatch(id, h) {
      if (!subs.has(id)) subs.set(id, new Set());
      subs.get(id).add(h);
      setTimeout(() => { h.onStatus('live'); h.onPresence(window.__fakeCfg.oppOnline === false ? [ME()] : [ME(), 'opp']); }, 50);
      return () => subs.get(id)?.delete(h);
    },
    subscribeLobby(cb) { lobbySubs.add(cb); return () => lobbySubs.delete(cb); },
  };

  // Test controls for the simulated opponent.
  window.__fake = {
    matches,
    users,
    /** Simulate clicking the confirmation link in the sign-up email. */
    confirm(email) { users.get(email).confirmed = true; },
    /** Simulate arriving from a password-reset email link. */
    recover(email) { const u = users.get(email); startSession(u, email); emit('password_recovery'); },
    async opponentJoin() {
      const m = [...matches.values()].find((x) => x.a === ME() && x.status === 'waiting');
      await start(m, 'opp', window.__fakeCfg.firstTeam ?? 'A');
      notify(m);
      return m.id;
    },
    async opponentAct(action) {
      const m = [...matches.values()].find((x) => x.status === 'active' && (x.a === ME() || x.b === ME()));
      await apply(m, m.a === 'opp' ? 'opp' : m.b, action);
      notify(m);
    },
    current() { return [...matches.values()].find((x) => (x.a === ME() || x.b === ME()) && x.status !== 'cancelled' && x.status !== 'waiting'); },
    turnStartedAgo(seconds) {
      const m = this.current();
      m.turnStartedAt = new Date(Date.now() - seconds * 1000).toISOString();
      notify(m);
    },
    opponentGone(seconds) {
      const m = this.current();
      const t = new Date(Date.now() - seconds * 1000).toISOString();
      if (m.a === ME()) m.bSeen = t; else m.aSeen = t;
      for (const h of subs.get(m.id) ?? []) h.onPresence([ME()]);
      notify(m);
    },
  };
  window.__CHECKLINE_TEST_BACKEND__ = backend;
})();
