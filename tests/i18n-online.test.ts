import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { catalogProblems, eventText, reasonText, setLang, t } from '../src/i18n/index.js';
import { en } from '../src/i18n/en.js';
import { ar } from '../src/i18n/ar.js';
import { parseOnlineConfig, looksSecret } from '../src/online/config.js';
import { toOnlineError, myTeamIn, type OnlineMatch } from '../src/online/backend.js';
import { fromWire, toWire } from '../src/online/wire.js';
import { applyAction, createMatch, parseSquare, type ReasonCode } from '../src/rules/index.js';
import { LESSONS } from '../src/tutorial/lessons.js';

const REASONS: ReasonCode[] = [
  'unknown_piece', 'match_over', 'not_your_turn', 'captured', 'no_ap', 'occupied_own', 'opponent_blocks', 'path_blocked',
  'pawn_tackle', 'keeper_box', 'goal_mouth', 'covered_by_keeper', 'cannot_reach', 'only_carrier', 'not_in_line',
  'pass_out_of_range', 'pass_lane_blocked', 'pass_invalid_receiver', 'receiver_marked', 'shot_out_of_range',
  'shot_blocked', 'shot_not_goal', 'no_surge', 'unknown_action',
];

describe('localization', () => {
  test('Arabic catalog covers every English key with the same placeholders', () => {
    assert.deepEqual(catalogProblems(), []);
    assert.equal(Object.keys(ar).length, Object.keys(en).length);
  });

  test('every rule reason and tutorial lesson has text in both languages', () => {
    for (const lang of ['en', 'ar'] as const) {
      const cat = lang === 'en' ? en : ar;
      for (const r of REASONS) assert.ok((cat as Record<string, string>)[`reason.${r}`], `${lang} reason.${r}`);
      for (const l of LESSONS) for (const part of ['title', 'task', 'tip', 'success']) assert.ok((cat as Record<string, string>)[`lesson.${l.id}.${part}`], `${lang} lesson.${l.id}.${part}`);
    }
  });

  test('Arabic strings are actually Arabic (no untranslated English left behind)', () => {
    const allowLatin = new Set(['app.name', 'lang.en', 'online.profile']);
    const untranslated = Object.entries(ar).filter(([k, v]) => !allowLatin.has(k) && !/[؀-ۿ]/.test(v) && !/^[\s{}\w·:.,()#–-]*$/.test(v));
    assert.deepEqual(untranslated, []);
    const sameAsEnglish = Object.keys(en).filter((k) => !allowLatin.has(k) && (en as Record<string, string>)[k] === (ar as Record<string, string>)[k] && /[a-z]{3}/i.test((en as Record<string, string>)[k]));
    assert.deepEqual(sameAsEnglish, []);
  });

  test('reasons and events translate with parameters in both languages', () => {
    const s = createMatch({ firstTeam: 'A' });
    const r = applyAction(s, { type: 'move', pieceId: 'A-R1', to: parseSquare('E3') });
    assert.ok(!r.ok);
    setLang('en');
    const enText = reasonText(r.ok ? (null as never) : r.why);
    setLang('ar');
    const arText = reasonText(r.ok ? (null as never) : r.why);
    assert.ok(enText.length > 0 && arText.length > 0 && enText !== arText);
    assert.match(arText, /[؀-ۿ]/);
    const moved = applyAction(s, { type: 'move', pieceId: 'A-Q', to: parseSquare('D7') });
    assert.ok(moved.ok);
    const line = eventText(moved.events[0], (id) => s.pieces.find((p) => p.id === id));
    assert.match(line, /وزير/);
    assert.match(line, /D6/);
    assert.equal(t('ov.reason.goals', { n: 3 }), 'أول من يسجل 3 أهداف');
    assert.equal(eventText({ type: 'fullTime', winner: null }, () => undefined), 'نهاية المباراة: تعادل');
    setLang('en');
    assert.equal(t('ov.reason.goals', { n: 3 }), 'First to 3 goals');
    assert.equal(eventText({ type: 'surge', team: 'B' }, () => undefined), 'Ebony surges: +1 AP');
  });
});

describe('online configuration', () => {
  const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.y`;

  test('missing or placeholder settings disable online play', () => {
    assert.deepEqual(parseOnlineConfig(undefined), { ok: false, problem: 'missing' });
    assert.deepEqual(parseOnlineConfig({ supabaseUrl: 'https://x.supabase.co' }), { ok: false, problem: 'missing' });
    assert.deepEqual(
      parseOnlineConfig({ supabaseUrl: 'https://your-project-ref.supabase.co', supabaseAnonKey: 'your-anon-or-publishable-key' }),
      { ok: false, problem: 'placeholder' },
    );
    assert.deepEqual(parseOnlineConfig({ supabaseUrl: 'not a url', supabaseAnonKey: 'abc' }), { ok: false, problem: 'bad_url' });
  });

  test('secret keys are refused in the browser', () => {
    assert.ok(looksSecret('sb_secret_123'));
    assert.ok(looksSecret(jwt('service_role')));
    assert.ok(!looksSecret(jwt('anon')));
    assert.deepEqual(parseOnlineConfig({ supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: jwt('service_role') }), { ok: false, problem: 'secret_key' });
  });

  test('valid public settings are accepted (anon JWT or publishable key)', () => {
    const a = parseOnlineConfig({ supabaseUrl: 'https://abc.supabase.co/', supabaseAnonKey: jwt('anon') });
    assert.ok(a.ok && a.config.supabaseUrl === 'https://abc.supabase.co' && /supabase-js@2\./.test(a.config.supabaseJsUrl));
    assert.ok(parseOnlineConfig({ supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: 'sb_publishable_abc' }).ok);
    // A pasted REST endpoint is reduced to the project URL.
    const rest = parseOnlineConfig({ supabaseUrl: 'https://abc.supabase.co/rest/v1/', supabaseAnonKey: 'sb_publishable_abc' });
    assert.ok(rest.ok && rest.config.supabaseUrl === 'https://abc.supabase.co');
  });

  test('server errors map to translatable codes', () => {
    assert.equal(toOnlineError({ message: 'CL:stale_state' }).code, 'stale_state');
    const illegal = toOnlineError({ message: 'CL:illegal:no_ap' });
    assert.equal(illegal.code, 'illegal');
    assert.equal(illegal.detail, 'no_ap');
    assert.equal(toOnlineError(new Error('Failed to fetch')).code, 'network');
    assert.equal(toOnlineError({ message: 'Anonymous sign-ins are disabled' }).code, 'anonymous_disabled');
    // Supabase Auth errors (by code on newer servers, by message on older ones).
    assert.equal(toOnlineError({ code: 'invalid_credentials', message: 'Invalid login credentials' }).code, 'invalid_credentials');
    assert.equal(toOnlineError({ message: 'Invalid login credentials' }).code, 'invalid_credentials');
    assert.equal(toOnlineError({ message: 'Email not confirmed' }).code, 'email_not_confirmed');
    assert.equal(toOnlineError({ message: 'User already registered' }).code, 'email_taken');
    assert.equal(toOnlineError({ code: 'weak_password', message: 'Password should be at least 6 characters.' }).code, 'weak_password');
    assert.equal(toOnlineError({ message: 'For security purposes, you can only request this after 42 seconds.' }).code, 'rate_limited');
    assert.equal(toOnlineError({ code: 'otp_expired', message: 'Email link is invalid or has expired' }).code, 'link_expired');
    assert.equal(toOnlineError({ message: 'Email address not authorized' }).code, 'email_not_authorized');
    for (const code of ['stale_state', 'illegal', 'network', 'anonymous_disabled', 'match_not_found', 'invalid_credentials', 'email_not_confirmed',
      'email_taken', 'weak_password', 'invalid_email', 'password_mismatch', 'same_password', 'rate_limited', 'signup_disabled', 'email_disabled', 'link_expired', 'email_not_authorized', 'name_taken']) {
      assert.ok((en as Record<string, string>)[`online.err.${code}`] && (ar as Record<string, string>)[`online.err.${code}`]);
    }
  });

  test('match state survives the trip to the server format and back', () => {
    let s = createMatch({ firstTeam: 'B' });
    s = applyAction(s, { type: 'move', pieceId: 'B-Q', to: parseSquare('D6') }).state;
    s = applyAction(s, { type: 'surge' }).state;
    assert.equal(s.surge.B, false);
    const back = fromWire(JSON.parse(JSON.stringify(toWire(s))));
    assert.deepEqual(toWire(back), toWire(s));
    assert.throws(() => fromWire({ pieces: 'nope' }));
  });

  test('every tutorial lesson starts unsolved and has a legal solution path', () => {
    for (const l of LESSONS) {
      const s = l.setup();
      assert.equal(l.check([], s), false, l.id);
    }
  });

  test('player team is derived from the match', () => {
    const m = { playerA: { id: 'u1' }, playerB: { id: 'u2' } } as unknown as OnlineMatch;
    assert.equal(myTeamIn(m, 'u1'), 'A');
    assert.equal(myTeamIn(m, 'u2'), 'B');
    assert.equal(myTeamIn(m, 'u3'), null);
  });
});
