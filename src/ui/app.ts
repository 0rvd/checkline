// App controller: screens, game flow (local, tutorial, computer, online), input and rendering.
// Rules live in src/rules, the computer opponent in src/ai, online transport in src/online.
import { planTurn, type Difficulty } from '../ai/ai.js';
import {
  applyDocumentLang,
  escapeHtml as esc,
  eventText,
  getLang,
  moveText,
  pieceName,
  pieceRole,
  reasonText,
  setLang,
  t,
  tHtml,
  teamFull,
  teamName,
  type Lang,
  type MessageKey,
} from '../i18n/index.js';
import {
  OnlineError,
  SupabaseBackend,
  TURN_GRACE_SECONDS,
  TURN_SECONDS,
  myTeamIn,
  toOnlineError,
  type ChannelStatus,
  type LeaderboardPage,
  type MatchRowChange,
  type OnlineBackend,
  type OnlineMatch,
} from '../online/backend.js';
import { readOnlineConfig, type ConfigResult } from '../online/config.js';
import { fromWire, toWire } from '../online/wire.js';
import { rankFor } from '../online/ranks.js';
import {
  applyAction,
  carrier,
  createMatch,
  getPiece,
  isGoldenGoal,
  other,
  passOptions,
  pieceAt,
  previewMoves,
  sameSquare,
  shotTargets,
  squareName,
  tackleThreats,
  turnsPlayed,
} from '../rules/engine.js';
import type { Action, GameEvent, MatchState, Piece, PieceKind, Square, Team } from '../rules/types.js';
import { LESSONS } from '../tutorial/lessons.js';
import { renderBoard } from './board.js';
import { burstAt, confetti, flipTokens, flyBall, reducedMotion, setReduceMotion, snapshotTokens } from './motion.js';
import { BALL_SVG, SVG_DEFS, moveDiagram, pieceSvg } from './pieces.js';
import { play, setSoundEnabled } from './sound.js';
import { applyTheme, awardMatch, buyBundle, buyOrEquip, findBundle, findItem, fromServer, loadWallet, type Award, type ItemKind, type Wallet } from './economy.js';
import {
  errorText,
  langSwitch,
  renderAiSetup,
  renderLeaderboard,
  renderMenu,
  renderOnline,
  renderShop,
  coinIcon,
  spinner,
  tierChip,
  type AuthMode,
  type MenuAccount,
  type OnlineScreen,
} from './views.js';

type Screen = 'menu' | 'ai-setup' | 'game' | 'online' | 'leaderboard' | 'shop';
type GameKind = 'local' | 'ai' | 'online' | 'tutorial';
type Overlay =
  | { kind: 'handoff'; team: Team; opening?: boolean }
  | { kind: 'goal'; team: Team; score: Record<Team, number>; next: Team }
  | { kind: 'win'; team: Team | null }
  | { kind: 'rules' }
  | { kind: 'resign' }
  | null;

/** Log entries are kept as data so they re-translate when the language changes. */
type LogEntry = { ev: GameEvent } | { note: MessageKey; params?: Record<string, string | number>; teamParam?: Team };

interface Settings {
  rotate: boolean;
  handoff: boolean;
  reduceMotion: boolean;
  sound: boolean;
}

interface OnlineGame {
  match: OnlineMatch;
  myTeam: Team;
  version: number;
  pending: boolean;
  presenceIds: string[];
  conn: ChannelStatus;
  unsub: (() => void) | null;
  timers: number[];
  skewMs: number;
  /** Started under older rules: can be viewed and resigned, not played. */
  outdated: boolean;
}

const SETTINGS_KEY = 'checkline.settings.v2';
const ACTIVE_MATCH_KEY = 'checkline.online.match';
const AWAY_AFTER_S = 30;
const CLAIM_AFTER_S = 95; // forfeit: server allows 90 s away; a little margin for clock skew
/** Last seconds of a turn are highlighted. */
const CLOCK_LOW_S = 5;

function store<T>(k: string, v?: T): T | null {
  try {
    if (v === undefined) {
      const raw = localStorage.getItem(k);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable: keep going without persistence */
  }
  return null;
}

export class App {
  private screen: Screen = 'menu';
  private kind: GameKind = 'local';
  private game: MatchState = createMatch({ firstTeam: 'A' });
  private history: MatchState[] = [];
  private selected: string | null = null;
  private cursor: Square = { c: 3, r: 5 };
  private overlay: Overlay = null;
  private log: LogEntry[] = [];
  private toast: (() => string) | null = null;
  private toastTimer = 0;
  private lastMove: Square[] = [];
  private lessonIndex = 0;
  private lessonDone = false;
  private settings: Settings;
  private boardHasFocus = false;

  // coins, shop and cosmetic themes (saved in this browser)
  private wallet: Wallet = loadWallet();
  /** Identifies the current match so it is paid at most once. */
  private matchKey = '';
  /** What the finished match paid (shown on the full-time screen). */
  private lastAward: Award | null = null;
  /** Signed in: coins and items live in the database (public."user" + public.user_cosmetics), never in this browser. */
  private cloudWallet = false;
  private cloudPaid = new Set<string>();

  // computer opponent
  private difficulty: Difficulty = 'medium';
  private aiSide: Team | 'random' = 'A';
  private humanTeam: Team = 'A';
  private aiToken = 0;
  private aiState: 'idle' | 'thinking' | 'playing' = 'idle';

  // online
  private configResult: ConfigResult = readOnlineConfig();
  private backend: OnlineBackend | null = null;
  private onlineInit: Promise<void> | null = null;
  private og: OnlineGame | null = null;
  private lobbyUnsub: (() => void) | null = null;
  private lobbyTimer = 0;
  private presenceTimer = 0;
  private ui: OnlineScreen = {
    phase: 'connecting',
    authMode: 'login',
    notice: null,
    pendingEmail: '',
    showPassword: false,
    session: null,
    error: null,
    formError: null,
    busy: null,
    profile: null,
    renaming: false,
    changingPassword: false,
    open: { loading: false, error: null, items: [] },
    mine: { loading: false, error: null, items: [] },
    waiting: null,
    uid: null,
    serverSkewMs: 0,
  };
  private waitingUnsub: (() => void) | null = null;
  private waitingTimer = 0;
  /** Menu account chip (null = online play not configured). */
  private account: MenuAccount | null = null;
  /** What an email link brought us back for (read from the URL before supabase-js consumes it). */
  private authLanding: 'recovery' | 'signup' | 'error' | null = null;
  private lb: { loading: boolean; error: OnlineError | null; data: LeaderboardPage | null; page: number } = {
    loading: false,
    error: null,
    data: null,
    page: 0,
  };

  // rendering + motion
  private renderQueued = false;
  private flipFrom: Map<string, DOMRect> | null = null;
  private anim: {
    pass?: { from: Square; to: Square; toId: string };
    shot?: { from: Square; to: Square };
    ripple?: Square;
    tackleAt?: Square;
    ghost?: { piece: Piece; at: Square };
    gainId?: string;
    spentPip?: number;
    turnBanner?: string;
    bannerKind?: 'turn' | 'golden' | 'surge';
    flash?: 'goal' | 'tackle' | 'surge';
    confetti?: Team;
    kickoff?: boolean;
    enter?: boolean;
  } = {};
  private flashTimer = 0;
  private overlayTimer = 0;

  // turn clock: TURN_SECONDS for every human-controlled turn (local, computer, online)
  private clockKey = '';
  private clockLeftMs = TURN_SECONDS * 1000;
  private clockLast = 0;
  /** No countdown until this time (animations, banners, kickoff). */
  private clockHoldUntil = 0;
  private claimBusy = false;
  /** Online: match version an expiry claim was last sent for, and when to retry. */
  private claimTried = -1;
  private claimRetryAt = 0;

  constructor(private root: HTMLElement) {
    const saved = store<Partial<Settings>>(SETTINGS_KEY) ?? {};
    this.settings = { rotate: false, handoff: true, reduceMotion: false, sound: true, ...saved };
    setReduceMotion(this.settings.reduceMotion);
    setSoundEnabled(this.settings.sound);
    applyTheme(this.wallet);
    applyDocumentLang();
    if (!document.getElementById('cl-svg-defs')) {
      const holder = document.createElement('div');
      holder.id = 'cl-svg-defs';
      holder.innerHTML = SVG_DEFS;
      document.body.prepend(holder);
    }
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('change', (e) => this.onChange(e));
    root.addEventListener('submit', (e) => this.onSubmit(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
    root.addEventListener('focusin', (e) => {
      this.boardHasFocus = !!(e.target as HTMLElement).closest('.board');
    });
    window.addEventListener('online', () => this.onReconnect());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.onReconnect();
    });
    this.readAuthLanding();
    if (this.onlineConfigured()) void this.bootAccount();
    // Read-only snapshot of the current position (used by automated UI checks).
    (window as unknown as { __checklineState: () => unknown }).__checklineState = () => toWire(this.game);
    this.anim.enter = true;
    this.requestRender();
    window.setInterval(() => this.tickClock(), 200);
  }

  // ================================================================== screens & flows

  private goScreen(s: Screen): void {
    this.cancelAi();
    if (s !== 'online') this.stopLobby();
    if (s !== 'game') this.leaveOnlineGame();
    window.clearTimeout(this.overlayTimer);
    this.screen = s;
    this.overlay = null;
    this.toast = null;
    this.anim = { enter: true };
    this.requestRender();
    window.scrollTo?.(0, 0);
  }

  private beginGame(kind: GameKind, state: MatchState): void {
    this.matchKey = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.lastAward = null;
    this.clockKey = '';
    this.cancelAi();
    this.kind = kind;
    this.game = state;
    this.history = [];
    this.selected = null;
    this.lastMove = [];
    this.log = [];
    this.toast = null;
    const c = carrier(state);
    if (c.pos) this.cursor = { ...c.pos };
    this.screen = 'game';
    this.anim = { enter: true, kickoff: kind !== 'tutorial' };
  }

  private startLocal(): void {
    this.goScreen('game');
    this.beginGame('local', createMatch());
    this.log = [{ note: 'log.coinToss', teamParam: this.game.turn }];
    this.overlay = { kind: 'handoff', team: this.game.turn, opening: true };
    this.requestRender();
  }

  private startAi(): void {
    this.goScreen('game');
    this.humanTeam = this.aiSide === 'random' ? (Math.random() < 0.5 ? 'A' : 'B') : this.aiSide;
    this.beginGame('ai', createMatch());
    this.log = [{ note: 'log.coinToss', teamParam: this.game.turn }];
    this.overlay = { kind: 'handoff', team: this.game.turn, opening: true };
    this.requestRender();
  }

  private startTutorial(index = 0): void {
    if (this.screen !== 'game') this.goScreen('game');
    this.lessonIndex = Math.max(0, Math.min(index, LESSONS.length - 1));
    this.beginGame('tutorial', LESSONS[this.lessonIndex].setup());
    this.lessonDone = false;
    this.overlay = null;
    this.requestRender();
  }

  private flipped(): boolean {
    if (this.kind === 'local') return this.settings.rotate && this.game.turn === 'B';
    if (this.kind === 'ai') return this.humanTeam === 'B';
    if (this.kind === 'online') return this.og?.myTeam === 'B';
    return false;
  }

  /** The team the person at this screen may move right now (null = wait). */
  private activeTeam(): Team | null {
    const g = this.game;
    if (g.phase !== 'playing') return null;
    if (this.kind === 'ai') return g.turn === this.humanTeam && this.aiState === 'idle' ? g.turn : null;
    if (this.kind === 'online') return this.og && !this.og.outdated && g.turn === this.og.myTeam && !this.og.pending ? g.turn : null;
    return g.turn;
  }

  // ================================================================== actions

  private act(action: Action, source: 'human' | 'ai' = 'human'): void {
    if (this.kind === 'tutorial' && this.lessonDone && action.type !== 'endTurn') {
      this.showToast(() => t('toast.lessonDone'));
      return;
    }
    if (source === 'human') {
      if (this.kind === 'ai' && this.game.turn !== this.humanTeam) return this.showToast(() => t('toast.aiTurn'));
      if (this.kind === 'online') {
        void this.sendOnline(action);
        return;
      }
    }
    const result = applyAction(this.game, action);
    if (!result.ok) {
      const why = result.why;
      play('error');
      this.showToast(() => reasonText(why));
      return;
    }
    this.captureFlip();
    const before = this.game;
    this.history.push(before);
    this.game = result.state;
    this.afterChange(before, result.events, source);
  }

  /** Shared post-action handling for local, computer, tutorial and online updates. */
  private afterChange(before: MatchState, events: GameEvent[], source: 'human' | 'ai' | 'remote'): void {
    const g = this.game;
    const goal = events.find((e) => e.type === 'goal');
    const end = events.find((e) => e.type === 'win' || e.type === 'fullTime');
    for (const e of events) this.log.unshift({ ev: e });
    this.log = this.log.slice(0, 40);
    this.lastMove = [];
    let cue: Parameters<typeof play>[0] | null = null;

    for (const e of events) {
      if (e.type === 'move') {
        this.lastMove = [e.from, e.to];
        cue = 'move';
      }
      if (e.type === 'tackle') {
        const victim = getPiece(before, before.carrierId);
        if (victim) this.anim.ghost = { piece: victim, at: e.at };
        this.anim.tackleAt = e.at;
        this.anim.flash = 'tackle';
        const mover = getPiece(before, e.pieceId);
        if (mover?.pos) this.lastMove = [mover.pos, e.at];
        const team = mover?.team ?? g.turn;
        this.showToast(() => t('toast.tackle', { team: teamName(team) }), false);
        cue = 'tackle';
      }
      if (e.type === 'pass') {
        const from = getPiece(before, e.fromId)?.pos;
        const to = getPiece(g, e.toId)?.pos;
        if (from && to) {
          this.lastMove = [from, to];
          this.anim.pass = { from, to, toId: e.toId };
        }
        cue = 'pass';
      }
      if (e.type === 'shot') {
        this.lastMove = [e.from, e.to];
        this.anim.shot = { from: e.from, to: e.to };
        this.anim.ripple = e.to;
        cue = 'shot';
      }
      if (e.type === 'surge') {
        this.anim.flash = 'surge';
        this.anim.turnBanner = t('board.surge');
        this.anim.bannerKind = 'surge';
        cue = 'surge';
      }
      if (e.type === 'goldenGoal') {
        this.anim.turnBanner = t('board.golden');
        this.anim.bannerKind = 'golden';
        play('whistle');
      }
    }
    if (goal && goal.type === 'goal' && !this.anim.ripple) {
      const scorer = getPiece(this.kind === 'tutorial' ? g : before, goal.carrierId);
      const mv = events.find((e) => e.type === 'move' || e.type === 'tackle');
      if (mv && mv.type === 'move') this.anim.ripple = mv.to;
      else if (mv && mv.type === 'tackle') this.anim.ripple = mv.at;
      else if (scorer?.pos) this.anim.ripple = scorer.pos;
    }
    this.holdClock(goal || this.anim.turnBanner ? 1300 : this.anim.pass || this.anim.shot ? 800 : 350);
    if (g.carrierId !== before.carrierId && !goal) this.anim.gainId = g.carrierId;
    if (g.turn === before.turn && g.ap < before.ap) this.anim.spentPip = g.ap;
    this.scheduleFlashClear();
    if (cue) play(cue);
    if (goal) window.setTimeout(() => play('goal'), cue === 'shot' ? 260 : 0);

    if (this.kind === 'tutorial') {
      if (LESSONS[this.lessonIndex].check(events, g)) {
        this.lessonDone = true;
        this.selected = null;
        if (goal) this.anim.confetti = (goal as { team: Team }).team;
      }
      this.requestRender();
      return;
    }

    if (end) {
      this.history = [];
      this.selected = null;
      this.anim.flash = goal ? 'goal' : this.anim.flash;
      this.overlay = { kind: 'win', team: g.winner };
      if (g.winner) this.anim.confetti = g.winner;
      window.setTimeout(() => play('whistle'), 500);
      if (this.kind === 'online') this.finishOnline();
      this.requestRender();
      return;
    }

    if (goal && goal.type === 'goal') {
      this.history = [];
      this.selected = null;
      this.anim.flash = 'goal';
      this.overlay = { kind: 'goal', team: goal.team, score: goal.score, next: other(goal.team) };
      this.anim.confetti = goal.team;
      this.lastMove = [];
      this.anim.kickoff = true;
      const c = carrier(g);
      if (c.pos) this.cursor = { ...c.pos };
      if (this.kind !== 'local') this.autoCloseOverlay(2800);
      this.requestRender();
      return;
    }

    if (events.some((e) => e.type === 'turnEnd')) {
      this.history = [];
      this.selected = null;
      if (this.kind === 'local' && this.settings.handoff) this.overlay = { kind: 'handoff', team: g.turn };
      else if (!this.anim.turnBanner) this.anim.turnBanner = this.bannerText(g.turn);
      play('turn');
      this.requestRender();
      this.maybeRunAi();
      return;
    }

    if (source === 'human') {
      const moved = events.find((e) => e.type === 'move' || e.type === 'tackle');
      if (moved && (moved.type === 'move' || moved.type === 'tackle')) this.selected = moved.pieceId;
      const passed = events.find((e) => e.type === 'pass');
      if (passed && passed.type === 'pass') this.selected = passed.toId;
      if (events.some((e) => e.type === 'surge')) this.selected = this.selected ?? null;
      if (g.ap === 0) this.selected = null;
    } else {
      this.selected = null;
    }
    this.requestRender();
  }

  private bannerText(team: Team): string {
    if (this.kind === 'online' && this.og) return team === this.og.myTeam ? t('board.yourTurn') : t('board.turnBanner', { team: teamName(team) });
    if (this.kind === 'ai') return team === this.humanTeam ? t('board.yourTurn') : t('board.turnBanner', { team: teamName(team) });
    return t('board.turnBanner', { team: teamName(team) });
  }

  private undo(): void {
    if (this.kind === 'online') return;
    const prev = this.history.pop();
    if (!prev) return this.showToast(() => t('toast.nothingToUndo'));
    this.captureFlip();
    this.game = prev;
    this.selected = null;
    this.lastMove = [];
    this.lessonDone = false;
    this.log.unshift({ note: 'log.undo' });
    this.requestRender();
  }

  private autoCloseOverlay(ms: number): void {
    window.clearTimeout(this.overlayTimer);
    this.overlayTimer = window.setTimeout(() => {
      if (this.overlay?.kind === 'goal' || this.overlay?.kind === 'handoff') this.closeOverlay();
    }, ms);
  }

  private closeOverlay(): void {
    window.clearTimeout(this.overlayTimer);
    const wasHandoff = this.overlay?.kind === 'handoff' || this.overlay?.kind === 'goal';
    this.overlay = null;
    if (wasHandoff && this.screen === 'game') {
      if (this.kind !== 'local') this.anim.turnBanner = this.bannerText(this.game.turn);
      this.anim.kickoff = true;
      this.holdClock(1300);
    }
    this.requestRender();
    this.maybeRunAi();
  }

  // ================================================================== computer opponent

  private cancelAi(): void {
    this.aiToken++;
    this.aiState = 'idle';
  }

  private maybeRunAi(): void {
    if (this.kind !== 'ai' || this.screen !== 'game' || this.overlay || this.aiState !== 'idle') return;
    const g = this.game;
    if (g.phase !== 'playing' || g.turn === this.humanTeam) return;
    const token = ++this.aiToken;
    this.aiState = 'thinking';
    this.selected = null;
    this.requestRender();
    const fast = reducedMotion();
    window.setTimeout(() => {
      if (token !== this.aiToken) return;
      const plan = planTurn(this.game, { difficulty: this.difficulty, timeBudgetMs: 900 });
      this.aiState = 'playing';
      this.requestRender();
      const team = this.game.turn;
      let i = 0;
      const stepOnce = () => {
        if (token !== this.aiToken) return;
        if (this.overlay) {
          window.setTimeout(stepOnce, 300);
          return;
        }
        const action = plan[i++];
        if (!action || this.game.turn !== team || this.game.phase !== 'playing') {
          this.aiState = 'idle';
          this.requestRender();
          this.maybeRunAi();
          return;
        }
        // Show what the computer is about to do: highlight the piece first.
        if (action.type === 'move') this.selected = action.pieceId;
        this.act(action, 'ai');
        const pause = action.type === 'surge' ? 500 : action.type === 'shoot' ? 900 : 640;
        window.setTimeout(stepOnce, fast ? 220 : pause);
      };
      window.setTimeout(stepOnce, fast ? 100 : 250);
    }, fast ? 120 : 420);
  }

  // ================================================================== online: setup, lobby

  private async ensureBackend(): Promise<OnlineBackend> {
    const injected = (window as unknown as { __CHECKLINE_TEST_BACKEND__?: OnlineBackend }).__CHECKLINE_TEST_BACKEND__;
    if (!this.backend) {
      if (injected) this.backend = injected;
      else if (this.configResult.ok) this.backend = new SupabaseBackend(this.configResult.config);
      else throw new OnlineError('unknown', 'not configured');
    }
    if (!this.onlineInit)
      this.onlineInit = this.backend.init().catch((e) => {
        this.onlineInit = null;
        throw e;
      });
    await this.onlineInit;
    return this.backend;
  }

  private onlineConfigured(): boolean {
    return this.configResult.ok || !!(window as unknown as { __CHECKLINE_TEST_BACKEND__?: unknown }).__CHECKLINE_TEST_BACKEND__;
  }

  private async openOnline(): Promise<void> {
    this.goScreen('online');
    this.ui.formError = null;
    this.ui.notice = null;
    this.ui.renaming = false;
    if (!this.onlineConfigured()) {
      this.ui.phase = 'unconfigured';
      this.ui.problem = this.configResult.ok ? undefined : this.configResult.problem;
      this.requestRender();
      return;
    }
    this.ui.phase = 'connecting';
    this.requestRender();
    try {
      const be = await this.ensureBackend();
      this.ui.session = be.session();
      this.ui.uid = be.userId();
      if (this.screen !== 'online') return;
      if (!this.ui.session) {
        this.ui.phase = 'auth';
        this.requestRender();
        return;
      }
      await this.afterAuth();
      return;
    } catch (e) {
      this.ui.phase = 'error';
      this.ui.error = toOnlineError(e);
    }
    this.requestRender();
  }

  // ================================================================== accounts

  /** Remember whether this page load came from an email link (confirm sign-up / reset password). */
  private readAuthLanding(): void {
    const hash = typeof location === 'undefined' ? '' : location.hash;
    if (/type=recovery/.test(hash)) this.authLanding = 'recovery';
    else if (/type=(signup|email|magiclink)/.test(hash)) this.authLanding = 'signup';
    else if (/error_code=|error=/.test(hash)) this.authLanding = 'error';
  }

  /** Load the session in the background so the menu can show who is signed in. */
  private async bootAccount(): Promise<void> {
    this.account = { state: 'loading' };
    this.requestRender();
    try {
      const be = await this.ensureBackend();
      be.onAuthEvent((e) => this.onAuthEvent(e));
      this.ui.session = be.session();
      await this.refreshAccount();
      if (this.authLanding === 'recovery') {
        this.goScreen('online');
        this.ui.phase = 'recovery';
      } else if (this.authLanding === 'error') {
        this.goScreen('online');
        this.ui.phase = 'auth';
        this.ui.formError = new OnlineError('link_expired');
      } else if (this.authLanding === 'signup' && this.ui.session) {
        await this.openOnline();
        this.ui.notice = 'auth.confirmed';
      }
      if (this.authLanding) history.replaceState?.(null, '', location.pathname + location.search);
      this.authLanding = null;
    } catch {
      this.account = { state: 'signed-out' };
    }
    this.requestRender();
  }

  private async refreshAccount(): Promise<void> {
    const be = this.backend;
    const session = be?.session() ?? null;
    if (!be || !session) {
      this.account = { state: 'signed-out' };
      if (this.cloudWallet) {
        // Back to this browser's own coins and items.
        this.cloudWallet = false;
        this.wallet = loadWallet();
        applyTheme(this.wallet);
      }
      return;
    }
    void this.syncWallet();
    let name = session.displayName;
    try {
      name = (await be.myProfile())?.displayName ?? name;
    } catch {
      /* keep the name from the account */
    }
    this.account = { state: 'signed-in', name, guest: session.isGuest };
  }

  /** Load the signed-in player's wallet from the database (falls back to this browser on error). */
  private async syncWallet(): Promise<void> {
    const be = this.backend;
    if (!be?.session()) return;
    try {
      const sw = await be.getWallet();
      this.wallet = fromServer(this.wallet, sw);
      this.cloudWallet = true;
      applyTheme(this.wallet);
      this.requestRender();
    } catch {
      /* no profile yet, or the wallet table is not installed: keep using this browser's wallet */
    }
  }

  private onAuthEvent(e: 'signed_in' | 'signed_out' | 'password_recovery'): void {
    if (e === 'password_recovery') {
      this.goScreen('online');
      this.ui.phase = 'recovery';
      this.ui.formError = null;
      this.requestRender();
      return;
    }
    this.ui.session = this.backend?.session() ?? null;
    void this.refreshAccount().then(() => this.requestRender());
  }

  /** Signed in: make sure the player has a profile, then go to the lobby. */
  private async afterAuth(): Promise<void> {
    const be = this.backend;
    if (!be) return;
    this.ui.session = be.session();
    this.ui.uid = be.userId();
    this.ui.formError = null;
    let profile = await be.myProfile();
    // A name chosen at sign-up becomes the public profile on first login.
    if (!profile && this.ui.session?.displayName) {
      try {
        profile = await be.saveProfile(this.ui.session.displayName);
      } catch {
        profile = null;
      }
    }
    this.ui.profile = profile;
    if (this.screen !== 'online') return;
    if (!profile) {
      this.ui.phase = 'profile';
    } else {
      this.ui.phase = 'lobby';
      this.startLobby();
    }
    await this.refreshAccount();
    this.requestRender();
  }

  private authError(code: 'invalid_email' | 'weak_password' | 'password_mismatch' | 'invalid_name' | 'wrong_password'): void {
    this.ui.formError = new OnlineError(code);
    this.ui.notice = null;
    this.requestRender();
  }

  private static validEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  }

  private async logIn(email: string, password: string): Promise<void> {
    if (!App.validEmail(email)) return this.authError('invalid_email');
    if (!password) return this.authError('weak_password');
    this.ui.notice = null;
    const ok = await this.onlineBusy('login', async (be) => {
      await be.logIn(email, password);
      return true;
    });
    if (ok) await this.afterAuth();
  }

  private async signUp(name: string, email: string, password: string, password2: string): Promise<void> {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 24) return this.authError('invalid_name');
    if (!App.validEmail(email)) return this.authError('invalid_email');
    if (password.length < 6) return this.authError('weak_password');
    if (password !== password2) return this.authError('password_mismatch');
    this.ui.notice = null;
    const res = await this.onlineBusy('signup', async (be) => {
      // Display names are unique: check before creating the account.
      if (!(await be.nameAvailable(clean))) throw new OnlineError('name_taken');
      return be.signUp(email, password, clean);
    });
    if (!res) return;
    if (res.needsConfirmation) {
      this.ui.pendingEmail = email.trim();
      this.ui.phase = 'check-email';
      this.requestRender();
      return;
    }
    await this.afterAuth();
  }

  private async guest(): Promise<void> {
    this.ui.notice = null;
    const ok = await this.onlineBusy('guest', async (be) => {
      await be.guestSignIn();
      return true;
    });
    if (ok) await this.afterAuth();
  }

  private async forgot(email: string): Promise<void> {
    if (!App.validEmail(email)) return this.authError('invalid_email');
    const ok = await this.onlineBusy('forgot', async (be) => {
      await be.requestPasswordReset(email);
      return true;
    });
    if (ok) {
      this.ui.notice = 'auth.forgot.sent';
      this.requestRender();
    }
  }

  private async newPassword(password: string, password2: string): Promise<void> {
    if (password.length < 6) return this.authError('weak_password');
    if (password !== password2) return this.authError('password_mismatch');
    const ok = await this.onlineBusy('recovery', async (be) => {
      await be.updatePassword(password);
      return true;
    });
    if (!ok) return;
    await this.afterAuth();
    this.ui.notice = 'auth.recovery.done';
    this.showToast(() => t('auth.recovery.done'));
  }

  /** Signed in with email: change the password (the current one is checked first). */
  private async changePassword(current: string, next: string, next2: string): Promise<void> {
    if (!current) return this.authError('wrong_password');
    if (next.length < 6) return this.authError('weak_password');
    if (next !== next2) return this.authError('password_mismatch');
    const ok = await this.onlineBusy('change-password', async (be) => {
      await be.changePassword(current, next);
      return true;
    });
    if (!ok) return;
    this.ui.changingPassword = false;
    this.ui.showPassword = false;
    this.requestRender();
    this.showToast(() => t('auth.changePw.done'));
  }

  private async saveProfile(name: string): Promise<void> {
    const profile = await this.onlineBusy('profile', (be) => be.saveProfile(name));
    if (!profile) return;
    this.ui.profile = profile;
    this.ui.uid = this.backend?.userId() ?? null;
    this.ui.renaming = false;
    this.ui.phase = 'lobby';
    this.startLobby();
    await this.refreshAccount();
    this.requestRender();
  }

  private async logOut(): Promise<void> {
    this.stopLobby();
    this.leaveOnlineGame();
    store(ACTIVE_MATCH_KEY, null);
    try {
      await this.backend?.logOut();
    } catch {
      /* signed out locally even if the server call failed */
    }
    this.ui = { ...this.ui, phase: 'auth', authMode: 'login', session: null, profile: null, uid: null, formError: null, notice: null, renaming: false, changingPassword: false };
    this.ui.open = { loading: false, error: null, items: [] };
    this.ui.mine = { loading: false, error: null, items: [] };
    this.account = { state: 'signed-out' };
    if (this.screen !== 'online') this.goScreen('online');
    this.showToast(() => t('auth.loggedOut'));
  }

  private startLobby(): void {
    void this.refreshLobby();
    if (!this.lobbyUnsub && this.backend) {
      let debounce = 0;
      this.lobbyUnsub = this.backend.subscribeLobby(() => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => void this.refreshLobby(), 400);
      });
    }
    window.clearInterval(this.lobbyTimer);
    this.lobbyTimer = window.setInterval(() => void this.refreshLobby(), 20000);
  }

  private stopLobby(): void {
    this.lobbyUnsub?.();
    this.lobbyUnsub = null;
    window.clearInterval(this.lobbyTimer);
    this.stopWaiting();
  }

  private async refreshLobby(): Promise<void> {
    const be = this.backend;
    if (!be || this.screen !== 'online' || this.ui.phase !== 'lobby') return;
    this.ui.open.loading = this.ui.mine.loading = true;
    this.requestRender();
    const [open, mine, profile] = await Promise.allSettled([be.listOpenMatches(), be.listMyMatches(), be.myProfile()]);
    if (open.status === 'fulfilled') this.ui.open = { loading: false, error: null, items: open.value };
    else this.ui.open = { loading: false, error: toOnlineError(open.reason), items: [] };
    if (mine.status === 'fulfilled') this.ui.mine = { loading: false, error: null, items: mine.value.filter((m) => m.status === 'active' || m.status === 'waiting') };
    else this.ui.mine = { loading: false, error: toOnlineError(mine.reason), items: [] };
    if (profile.status === 'fulfilled' && profile.value) this.ui.profile = profile.value;
    const any = [...this.ui.open.items, ...this.ui.mine.items][0];
    if (any) this.ui.serverSkewMs = Date.parse(any.serverNow) - Date.now();
    this.requestRender();
  }

  private async onlineBusy<T>(busy: string, fn: (be: OnlineBackend) => Promise<T>): Promise<T | null> {
    if (this.ui.busy) return null;
    this.ui.busy = busy;
    this.ui.formError = null;
    this.requestRender();
    try {
      const be = await this.ensureBackend();
      return await fn(be);
    } catch (e) {
      this.ui.formError = toOnlineError(e);
      return null;
    } finally {
      this.ui.busy = null;
      this.requestRender();
    }
  }

  private async createOnline(isPublic: boolean): Promise<void> {
    const m = await this.onlineBusy(`create-${isPublic ? 1 : 0}`, (be) => be.createMatch(isPublic));
    if (m) this.enterWaiting(m);
  }

  private async joinOnline(code: string): Promise<void> {
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(clean)) {
      this.ui.formError = new OnlineError('match_not_found');
      this.requestRender();
      return;
    }
    const m = await this.onlineBusy('join', (be) => be.joinMatch(clean));
    if (m) this.openOnlineMatch(m);
  }

  private enterWaiting(m: OnlineMatch): void {
    this.ui.phase = 'waiting';
    this.ui.waiting = m;
    this.ui.formError = null;
    this.stopWaiting();
    const be = this.backend!;
    const check = async () => {
      try {
        const fresh = await be.getMatch(m.id);
        if (fresh.status === 'active') this.openOnlineMatch(fresh);
        else if (fresh.status !== 'waiting') {
          this.ui.phase = 'lobby';
          this.startLobby();
        }
      } catch {
        /* keep waiting; next poll retries */
      }
    };
    this.waitingUnsub = be.subscribeMatch(m.id, {
      onChange: (row) => {
        if (row.status !== 'waiting') void check();
      },
      onPresence: () => {},
      onStatus: () => {},
    });
    this.waitingTimer = window.setInterval(check, 5000);
    this.requestRender();
  }

  private stopWaiting(): void {
    this.waitingUnsub?.();
    this.waitingUnsub = null;
    window.clearInterval(this.waitingTimer);
  }

  private async cancelWaiting(): Promise<void> {
    const m = this.ui.waiting;
    if (!m) return;
    const res = await this.onlineBusy('cancel', (be) => be.cancelMatch(m.id));
    if (res) {
      this.stopWaiting();
      this.ui.waiting = null;
      this.ui.phase = 'lobby';
      this.startLobby();
    }
  }

  private async copyCode(): Promise<void> {
    const code = this.ui.waiting?.code ?? '';
    try {
      await navigator.clipboard.writeText(code);
      this.showToast(() => t('toast.copied'));
    } catch {
      const el = this.root.querySelector('#invite-code');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      this.showToast(() => t('toast.copyFailed'));
    }
  }

  private async openOnlineById(id: string): Promise<void> {
    try {
      const be = await this.ensureBackend();
      const m = await be.getMatch(id);
      if (m.status === 'waiting' && m.playerA.id === be.userId()) {
        if (this.screen !== 'online') {
          this.goScreen('online');
          this.ui.uid = be.userId();
          this.ui.profile = await be.myProfile();
        }
        this.enterWaiting(m);
      } else if (m.status === 'active' || m.status === 'finished') this.openOnlineMatch(m);
      else {
        store(ACTIVE_MATCH_KEY, null);
        void this.openOnline();
      }
    } catch (e) {
      const err = toOnlineError(e);
      if (err.code === 'match_not_found') store(ACTIVE_MATCH_KEY, null);
      if (this.screen !== 'online') await this.openOnline();
      this.ui.formError = err;
      this.requestRender();
    }
  }

  // ================================================================== online: match

  private openOnlineMatch(m: OnlineMatch): void {
    const uid = this.backend?.userId() ?? null;
    const myTeam = myTeamIn(m, uid);
    if (!myTeam || !m.state) return;
    this.stopLobby();
    this.goScreen('game');
    this.beginGame('online', fromWire(m.state));
    this.og = {
      match: m,
      myTeam,
      version: m.version,
      pending: false,
      presenceIds: [],
      conn: 'connecting',
      unsub: null,
      timers: [],
      skewMs: Date.parse(m.serverNow) - Date.now(),
      outdated: !!m.rulesVersion && m.rulesVersion < 3,
    };
    this.matchKey = `online-${m.id}`;
    if (m.status === 'active') store(ACTIVE_MATCH_KEY, m.id);
    this.log = (m.lastEvents ?? []).map((ev) => ({ ev }));
    if (m.status === 'finished') {
      this.overlay = { kind: 'win', team: this.winnerTeam(m) };
      store(ACTIVE_MATCH_KEY, null);
    } else {
      this.anim.turnBanner = this.bannerText(this.game.turn);
      this.subscribeOnline();
    }
    this.requestRender();
  }

  private winnerTeam(m: OnlineMatch): Team | null {
    if (!m.winnerId) return null;
    return m.winnerId === m.playerA.id ? 'A' : 'B';
  }

  private subscribeOnline(): void {
    const og = this.og;
    const be = this.backend;
    if (!og || !be) return;
    const id = og.match.id;
    og.unsub = be.subscribeMatch(id, {
      onChange: (row) => this.onMatchRow(row),
      onPresence: (ids) => {
        if (this.og) {
          this.og.presenceIds = ids;
          this.updatePresence();
        }
      },
      onStatus: (s) => {
        if (!this.og) return;
        const was = this.og.conn;
        this.og.conn = s;
        if (s === 'live' && was !== 'live') void this.resyncOnline();
        this.updatePresence();
      },
    });
    const beat = () => void be.heartbeat(id).catch(() => undefined);
    beat();
    og.timers.push(window.setInterval(beat, 15000));
    og.timers.push(window.setInterval(() => void this.resyncOnline(true), 8000));
    window.clearInterval(this.presenceTimer);
    this.presenceTimer = window.setInterval(() => this.updatePresence(), 1000);
  }

  private leaveOnlineGame(): void {
    if (!this.og) return;
    this.og.unsub?.();
    this.og.timers.forEach((id) => window.clearInterval(id));
    window.clearInterval(this.presenceTimer);
    this.og = null;
  }

  private onMatchRow(row: MatchRowChange): void {
    const og = this.og;
    if (!og) return;
    og.match = { ...og.match, aSeenAt: row.a_seen_at, bSeenAt: row.b_seen_at, turnStartedAt: row.turn_started_at ?? og.match.turnStartedAt };
    if (row.version > og.version || row.status !== og.match.status) void this.resyncOnline();
    else this.updatePresence();
  }

  private onReconnect(): void {
    if (this.og) void this.resyncOnline();
    else if (this.screen === 'online' && this.ui.phase === 'lobby') void this.refreshLobby();
  }

  private async resyncOnline(quiet = false): Promise<void> {
    const og = this.og;
    const be = this.backend;
    if (!og || !be || og.pending) return;
    try {
      const m = await be.getMatch(og.match.id);
      if (this.og !== og) return;
      og.skewMs = Date.parse(m.serverNow) - Date.now();
      this.applyServerMatch(m);
    } catch (e) {
      if (!quiet) {
        const err = toOnlineError(e);
        this.showToast(() => errorText(err));
      }
    }
  }

  private applyServerMatch(m: OnlineMatch): void {
    const og = this.og;
    if (!og || !m.state) return;
    const statusChanged = m.status !== og.match.status;
    og.match = m;
    if (m.version > og.version) {
      const before = this.game;
      og.version = m.version;
      this.captureFlip();
      this.game = fromWire(m.state);
      const fromOpponent = m.lastActor !== this.backend?.userId();
      if (fromOpponent) this.afterChange(before, m.lastEvents ?? [], 'remote');
    }
    if (statusChanged && m.status === 'finished') {
      this.overlay = { kind: 'win', team: this.winnerTeam(m) };
      this.finishOnline();
    }
    this.requestRender();
  }

  private finishOnline(): void {
    store(ACTIVE_MATCH_KEY, null);
    const og = this.og;
    if (!og) return;
    og.timers.forEach((id) => window.clearInterval(id));
    og.timers = [];
    if (!og.match.result && this.backend) {
      void this.backend.getMatch(og.match.id).then((m) => {
        if (this.og === og) {
          og.match = m;
          this.requestRender();
        }
      });
    }
  }

  private async sendOnline(action: Action): Promise<void> {
    const og = this.og;
    const be = this.backend;
    if (!og || !be) return;
    if (og.match.status !== 'active') return this.showToast(() => t('online.err.match_not_active'));
    if (og.outdated) return this.showToast(() => t('online.err.match_outdated'));
    if (this.game.turn !== og.myTeam) return this.showToast(() => t('toast.waitTurn'));
    if (og.pending) return this.showToast(() => t('toast.sending'));
    const local = applyAction(this.game, action);
    if (!local.ok) {
      const why = local.why;
      play('error');
      return this.showToast(() => reasonText(why));
    }
    og.pending = true;
    this.captureFlip();
    const before = this.game;
    this.game = local.state;
    this.afterChange(before, local.events, 'human');
    try {
      const m = await be.submitAction(og.match.id, og.version, action);
      og.pending = false;
      if (this.og !== og) return;
      og.version = m.version;
      og.match = m;
      if (m.state) this.game = fromWire(m.state);
      if (m.status === 'finished') {
        if (this.overlay?.kind !== 'win') this.overlay = { kind: 'win', team: this.winnerTeam(m) };
        this.finishOnline();
      }
      this.requestRender();
    } catch (e) {
      og.pending = false;
      const err = toOnlineError(e);
      this.showToast(() => (err.code === 'illegal' ? t('online.err.illegal', { reason: err.detail }) : errorText(err)));
      this.game = before;
      await this.resyncOnline(true);
      this.requestRender();
    }
  }

  private async resignOnline(): Promise<void> {
    const og = this.og;
    const be = this.backend;
    this.overlay = null;
    if (!og || !be) return;
    try {
      const m = await be.resign(og.match.id);
      og.match = m;
      this.overlay = { kind: 'win', team: this.winnerTeam(m) };
      this.finishOnline();
    } catch (e) {
      const err = toOnlineError(e);
      this.showToast(() => errorText(err));
    }
    this.requestRender();
  }

  private async claimWin(): Promise<void> {
    const og = this.og;
    const be = this.backend;
    if (!og || !be) return;
    try {
      const m = await be.claimForfeit(og.match.id);
      og.match = m;
      this.overlay = { kind: 'win', team: og.myTeam };
      this.finishOnline();
    } catch (e) {
      const err = toOnlineError(e);
      this.showToast(() => errorText(err));
    }
    this.requestRender();
  }

  /** Online: the current turn is past its server deadline; ask the server to end it.
   *  Either player may ask; the server checks the time and the match version, so a turn is
   *  only ever ended once (a late or repeated request is refused and simply resyncs). */
  private async claimTime(): Promise<void> {
    const og = this.og;
    const be = this.backend;
    if (!og || !be || this.claimBusy) return;
    const idle = this.game.turn;
    this.claimBusy = true;
    try {
      const m = await be.claimTimeout(og.match.id, og.version);
      if (this.og !== og) return;
      const before = this.game;
      og.match = m;
      if (m.state && m.version > og.version) {
        og.version = m.version;
        this.captureFlip();
        this.game = fromWire(m.state);
        this.afterChange(before, m.lastEvents ?? [], 'remote');
      }
      this.timeUpToast(idle);
    } catch {
      // Already ended (by the other player or the server), or not quite due: just catch up.
      if (this.og === og) await this.resyncOnline(false);
    } finally {
      this.claimBusy = false;
    }
    this.requestRender();
  }

  private timeUpToast(idle: Team): void {
    const mine = this.kind === 'online' ? idle === this.og?.myTeam : this.kind === 'ai' ? idle === this.humanTeam : true;
    this.showToast(() => (mine && this.kind !== 'local' ? t('clock.youTimedOut') : t('clock.timedOut', { team: teamName(idle) })), false);
  }

  private opponentStatus(): { online: boolean; secondsAway: number } {
    const og = this.og!;
    const oppId = og.myTeam === 'A' ? og.match.playerB?.id : og.match.playerA.id;
    const online = !!oppId && og.presenceIds.includes(oppId);
    const seen = og.myTeam === 'A' ? og.match.bSeenAt : og.match.aSeenAt;
    const secondsAway = seen ? Math.max(0, Math.floor((Date.now() + og.skewMs - Date.parse(seen)) / 1000)) : 999;
    return { online, secondsAway: online ? 0 : secondsAway };
  }

  /** Online: milliseconds until the server deadline of the current turn (null if not applicable).
   *  The server allows TURN_SECONDS plus TURN_GRACE_SECONDS for network delay and the move
   *  animation; the clock shows at most TURN_SECONDS of it. */
  private onlineMsLeft(): number | null {
    const og = this.og;
    if (!og || og.match.status !== 'active' || og.outdated || !og.match.turnStartedAt) return null;
    const deadline = Date.parse(og.match.turnStartedAt) + (TURN_SECONDS + TURN_GRACE_SECONDS) * 1000;
    return deadline - (Date.now() + og.skewMs);
  }

  private turnLimitMs(): number {
    // Test hook: automated UI checks may shorten or lengthen local turns.
    const o = (window as unknown as { __CHECKLINE_TURN_SECONDS__?: number }).__CHECKLINE_TURN_SECONDS__;
    return (typeof o === 'number' && o > 0 ? o : TURN_SECONDS) * 1000;
  }

  private holdClock(ms: number): void {
    const until = performance.now() + (reducedMotion() ? Math.min(ms, 150) : ms);
    if (until > this.clockHoldUntil) this.clockHoldUntil = until;
  }

  /** What the turn clock shows now (null = hidden). */
  private clockView(): { secs: number; frac: number; mine: boolean; paused: boolean } | null {
    if (this.screen !== 'game' || this.game.phase !== 'playing') return null;
    const limit = TURN_SECONDS * 1000;
    if (this.kind === 'online') {
      const left = this.onlineMsLeft();
      if (left === null) return null;
      const ms = Math.max(0, Math.min(limit, left));
      return { secs: Math.ceil(ms / 1000), frac: ms / limit, mine: this.game.turn === this.og?.myTeam, paused: false };
    }
    if (this.kind !== 'local' && this.kind !== 'ai') return null;
    if (this.kind === 'ai' && this.game.turn !== this.humanTeam) return null;
    const full = this.turnLimitMs();
    const ms = this.clockKey === this.turnKey() ? Math.max(0, this.clockLeftMs) : full;
    return { secs: Math.ceil(ms / 1000), frac: ms / full, mine: true, paused: !this.clockRunning() };
  }

  private turnKey(): string {
    const g = this.game;
    return `${g.turnNumber}|${g.turn}|${g.rally}|${g.score.A}-${g.score.B}`;
  }

  /** Local / computer: the countdown only runs while the player can actually act. */
  private clockRunning(): boolean {
    return this.activeTeam() !== null && !this.overlay && performance.now() >= this.clockHoldUntil;
  }

  private tickClock(): void {
    const now = performance.now();
    const dt = this.clockLast ? Math.min(now - this.clockLast, 1000) : 0;
    this.clockLast = now;
    if (this.screen !== 'game' || this.game.phase !== 'playing') return;
    if (this.kind === 'online') {
      const left = this.onlineMsLeft();
      const og = this.og;
      if (og && left !== null && left <= 0 && !og.pending && !this.claimBusy && (this.claimTried !== og.version || now >= this.claimRetryAt)) {
        // The opponent's own game normally ends their turn; step in shortly after if it doesn't.
        if (this.game.turn === og.myTeam || left <= -800) {
          this.claimTried = og.version;
          this.claimRetryAt = now + 2500;
          void this.claimTime();
        }
      }
      this.paintClock();
      return;
    }
    if (this.kind !== 'local' && this.kind !== 'ai') return;
    const key = this.turnKey();
    if (key !== this.clockKey) {
      this.clockKey = key;
      this.clockLeftMs = this.turnLimitMs();
    }
    if (this.clockRunning()) {
      this.clockLeftMs -= dt;
      if (this.clockLeftMs <= 0) {
        this.clockLeftMs = 0;
        this.localTimeout();
      }
    }
    this.paintClock();
  }

  /** Local / computer: time is up, so the turn ends as if End turn had been pressed. */
  private localTimeout(): void {
    const team = this.game.turn;
    this.selected = null;
    this.log.unshift({ note: 'log.timeout', teamParam: team });
    this.act({ type: 'endTurn' }, 'human');
    this.timeUpToast(team);
    play('whistle');
    this.requestRender();
  }

  /** Cheap per-tick update of the turn clock (no full re-render). */
  private paintClock(): void {
    const el = this.root.querySelector<HTMLElement>('[data-turn-clock]');
    if (!el) return;
    const v = this.clockView();
    el.hidden = !v;
    if (!v) return;
    const num = el.querySelector('b');
    if (num && num.textContent !== String(v.secs)) num.textContent = String(v.secs);
    el.style.setProperty('--left', v.frac.toFixed(3));
    el.classList.toggle('low', v.secs <= CLOCK_LOW_S);
    el.classList.toggle('theirs', !v.mine);
    el.classList.toggle('paused', v.paused);
    const label = t(v.mine ? 'clock.aria' : 'clock.ariaTheirs', { n: v.secs });
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  }

  private clockHtml(): string {
    if (this.kind === 'tutorial') return '';
    return `<span class="turn-clock" data-turn-clock role="timer" title="${esc(t('clock.tip', { n: TURN_SECONDS }))}" hidden>
        <span class="clock-icon" aria-hidden="true">⏱</span><b dir="ltr">${TURN_SECONDS}</b><i class="clock-bar" aria-hidden="true"><i></i></i></span>`;
  }

  /** Cheap per-second refresh of the presence block and turn timer (no full re-render). */
  private updatePresence(): void {
    if (!this.og) return;
    const el = this.root.querySelector<HTMLElement>('[data-presence]');
    if (el) {
      // Only touch the DOM when the content changes, so buttons inside stay stable under the pointer.
      const html = this.presenceHtml();
      if (el.dataset.html !== html) {
        el.innerHTML = html;
        el.dataset.html = html;
      }
    }
  }

  // ================================================================== leaderboard

  private openLeaderboard(): void {
    this.goScreen('leaderboard');
    this.lb.page = 0;
    void this.loadLeaderboard();
  }

  private async loadLeaderboard(): Promise<void> {
    if (!this.onlineConfigured()) {
      this.requestRender();
      return;
    }
    this.lb.loading = true;
    this.lb.error = null;
    this.requestRender();
    try {
      const be = await this.ensureBackend();
      const data = await be.leaderboard(this.lb.page * 15, 15);
      this.lb.data = data;
      this.ui.uid = be.userId();
    } catch (e) {
      this.lb.error = toOnlineError(e);
    }
    this.lb.loading = false;
    this.requestRender();
  }

  // ================================================================== input

  private onCell(sq: Square): void {
    this.cursor = sq;
    const g = this.game;
    const occupant = pieceAt(g, sq);
    const sel = this.selected ? getPiece(g, this.selected) : undefined;
    const active = this.activeTeam();

    if (sel && sel.pos) {
      const mine = sel.team === g.turn && active === sel.team;
      // Shooting: click an open goal square with the ball carrier selected.
      if (sel.id === g.carrierId && mine) {
        const target = shotTargets(g).find((x) => sameSquare(x.at, sq));
        if (target && !target.why && g.ap >= g.config.shotCost) {
          this.act({ type: 'shoot', fromId: sel.id, to: sq });
          return;
        }
      }
      const pv = previewMoves(g, sel.id);
      const opt = pv.options.find((o) => o.to.c === sq.c && o.to.r === sq.r);
      if (opt) {
        if (sel.team !== g.turn) {
          this.selected = null;
          return this.showToast(() => t('toast.notYourPiece', { team: teamName(sel.team), turn: teamName(g.turn) }));
        }
        if (active !== sel.team) return this.waitToast();
        this.act({ type: 'move', pieceId: sel.id, to: sq });
        return;
      }
      if (sel.id === g.carrierId && mine && !occupant) {
        const target = shotTargets(g).find((x) => sameSquare(x.at, sq));
        if (target?.why) {
          const why = target.why;
          return this.showToast(() => reasonText(why));
        }
      }
      if (sel.id === g.carrierId && sel.team === g.turn && occupant && occupant.team === sel.team && occupant.id !== sel.id) {
        if (active !== sel.team) return this.waitToast();
        const passes = passOptions(g);
        if (passes.options.some((o) => o.toId === occupant.id)) {
          this.act({ type: 'pass', fromId: sel.id, toId: occupant.id });
          return;
        }
        const blocked = passes.blocked.find((b) => b.toId === occupant.id);
        if (blocked) {
          this.selected = occupant.id;
          const why = blocked.why;
          return this.showToast(() => t('toast.cantPass', { reason: reasonText(why), piece: pieceName(occupant.kind) }));
        }
      }
      // Clicking an opponent with one of your pieces selected is a tackle attempt: if it is not
      // legal, keep your selection and explain why.
      if (occupant && occupant.team !== sel.team && mine) {
        const why = pv.blocked.find((b) => b.at.c === sq.c && b.at.r === sq.r)?.why;
        if (why) return this.showToast(() => reasonText(why));
        if (occupant.id !== g.carrierId) {
          return this.showToast(() => t('toast.notCarrier', { piece: pieceName(occupant.kind), sq: squareName(sq) }));
        }
        return this.showToast(() => this.cantReachText(sel, sq));
      }
      if (!occupant) {
        const why = pv.blocked.find((b) => b.at.c === sq.c && b.at.r === sq.r)?.why;
        this.selected = null;
        if (why) this.showToast(() => reasonText(why));
        else if (mine) this.showToast(() => this.cantReachText(sel, sq));
        else this.requestRender();
        return;
      }
    }

    if (occupant) {
      this.selected = occupant.id === this.selected ? null : occupant.id;
      if (this.selected && occupant.team !== g.turn) {
        return this.showToast(() => t('toast.readOnly', { team: teamName(occupant.team) }));
      }
      this.requestRender();
      return;
    }
    this.selected = null;
    this.requestRender();
  }

  private waitToast(): void {
    this.showToast(() => (this.kind === 'ai' ? t('toast.aiTurn') : this.og?.pending ? t('toast.sending') : t('toast.waitTurn')));
  }

  private cantReachText(p: Piece, sq: Square): string {
    const spec = this.game.config.pieces[p.kind];
    const dribbling = p.id === this.game.carrierId && (spec.pattern === 'queen' || spec.pattern === 'rook' || spec.pattern === 'bishop');
    if (dribbling) return t('toast.cantReachDribble', { piece: pieceName(p.kind), sq: squareName(sq) });
    return t('toast.cantReach', { piece: pieceName(p.kind), sq: squareName(sq), how: moveText(spec.pattern, spec.range) });
  }

  private onClick(e: Event): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    const act = el.dataset.act!;
    switch (act) {
      case 'cell':
        if (this.overlay) return;
        this.onCell({ c: Number(el.dataset.c), r: Number(el.dataset.r) });
        return;
      case 'lang':
        setLang(el.dataset.lang as Lang);
        this.requestRender();
        return;
      case 'menu':
        if (this.cloudWallet) void this.syncWallet();
        this.goScreen('menu');
        return;
      case 'play-local':
      case 'rematch-local':
        this.startLocal();
        return;
      case 'ai-setup':
        this.goScreen('ai-setup');
        return;
      case 'pick-difficulty':
        this.difficulty = el.dataset.value as Difficulty;
        this.requestRender();
        return;
      case 'pick-side':
        this.aiSide = el.dataset.value as Team | 'random';
        this.requestRender();
        return;
      case 'ai-start':
      case 'rematch-ai':
        this.startAi();
        return;
      case 'tutorial':
        this.startTutorial(0);
        return;
      case 'rules':
        this.overlay = { kind: 'rules' };
        this.requestRender();
        return;
      case 'close':
        this.closeOverlay();
        return;
      case 'end':
        if (this.kind === 'online') void this.sendOnline({ type: 'endTurn' });
        else if (this.activeTeam()) this.act({ type: 'endTurn' });
        else this.waitToast();
        return;
      case 'surge':
        if (this.kind === 'online') void this.sendOnline({ type: 'surge' });
        else if (this.activeTeam()) this.act({ type: 'surge' });
        else this.waitToast();
        return;
      case 'undo':
        this.undo();
        return;
      case 'lesson-reset':
        this.startTutorial(this.lessonIndex);
        return;
      case 'lesson-next':
        if (this.lessonIndex >= LESSONS.length - 1) this.startAi();
        else this.startTutorial(this.lessonIndex + 1);
        return;
      case 'lesson-prev':
        this.startTutorial(this.lessonIndex - 1);
        return;
      case 'online':
        void this.openOnline();
        return;
      case 'online-retry':
        this.onlineInit = null;
        this.backend = null;
        void this.openOnline();
        return;
      case 'online-resume': {
        const id = store<string>(ACTIVE_MATCH_KEY);
        if (id) void this.openOnlineById(id);
        return;
      }
      case 'online-create':
        void this.createOnline(el.dataset.public === '1');
        return;
      case 'online-join-open':
        void this.joinOnline(el.dataset.code ?? '');
        return;
      case 'online-open':
        void this.openOnlineById(el.dataset.id ?? '');
        return;
      case 'online-refresh':
        void this.refreshLobby();
        return;
      case 'account':
        void this.openOnline();
        return;
      case 'auth-mode':
        this.ui.authMode = (el.dataset.mode as AuthMode) ?? 'login';
        if (this.ui.phase !== 'auth') this.ui.phase = 'auth';
        this.ui.formError = null;
        this.ui.notice = null;
        this.requestRender();
        return;
      case 'auth-guest':
        void this.guest();
        return;
      case 'toggle-pw':
        this.ui.showPassword = !this.ui.showPassword;
        this.requestRender();
        return;
      case 'logout':
        void this.logOut();
        return;
      case 'online-rename':
        this.ui.renaming = true;
        this.ui.formError = null;
        this.requestRender();
        return;
      case 'online-rename-cancel':
        this.ui.renaming = false;
        this.ui.formError = null;
        this.requestRender();
        return;
      case 'online-change-pw':
      case 'online-change-pw-cancel':
        this.ui.changingPassword = act === 'online-change-pw';
        this.ui.renaming = false;
        this.ui.formError = null;
        this.requestRender();
        return;
      case 'online-copy':
        void this.copyCode();
        return;
      case 'online-cancel':
        void this.cancelWaiting();
        return;
      case 'online-lobby':
        void this.openOnline();
        return;
      case 'resign':
        this.overlay = { kind: 'resign' };
        this.requestRender();
        return;
      case 'resign-confirm':
        void this.resignOnline();
        return;
      case 'claim':
        void this.claimWin();
        return;
      case 'leaderboard':
        this.openLeaderboard();
        return;
      case 'shop':
        if (this.cloudWallet) void this.syncWallet();
        this.goScreen('shop');
        return;
      case 'shop-item':
        this.shopItem(el.dataset.kind as ItemKind, el.dataset.id ?? '');
        return;
      case 'shop-bundle':
        this.shopBundle(el.dataset.id ?? '');
        return;
      case 'lb-prev':
        this.lb.page = Math.max(0, this.lb.page - 1);
        void this.loadLeaderboard();
        return;
      case 'lb-next':
        this.lb.page++;
        void this.loadLeaderboard();
        return;
      case 'lb-retry':
        void this.loadLeaderboard();
        return;
    }
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement;
    const setting = el.dataset.setting as keyof Settings | undefined;
    if (!setting) return;
    this.settings[setting] = el.checked;
    store(SETTINGS_KEY, this.settings);
    if (setting === 'reduceMotion') setReduceMotion(el.checked);
    if (setting === 'sound') setSoundEnabled(el.checked);
    this.requestRender();
  }

  private onSubmit(e: Event): void {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const data = new FormData(form);
    switch (form.dataset.form) {
      case 'profile':
      case 'rename':
        void this.saveProfile(String(data.get('name') ?? ''));
        return;
      case 'login':
        void this.logIn(String(data.get('auth-email') ?? ''), String(data.get('auth-password') ?? ''));
        return;
      case 'signup':
        void this.signUp(
          String(data.get('auth-name') ?? ''),
          String(data.get('auth-email') ?? ''),
          String(data.get('auth-password') ?? ''),
          String(data.get('auth-password2') ?? ''),
        );
        return;
      case 'forgot':
        void this.forgot(String(data.get('auth-email') ?? ''));
        return;
      case 'new-password':
        void this.newPassword(String(data.get('auth-password') ?? ''), String(data.get('auth-password2') ?? ''));
        return;
      case 'change-password':
        void this.changePassword(String(data.get('pw-current') ?? ''), String(data.get('pw-new') ?? ''), String(data.get('pw-new2') ?? ''));
        return;
      case 'join':
        void this.joinOnline(String(data.get('code') ?? ''));
        return;
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (this.overlay) {
      if (e.key === 'Escape' && this.overlay.kind === 'resign') {
        e.preventDefault();
        this.overlay = null;
        this.requestRender();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
        const btn = this.root.querySelector<HTMLElement>('.overlay [data-primary]');
        if (btn && !(e.target as HTMLElement).closest('.overlay button')) {
          e.preventDefault();
          btn.click();
        }
      }
      return;
    }
    if (this.screen !== 'game') return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const flip = this.flipped();
    const cfg = this.game.config;
    const moveCursor = (dc: number, dr: number) => {
      e.preventDefault();
      const sdc = flip ? -dc : dc;
      const sdr = flip ? -dr : dr;
      this.cursor = {
        c: Math.max(0, Math.min(cfg.cols - 1, this.cursor.c + sdc)),
        r: Math.max(0, Math.min(cfg.rows - 1, this.cursor.r + sdr)),
      };
      this.boardHasFocus = true;
      this.requestRender();
    };
    switch (e.key) {
      case 'ArrowUp':
        return moveCursor(0, 1);
      case 'ArrowDown':
        return moveCursor(0, -1);
      case 'ArrowLeft':
        return moveCursor(-1, 0);
      case 'ArrowRight':
        return moveCursor(1, 0);
      case 'Enter':
      case ' ':
        if (!(e.target as HTMLElement).closest('.board')) return;
        e.preventDefault();
        this.boardHasFocus = true;
        this.onCell(this.cursor);
        return;
      case 'Escape':
        this.selected = null;
        this.requestRender();
        return;
      case 'e':
      case 'E':
        if (this.kind !== 'tutorial') this.root.querySelector<HTMLElement>('[data-act="end"]')?.click();
        return;
      case 's':
      case 'S':
        this.root.querySelector<HTMLElement>('[data-act="surge"]')?.click();
        return;
      case 'u':
      case 'U':
        this.undo();
        return;
      case 'z':
        if (e.ctrlKey || e.metaKey) this.undo();
        return;
    }
  }

  // ================================================================== rendering

  private showToast(msg: () => string, render = true): void {
    this.toast = msg;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = null;
      this.requestRender();
    }, 3200);
    if (render) this.requestRender();
  }

  private captureFlip(): void {
    if (!this.flipFrom && this.screen === 'game') this.flipFrom = snapshotTokens(this.root);
  }

  private scheduleFlashClear(): void {
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      if (this.anim.flash || this.anim.ghost) {
        this.anim.flash = undefined;
        this.anim.ghost = undefined;
        this.requestRender();
      }
    }, 950);
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    const active = document.activeElement as HTMLInputElement | null;
    const focusId = active && this.root.contains(active) && active.id ? active.id : null;
    const caret = focusId && 'selectionStart' in active! ? active!.selectionStart : null;
    const values = new Map<string, string>();
    this.root.querySelectorAll<HTMLInputElement>('input[id]:not([type=checkbox])').forEach((i) => values.set(i.id, i.value));

    this.payFinishedMatch();
    const anim = this.anim;
    let html: string;
    switch (this.screen) {
      case 'menu':
        html = renderMenu({
          onlineOk: this.onlineConfigured(),
          resume: !!store<string>(ACTIVE_MATCH_KEY) && this.onlineConfigured() && this.account?.state === 'signed-in',
          account: this.onlineConfigured() ? this.account : null,
          coins: this.wallet.coins,
        });
        break;
      case 'shop':
        html = renderShop(this.wallet, this.cloudWallet);
        break;
      case 'ai-setup':
        html = renderAiSetup({ difficulty: this.difficulty, side: this.aiSide });
        break;
      case 'online':
        html = renderOnline(this.ui);
        break;
      case 'leaderboard':
        html = renderLeaderboard({
          configured: this.onlineConfigured(),
          problem: this.configResult.ok ? undefined : this.configResult.problem,
          ...this.lb,
          pageSize: 15,
          uid: this.ui.uid ?? this.backend?.userId() ?? null,
        });
        break;
      default:
        html = this.renderGame();
    }
    if (!anim.enter) html = html.replace(/\bscreen-enter\b/g, '');
    this.root.innerHTML =
      html + this.renderOverlay() + (this.screen !== 'game' && this.toast ? `<div class="toast" role="alert">${esc(this.toast())}</div>` : '');

    values.forEach((v, id) => {
      const input = this.root.querySelector<HTMLInputElement>(`#${id}`);
      if (input && v) input.value = v;
    });
    if (focusId) {
      const input = this.root.querySelector<HTMLInputElement>(`#${focusId}`);
      input?.focus({ preventScroll: true });
      if (input && caret !== null && typeof input.setSelectionRange === 'function') {
        try {
          input.setSelectionRange(caret, caret);
        } catch {
          /* not a text input */
        }
      }
    } else if (this.screen === 'game' && this.boardHasFocus && !this.overlay) {
      this.root.querySelector<HTMLElement>('.cell.cursor')?.focus({ preventScroll: true });
    }

    if (this.flipFrom) {
      flipTokens(this.root, this.flipFrom);
      this.flipFrom = null;
    }
    if (anim.pass) flyBall(this.root, anim.pass.from, anim.pass.to, BALL_SVG);
    if (anim.shot) flyBall(this.root, anim.shot.from, anim.shot.to, BALL_SVG, 520, 'shot');
    if (anim.tackleAt) burstAt(this.root, anim.tackleAt, 'tackle');
    if (anim.confetti) {
      const host = this.root.querySelector<HTMLElement>('.overlay .modal') ?? this.root.querySelector<HTMLElement>('.board-frame');
      if (host) confetti(host, anim.confetti === 'A' ? ['#f2e9d6', '#d8a84c', '#fffaf0'] : ['#2b2f34', '#d8a84c', '#a8853c']);
    }
    if (this.og) this.updatePresence();
    this.paintClock();
    this.anim = { flash: anim.flash, ghost: anim.ghost };
  }

  private renderGame(): string {
    const g = this.game;
    const a = this.anim;
    const board = renderBoard({
      game: g,
      selected: this.selected,
      cursor: this.cursor,
      flipped: this.flipped(),
      lastMove: this.lastMove,
      activeTeam: this.activeTeam(),
      ghost: a.ghost,
      gainId: a.gainId,
      incomingId: a.pass?.toId,
      kickoff: a.kickoff,
      turnBanner: a.turnBanner,
      bannerKind: a.bannerKind,
      rippleGoal: a.ripple,
      flash: a.flash,
      toast: this.toast ? this.toast() : null,
    });
    return `
      <div class="screen game-screen ${this.kind} ${a.enter ? 'screen-enter' : ''}">
        ${this.renderStatus()}
        <div class="layout">
          <section class="pitch-col">${board}</section>
          <aside class="side">${this.kind === 'tutorial' ? this.renderLesson() : this.renderSide()}</aside>
        </div>
      </div>`;
  }

  private clockText(): string {
    const g = this.game;
    if (this.kind === 'tutorial' || !g.resetOnGoal) return '';
    if (g.phase === 'finished') return `<span class="clock done">${esc(t('clock.fullTime'))}</span>`;
    if (isGoldenGoal(g)) return `<span class="clock golden">${esc(t('clock.golden'))}</span>`;
    const n = Math.min(turnsPlayed(g) + 1, g.config.regulationTurns);
    return `<span class="clock" title="${esc(t('clock.title', { n: g.config.regulationTurns }))}"><b dir="ltr">${n}</b><i dir="ltr">/${g.config.regulationTurns}</i></span>`;
  }

  private renderStatus(): string {
    const g = this.game;
    const c = carrier(g);
    const pipCount = Math.max(g.config.apPerTurn, g.ap);
    const pips = Array.from(
      { length: pipCount },
      (_, i) => `<span class="pip ${i < g.ap ? 'on' : ''} ${i >= g.config.apPerTurn ? 'bonus' : ''} ${this.anim.spentPip === i ? 'spent' : ''}"></span>`,
    ).join('');
    const you = (team: Team) =>
      (this.kind === 'ai' && team === this.humanTeam) || (this.kind === 'online' && team === this.og?.myTeam)
        ? `<span class="you-chip">${esc(t('status.you'))}</span>`
        : '';
    const scoreBlock =
      this.kind === 'tutorial'
        ? `<div class="scoreboard"><span class="lesson-badge">${esc(t('status.tutorial', { n: this.lessonIndex + 1, total: LESSONS.length }))}</span></div>`
        : `<div class="scoreboard" aria-label="${esc(t('status.score'))}">
             <span class="crest A ${g.turn === 'A' ? 'active' : ''}" title="${esc(teamName('A'))}">A</span>${you('A')}
             <span class="digits" dir="ltr"><strong>${g.score.A}</strong><span class="dash">–</span><strong>${g.score.B}</strong></span>
             ${you('B')}<span class="crest B ${g.turn === 'B' ? 'active' : ''}" title="${esc(teamName('B'))}">B</span>
             ${this.clockText()}
           </div>`;
    const active = this.activeTeam();
    const surgeReady = g.phase === 'playing' && g.surge[g.turn];
    const surge =
      this.kind === 'tutorial' && !LESSONS[this.lessonIndex].surge
        ? ''
        : `<button class="surge-chip ${surgeReady ? 'ready' : 'used'}" data-act="surge" ${surgeReady && active ? '' : 'disabled'}
             title="${esc(t('surge.tip'))}"><span aria-hidden="true">⚡</span>${esc(t(surgeReady ? 'surge.ready' : 'surge.used'))}</button>`;
    let thinking = '';
    if (this.kind === 'ai' && this.aiState !== 'idle') thinking = `<span class="thinking"><span class="spinner sm"></span>${esc(t(this.aiState === 'thinking' ? 'ai.thinking' : 'ai.playing'))}</span>`;
    if (this.kind === 'online' && this.og) {
      const conn = this.og.conn;
      thinking = `<span class="conn ${conn}"><i></i>${esc(t(conn === 'live' ? 'online.conn.live' : conn === 'connecting' ? 'online.conn.connecting' : 'online.conn.offline'))}</span>`;
    }
    return `
      <header class="status" role="status" aria-live="polite">
        <button class="btn icon" data-act="menu" title="${esc(t('common.menu'))}" aria-label="${esc(t('common.menu'))}">☰</button>
        ${scoreBlock}
        <div class="turn ${g.turn}"><span class="label">${esc(t('status.turn'))}</span>
          <span class="team-dot ${g.turn}"></span><strong>${esc(teamName(g.turn))}</strong></div>
        ${this.clockHtml()}
        <div class="ap" aria-label="${esc(t('status.apAria', { n: g.ap, max: g.config.apPerTurn }))}">
          <span class="label">${esc(t('status.ap'))}</span>${pips}</div>
        ${surge}
        <div class="poss ${this.anim.gainId ? 'flash' : ''}"><span class="label">${esc(t('status.ball'))}</span>
          <span class="team-dot ${c.team}"></span>${esc(pieceName(c.kind))} <span dir="ltr">${c.pos ? squareName(c.pos) : ''}</span></div>
        ${thinking}
      </header>`;
  }

  private renderSelection(): string {
    const g = this.game;
    const sel = this.selected ? getPiece(g, this.selected) : undefined;
    const active = this.activeTeam();
    if (!sel || !sel.pos) {
      let hint: string;
      if (g.phase !== 'playing') hint = '';
      else if (!active) hint = this.kind === 'ai' ? t('ai.thinking') : t('sel.waitOpponent');
      else if (g.ap === 0) hint = g.surge[g.turn] ? t('sel.noApSurge') : t('sel.noAp');
      else hint = t('sel.prompt', { team: teamName(g.turn) });
      return `<div class="card selection idle"><p>${esc(hint)}</p>${this.threatLine()}</div>`;
    }
    const spec = g.config.pieces[sel.kind];
    const isCarrier = sel.id === g.carrierId;
    const dribble = isCarrier && ['queen', 'rook', 'bishop'].includes(spec.pattern);
    const pv = previewMoves(g, sel.id);
    const mine = sel.team === g.turn && active === sel.team;
    const passCount = isCarrier && mine ? passOptions(g).options.length : 0;
    const shotCount = isCarrier && mine ? shotTargets(g).filter((x) => !x.why).length : 0;
    const status = !mine
      ? `<p class="muted">${esc(sel.team !== g.turn ? t('sel.opponent') : t('sel.waitOpponent'))}</p>`
      : pv.unavailableWhy
        ? `<p class="warn">${esc(reasonText(pv.unavailableWhy))}</p>`
        : '';
    return `
      <div class="card selection">
        <div class="sel-head">
          <div class="token mini team-${sel.team}">${pieceSvg(sel.kind)}</div>
          <div>
            <h3>${esc(pieceName(sel.kind))} · ${esc(teamName(sel.team))} <span class="sq" dir="ltr">${squareName(sel.pos)}</span></h3>
            <p class="muted">${esc(pieceRole(sel.kind))}</p>
          </div>
          ${moveDiagram(sel.kind)}
        </div>
        <dl>
          <dt>${esc(t('sel.moves'))}</dt><dd>${esc(moveText(spec.pattern, spec.range))}</dd>
          ${dribble ? `<dt>${esc(t('sel.withBall'))}</dt><dd>${esc(t('sel.dribble'))}</dd>` : ''}
          ${isCarrier && spec.pattern === 'knight' ? `<dt>${esc(t('sel.withBall'))}</dt><dd>${esc(t('sel.knightBall'))}</dd>` : ''}
          ${sel.kind === 'king' ? `<dt>${esc(t('sel.special'))}</dt><dd>${esc(t('sel.keeper'))}</dd>` : ''}
          ${isCarrier ? `<dt>${esc(t('sel.pass'))}</dt><dd>${esc(t('sel.passRule', { n: g.config.passRange }))}</dd>` : ''}
          ${isCarrier ? `<dt>${esc(t('sel.shoot'))}</dt><dd>${esc(t('sel.shootRule', { n: g.config.shotRange }))}</dd>` : ''}
        </dl>
        ${status}
        ${passCount > 0 ? `<p class="legend"><span class="lg pass"></span>${esc(t('sel.passHint'))}</p>` : ''}
        ${shotCount > 0 ? `<p class="legend"><span class="lg shot"></span>${esc(t('sel.shotHint'))}</p>` : ''}
        ${this.threatLine()}
      </div>`;
  }

  private threatLine(): string {
    const g = this.game;
    if (g.phase !== 'playing' || (this.kind === 'tutorial' && this.lessonDone)) return '';
    const threats = tackleThreats(g);
    if (!threats.length) return '';
    const c = carrier(g);
    const list = threats.map((p) => `${pieceName(p.kind)} ${squareName(p.pos!)}`).join(getLang() === 'ar' ? '، ' : ', ');
    return `<p class="threat">${esc(t('sel.threat', { team: teamName(c.team), list }))}</p>`;
  }

  private presenceHtml(): string {
    const og = this.og!;
    const opp = og.myTeam === 'A' ? og.match.playerB : og.match.playerA;
    const s = this.opponentStatus();
    const away = !s.online && s.secondsAway >= AWAY_AFTER_S;
    const state = s.online || !away ? 'online' : 'away';
    const label = s.online || !away ? t('online.presence.online') : t('online.presence.away', { n: s.secondsAway });
    let claim = '';
    if (og.match.status === 'active' && away) {
      claim =
        s.secondsAway >= CLAIM_AFTER_S
          ? `<p class="small">${esc(t('online.claimReady'))}</p><button class="btn small primary" data-act="claim">${esc(t('act.claimWin'))}</button>`
          : `<p class="small muted">${esc(t('online.claimIn', { n: CLAIM_AFTER_S - s.secondsAway }))}</p>`;
    }
    return `<div class="player-line"><span class="presence ${state}"><i></i></span>
        <span><bdi>${esc(opp?.name ?? '?')}</bdi> <span class="rating-chip" dir="ltr">${opp?.rating ?? ''}</span></span>
        <span class="muted small">${esc(label)}</span></div>${claim}`;
  }

  private renderSide(): string {
    const g = this.game;
    const captured = (team: Team) =>
      g.pieces
        .filter((p) => p.team === team && !p.pos)
        .map((p) => pieceName(p.kind))
        .join(getLang() === 'ar' ? '، ' : ', ') || '–';
    const lookup = (id: string) => {
      const p = g.pieces.find((x) => x.id === id);
      return p ? { team: p.team, kind: p.kind } : undefined;
    };
    const logLines = this.log
      .slice(0, 8)
      .map((entry) =>
        'ev' in entry ? eventText(entry.ev, lookup) : t(entry.note, entry.teamParam ? { ...(entry.params ?? {}), team: teamName(entry.teamParam) } : entry.params),
      );
    const active = this.activeTeam();
    const canEnd = !!active && g.phase === 'playing';
    let top = '';
    if (this.kind === 'ai') {
      top = `<div class="card opponent-card"><div class="player-line"><span class="cpu-badge" aria-hidden="true">CPU</span>
        <strong>${esc(t('ai.opponent', { level: t(`ai.${this.difficulty}` as MessageKey) }))}</strong></div>
        <p class="small muted"><span class="team-dot ${this.humanTeam}"></span>${esc(t('status.you'))}: ${esc(teamFull(this.humanTeam))}</p></div>`;
    }
    if (this.kind === 'online' && this.og) {
      const me = this.og.myTeam === 'A' ? this.og.match.playerA : this.og.match.playerB;
      top = `<div class="card opponent-card">
        <p class="small muted"><span class="team-dot ${this.og.myTeam}"></span>${esc(t('online.you'))}: <bdi>${esc(me?.name ?? '')}</bdi> · ${esc(teamName(this.og.myTeam))}</p>
        <div data-presence>${this.presenceHtml()}</div>
        ${this.og.outdated && this.og.match.status === 'active' ? `<p class="warn small">${esc(t('sel.outdated'))}</p>` : ''}</div>`;
    }
    const undoBtn =
      this.kind === 'online'
        ? `<button class="btn" data-act="resign" ${this.og?.match.status === 'active' ? '' : 'disabled'}>${esc(t('act.resign'))}</button>`
        : `<button class="btn" data-act="undo" ${this.history.length && active ? '' : 'disabled'} title="${esc(t('tip.undo'))}">${esc(t('act.undo'))}</button>`;
    const settings = [
      this.kind === 'local' ? `<label><input type="checkbox" data-setting="rotate" ${this.settings.rotate ? 'checked' : ''}/> ${esc(t('set.rotate'))}</label>` : '',
      this.kind === 'local' ? `<label><input type="checkbox" data-setting="handoff" ${this.settings.handoff ? 'checked' : ''}/> ${esc(t('set.handoff'))}</label>` : '',
      `<label><input type="checkbox" data-setting="sound" ${this.settings.sound ? 'checked' : ''}/> ${esc(t('set.sound'))}</label>`,
      `<label><input type="checkbox" data-setting="reduceMotion" ${this.settings.reduceMotion ? 'checked' : ''}/> ${esc(t('set.motion'))}</label>`,
    ].join('');
    return `
      ${top}
      ${this.renderSelection()}
      <div class="actions dock">
        ${undoBtn}
        <button class="btn primary ${g.ap === 0 && canEnd && !g.surge[g.turn] ? 'pulse' : ''}" data-act="end" ${canEnd ? '' : 'disabled'} title="${esc(t('tip.end'))}">${esc(t('act.endTurn'))}</button>
      </div>
      <div class="card">
        <h4>${esc(t('side.offPitch'))}</h4>
        <p class="off"><span class="team-dot A"></span>${esc(captured('A'))}</p>
        <p class="off"><span class="team-dot B"></span>${esc(captured('B'))}</p>
        <p class="muted small">${esc(t('side.rallyTurn', { rally: g.rally, turn: g.turnNumber }))}</p>
      </div>
      <div class="card log">
        <h4>${esc(t('side.log'))}</h4>
        <ol>${logLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
      </div>
      <div class="card settings">
        <h4>${esc(t('side.settings'))}</h4>
        ${settings}
        <div class="row between">${langSwitch()}<button class="btn ghost small" data-act="rules">${esc(t('act.rules'))}</button></div>
      </div>`;
  }

  private renderLesson(): string {
    const lesson = LESSONS[this.lessonIndex];
    const k = (part: string) => `lesson.${lesson.id}.${part}` as MessageKey;
    const dots = LESSONS.map((_, i) => `<span class="pip ${i <= this.lessonIndex ? 'on' : ''}"></span>`).join('');
    const last = this.lessonIndex === LESSONS.length - 1;
    return `
      <div class="card lesson">
        <div class="lesson-dots">${dots}</div>
        <h3>${esc(t(k('title')))}</h3>
        <p class="task">${t(k('task'))}</p>
        <p class="muted">${esc(t(k('tip')))}</p>
        ${
          this.lessonDone
            ? `<div class="success"><strong>${esc(t('lesson.nice'))}</strong> ${esc(t(k('success')))}</div>`
            : this.game.ap === 0 && !this.game.surge[this.game.turn]
              ? `<p class="warn">${esc(t('lesson.outOfAp'))}</p>`
              : ''
        }
      </div>
      ${this.renderSelection()}
      <div class="actions dock lesson-dock">
        <button class="btn" data-act="undo" ${this.history.length ? '' : 'disabled'}>${esc(t('act.undo'))}</button>
        <button class="btn" data-act="lesson-reset">${esc(t('act.reset'))}</button>
        <button class="btn ghost" data-act="lesson-prev" ${this.lessonIndex === 0 ? 'disabled' : ''}>${esc(t('act.prev'))}</button>
        <button class="btn ${this.lessonDone ? 'primary pulse' : ''}" data-act="lesson-next">${esc(t(last ? 'act.playMatch' : 'act.next'))}</button>
      </div>
      <div class="card settings"><div class="row between">${langSwitch()}<button class="btn ghost small" data-act="rules">${esc(t('act.rules'))}</button></div></div>`;
  }

  private renderOverlay(): string {
    const o = this.overlay;
    if (!o) return '';
    const g = this.game;
    let body = '';
    if (o.kind === 'handoff') {
      const humanSide = this.kind === 'ai' ? this.humanTeam : o.team;
      const isAiTurn = this.kind === 'ai' && o.team !== this.humanTeam;
      body = `
        <p class="eyebrow">${esc(t(o.opening ? 'ov.coinToss' : 'ov.passDevice'))}</p>
        <h2><span class="team-dot big ${o.team}"></span>${esc(teamFull(o.team))}</h2>
        <p>${o.opening ? esc(t('ov.kicksOff', { team: teamName(o.team) })) + ' ' : ''}${isAiTurn ? '' : esc(t('ov.yourTurnAp', { n: g.config.apPerTurn }))}</p>
        <p class="muted">${esc(t(humanSide === 'A' ? 'ov.attackUp' : 'ov.attackDown'))}</p>
        ${o.opening ? `<p class="small muted">${esc(t('ov.format', { goals: g.config.goalsToWin, turns: g.config.regulationTurns }))}</p>` : ''}
        <button class="btn primary" data-act="close" data-primary>${esc(t(isAiTurn ? 'act.kickOff' : 'act.startTurn'))}</button>`;
    } else if (o.kind === 'goal') {
      body = `
        <div class="goal-word" dir="ltr" aria-hidden="true">GOAL</div>
        <h2><span class="team-dot big ${o.team}"></span>${esc(t('ov.scores', { team: teamName(o.team) }))}</h2>
        <p class="bigscore" dir="ltr">${o.score.A} – ${o.score.B}</p>
        <p>${esc(t('ov.goalReset', { team: teamName(o.next), n: g.config.apPerTurn }))}</p>
        <button class="btn primary" data-act="close" data-primary>${esc(t('act.kickOff'))}</button>`;
    } else if (o.kind === 'win') {
      body = this.renderWinBody(o.team);
    } else if (o.kind === 'rules') {
      body = this.renderRules();
    } else if (o.kind === 'resign') {
      body = `
        <h2>${esc(t('ov.resignTitle'))}</h2>
        <p>${esc(t('ov.resignBody'))}</p>
        <div class="row center">
          <button class="btn primary" data-act="close" data-primary>${esc(t('ov.keepPlaying'))}</button>
          <button class="btn danger" data-act="resign-confirm">${esc(t('ov.resignConfirm'))}</button>
        </div>`;
    }
    return `<div class="overlay" role="dialog" aria-modal="true"><div class="modal ${o.kind}">${body}</div></div>`;
  }

  private renderRules(): string {
    const cfg = this.game.config;
    const kinds: PieceKind[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
    const cards = kinds
      .map(
        (k) => `<div class="piece-card">${moveDiagram(k)}<div><strong>${esc(pieceName(k))}</strong>
          <span class="muted small">${esc(pieceRole(k))}</span><span class="small">${esc(moveText(cfg.pieces[k].pattern, cfg.pieces[k].range))}</span></div></div>`,
      )
      .join('');
    const items: [MessageKey, Record<string, string | number>?][] = [
      ['rules.goal', { goals: cfg.goalsToWin, turns: cfg.regulationTurns }],
      ['rules.turn', { ap: cfg.apPerTurn }],
      ['rules.dribble'],
      ['rules.pass', { range: cfg.passRange }],
      ['rules.shoot', { range: cfg.shotRange }],
      ['rules.keeper'],
      ['rules.tackle'],
      ['rules.surge'],
      ['rules.clock', { turns: cfg.regulationTurns, max: cfg.maxTurns }],
    ];
    return `
      <h2>${esc(t('ov.howTo'))}</h2>
      <ul class="rules">${items.map(([key, params]) => `<li>${tHtml(key, params)}</li>`).join('')}</ul>
      <div class="piece-grid">${cards}</div>
      <button class="btn primary" data-act="close" data-primary>${esc(t('act.gotIt'))}</button>`;
  }

  /** How the (local) match ended, read from the state and the last end-of-match event. */
  private endKind(): 'goals' | 'golden' | 'clock' | 'draw' {
    const g = this.game;
    if (!g.winner) return 'draw';
    if (g.score[g.winner] >= g.config.goalsToWin) return 'goals';
    const last = this.log.find((e) => 'ev' in e && (e.ev.type === 'win' || e.ev.type === 'fullTime'));
    if (last && 'ev' in last && last.ev.type === 'fullTime') return 'clock';
    return turnsPlayed(g) >= g.config.regulationTurns && g.turnNumber - 1 >= g.config.regulationTurns ? 'golden' : 'clock';
  }

  // ================================================================== coins & shop

  /** Pay coins once when a real match reaches full time (never in the tutorial). */
  private payFinishedMatch(): void {
    if (this.overlay?.kind !== 'win' || this.kind === 'tutorial' || !this.matchKey) return;
    if (this.kind !== 'online' && this.game.phase !== 'finished') return;
    if (this.kind === 'online' && this.og?.match.status !== 'finished') return;
    const team = this.overlay.team;
    // Win bonus when *you* won: against the computer or an online opponent. Local hot-seat
    // matches count towards the match bonus only (both players share this device).
    const won = !!team && this.kind === 'ai' && team === this.humanTeam;
    if (this.kind === 'online') {
      // Scored on the server together with the result (coins + rank points); just reload.
      if (!this.cloudPaid.has(this.matchKey)) {
        this.cloudPaid.add(this.matchKey);
        void this.syncWallet();
      }
      return;
    }
    // Signed in: the account balance only changes on the server, which cannot verify matches
    // played in this browser, so they pay nothing (and never touch the browser wallet either).
    if (this.cloudWallet) return;
    const award = awardMatch(this.wallet, this.matchKey, won);
    if (award) this.lastAward = award;
  }

  private shopItem(kind: ItemKind, id: string): void {
    if (this.cloudWallet && this.backend) {
      void this.shopItemCloud(this.backend, kind, id);
      return;
    }
    const item = findItem(kind, id);
    if (!item) return;
    const name = () => t(`${kind}.${id}.name` as MessageKey);
    const res = buyOrEquip(this.wallet, kind, id);
    if (res === 'too_poor') {
      play('error');
      this.showToast(() => t('shop.tooPoor'));
      return;
    }
    play(res === 'bought' ? 'goal' : 'move');
    this.showToast(() => t(res === 'bought' ? 'shop.bought' : 'shop.equippedToast', { name: name() }));
  }

  /** Buy (or re-equip) a full set: pitch floor + piece skin + ball. */
  private shopBundle(id: string): void {
    if (!findBundle(id)) return;
    const name = () => t(`bundle.${id}.name` as MessageKey);
    if (this.cloudWallet && this.backend) {
      void this.shopBundleCloud(this.backend, id, name);
      return;
    }
    const res = buyBundle(this.wallet, id);
    if (res === 'too_poor') {
      play('error');
      this.showToast(() => t('shop.tooPoor'));
      return;
    }
    play(res === 'bought' ? 'goal' : 'move');
    this.showToast(() => t(res === 'bought' ? 'bundle.bought' : 'bundle.equipped', { name: name() }));
  }

  private async shopBundleCloud(be: OnlineBackend, id: string, name: () => string): Promise<void> {
    const before = this.wallet.owned.length;
    try {
      this.wallet = fromServer(this.wallet, await be.buyBundle(id));
      applyTheme(this.wallet);
      const bought = this.wallet.owned.length > before;
      play(bought ? 'goal' : 'move');
      this.showToast(() => t(bought ? 'bundle.bought' : 'bundle.equipped', { name: name() }));
    } catch (e) {
      const err = toOnlineError(e);
      play('error');
      this.showToast(() => (err.code === 'too_poor' ? t('shop.tooPoor') : errorText(err)));
    }
  }

  private async shopItemCloud(be: OnlineBackend, kind: ItemKind, id: string): Promise<void> {
    const had = this.wallet.owned.includes(`${kind}:${id}`);
    try {
      this.wallet = fromServer(this.wallet, await be.buyItem(kind, id));
      applyTheme(this.wallet);
      play(had ? 'move' : 'goal');
      this.showToast(() => t(had ? 'shop.equippedToast' : 'shop.bought', { name: t(`${kind}.${id}.name` as MessageKey) }));
    } catch (e) {
      const err = toOnlineError(e);
      play('error');
      this.showToast(() => (err.code === 'too_poor' ? t('shop.tooPoor') : errorText(err)));
    }
  }

  private awardHtml(): string {
    if (this.kind === 'tutorial') return '';
    if (this.kind === 'online') return this.onlineAwardHtml();
    if (this.cloudWallet) return `<div class="award"><p class="small muted">${esc(t('ov.coinsOnlineOnly'))}</p></div>`;
    const a = this.lastAward;
    if (!a) return '';
    const parts: string[] = [];
    if (a.win) parts.push(t('ov.coinsWin', { n: a.win }));
    if (a.bonus) parts.push(t('ov.coinsBonus', { n: a.bonus }));
    const next = t('ov.coinsNext', { n: a.toNext });
    return `<div class="award ${a.coins ? 'paid' : ''}">
        ${a.coins ? `<p class="award-total"><span class="emoji" aria-hidden="true">🎉</span>${coinIcon()}<strong dir="ltr">+${a.coins}</strong> <span>${esc(t('ov.coinsEarned'))}</span></p>` : ''}
        <p class="small muted">${esc([...parts, next].join(' · '))}</p>
      </div>`;
  }

  /** Online: coins and C-rank points come straight from the server's result row. */
  private onlineAwardHtml(): string {
    const og = this.og;
    const r = og?.match.result;
    if (!og || !r) return '';
    const mine = og.myTeam === 'A';
    const coins = (mine ? r.aCoins : r.bCoins) ?? 0;
    const before = mine ? r.aPointsBefore : r.bPointsBefore;
    const after = mine ? r.aPointsAfter : r.bPointsAfter;
    const iWon = r.winnerId !== null && r.winnerId === (og.myTeam === 'A' ? og.match.playerA.id : og.match.playerB?.id);
    let rank: string;
    if (!r.ranked || before == null || after == null) {
      rank = `<p class="small muted">${esc(t('rank.unranked'))}</p>`;
    } else {
      const d = after - before;
      const note = iWon && d === 0 && r.rankNote ? `<p class="small muted">${esc(t(`rank.note.${r.rankNote}` as MessageKey))}</p>` : '';
      rank = `<p class="rank-change">${tierChip(rankFor(after).tier)} <span dir="ltr" class="rating-change ${d >= 0 ? 'up' : 'down'}">${before} → <strong>${after}</strong> (${d >= 0 ? '+' : ''}${d})</span> <span class="small muted">${esc(t('rank.points'))}</span></p>${note}`;
    }
    return `<div class="award ${coins ? 'paid' : ''}">
        ${coins ? `<p class="award-total"><span class="emoji" aria-hidden="true">🎉</span>${coinIcon()}<strong dir="ltr">+${coins}</strong> <span>${esc(t('ov.coinsEarned'))}</span></p>` : ''}
        ${rank}
      </div>`;
  }

  private renderWinBody(team: Team | null): string {
    const g = this.game;
    let title = team ? t('ov.wins', { team: teamName(team) }) : t('ov.draw');
    let extra = '';
    let buttons = `<button class="btn primary" data-act="${this.kind === 'ai' ? 'rematch-ai' : 'rematch-local'}" data-primary>${esc(t('act.rematch'))}</button>
      <button class="btn" data-act="menu">${esc(t('common.menu'))}</button>`;
    if (this.kind === 'ai' && team) title = t(team === this.humanTeam ? 'ov.youWin' : 'ov.youLose');
    const kind = this.endKind();
    let reasonKey: MessageKey = `ov.reason.${kind}`;
    if (this.kind === 'online' && this.og) {
      const m = this.og.match;
      const won = team === this.og.myTeam;
      title = team ? t(won ? 'ov.youWin' : 'ov.youLose') : t('ov.draw');
      const reason = m.endReason ?? 'goals';
      reasonKey =
        reason === 'goals'
          ? team && g.score[team] < g.config.goalsToWin
            ? 'ov.reason.golden'
            : 'ov.reason.goals'
          : reason === 'clock'
            ? 'ov.reason.clock'
            : reason === 'draw'
              ? 'ov.reason.draw'
              : reason === 'resign'
                ? won
                  ? 'ov.reason.resign'
                  : 'ov.reason.resignYou'
                : won
                  ? 'ov.reason.forfeit'
                  : 'ov.reason.forfeitYou';
      let rating = spinner(t('common.loading'));
      if (m.result) {
        const before = this.og.myTeam === 'A' ? m.result.aRatingBefore : m.result.bRatingBefore;
        const after = this.og.myTeam === 'A' ? m.result.aRatingAfter : m.result.bRatingAfter;
        const d = after - before;
        rating = `<span dir="ltr" class="rating-change ${d >= 0 ? 'up' : 'down'}">${before} → <strong>${after}</strong> (${d >= 0 ? '+' : ''}${d})</span>`;
      }
      extra = `<dl class="summary"><dt>${esc(t('ov.rating'))}</dt><dd>${rating}</dd></dl>`;
      buttons = `<button class="btn primary" data-act="online-lobby" data-primary>${esc(t('act.toLobby'))}</button>
        <button class="btn" data-act="leaderboard">${esc(t('act.leaderboard'))}</button>`;
    }
    return `
      <p class="eyebrow">${esc(t('ov.fullTime'))}</p>
      <h2>${team ? `<span class="team-dot big ${team}"></span>` : ''}${esc(title)}</h2>
      <p class="bigscore" dir="ltr">${g.score.A} – ${g.score.B}</p>
      <p>${esc(t(reasonKey, { n: g.config.goalsToWin }))}</p>
      ${extra}
      ${this.awardHtml()}
      <dl class="summary">
        <dt>${esc(t('ov.rallies'))}</dt><dd>${g.rally}</dd>
        <dt>${esc(t('ov.turns'))}</dt><dd>${kind === 'goals' || kind === 'golden' ? g.turnNumber : turnsPlayed(g)}</dd>
        <dt>${esc(t('ov.tackles'))}</dt><dd>${esc(teamName('A'))} ${g.capturesBy.A} · ${esc(teamName('B'))} ${g.capturesBy.B}</dd>
      </dl>
      <div class="row center">${buttons}</div>`;
  }
}

