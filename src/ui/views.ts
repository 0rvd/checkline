// Screens outside the pitch: menu, computer setup, online lobby, leaderboard. Pure HTML builders.
import type { Difficulty } from '../ai/ai.js';
import { escapeHtml as esc, getLang, t, tHtml, teamName, type MessageKey } from '../i18n/index.js';
import type { AuthSession, LeaderboardPage, OnlineError, OnlineMatch, OnlineProfile } from '../online/backend.js';
import type { ConfigProblem } from '../online/config.js';
import type { PieceKind, Team } from '../rules/types.js';
import { MATCHES_PER_BONUS, MATCH_BONUS, SHOP_ITEMS, WIN_BONUS, equipped, owns, type ShopItem, type Wallet } from './economy.js';
import { BALL_SVG, pieceSvg } from './pieces.js';

export function langSwitch(): string {
  const l = getLang();
  return `<div class="lang-switch" role="group" aria-label="${esc(t('lang.label'))}">
    <button class="${l === 'en' ? 'on' : ''}" data-act="lang" data-lang="en" lang="en" aria-pressed="${l === 'en'}">English</button>
    <button class="${l === 'ar' ? 'on' : ''}" data-act="lang" data-lang="ar" lang="ar" aria-pressed="${l === 'ar'}">العربية</button>
  </div>`;
}

export function errorText(e: OnlineError | null | undefined): string {
  if (!e) return '';
  return t(`online.err.${e.code}` as MessageKey, { detail: e.detail.slice(0, 140), reason: e.detail });
}

export function spinner(label: string): string {
  return `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(label)}</span></div>`;
}

// ------------------------------------------------------------------ menu
/** Decorative mini pitch for the menu: a Queen threads a shot past the keeper into the open corner. */
function heroPitch(): string {
  const tok = (team: Team, kind: PieceKind, x: number, y: number, extra = '') =>
    `<div class="token team-${team} kind-${kind} ${extra}" style="--x:${x};--y:${y}">${pieceSvg(kind)}</div>`;
  return `
    <div class="hero-pitch" aria-hidden="true" dir="ltr">
      <div class="hero-net"><i></i></div>
      <div class="hero-grid">${'<i></i>'.repeat(24)}</div>
      <div class="hero-lane"></div>
      ${tok('B', 'king', 2, 0, 'keeper')}
      ${tok('B', 'bishop', 1, 2)}
      ${tok('B', 'pawn', 3, 2)}
      ${tok('A', 'knight', 1, 3)}
      ${tok('A', 'queen', 4, 3, 'shooter')}
      <div class="hero-ball">${BALL_SVG}</div>
    </div>`;
}

/** Account button on the menu: "Log in" when signed out, the player's name when signed in. */
export interface MenuAccount {
  state: 'loading' | 'signed-out' | 'signed-in';
  name?: string | null;
  guest?: boolean;
}

function accountChip(a: MenuAccount | null): string {
  if (!a) return '';
  if (a.state === 'loading') return `<span class="account-chip loading" aria-hidden="true"><span class="spinner sm"></span></span>`;
  if (a.state === 'signed-out')
    return `<button class="account-chip" data-act="account"><span class="avatar" aria-hidden="true">→</span>${esc(t('auth.chip.login'))}</button>`;
  const name = a.name || t('auth.guest');
  return `<button class="account-chip in" data-act="account" title="${esc(t(a.guest ? 'auth.guestAccount' : 'auth.chip.account'))}">
      <span class="avatar" aria-hidden="true">${esc([...name][0]?.toUpperCase() ?? '?')}</span><bdi>${esc(name)}</bdi></button>`;
}

/** Small gold coin (original vector art). */
export function coinIcon(): string {
  return `<svg class="coin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/><circle cx="12" cy="12" r="7.2" class="rim"/><path d="M12 7.6 L13.4 10.6 L16.6 11 L14.2 13.2 L14.8 16.4 L12 14.8 L9.2 16.4 L9.8 13.2 L7.4 11 L10.6 10.6 Z" class="star"/></svg>`;
}

function coinChip(coins: number): string {
  return `<button class="coin-chip" data-act="shop" title="${esc(t('menu.shop'))}">${coinIcon()}<span dir="ltr">${coins}</span></button>`;
}

export function renderMenu(o: { onlineOk: boolean; resume: boolean; account?: MenuAccount | null; coins?: number }): string {
  const item = (act: string, title: MessageKey, sub: MessageKey, cls = '', extra = '') => `
    <button class="mode-card ${cls}" data-act="${act}">
      <span class="mode-title">${esc(t(title))}</span>
      <span class="mode-sub">${esc(t(sub))}</span>${extra}
    </button>`;
  const feats: MessageKey[] = ['menu.feat.dribble', 'menu.feat.pass', 'menu.feat.shoot', 'menu.feat.tackle'];
  return `
    <main class="menu screen-enter">
      <div class="menu-top">${coinChip(o.coins ?? 0)}${accountChip(o.account ?? null)}${langSwitch()}</div>
      <div class="menu-card">
        <div class="menu-hero">
          <div class="menu-copy">
            <p class="eyebrow">${esc(t('app.eyebrow'))}</p>
            <h1 class="wordmark" dir="ltr">CHECK<span>LINE</span></h1>
            <p class="tagline">${esc(t('app.tagline'))}</p>
            <p class="pitchline">${esc(t('app.pitchline'))}</p>
            <ul class="feats">${feats.map((k) => `<li>${esc(t(k))}</li>`).join('')}</ul>
          </div>
          ${heroPitch()}
        </div>
        ${o.resume ? `<button class="btn primary resume" data-act="online-resume">${esc(t('menu.resume'))}</button>` : ''}
        <div class="mode-grid">
          ${item('ai-setup', 'menu.vsComputer', 'menu.vsComputer.sub', 'featured')}
          ${item('play-local', 'menu.local', 'menu.local.sub')}
          ${item('online', 'menu.online', o.onlineOk ? 'menu.online.sub' : 'menu.online.off', o.onlineOk ? '' : 'muted-card')}
          ${item('leaderboard', 'menu.leaderboard', o.onlineOk ? 'menu.leaderboard.sub' : 'menu.online.off', o.onlineOk ? '' : 'muted-card')}
          ${item('tutorial', 'menu.tutorial', 'menu.tutorial.sub')}
          <button class="mode-card shop-card" data-act="shop">
            <span class="mode-title">${coinIcon()}${esc(t('menu.shop'))}</span>
            <span class="mode-sub">${esc(t('menu.shop.sub', { n: o.coins ?? 0 }))}</span>
          </button>
          <button class="mode-card ghost" data-act="rules"><span class="mode-title">${esc(t('menu.rules'))}</span></button>
        </div>
        <p class="fine">${esc(t('menu.fine'))}</p>
      </div>
    </main>`;
}

// ------------------------------------------------------------------ AI setup
export function renderAiSetup(o: { difficulty: Difficulty; side: Team | 'random' }): string {
  const levels: Difficulty[] = ['easy', 'medium', 'hard'];
  const bars = { easy: 1, medium: 2, hard: 3 };
  const sides: (Team | 'random')[] = ['A', 'B', 'random'];
  return `
    <main class="page screen-enter">
      <header class="page-head">
        <button class="btn ghost small" data-act="menu">${esc(t('common.back'))}</button>
        ${langSwitch()}
      </header>
      <h1 class="page-title">${esc(t('ai.title'))}</h1>
      <section class="setup">
        <h2 class="section-label" id="diff-label">${esc(t('ai.difficulty'))}</h2>
        <div class="choice-grid" role="radiogroup" aria-labelledby="diff-label">
          ${levels
            .map(
              (d) => `
            <button class="choice ${o.difficulty === d ? 'on' : ''}" role="radio" aria-checked="${o.difficulty === d}" data-act="pick-difficulty" data-value="${d}">
              <span class="choice-head"><span class="choice-title">${esc(t(`ai.${d}` as MessageKey))}</span>
                <span class="meter" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= bars[d] ? 'on' : ''}"></i>`).join('')}</span></span>
              <span class="choice-desc">${esc(t(`ai.${d}.desc` as MessageKey))}</span>
            </button>`,
            )
            .join('')}
        </div>
        <h2 class="section-label" id="side-label">${esc(t('ai.side'))}</h2>
        <div class="segmented" role="radiogroup" aria-labelledby="side-label">
          ${sides
            .map(
              (s) => `<button class="${o.side === s ? 'on' : ''}" role="radio" aria-checked="${o.side === s}" data-act="pick-side" data-value="${s}">
                ${s === 'random' ? '' : `<span class="team-dot ${s}"></span>`}${esc(t(s === 'random' ? 'ai.side.random' : (`ai.side.${s}` as MessageKey)))}</button>`,
            )
            .join('')}
        </div>
        <button class="btn primary big" data-act="ai-start">${esc(t('ai.start'))}</button>
      </section>
    </main>`;
}

// ------------------------------------------------------------------ online
export interface ListState {
  loading: boolean;
  error: OnlineError | null;
  items: OnlineMatch[];
}

export type AuthMode = 'login' | 'signup' | 'forgot';

export interface OnlineScreen {
  phase: 'unconfigured' | 'connecting' | 'error' | 'auth' | 'check-email' | 'recovery' | 'profile' | 'lobby' | 'waiting';
  authMode: AuthMode;
  /** Positive message on the auth page (e.g. "reset link sent"). */
  notice: MessageKey | null;
  /** Address the confirmation link was sent to (check-email phase). */
  pendingEmail: string;
  showPassword: boolean;
  session: AuthSession | null;
  problem?: ConfigProblem;
  error: OnlineError | null;
  formError: OnlineError | null;
  busy: string | null;
  profile: OnlineProfile | null;
  renaming: boolean;
  open: ListState;
  mine: ListState;
  waiting: OnlineMatch | null;
  uid: string | null;
  serverSkewMs: number;
}

function head(title: MessageKey): string {
  return `
    <header class="page-head">
      <button class="btn ghost small" data-act="menu">${esc(t('common.back'))}</button>
      ${langSwitch()}
    </header>
    <h1 class="page-title">${esc(t(title))}</h1>`;
}

function ago(iso: string, skewMs: number): string {
  const mins = Math.floor((Date.now() + skewMs - Date.parse(iso)) / 60000);
  return mins < 1 ? t('online.open.justNow') : t('online.open.ago', { n: mins });
}

export function renderUnconfigured(problem: ConfigProblem, titleKey: MessageKey): string {
  return `
    <main class="page screen-enter">
      ${head(titleKey)}
      <section class="card notice">
        <h2>${esc(t('online.unconfigured.title'))}</h2>
        <p>${esc(t(`online.unconfigured.${problem}` as MessageKey))}</p>
        <p class="muted">${esc(t('online.unconfigured.how'))}</p>
        <p>${esc(t('online.unconfigured.offline'))}</p>
        <div class="row"><button class="btn primary" data-act="ai-setup">${esc(t('menu.vsComputer'))}</button>
        <button class="btn" data-act="play-local">${esc(t('menu.local'))}</button></div>
      </section>
    </main>`;
}

export function renderOnline(s: OnlineScreen): string {
  if (s.phase === 'unconfigured') return renderUnconfigured(s.problem ?? 'missing', 'online.title');
  if (s.phase === 'connecting') return `<main class="page screen-enter">${head('online.title')}${spinner(t('online.connecting'))}</main>`;
  if (s.phase === 'error')
    return `<main class="page screen-enter">${head('online.title')}
      <section class="card notice error-card" role="alert"><p>${esc(errorText(s.error))}</p>
      <button class="btn primary" data-act="online-retry">${esc(t('common.retry'))}</button></section></main>`;
  if (s.phase === 'auth') return renderAuth(s);
  if (s.phase === 'check-email') return renderCheckEmail(s);
  if (s.phase === 'recovery') return renderRecovery(s);
  if (s.phase === 'profile') return renderProfileStep(s);
  if (s.phase === 'waiting' && s.waiting) return renderWaiting(s, s.waiting);
  return renderLobby(s);
}

function formError(s: OnlineScreen): string {
  return s.formError ? `<p class="form-error" role="alert">${esc(errorText(s.formError))}</p>` : '';
}

// ------------------------------------------------------------------ accounts
function authHead(): string {
  return `
    <header class="page-head">
      <button class="btn ghost small" data-act="menu">${esc(t('common.back'))}</button>
      ${langSwitch()}
    </header>`;
}

function noticeHtml(s: OnlineScreen): string {
  return s.notice ? `<p class="form-notice" role="status">${esc(t(s.notice))}</p>` : '';
}

function busyLabel(s: OnlineScreen, key: string, label: MessageKey): string {
  return `${s.busy === key ? '<span class="spinner sm"></span>' : ''}${esc(t(label))}`;
}

/** Password input with a show / hide toggle. Emails and passwords are always typed left-to-right. */
function passwordField(s: OnlineScreen, id: string, label: MessageKey, autocomplete: string, hint?: MessageKey): string {
  const shown = s.showPassword;
  return `
    <label for="${id}">${esc(t(label))}</label>
    <div class="pw-field">
      <input id="${id}" name="${id}" type="${shown ? 'text' : 'password'}" dir="ltr" autocomplete="${autocomplete}" required minlength="6" maxlength="72"/>
      <button type="button" class="pw-toggle" data-act="toggle-pw" aria-pressed="${shown}" aria-label="${esc(t(shown ? 'auth.hidePassword' : 'auth.showPassword'))}">${esc(t(shown ? 'auth.hide' : 'auth.show'))}</button>
    </div>
    ${hint ? `<p class="field-hint">${esc(t(hint))}</p>` : ''}`;
}

function emailField(): string {
  return `
    <label for="auth-email">${esc(t('auth.email'))}</label>
    <input id="auth-email" name="auth-email" type="email" dir="ltr" inputmode="email" autocomplete="email" required maxlength="254" placeholder="name@example.com"/>`;
}

function renderAuth(s: OnlineScreen): string {
  const mode = s.authMode;
  const tab = (m: AuthMode, label: MessageKey) =>
    `<button type="button" role="tab" class="${mode === m ? 'on' : ''}" aria-selected="${mode === m}" data-act="auth-mode" data-mode="${m}">${esc(t(label))}</button>`;
  let form: string;
  if (mode === 'forgot') {
    form = `
      <form class="form auth-form" data-form="forgot" novalidate>
        <h2>${esc(t('auth.forgot.title'))}</h2>
        <p class="muted">${esc(t('auth.forgot.body'))}</p>
        ${emailField()}
        ${formError(s)}${noticeHtml(s)}
        <button class="btn primary wide" type="submit" ${s.busy ? 'disabled' : ''}>${busyLabel(s, 'forgot', 'auth.forgot.submit')}</button>
        <button type="button" class="link-btn" data-act="auth-mode" data-mode="login">${esc(t('auth.backToLogin'))}</button>
      </form>`;
  } else if (mode === 'signup') {
    form = `
      <form class="form auth-form" data-form="signup" novalidate>
        <label for="auth-name">${esc(t('online.signin.label'))}</label>
        <input id="auth-name" name="auth-name" autocomplete="nickname" required minlength="2" maxlength="24" placeholder="${esc(t('online.signin.placeholder'))}"/>
        ${emailField()}
        ${passwordField(s, 'auth-password', 'auth.password', 'new-password', 'auth.passwordHint')}
        ${passwordField(s, 'auth-password2', 'auth.password2', 'new-password')}
        ${formError(s)}${noticeHtml(s)}
        <button class="btn primary wide" type="submit" ${s.busy ? 'disabled' : ''}>${busyLabel(s, 'signup', 'auth.signup.submit')}</button>
      </form>`;
  } else {
    form = `
      <form class="form auth-form" data-form="login" novalidate>
        ${emailField()}
        ${passwordField(s, 'auth-password', 'auth.password', 'current-password')}
        <button type="button" class="link-btn end" data-act="auth-mode" data-mode="forgot">${esc(t('auth.forgotLink'))}</button>
        ${formError(s)}${noticeHtml(s)}
        <button class="btn primary wide" type="submit" ${s.busy ? 'disabled' : ''}>${busyLabel(s, 'login', 'auth.login.submit')}</button>
      </form>`;
  }
  return `
    <main class="page auth-page screen-enter">
      ${authHead()}
      <section class="auth-card">
        <div class="auth-brand">
          <p class="wordmark small" dir="ltr">CHECK<span>LINE</span></p>
          <p class="muted">${esc(t(mode === 'signup' ? 'auth.signup.lead' : 'auth.login.lead'))}</p>
        </div>
        ${mode === 'forgot' ? '' : `<div class="auth-tabs" role="tablist">${tab('login', 'auth.tab.login')}${tab('signup', 'auth.tab.signup')}</div>`}
        ${form}
        ${
          mode === 'forgot'
            ? ''
            : `<div class="auth-divider"><span>${esc(t('common.or'))}</span></div>
               <button class="btn ghost wide" data-act="auth-guest" ${s.busy ? 'disabled' : ''}>${busyLabel(s, 'guest', 'auth.guest.button')}</button>
               <p class="field-hint center">${esc(t('auth.guest.note'))}</p>`
        }
      </section>
    </main>`;
}

function renderCheckEmail(s: OnlineScreen): string {
  return `
    <main class="page auth-page screen-enter">
      ${authHead()}
      <section class="auth-card center">
        <div class="mail-icon" aria-hidden="true"><svg viewBox="0 0 48 48"><rect x="5" y="11" width="38" height="26" rx="4"/><path d="M7 14 L24 27 L41 14"/></svg></div>
        <h2>${esc(t('auth.check.title'))}</h2>
        <p>${tHtml('auth.check.body', { email: s.pendingEmail })}</p>
        <p class="field-hint center">${esc(t('auth.check.hint'))}</p>
        <button class="btn primary wide" data-act="auth-mode" data-mode="login">${esc(t('auth.backToLogin'))}</button>
      </section>
    </main>`;
}

function renderRecovery(s: OnlineScreen): string {
  return `
    <main class="page auth-page screen-enter">
      ${authHead()}
      <section class="auth-card">
        <form class="form auth-form" data-form="new-password" novalidate>
          <h2>${esc(t('auth.recovery.title'))}</h2>
          <p class="muted">${esc(t('auth.recovery.body'))}</p>
          ${passwordField(s, 'auth-password', 'auth.newPassword', 'new-password', 'auth.passwordHint')}
          ${passwordField(s, 'auth-password2', 'auth.password2', 'new-password')}
          ${formError(s)}
          <button class="btn primary wide" type="submit" ${s.busy ? 'disabled' : ''}>${busyLabel(s, 'recovery', 'auth.recovery.submit')}</button>
        </form>
      </section>
    </main>`;
}

/** First visit after signing in without a profile yet (e.g. guests): pick a display name. */
function renderProfileStep(s: OnlineScreen): string {
  return `
    <main class="page auth-page screen-enter">
      ${authHead()}
      <form class="auth-card form" data-form="profile" novalidate>
        <h2>${esc(t('online.signin.title'))}</h2>
        <p class="muted">${esc(t('online.signin.body'))}</p>
        <label for="online-name">${esc(t('online.signin.label'))}</label>
        <input id="online-name" name="name" maxlength="24" minlength="2" required autocomplete="nickname" placeholder="${esc(t('online.signin.placeholder'))}" value="${esc(s.profile?.displayName ?? s.session?.displayName ?? '')}"/>
        ${formError(s)}
        <button class="btn primary wide" type="submit" ${s.busy ? 'disabled' : ''}>${busyLabel(s, 'profile', 'online.signin.submit')}</button>
        <button type="button" class="link-btn" data-act="logout">${esc(t('auth.logout'))}</button>
      </form>
    </main>`;
}

function matchRow(m: OnlineMatch, s: OnlineScreen, mine: boolean): string {
  const uid = s.uid;
  const opp = m.playerA.id === uid ? m.playerB : m.playerA;
  const myTeam: Team = m.playerA.id === uid ? 'A' : 'B';
  let status = t('online.status.waiting');
  if (m.status === 'active' && m.state) status = m.state.turn === myTeam ? t('online.status.yourTurn') : t('online.status.theirTurn');
  if (m.status === 'active' && m.rulesVersion && m.rulesVersion < 3) status = t('online.status.outdated');
  if (mine) {
    return `<li class="match-row">
      <div><strong>${esc(opp ? t('online.vs', { name: opp.name }) : `#${m.code}`)}</strong>
      <span class="muted small"><span class="team-dot ${myTeam}"></span>${esc(teamName(myTeam))} · ${esc(status)}</span></div>
      <button class="btn small ${m.status === 'active' && m.state?.turn === myTeam ? 'primary' : ''}" data-act="online-open" data-id="${m.id}">${esc(t('online.resume'))}</button></li>`;
  }
  return `<li class="match-row">
    <div><strong>${esc(m.playerA.name)}</strong> <span class="rating-chip" dir="ltr">${m.playerA.rating}</span>
    <span class="muted small">${esc(ago(m.createdAt, s.serverSkewMs))}</span></div>
    <button class="btn small primary" data-act="online-join-open" data-code="${esc(m.code)}" ${s.busy ? 'disabled' : ''}>${esc(t('online.open.join'))}</button></li>`;
}

function listBlock(title: MessageKey, l: ListState, s: OnlineScreen, mine: boolean, empty: MessageKey, extra = ''): string {
  let body: string;
  if (l.loading && !l.items.length) body = `<ul class="match-list">${'<li class="skeleton-row"></li>'.repeat(3)}</ul>`;
  else if (l.error) body = `<p class="form-error" role="alert">${esc(errorText(l.error))}</p>`;
  else if (!l.items.length) body = `<p class="muted empty">${esc(t(empty))}</p>`;
  else body = `<ul class="match-list">${l.items.map((m) => matchRow(m, s, mine)).join('')}</ul>`;
  return `<section class="card"><div class="card-head"><h2>${esc(t(title))}</h2>${extra}</div>${body}</section>`;
}

function renderLobby(s: OnlineScreen): string {
  const p = s.profile!;
  const profileCard = s.renaming
    ? `<form class="card form inline" data-form="rename" novalidate>
        <label for="rename-name">${esc(t('online.signin.label'))}</label>
        <div class="row"><input id="rename-name" name="name" maxlength="24" minlength="2" required value="${esc(p.displayName)}"/>
        <button class="btn primary" type="submit" ${s.busy ? 'disabled' : ''}>${esc(t('online.save'))}</button>
        <button class="btn ghost" type="button" data-act="online-rename-cancel">${esc(t('common.cancel'))}</button></div>
        ${formError(s)}
      </form>`
    : `<section class="card profile-card">
        <div class="profile-main">
          <span class="avatar big" aria-hidden="true">${esc([...p.displayName][0]?.toUpperCase() ?? '?')}</span>
          <div class="profile-text">
            <div class="row"><strong class="profile-name"><bdi>${esc(p.displayName)}</bdi></strong>
            <span class="rating-chip big" dir="ltr">${p.rating}</span>
            <span class="muted">${esc(t('online.record', { w: p.wins, d: p.draws ?? 0, l: p.losses }))}</span></div>
            <span class="small muted account-line">${
              s.session?.isGuest ? esc(t('auth.guestAccount')) : esc(t('auth.signedInAs')) + ` <bdi dir="ltr">${esc(s.session?.email ?? '')}</bdi>`
            }</span>
          </div>
        </div>
        <div class="row">
          <button class="btn ghost small" data-act="online-rename">${esc(t('online.rename'))}</button>
          <button class="btn ghost small" data-act="logout">${esc(t('auth.logout'))}</button>
        </div>
      </section>`;
  return `
    <main class="page lobby screen-enter">
      ${head('online.title')}
      ${profileCard}
      ${!s.renaming ? formError(s) : ''}
      <div class="lobby-grid">
        <section class="card">
          <h2>${esc(t('online.create.title'))}</h2>
          <div class="create-grid">
            <button class="choice" data-act="online-create" data-public="1" ${s.busy ? 'disabled' : ''}>
              <span class="choice-title">${s.busy === 'create-1' ? '<span class="spinner sm"></span>' : ''}${esc(t('online.create.public'))}</span>
              <span class="choice-desc">${esc(t('online.create.public.sub'))}</span></button>
            <button class="choice" data-act="online-create" data-public="0" ${s.busy ? 'disabled' : ''}>
              <span class="choice-title">${s.busy === 'create-0' ? '<span class="spinner sm"></span>' : ''}${esc(t('online.create.private'))}</span>
              <span class="choice-desc">${esc(t('online.create.private.sub'))}</span></button>
          </div>
          <form class="form join" data-form="join">
            <label for="join-code">${esc(t('online.join.title'))}</label>
            <div class="row"><input id="join-code" name="code" dir="ltr" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${esc(t('online.join.placeholder'))}"/>
            <button class="btn primary" type="submit" ${s.busy ? 'disabled' : ''}>${s.busy === 'join' ? '<span class="spinner sm"></span>' : ''}${esc(t('online.join.submit'))}</button></div>
          </form>
        </section>
        ${listBlock('online.mine.title', s.mine, s, true, 'online.mine.empty')}
        ${listBlock('online.open.title', s.open, s, false, 'online.open.empty', `<button class="btn ghost small" data-act="online-refresh">${esc(t('online.refresh'))}</button>`)}
      </div>
    </main>`;
}

function renderWaiting(s: OnlineScreen, m: OnlineMatch): string {
  return `
    <main class="page screen-enter">
      ${head('online.title')}
      <section class="card waiting-card">
        <h2>${esc(t('online.waiting.title'))}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></h2>
        <p class="muted">${esc(t('online.waiting.body'))}</p>
        <div class="code" dir="ltr" id="invite-code" tabindex="0" aria-label="${esc(t('online.join.label'))}">${esc(m.code)}</div>
        <p class="small muted">${esc(t(m.isPublic ? 'online.waiting.public' : 'online.waiting.private'))}</p>
        ${formError(s)}
        <div class="row center">
          <button class="btn primary" data-act="online-copy">${esc(t('online.waiting.copy'))}</button>
          <button class="btn ghost" data-act="online-cancel" ${s.busy ? 'disabled' : ''}>${esc(t('online.waiting.cancel'))}</button>
        </div>
      </section>
    </main>`;
}

// ------------------------------------------------------------------ leaderboard
export interface LeaderboardScreen {
  configured: boolean;
  problem?: ConfigProblem;
  loading: boolean;
  error: OnlineError | null;
  data: LeaderboardPage | null;
  page: number;
  pageSize: number;
  uid: string | null;
}

export function renderLeaderboard(s: LeaderboardScreen): string {
  if (!s.configured) return renderUnconfigured(s.problem ?? 'missing', 'lb.title');
  const pages = Math.max(1, Math.ceil((s.data?.total ?? 0) / s.pageSize));
  let body: string;
  if (s.loading && !s.data) {
    body = `<div class="table-wrap"><table class="lb"><tbody>${'<tr class="skeleton"><td colspan="6"><span></span></td></tr>'.repeat(6)}</tbody></table></div>`;
  } else if (s.error) {
    body = `<div class="card notice error-card" role="alert"><p>${esc(t('lb.error'))} ${esc(errorText(s.error))}</p>
      <button class="btn primary" data-act="lb-retry">${esc(t('common.retry'))}</button></div>`;
  } else if (!s.data || !s.data.rows.length) {
    body = `<p class="card empty muted">${esc(t('lb.empty'))}</p>`;
  } else {
    const rows = s.data.rows
      .map(
        (r) => `<tr class="${r.id === s.uid ? 'me' : ''} ${r.rank <= 3 ? 'podium p' + r.rank : ''}">
          <td class="num rank">${r.rank}</td>
          <td class="name"><bdi>${esc(r.displayName)}</bdi>${r.id === s.uid ? ` <span class="you-chip">${esc(t('lb.you'))}</span>` : ''}</td>
          <td class="num rating">${r.rating}</td><td class="num">${r.wins}</td><td class="num">${r.draws ?? 0}</td><td class="num">${r.losses}</td></tr>`,
      )
      .join('');
    body = `
      <div class="table-wrap ${s.loading ? 'is-loading' : ''}">
        <table class="lb">
          <thead><tr><th scope="col" class="num">${esc(t('lb.rank'))}</th><th scope="col">${esc(t('lb.player'))}</th>
          <th scope="col" class="num">${esc(t('lb.rating'))}</th><th scope="col" class="num"><abbr title="${esc(t('lb.winsFull'))}">${esc(t('lb.wins'))}</abbr></th>
          <th scope="col" class="num"><abbr title="${esc(t('lb.drawsFull'))}">${esc(t('lb.draws'))}</abbr></th>
          <th scope="col" class="num"><abbr title="${esc(t('lb.lossesFull'))}">${esc(t('lb.losses'))}</abbr></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <nav class="pager" aria-label="${esc(t('lb.page', { page: s.page + 1, pages }))}">
        <button class="btn small" data-act="lb-prev" ${s.page <= 0 || s.loading ? 'disabled' : ''}>${esc(t('lb.prev'))}</button>
        <span class="muted">${esc(t('lb.page', { page: s.page + 1, pages }))}</span>
        <button class="btn small" data-act="lb-next" ${s.page + 1 >= pages || s.loading ? 'disabled' : ''}>${esc(t('lb.next'))}</button>
      </nav>`;
  }
  const me = s.data?.me ? `<p class="my-rank">${tHtml('lb.yourRank', { rank: s.data.me.rank, total: s.data.total })}</p>` : '';
  return `
    <main class="page screen-enter">
      ${head('lb.title')}
      <p class="muted explain">${esc(t('lb.explain'))}</p>
      ${me}
      ${body}
    </main>`;
}

// ------------------------------------------------------------------ shop
/** Mini pitch showing a floor theme (uses the same CSS variables as the real pitch). */
function floorPreview(id: string): string {
  return `<div class="floor-preview theme-floor-${id}" aria-hidden="true">
      <div class="fp-net"></div>
      <div class="fp-grid">${'<i></i>'.repeat(24)}</div>
      <svg class="fp-lines" viewBox="0 0 6 4" preserveAspectRatio="none"><rect x="1" y="0.04" width="4" height="1.2" vector-effect="non-scaling-stroke"/><line x1="0" y1="3.96" x2="6" y2="3.96" vector-effect="non-scaling-stroke"/><circle cx="3" cy="4" r="1" vector-effect="non-scaling-stroke"/></svg>
    </div>`;
}

/** Two sample pieces (one per team) wearing a skin. */
function skinPreview(id: string): string {
  return `<div class="skin-preview theme-skin-${id}" aria-hidden="true">
      <div class="token team-A kind-queen carrier">${pieceSvg('queen')}<span class="ball">${BALL_SVG}</span></div>
      <div class="token team-B kind-knight">${pieceSvg('knight')}</div>
    </div>`;
}

function shopCard(w: Wallet, it: ShopItem): string {
  const has = owns(w, it.kind, it.id);
  const on = equipped(w, it.kind) === it.id;
  const affordable = w.coins >= it.price;
  const name = t(`${it.kind}.${it.id}.name` as MessageKey);
  let button: string;
  if (on) button = `<button class="btn small equipped-btn" disabled>✓ ${esc(t('shop.equipped'))}</button>`;
  else if (has) button = `<button class="btn small" data-act="shop-item" data-kind="${it.kind}" data-id="${it.id}">${esc(t('shop.equip'))}</button>`;
  else if (affordable)
    button = `<button class="btn small primary" data-act="shop-item" data-kind="${it.kind}" data-id="${it.id}">${esc(t('shop.unlock'))} · ${coinIcon()}<span dir="ltr">${it.price}</span></button>`;
  else button = `<button class="btn small" disabled><span aria-hidden="true">🔒</span> ${esc(t('shop.need', { n: it.price }))}</button>`;
  const tag = on ? 'equipped' : has ? 'owned' : 'locked';
  const tagText = on ? t('shop.equipped') : has ? (it.price === 0 ? t('shop.free') : t('shop.owned')) : '';
  return `
    <article class="shop-item ${tag}" aria-label="${esc(name)}">
      ${it.kind === 'floor' ? floorPreview(it.id) : skinPreview(it.id)}
      <div class="shop-info">
        <div class="shop-name"><strong>${esc(name)}</strong>${tagText ? `<span class="shop-tag">${esc(tagText)}</span>` : `<span class="price">${coinIcon()}<span dir="ltr">${it.price}</span></span>`}</div>
        <p class="muted small">${esc(t(`${it.kind}.${it.id}.desc` as MessageKey))}</p>
      </div>
      ${button}
    </article>`;
}

export function renderShop(w: Wallet): string {
  const toNext = MATCHES_PER_BONUS - (w.matches % MATCHES_PER_BONUS);
  const pips = Array.from({ length: MATCHES_PER_BONUS }, (_, i) => `<i class="${i < MATCHES_PER_BONUS - toNext ? 'on' : ''}"></i>`).join('');
  const section = (kind: 'floor' | 'skin', title: MessageKey) => `
      <h2 class="section-label">${esc(t(title))}</h2>
      <div class="shop-grid">${SHOP_ITEMS.filter((i) => i.kind === kind).map((i) => shopCard(w, i)).join('')}</div>`;
  return `
    <main class="page shop screen-enter">
      ${head('shop.title')}
      <section class="card wallet-card">
        <div class="wallet-balance">${coinIcon()}<strong dir="ltr">${w.coins}</strong><span class="muted">${esc(t('shop.coins'))}</span></div>
        <div class="wallet-earn">
          <p class="small">${esc(t('shop.earn', { win: WIN_BONUS, bonus: MATCH_BONUS, every: MATCHES_PER_BONUS }))}</p>
          <div class="bonus-meter" aria-label="${esc(t('shop.nextBonus', { n: toNext }))}"><span class="pips">${pips}</span><span class="small muted">${esc(t('shop.nextBonus', { n: toNext }))}</span></div>
        </div>
      </section>
      ${section('floor', 'shop.floors')}
      ${section('skin', 'shop.skins')}
      <p class="fine">${esc(t('shop.note'))}</p>
    </main>`;
}
