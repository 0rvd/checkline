// Online play backend. The UI only talks to the OnlineBackend interface; SupabaseBackend is the
// real implementation (all writes go through the SQL functions in supabase/setup.sql).
// Supabase is initialised in exactly one place: SupabaseBackend.init().
import type { Action, GameEvent, Team } from '../rules/types.js';
import type { OnlineConfig } from './config.js';
import type { WireState } from './wire.js';
import type { Tier } from './ranks.js';

/** A player's row in public."user" as the game sees it (email only for yourself). */
export interface OnlineProfile {
  id: string;
  displayName: string;
  /** Elo (orders the leaderboard). */
  rating: number;
  wins: number;
  draws: number;
  losses: number;
  games: number;
  /** C-rank ladder, derived on the server from rankPoints. */
  tier?: Tier;
  rankPoints?: number;
  tierMin?: number;
  nextTierAt?: number | null;
  rankedGames?: number;
  isGuest?: boolean;
  email?: string | null;
}

export interface MatchPlayer {
  id: string;
  name: string;
  rating: number;
  tier?: Tier;
}

export type MatchStatus = 'waiting' | 'active' | 'finished' | 'cancelled';

export type EndReason = 'goals' | 'clock' | 'draw' | 'resign' | 'forfeit';

export interface MatchResult {
  /** null = draw */
  winnerId: string | null;
  reason: EndReason;
  aRatingBefore: number;
  aRatingAfter: number;
  bRatingBefore: number;
  bRatingAfter: number;
  /** C-rank points: only between two registered players. */
  ranked?: boolean;
  /** Why the winner gained no points: 'guest' | 'short_match' | 'repeat_opponent' (null = normal). */
  rankNote?: string | null;
  aPointsBefore?: number | null;
  aPointsAfter?: number | null;
  bPointsBefore?: number | null;
  bPointsAfter?: number | null;
  /** Coins paid to each side with the result. */
  aCoins?: number;
  bCoins?: number;
}

export interface OnlineMatch {
  id: string;
  code: string;
  status: MatchStatus;
  isPublic: boolean;
  playerA: MatchPlayer;
  playerB: MatchPlayer | null;
  state: WireState | null;
  version: number;
  lastAction: Action | null;
  lastEvents: GameEvent[] | null;
  lastActor: string | null;
  winnerId: string | null;
  endReason: EndReason | null;
  rulesVersion: number;
  aSeenAt: string | null;
  bSeenAt: string | null;
  /** When the side to move started its turn (online turn timer). */
  turnStartedAt: string | null;
  createdAt: string;
  serverNow: string;
  result: MatchResult | null;
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  displayName: string;
  rating: number;
  wins: number;
  draws: number;
  losses: number;
  games: number;
  tier?: Tier;
  rankPoints?: number;
}

export interface LeaderboardPage {
  total: number;
  rows: LeaderboardRow[];
  me: LeaderboardRow | null;
}

/** Who is signed in. Guests use Supabase anonymous sign-in; everyone else has an email account. */
export interface AuthSession {
  userId: string;
  email: string | null;
  isGuest: boolean;
  /** Display name chosen at sign-up (stored with the account until the profile exists). */
  displayName: string | null;
}

/** Coins and cosmetics of a signed-in player (public."user" + public.user_cosmetics). */
export interface ServerWallet {
  coins: number;
  matches: number;
  wins: number;
  owned: string[];
  floor: string;
  skin: string;
  ball: string;
  /** Live prices from public.cosmetics and public.bundles ("skin:gold" -> 25, "bundle:cosmic" -> 70). */
  prices?: Record<string, number>;
}

/** Auth changes the UI reacts to (e.g. arriving from an email link). */
export type AuthEvent = 'signed_in' | 'signed_out' | 'password_recovery';

/** Every human-controlled turn lasts this many seconds (local, computer and online play).
 *  Online, the server enforces it (checkline_private.turn_deadline in supabase/setup.sql). */
export const TURN_SECONDS = 25;
/** Online only: extra seconds the server allows for network delay and the opponent's move
 *  animation before the deadline. The clock never shows more than TURN_SECONDS. */
export const TURN_GRACE_SECONDS = 3;

/** Raw row pushed by Realtime for cl_matches (snake_case). */
export interface MatchRowChange {
  id: string;
  status: MatchStatus;
  version: number;
  a_seen_at: string | null;
  b_seen_at: string | null;
  turn_started_at?: string | null;
}

export type ChannelStatus = 'connecting' | 'live' | 'offline';

export interface MatchSubscription {
  onChange: (row: MatchRowChange) => void;
  onPresence: (onlineUserIds: string[]) => void;
  onStatus: (status: ChannelStatus) => void;
}

/** Error codes raised by the backend (`CL:<code>` in SQL) plus client-side ones. */
export type OnlineErrorCode =
  | 'not_signed_in'
  | 'profile_required'
  | 'invalid_name'
  | 'match_not_found'
  | 'own_match'
  | 'match_unavailable'
  | 'match_expired'
  | 'match_not_active'
  | 'stale_state'
  | 'not_your_turn'
  | 'illegal'
  | 'bad_action'
  | 'opponent_still_connected'
  | 'turn_time_left'
  | 'turn_expired'
  | 'match_outdated'
  | 'try_again'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'email_taken'
  | 'weak_password'
  | 'invalid_email'
  | 'password_mismatch'
  | 'same_password'
  | 'rate_limited'
  | 'signup_disabled'
  | 'email_disabled'
  | 'link_expired'
  | 'email_not_authorized'
  | 'name_taken'
  | 'too_poor'
  | 'unknown_item'
  | 'wrong_password'
  | 'anonymous_disabled'
  | 'library_failed'
  | 'network'
  | 'unknown';

export class OnlineError extends Error {
  constructor(
    public code: OnlineErrorCode,
    public detail = '',
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
  }
}

/** Supabase Auth error codes -> our codes (newer servers send `code`; older ones only a message). */
const AUTH_CODES: Record<string, OnlineErrorCode> = {
  invalid_credentials: 'invalid_credentials',
  email_not_confirmed: 'email_not_confirmed',
  user_already_exists: 'email_taken',
  email_exists: 'email_taken',
  weak_password: 'weak_password',
  email_address_invalid: 'invalid_email',
  same_password: 'same_password',
  over_email_send_rate_limit: 'rate_limited',
  over_request_rate_limit: 'rate_limited',
  signup_disabled: 'signup_disabled',
  email_provider_disabled: 'email_disabled',
  anonymous_provider_disabled: 'anonymous_disabled',
  otp_expired: 'link_expired',
  email_address_not_authorized: 'email_not_authorized',
};

const AUTH_MESSAGES: [RegExp, OnlineErrorCode][] = [
  [/invalid login credentials/i, 'invalid_credentials'],
  [/email not confirmed/i, 'email_not_confirmed'],
  [/already registered|already been registered|already exists/i, 'email_taken'],
  [/password should be|password is too weak|weak password|pwned/i, 'weak_password'],
  [/unable to validate email|invalid email|email address .* is invalid/i, 'invalid_email'],
  [/should be different from the old password/i, 'same_password'],
  [/rate limit|only request this after|too many requests/i, 'rate_limited'],
  [/signups not allowed|signup is disabled/i, 'signup_disabled'],
  [/email logins are disabled|email provider is disabled/i, 'email_disabled'],
  [/anonymous sign-ins are disabled|anonymous_provider_disabled/i, 'anonymous_disabled'],
  [/link is invalid or has expired|otp_expired/i, 'link_expired'],
  [/email address not authorized/i, 'email_not_authorized'],
];

export function toOnlineError(err: unknown): OnlineError {
  if (err instanceof OnlineError) return err;
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  const m = /CL:([a-z_]+)(?::([a-z_]+))?/.exec(msg);
  if (m) return new OnlineError(m[1] as OnlineErrorCode, m[2] ?? '');
  const code = String((err as { code?: string })?.code ?? '');
  if (AUTH_CODES[code]) return new OnlineError(AUTH_CODES[code], msg);
  for (const [re, c] of AUTH_MESSAGES) if (re.test(msg)) return new OnlineError(c, msg);
  if (/fetch|network|Failed to fetch|NetworkError|timeout/i.test(msg)) return new OnlineError('network', msg);
  return new OnlineError('unknown', msg);
}

export interface OnlineBackend {
  init(): Promise<void>;
  userId(): string | null;
  session(): AuthSession | null;
  /** Create an email account. `needsConfirmation` = the project requires clicking the emailed link first. */
  signUp(email: string, password: string, displayName: string): Promise<{ needsConfirmation: boolean }>;
  logIn(email: string, password: string): Promise<void>;
  /** Play without an account (Supabase anonymous sign-in). */
  guestSignIn(): Promise<void>;
  logOut(): Promise<void>;
  /** Email a password-reset link that brings the player back to this page. */
  requestPasswordReset(email: string): Promise<void>;
  /** Set a new password after arriving from a reset link (the link signs the player in). */
  updatePassword(password: string): Promise<void>;
  /** Signed in with email: check the current password, then set a new one. */
  changePassword(current: string, next: string): Promise<void>;
  onAuthEvent(cb: (e: AuthEvent) => void): () => void;
  /** The signed-in player's coins and items (database). */
  getWallet(): Promise<ServerWallet>;
  /** Buy (if needed) and equip a floor, skin or ball; the server checks the price. */
  buyItem(kind: 'floor' | 'skin' | 'ball', id: string): Promise<ServerWallet>;
  /** Buy (if needed) and equip a full set; the server prices it and adds all items at once. */
  buyBundle(id: string): Promise<ServerWallet>;
  /** Is this display name free? (Names are unique, ignoring case.) */
  nameAvailable(name: string): Promise<boolean>;
  /** Create or rename the player's public profile (display name). */
  saveProfile(displayName: string): Promise<OnlineProfile>;
  myProfile(): Promise<OnlineProfile | null>;
  createMatch(isPublic: boolean): Promise<OnlineMatch>;
  joinMatch(code: string): Promise<OnlineMatch>;
  getMatch(id: string): Promise<OnlineMatch>;
  listOpenMatches(): Promise<OnlineMatch[]>;
  listMyMatches(): Promise<OnlineMatch[]>;
  submitAction(id: string, expectedVersion: number, action: Action): Promise<OnlineMatch>;
  heartbeat(id: string): Promise<void>;
  resign(id: string): Promise<OnlineMatch>;
  claimForfeit(id: string): Promise<OnlineMatch>;
  /** End the current turn once its deadline has passed (either player may ask; the server
   *  checks the time and that `expectedVersion` is still current, so it happens only once). */
  claimTimeout(id: string, expectedVersion: number): Promise<OnlineMatch>;
  cancelMatch(id: string): Promise<OnlineMatch>;
  leaderboard(offset: number, limit: number): Promise<LeaderboardPage>;
  subscribeMatch(id: string, handlers: MatchSubscription): () => void;
  subscribeLobby(onChange: () => void): () => void;
}

// ------------------------------------------------------------------ Supabase implementation

/* Minimal structural types for the parts of supabase-js v2 we use. */
interface SbResult<T> {
  data: T;
  error: { message: string; code?: string } | null;
}
interface SbChannel {
  on(type: string, filter: Record<string, unknown>, cb: (payload: { new?: unknown }) => void): SbChannel;
  subscribe(cb?: (status: string) => void): SbChannel;
  track(payload: Record<string, unknown>): Promise<unknown>;
  presenceState(): Record<string, unknown[]>;
}
interface SbUser {
  id: string;
  email?: string;
  is_anonymous?: boolean;
  identities?: unknown[];
  user_metadata?: { display_name?: string };
}
interface SbSession {
  user: SbUser;
}
interface SbClient {
  auth: {
    getSession(): Promise<SbResult<{ session: SbSession | null }>>;
    signUp(p: { email: string; password: string; options?: Record<string, unknown> }): Promise<SbResult<{ user: SbUser | null; session: SbSession | null }>>;
    signInWithPassword(p: { email: string; password: string }): Promise<SbResult<{ user: SbUser | null; session: SbSession | null }>>;
    signInAnonymously(): Promise<SbResult<{ user: SbUser | null; session: SbSession | null }>>;
    signOut(): Promise<{ error: { message: string } | null }>;
    resetPasswordForEmail(email: string, opts?: { redirectTo?: string }): Promise<SbResult<unknown>>;
    updateUser(p: { password?: string }): Promise<SbResult<{ user: SbUser | null }>>;
    onAuthStateChange(cb: (event: string, session: SbSession | null) => void): { data: { subscription: { unsubscribe(): void } } };
  };
  rpc(fn: string, args?: Record<string, unknown>): Promise<SbResult<unknown>>;
  channel(name: string, opts?: Record<string, unknown>): SbChannel;
  removeChannel(ch: SbChannel): Promise<unknown>;
}

/** Where email links (confirm, reset password) send the player back to: this page. */
function returnUrl(): string {
  return typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`;
}

export class SupabaseBackend implements OnlineBackend {
  private client: SbClient | null = null;
  private sess: AuthSession | null = null;
  private listeners = new Set<(e: AuthEvent) => void>();

  constructor(private config: OnlineConfig) {}

  async init(): Promise<void> {
    if (this.client) return;
    let mod: { createClient: (url: string, key: string, opts: Record<string, unknown>) => SbClient };
    try {
      mod = await import(/* webpackIgnore: true */ this.config.supabaseJsUrl);
    } catch (e) {
      throw new OnlineError('library_failed', String(e));
    }
    const client = mod.createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'checkline-auth' },
    });
    // Registered right away so events from an email link (confirm / reset) are not missed.
    client.auth.onAuthStateChange((event, session) => {
      this.sess = toSession(session);
      const e: AuthEvent | null =
        event === 'PASSWORD_RECOVERY' ? 'password_recovery' : event === 'SIGNED_OUT' ? 'signed_out' : event === 'SIGNED_IN' ? 'signed_in' : null;
      if (e) this.listeners.forEach((cb) => cb(e));
    });
    this.client = client;
    const { data, error } = await client.auth.getSession();
    if (error) throw toOnlineError(error);
    this.sess = toSession(data.session);
  }

  userId(): string | null {
    return this.sess?.userId ?? null;
  }

  session(): AuthSession | null {
    return this.sess;
  }

  private get sb(): SbClient {
    if (!this.client) throw new OnlineError('not_signed_in');
    return this.client;
  }

  private async call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    let res: SbResult<unknown>;
    try {
      res = await this.sb.rpc(fn, args);
    } catch (e) {
      throw toOnlineError(e);
    }
    if (res.error) throw toOnlineError(res.error);
    return res.data as T;
  }

  async signUp(email: string, password: string, displayName: string): Promise<{ needsConfirmation: boolean }> {
    const { data, error } = await this.sb.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { display_name: displayName.trim() }, emailRedirectTo: returnUrl() },
    });
    if (error) throw toOnlineError(error);
    // With email confirmation on, Supabase answers an existing address with a user that has no identities.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new OnlineError('email_taken');
    if (data.session) {
      this.sess = toSession(data.session);
      return { needsConfirmation: false };
    }
    return { needsConfirmation: true };
  }

  async logIn(email: string, password: string): Promise<void> {
    const { data, error } = await this.sb.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw toOnlineError(error);
    this.sess = toSession(data.session);
  }

  async guestSignIn(): Promise<void> {
    const { data, error } = await this.sb.auth.signInAnonymously();
    if (error) throw toOnlineError(error);
    this.sess = toSession(data.session);
    if (!this.sess) throw new OnlineError('not_signed_in');
  }

  async logOut(): Promise<void> {
    const { error } = await this.sb.auth.signOut();
    this.sess = null;
    if (error) throw toOnlineError(error);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const { error } = await this.sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: returnUrl() });
    if (error) throw toOnlineError(error);
  }

  async updatePassword(password: string): Promise<void> {
    const { error } = await this.sb.auth.updateUser({ password });
    if (error) throw toOnlineError(error);
  }

  async changePassword(current: string, next: string): Promise<void> {
    const email = this.sess?.email;
    if (!this.sess || !email || this.sess.isGuest) throw new OnlineError('not_signed_in');
    // Supabase does not ask for the old password itself, so check it first (also gives a fresh
    // session, which "Secure password change" requires).
    const check = await this.sb.auth.signInWithPassword({ email, password: current });
    if (check.error) {
      const e = toOnlineError(check.error);
      throw e.code === 'invalid_credentials' ? new OnlineError('wrong_password') : e;
    }
    const { error } = await this.sb.auth.updateUser({ password: next });
    if (error) throw toOnlineError(error);
  }

  onAuthEvent(cb: (e: AuthEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getWallet() {
    return this.call<ServerWallet>('cl_get_wallet');
  }
  buyItem(kind: 'floor' | 'skin' | 'ball', id: string) {
    return this.call<ServerWallet>('cl_buy_item', { p_kind: kind, p_id: id });
  }
  buyBundle(id: string) {
    return this.call<ServerWallet>('cl_buy_bundle', { p_id: id });
  }

  nameAvailable(name: string): Promise<boolean> {
    return this.call<boolean>('cl_name_available', { p_name: name });
  }

  async saveProfile(displayName: string): Promise<OnlineProfile> {
    if (!this.sess) throw new OnlineError('not_signed_in');
    return this.call<OnlineProfile>('cl_upsert_profile', { p_display_name: displayName });
  }

  async myProfile(): Promise<OnlineProfile | null> {
    if (!this.sess) return null;
    return this.call<OnlineProfile | null>('cl_get_my_profile');
  }

  createMatch(isPublic: boolean) {
    return this.call<OnlineMatch>('cl_create_match', { p_is_public: isPublic });
  }
  joinMatch(code: string) {
    return this.call<OnlineMatch>('cl_join_match', { p_code: code });
  }
  getMatch(id: string) {
    return this.call<OnlineMatch>('cl_get_match', { p_match_id: id });
  }
  listOpenMatches() {
    return this.call<OnlineMatch[]>('cl_list_open_matches');
  }
  listMyMatches() {
    return this.call<OnlineMatch[]>('cl_list_my_matches');
  }
  submitAction(id: string, expectedVersion: number, action: Action) {
    return this.call<OnlineMatch>('cl_submit_action', { p_match_id: id, p_expected_version: expectedVersion, p_action: action });
  }
  async heartbeat(id: string) {
    await this.call('cl_touch_match', { p_match_id: id });
  }
  resign(id: string) {
    return this.call<OnlineMatch>('cl_resign', { p_match_id: id });
  }
  claimForfeit(id: string) {
    return this.call<OnlineMatch>('cl_claim_forfeit', { p_match_id: id });
  }
  cancelMatch(id: string) {
    return this.call<OnlineMatch>('cl_cancel_match', { p_match_id: id });
  }
  claimTimeout(id: string, expectedVersion: number) {
    return this.call<OnlineMatch>('cl_claim_timeout', { p_match_id: id, p_expected_version: expectedVersion });
  }
  leaderboard(offset: number, limit: number) {
    return this.call<LeaderboardPage>('cl_get_leaderboard', { p_offset: offset, p_limit: limit });
  }

  subscribeMatch(id: string, h: MatchSubscription): () => void {
    const ch = this.sb
      .channel(`checkline-match-${id}`, { config: { presence: { key: this.sess?.userId ?? 'anon' } } })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cl_matches', filter: `id=eq.${id}` }, (payload) => {
        if (payload.new) h.onChange(payload.new as MatchRowChange);
      })
      .on('presence', { event: 'sync' }, () => h.onPresence(Object.keys(ch.presenceState())))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          h.onStatus('live');
          void ch.track({ at: new Date().toISOString() });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          h.onStatus('offline');
        }
      });
    h.onStatus('connecting');
    return () => void this.sb.removeChannel(ch);
  }

  subscribeLobby(onChange: () => void): () => void {
    const ch = this.sb
      .channel('checkline-lobby')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cl_matches' }, () => onChange())
      .subscribe();
    return () => void this.sb.removeChannel(ch);
  }
}

function toSession(s: SbSession | null | undefined): AuthSession | null {
  if (!s?.user) return null;
  const name = s.user.user_metadata?.display_name;
  return {
    userId: s.user.id,
    email: s.user.email ?? null,
    isGuest: !!s.user.is_anonymous || !s.user.email,
    displayName: typeof name === 'string' && name.trim() ? name.trim() : null,
  };
}

/** Which team the signed-in user plays in a match. */
export function myTeamIn(m: OnlineMatch, uid: string | null): Team | null {
  if (!uid) return null;
  if (m.playerA.id === uid) return 'A';
  if (m.playerB?.id === uid) return 'B';
  return null;
}
