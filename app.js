import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { CONFIG } from './config.js';
import { Voice } from './voice.js';

// ═══════════════════════════ Основа ═══════════════════════════

const tg = window.Telegram?.WebApp;
const inTelegram = !!tg?.initData;
const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mafia-auth' },
});

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

const ROLES = {
  civilian: { name: 'Мирный житель', emoji: '🧑‍🌾', team: 'town', text: 'Днём вычисляйте мафию и голосуйте против неё. Ночью вы спите.' },
  mafia: { name: 'Мафия', emoji: '🕶', team: 'mafia', text: 'Ночью вместе с союзниками выбирайте жертву. Днём притворяйтесь мирным.' },
  don: { name: 'Дон мафии', emoji: '🎩', team: 'mafia', text: 'Глава мафии. Голосуете за жертву (при равенстве решает ваш голос) и ищете Комиссара.' },
  commissar: { name: 'Комиссар', emoji: '🔎', team: 'town', text: 'Каждую ночь проверяйте одного игрока — узнаете, мафия он или нет.' },
  doctor: { name: 'Доктор', emoji: '💉', team: 'town', text: 'Каждую ночь лечите одного игрока — если его хотели убить, он выживет. Одного и того же — не две ночи подряд.' },
  maniac: { name: 'Маньяк', emoji: '🔪', team: 'maniac', text: 'Играете сами за себя. Каждую ночь убиваете одного. Побеждаете, если останетесь последним.' },
  lover: { name: 'Любовница', emoji: '💋', team: 'town', text: 'Каждую ночь приходите к игроку — этой ночью он не сможет сделать свой ход.' },
};

const ACTIONS = {
  kill: { label: 'Убить', prompt: 'Выберите жертву', icon: '🔫' },
  don_check: { label: 'Искать комиссара', prompt: 'Кого проверить на комиссара?', icon: '🔍' },
  check: { label: 'Проверить', prompt: 'Кого проверить?', icon: '🔎' },
  heal: { label: 'Лечить', prompt: 'Кого лечить этой ночью?', icon: '💉' },
  maniac: { label: 'Убить', prompt: 'Кого убить этой ночью?', icon: '🔪' },
  lover: { label: 'Навестить', prompt: 'К кому пойти этой ночью?', icon: '💋' },
};
const ROLE_ACTIONS = { mafia: ['kill'], don: ['kill', 'don_check'], commissar: ['check'], doctor: ['heal'], maniac: ['maniac'], lover: ['lover'] };

const S = {
  user: null,
  profile: null,
  serverOffset: 0, // серверное время − моё
  screen: 'loading',
  rooms: [],
  room: null,
  players: [],
  events: [],
  chat: [],
  votes: [],
  role: null,
  team: [],
  teamVotes: [],
  myActions: {},
  actionTab: null,
  chatTab: 'all',
  voice: null,
  micOn: true,
  lastPhaseKey: '',
  shownRoleFor: null,
  tickBusy: false,
  createSettings: null,
};
let roomChannel = null;
let homeChannel = null;
let pingTimer = null;
let clockTimer = null;
let teamTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + S.serverOffset;

function toast(text, ms = 2600) {
  $toast.textContent = text;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), ms);
}

function haptic(kind = 'light') {
  try {
    if (kind === 'success' || kind === 'error' || kind === 'warning') tg?.HapticFeedback?.notificationOccurred(kind);
    else tg?.HapticFeedback?.impactOccurred(kind);
  } catch {}
}

// Короткие звуки на смену фаз (без файлов — синтезируем).
let audioCtx;
function beep(type) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const notes = { night: [392, 330, 262], day: [523, 659, 784], vote: [440, 440], end: [523, 659, 784, 1046], death: [220, 165] }[type] || [440];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.16 + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + i * 0.16);
      o.stop(audioCtx.currentTime + i * 0.16 + 0.32);
    });
  } catch {}
}

function errText(e) {
  const m = String(e?.message || e || '');
  const map = {
    'room not found': 'Комната не найдена — проверьте код',
    'game in progress': 'Игра уже идёт — дождитесь следующей',
    'room is full': 'Комната заполнена',
    'need at least 4 players': 'Нужно минимум 4 игрока',
    'not allowed': 'Это может только создатель комнаты',
    'not night': 'Сейчас не ночь',
    'not voting': 'Голосование ещё не началось',
    'you are dead': 'Вы выбыли из игры',
    'bad target': 'Этот игрок уже выбыл',
    'not yourself': 'Нельзя выбрать себя',
    'not your action': 'У вашей роли нет такого хода',
    'same heal twice': 'Нельзя лечить одного и того же две ночи подряд',
    'not now': 'Сейчас писать в общий чат нельзя',
  };
  for (const [k, v] of Object.entries(map)) if (m.includes(k)) return v;
  return m || 'Ошибка';
}

async function rpc(name, params) {
  const { data, error } = await sb.rpc(name, params);
  if (error) throw error;
  return data;
}

function avatar(p, cls = '') {
  const name = p?.name || '?';
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const img = p?.photo ? `<img src="${esc(p.photo)}" alt="" onerror="this.remove()">` : '';
  return `<div class="avatar ${cls}" style="background:hsl(${hue} 45% 38%)">${esc(name[0]?.toUpperCase() || '?')}${img}</div>`;
}

function inviteLink(code) {
  if (CONFIG.botUsername && !CONFIG.botUsername.includes('ВАШ')) {
    return `https://t.me/${CONFIG.botUsername}/${CONFIG.appName}?startapp=${code}`;
  }
  return `${location.origin}${location.pathname}?room=${code}`;
}

// ═══════════════════════════ Вход ═══════════════════════════

async function login() {
  if (inTelegram) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor?.('#0d0b0e');
      tg.setBackgroundColor?.('#0d0b0e');
      tg.disableVerticalSwipes?.();
    } catch {}
    // уже вошли этим же аккаунтом Telegram — повторно не входим
    const { data: cur } = await sb.auth.getSession();
    const tgId = tg.initDataUnsafe?.user?.id;
    const same = cur.session && tgId && Number(cur.session.user?.user_metadata?.tg_id) === Number(tgId);
    if (!same) {
      const r = await fetch(`${CONFIG.supabaseUrl}/functions/v1/tg-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: CONFIG.supabaseKey },
        body: JSON.stringify({ initData: tg.initData }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error(j.error || `Вход не удался (${r.status})`);
      const { error } = await sb.auth.setSession({ access_token: j.access_token, refresh_token: j.refresh_token });
      if (error) throw error;
    }
  } else {
    // открыто в браузере по кнопке из Telegram: сессия передана в адресе
    const hash = new URLSearchParams(location.hash.slice(1));
    const rt = hash.get('rt');
    if (rt) {
      history.replaceState(null, '', location.pathname + location.search);
      const { error } = await sb.auth.refreshSession({ refresh_token: rt });
      if (error) throw error;
    }
  }
  const { data } = await sb.auth.getSession();
  S.user = data.session?.user || null;
  if (!S.user) return false;
  S.profile = await rpc('mafia_my_profile');
  const t = await rpc('mafia_now');
  S.serverOffset = new Date(t).getTime() - Date.now();
  return true;
}

async function boot() {
  try {
    const ok = await login();
    if (!ok) {
      renderNoAuth();
      return;
    }
  } catch (e) {
    $app.innerHTML = `<div class="center"><div><h2>Не удалось войти</h2><p class="muted">${esc(errText(e))}</p>
      <button class="btn primary" onclick="location.reload()">Повторить</button></div></div>`;
    return;
  }
  const startCode = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('room');
  if (startCode) {
    await joinRoom(startCode);
    return;
  }
  // вернуться в игру после перезапуска
  try {
    const cur = await rpc('mafia_current_room');
    if (cur) {
      await joinRoom(cur, true);
      return;
    }
  } catch {}
  showHome();
}

function renderNoAuth() {
  const link = CONFIG.botUsername && !CONFIG.botUsername.includes('ВАШ') ? `https://t.me/${CONFIG.botUsername}/${CONFIG.appName}` : null;
  $app.innerHTML = `<div class="center"><div>
    <div style="font-size:72px">🎩</div><h1>Мафия</h1>
    <p style="color:var(--muted)">Игра открывается через Telegram.</p>
    ${link ? `<a class="btn primary" href="${link}">Открыть в Telegram</a>` : ''}
  </div></div>`;
}

// ═══════════════════════════ Главная ═══════════════════════════

async function showHome() {
  leaveRoomChannels();
  S.screen = 'home';
  S.room = null;
  tg?.BackButton?.hide();
  renderHome();
  await refreshRooms();
  homeChannel?.unsubscribe();
  homeChannel = sb
    .channel('mafia-home')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mafia_rooms' }, () => refreshRooms())
    .subscribe();
  clearInterval(pingTimer);
  pingTimer = setInterval(() => S.screen === 'home' && refreshRooms(), 15000);
}

async function refreshRooms() {
  try {
    S.rooms = (await rpc('mafia_public_rooms')) || [];
  } catch {
    S.rooms = [];
  }
  if (S.screen === 'home') renderHome();
}

function renderHome() {
  const p = S.profile || {};
  const rooms = S.rooms
    .map(
      (r) => `<button class="room-item" data-act="join" data-code="${esc(r.code)}">
        <div style="font-size:28px">🎲</div>
        <div><div class="t">${esc(r.title)}</div><div class="s">Ведёт: ${esc(r.host_name || '—')} · ${rolesLine(r.roles)}</div></div>
        <div class="n">${r.players}/${r.max_players}</div></button>`,
    )
    .join('');
  $app.innerHTML = `<div class="screen">
    <div class="hero"><h1>МАФИЯ</h1><p>Город засыпает… Просыпается мафия.</p><div class="hat">🎩</div></div>
    <div class="me">${avatar(p, 'big')}
      <div><b>${esc(p.name || 'Игрок')}</b><div class="stats">Игр: ${p.games || 0} · Побед: ${p.wins || 0}${p.games ? ` · ${Math.round(((p.wins || 0) * 100) / p.games)}%` : ''}</div></div>
    </div>
    <div class="row">
      <button class="btn primary" data-act="create">＋ Создать комнату</button>
      <button class="btn" data-act="enter-code">🔑 По коду</button>
    </div>
    <div class="section-title"><h3>Открытые комнаты</h3><button class="btn small ghost" data-act="refresh">Обновить</button></div>
    <div class="rooms">${rooms || '<div class="empty">Пока никто не ждёт игроков.<br>Создайте свою комнату и позовите друзей!</div>'}</div>
    <div class="section-title"><h3>Как играть</h3></div>
    <button class="btn block ghost" data-act="rules">📖 Правила и роли</button>
  </div>`;
}

function rolesLine(s) {
  if (!s) return 'классика';
  const extra = [];
  if (s.maniac) extra.push('маньяк');
  if (s.lover) extra.push('любовница');
  return extra.length ? `классика + ${extra.join(', ')}` : 'классика';
}

function showRules() {
  openModal(`<div class="sheet rules">
    <h2>Правила</h2>
    <p>Игроки делятся на <b>мирных</b> и <b>мафию</b>. Каждый знает только свою роль (мафиози знают друг друга).</p>
    <p>🌙 <b>Ночь.</b> Все микрофоны выключены. Мафия тайно выбирает жертву, Комиссар проверяет игрока, Доктор лечит, остальные спят.</p>
    <p>☀️ <b>День.</b> Ведущий объявляет, кто погиб. Живые обсуждают голосом, кто мафия.</p>
    <p>🗳 <b>Голосование.</b> Каждый живой голосует против одного игрока. Больше всего голосов — игрок выбывает (при равенстве никто). У выбывшего — последнее слово.</p>
    <p>🏆 <b>Победа.</b> Мирные — когда вся мафия выбыла. Мафия — когда её не меньше, чем остальных.</p>
    <h3 style="margin-top:14px">Роли</h3>
    ${Object.values(ROLES).map((r) => `<p>${r.emoji} <b>${r.name}</b> — ${r.text}</p>`).join('')}
    <button class="btn primary block" data-act="close-modal" style="margin-top:12px">Понятно</button>
  </div>`);
}

// ═══════════════════════════ Создание комнаты ═══════════════════════════

function showCreate() {
  S.screen = 'create';
  S.createSettings ??= { title: `Комната ${S.profile?.name || ''}`.trim(), public: true, don: true, doctor: true, commissar: true, maniac: false, lover: false, reveal: true, day: 120, night: 40, vote: 30, max: 12 };
  tg?.BackButton?.show();
  renderCreate();
}

function renderCreate() {
  const c = S.createSettings;
  const tog = (key, title, sub) => `<div class="toggle" data-act="toggle" data-key="${key}"><div>${title}${sub ? `<small>${sub}</small>` : ''}</div><div class="switch ${c[key] ? 'on' : ''}"></div></div>`;
  const chips = (key, values, fmt) =>
    `<div class="chips">${values.map((v) => `<button class="chip ${c[key] === v ? 'on' : ''}" data-act="set" data-key="${key}" data-val="${v}">${fmt(v)}</button>`).join('')}</div>`;
  $app.innerHTML = `<div class="screen">
    <div class="section-title" style="margin-top:4px"><h3>Новая комната</h3><button class="btn small ghost" data-act="home">Назад</button></div>
    <label class="field"><span>Название</span><input class="input" id="room-title" maxlength="40" value="${esc(c.title)}"></label>
    ${tog('public', 'Публичная комната', 'Видна всем в списке «Открытые комнаты»')}
    <div class="section-title"><h3>Роли</h3></div>
    ${tog('don', '🎩 Дон мафии', 'Глава мафии, ищет комиссара')}
    ${tog('commissar', '🔎 Комиссар', 'Проверяет игроков ночью')}
    ${tog('doctor', '💉 Доктор', 'Лечит ночью (от 5 игроков)')}
    ${tog('maniac', '🔪 Маньяк', 'Убивает сам по себе (от 7 игроков)')}
    ${tog('lover', '💋 Любовница', 'Блокирует ход игрока (от 7 игроков)')}
    ${tog('reveal', 'Показывать роль убитого', 'Классика: роль открывается после смерти')}
    <div class="section-title"><h3>Время</h3></div>
    <label class="field"><span>Обсуждение днём</span>${chips('day', [60, 120, 180, 300], (v) => (v < 120 ? `${v} с` : `${v / 60} мин`))}</label>
    <label class="field"><span>Ночь</span>${chips('night', [30, 40, 60], (v) => `${v} с`)}</label>
    <label class="field"><span>Голосование</span>${chips('vote', [20, 30, 45], (v) => `${v} с`)}</label>
    <label class="field"><span>Игроков максимум</span>${chips('max', [6, 8, 10, 12, 16], (v) => v)}</label>
    <button class="btn primary block" data-act="create-go" style="margin-top:10px">Создать</button>
  </div>`;
}

async function createRoom() {
  const c = S.createSettings;
  c.title = document.getElementById('room-title')?.value || c.title;
  const { title, public: isPublic, ...settings } = c;
  try {
    const code = await rpc('mafia_create', { p_title: title, p_public: isPublic, p_settings: settings });
    await joinRoom(code);
  } catch (e) {
    toast(errText(e));
  }
}

function askCode() {
  openModal(`<div class="sheet">
    <h2>Войти по коду</h2>
    <input class="input" id="code-input" maxlength="5" placeholder="Например: K7Q2M" style="text-transform:uppercase;font-size:22px;letter-spacing:4px;text-align:center">
    <div class="row" style="margin-top:12px"><button class="btn" data-act="close-modal">Отмена</button><button class="btn primary" data-act="code-go">Войти</button></div>
  </div>`);
  setTimeout(() => document.getElementById('code-input')?.focus(), 50);
}

// ═══════════════════════════ Комната ═══════════════════════════

async function joinRoom(code, silent = false) {
  try {
    const rid = await rpc('mafia_join', { p_code: code });
    closeModal();
    await openRoom(rid);
  } catch (e) {
    if (!silent) toast(errText(e));
    showHome();
  }
}

function leaveRoomChannels() {
  if (roomChannel) sb.removeChannel(roomChannel);
  roomChannel = null;
  homeChannel?.unsubscribe();
  homeChannel = null;
  clearInterval(pingTimer);
  clearInterval(clockTimer);
  clearInterval(teamTimer);
  S.voice?.stop();
  S.voice = null;
}

async function openRoom(rid) {
  leaveRoomChannels();
  S.screen = 'room';
  S.events = [];
  S.chat = [];
  S.role = null;
  S.team = [];
  S.myActions = {};
  S.lastPhaseKey = '';
  tg?.BackButton?.show();
  await loadRoom(rid);
  await Promise.all([loadPlayers(), loadEvents(), loadChat(), loadVotes(), loadSecret()]);
  S.lastPhaseKey = phaseKey();
  roomChannel = sb
    .channel(`room:${rid}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mafia_rooms', filter: `id=eq.${rid}` }, () => onRoomChange())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mafia_players', filter: `room_id=eq.${rid}` }, () => loadPlayers().then(renderRoom))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mafia_votes', filter: `room_id=eq.${rid}` }, () => loadVotes().then(renderRoom))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mafia_events', filter: `room_id=eq.${rid}` }, (p) => onEvent(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mafia_chat', filter: `room_id=eq.${rid}` }, (p) => onChat(p.new))
    .subscribe((status) => {
      // после переподключения — догружаем всё
      if (status === 'SUBSCRIBED') refreshAll();
    });
  pingTimer = setInterval(() => {
    rpc('mafia_ping', { p_room: rid }).catch(() => {});
    loadPlayers().then(renderRoom);
  }, 20000);
  rpc('mafia_ping', { p_room: rid }).catch(() => {});
  clockTimer = setInterval(clock, 500);
  teamTimer = setInterval(() => {
    if (S.room?.phase === 'night' && isMafia()) loadTeamVotes().then(renderRoom);
  }, 3000);
  renderRoom();
}

async function refreshAll() {
  if (!S.room) return;
  await loadRoom(S.room.id);
  await Promise.all([loadPlayers(), loadEvents(), loadChat(), loadVotes(), loadSecret()]);
  renderRoom();
}

async function loadRoom(rid) {
  const { data, error } = await sb.from('mafia_rooms').select('*').eq('id', rid).maybeSingle();
  if (error) throw error;
  if (!data) {
    toast('Комната закрыта');
    showHome();
    return;
  }
  S.room = data;
}

async function loadPlayers() {
  if (!S.room) return;
  const { data } = await sb.from('mafia_players').select('*').eq('room_id', S.room.id).order('seat');
  S.players = data || [];
  if (S.room && S.room.status !== 'playing' && !S.players.some((p) => p.user_id === S.user.id)) {
    toast('Вы больше не в комнате');
    showHome();
  }
}

async function loadEvents() {
  const { data } = await sb.from('mafia_events').select('*').eq('room_id', S.room.id).order('id').limit(300);
  S.events = data || [];
}

async function loadChat() {
  const { data } = await sb.from('mafia_chat').select('*').eq('room_id', S.room.id).order('id').limit(300);
  S.chat = data || [];
}

async function loadVotes() {
  if (!S.room) return;
  const { data } = await sb.from('mafia_votes').select('*').eq('room_id', S.room.id).eq('day', S.room.day);
  S.votes = data || [];
}

async function loadSecret() {
  if (!S.room || S.room.status === 'lobby') {
    S.role = null;
    S.team = [];
    S.myActions = {};
    return;
  }
  const { data } = await sb.from('mafia_secrets').select('role').eq('room_id', S.room.id).eq('user_id', S.user.id).maybeSingle();
  S.role = data?.role || null;
  S.team = isMafia() ? (await rpc('mafia_team', { p_room: S.room.id })) || [] : [];
  const acts = (await rpc('mafia_my_actions', { p_room: S.room.id })) || [];
  S.myActions = Object.fromEntries(acts.map((a) => [a.kind, a.target]));
  if (isMafia()) await loadTeamVotes();
  // показать карту роли один раз за игру
  const key = `${S.room.id}:${S.room.created_at}:${S.room.status}:${S.role}`;
  if (S.role && S.room.status === 'playing' && S.shownRoleFor !== key && S.room.day <= 1 && S.room.phase === 'night') {
    S.shownRoleFor = key;
    showRole();
  }
}

async function loadTeamVotes() {
  try {
    S.teamVotes = (await rpc('mafia_team_votes', { p_room: S.room.id })) || [];
  } catch {
    S.teamVotes = [];
  }
}

const phaseKey = () => (S.room ? `${S.room.status}:${S.room.phase}:${S.room.day}` : '');
const me = () => S.players.find((p) => p.user_id === S.user.id);
const isMafia = () => S.role === 'mafia' || S.role === 'don';
const isHost = () => S.room?.host === S.user.id;
const alive = () => !!me()?.alive;
const nameOf = (id) => S.players.find((p) => p.user_id === id)?.name || '?';

async function onRoomChange() {
  if (!S.room) return;
  const before = phaseKey();
  const wasStatus = S.room.status;
  await loadRoom(S.room.id);
  if (!S.room) return;
  const after = phaseKey();
  if (before !== after) {
    S.myActions = {};
    S.actionTab = null;
    if (wasStatus !== S.room.status) await Promise.all([loadEvents(), loadChat()]);
    if (wasStatus !== S.room.status || S.room.phase === 'night') await loadSecret();
    await Promise.all([loadVotes(), loadPlayers()]);
    phaseEffects();
  }
  updateVoiceRules();
  renderRoom();
}

function phaseEffects() {
  const ph = S.room.phase;
  if (ph === 'night') {
    beep('night');
    haptic('warning');
  } else if (ph === 'day') {
    beep('day');
    haptic('medium');
  } else if (ph === 'vote') {
    beep('vote');
    haptic('heavy');
  } else if (ph === 'ended') {
    beep('end');
    haptic('success');
  }
}

function onEvent(e) {
  if (!e) return;
  if (e.private_to && e.private_to !== S.user.id) return;
  if (S.events.some((x) => x.id === e.id)) return;
  S.events.push(e);
  if (e.kind === 'private') {
    haptic('success');
    toast(e.text, 4500);
  }
  if (e.kind === 'info' || e.kind === 'death') loadPlayers().then(renderRoom);
  renderFeed();
}

function onChat(c) {
  if (!c || S.chat.some((x) => x.id === c.id)) return;
  // сервер всё равно не пришлёт чужой канал, но проверим
  S.chat.push(c);
  renderFeed();
}

// Таймер и «двигатель» игры: когда время фазы вышло — просим сервер перейти дальше.
function clock() {
  const r = S.room;
  if (!r) return;
  const el = document.getElementById('timer');
  if (!r.phase_ends || r.status !== 'playing') {
    if (el) el.textContent = '';
    return;
  }
  const left = Math.max(0, Math.ceil((new Date(r.phase_ends).getTime() - now()) / 1000));
  if (el) {
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('low', left <= 10);
  }
  if (left <= 0) tick();
}

async function tick() {
  if (S.tickBusy || !S.room) return;
  S.tickBusy = true;
  // небольшой разброс, чтобы все не стучались в одну секунду
  const seat = me()?.seat || 1;
  await new Promise((r) => setTimeout(r, 200 + seat * 120));
  try {
    await rpc('mafia_tick', { p_room: S.room.id });
    await loadRoom(S.room.id);
  } catch {}
  setTimeout(() => (S.tickBusy = false), 1500);
}

// ═══════════════════════════ Голос ═══════════════════════════

async function startVoice() {
  if (S.voice?.active) return;
  S.voice = new Voice(sb, S.room.id, S.user.id, CONFIG.turn, () => renderPlayers() || renderDock());
  try {
    await S.voice.start();
    S.voice.setMic(S.micOn);
    updateVoiceRules();
    toast('Голос подключён 🎙');
  } catch {
    toast(inTelegram ? 'Микрофон недоступен в Telegram — откройте игру в браузере (кнопка 🌐)' : 'Разрешите доступ к микрофону', 5000);
    S.voice = null;
  }
  renderDock();
}

/** Могу ли я сейчас говорить и кому. */
function speakRule() {
  const r = S.room;
  const m = me();
  if (!r || !m) return { can: false };
  if (r.status !== 'playing') return { can: true, to: () => true };
  if (r.phase === 'night') {
    if (m.alive && isMafia()) {
      const team = new Set(S.team.map((t) => t.user_id));
      return { can: true, to: (id) => team.has(id), note: 'Ночью вас слышит только мафия' };
    }
    return { can: false, note: 'Ночью все молчат' };
  }
  if (r.phase === 'last_word') {
    return r.speaker === S.user.id ? { can: true, to: () => true, note: 'Ваше последнее слово' } : { can: false, note: 'Последнее слово выбывшего' };
  }
  if (!m.alive) return { can: false, note: 'Выбывшие не говорят' };
  return { can: true, to: () => true };
}

function updateVoiceRules() {
  const v = S.voice;
  if (!v) return;
  const rule = speakRule();
  v.setRules((id) => rule.can && rule.to(id));
}

function toggleMic() {
  if (!S.voice?.active) {
    startVoice();
    return;
  }
  S.micOn = !S.micOn;
  S.voice.setMic(S.micOn);
  haptic('light');
  renderDock();
}

async function openInBrowser() {
  // Отдельная сессия для браузера: заново входим через Telegram
  try {
    const r = await fetch(`${CONFIG.supabaseUrl}/functions/v1/tg-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CONFIG.supabaseKey },
      body: JSON.stringify({ initData: tg.initData }),
    });
    const j = await r.json();
    if (!j.refresh_token) throw new Error(j.error);
    const url = `${location.origin}${location.pathname}?room=${S.room.code}#rt=${encodeURIComponent(j.refresh_token)}`;
    tg.openLink(url, { try_instant_view: false });
  } catch (e) {
    toast(errText(e));
  }
}

// ═══════════════════════════ Действия ═══════════════════════════

function availableActions() {
  const r = S.room;
  if (!r || r.status !== 'playing' || !alive()) return [];
  if (r.phase === 'night') return ROLE_ACTIONS[S.role] || [];
  if (r.phase === 'vote') return ['vote'];
  return [];
}

function currentAction() {
  const acts = availableActions();
  if (!acts.length) return null;
  if (!acts.includes(S.actionTab)) S.actionTab = acts[0];
  return S.actionTab;
}

function canPick(p) {
  const act = currentAction();
  if (!act || !p.alive) return false;
  if (p.user_id === S.user.id && act !== 'heal' && act !== 'kill') return false;
  if (act === 'kill' && isMafia() && S.team.some((t) => t.user_id === p.user_id)) return false;
  return true;
}

async function pick(userId) {
  const act = currentAction();
  if (!act) return;
  const p = S.players.find((x) => x.user_id === userId);
  if (!p || !canPick(p)) return;
  haptic('medium');
  try {
    if (act === 'vote') {
      await rpc('mafia_vote', { p_room: S.room.id, p_target: userId });
      await loadVotes();
    } else {
      await rpc('mafia_act', { p_room: S.room.id, p_kind: act, p_target: userId });
      S.myActions[act] = userId;
      if (isMafia()) await loadTeamVotes();
      toast(`${ACTIONS[act].icon} ${ACTIONS[act].label}: ${p.name}`);
    }
    renderRoom();
    // если все сходили — сервер сразу перейдёт к утру
    rpc('mafia_tick', { p_room: S.room.id }).then(() => loadRoom(S.room.id)).catch(() => {});
  } catch (e) {
    toast(errText(e));
  }
}

async function sendChat() {
  const input = document.getElementById('chat-text');
  const text = input?.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await rpc('mafia_say', { p_room: S.room.id, p_text: text, p_channel: S.chatTab });
  } catch (e) {
    toast(errText(e));
  }
}

function invite() {
  const link = inviteLink(S.room.code);
  const text = `Го в Мафию! 🎩 Комната «${S.room.title}», код ${S.room.code}`;
  if (inTelegram) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  } else if (navigator.share) {
    navigator.share({ title: 'Мафия', text, url: link }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(link);
    toast('Ссылка скопирована');
  }
}

async function leave() {
  const playing = S.room?.status === 'playing' && alive();
  if (playing && !(await ask('Выйти из игры? Вы выбываете до конца партии.'))) return;
  try {
    await rpc('mafia_leave', { p_room: S.room.id });
  } catch {}
  showHome();
}

function ask(text) {
  if (tg?.showConfirm) return new Promise((res) => tg.showConfirm(text, (ok) => res(!!ok)));
  return Promise.resolve(window.confirm(text));
}

function showRole() {
  if (!S.role) return;
  const r = ROLES[S.role];
  const mates = S.team.filter((t) => t.user_id !== S.user.id).map((t) => `${nameOf(t.user_id)}${t.role === 'don' ? ' (Дон)' : ''}`);
  openModal(`<div class="role-card ${r.team === 'mafia' ? '' : 'town'}" data-act="close-modal">
    <div style="color:var(--muted)">Ваша роль</div>
    <div class="emoji">${r.emoji}</div>
    <h2>${r.name}</h2>
    <p>${r.text}</p>
    ${mates.length ? `<div class="team-list">Ваши союзники: ${esc(mates.join(', '))}</div>` : ''}
    <p style="font-size:13px;margin-top:14px">Никому не показывайте экран 🤫<br>Нажмите, чтобы закрыть</p>
  </div>`);
  haptic('heavy');
}

// ═══════════════════════════ Отрисовка комнаты ═══════════════════════════

function phaseInfo() {
  const r = S.room;
  const n = r.day;
  switch (r.phase) {
    case 'lobby':
      return { cls: 'phase-lobby', ico: '🎲', title: 'Ожидание игроков', text: `${S.players.length} из ${r.settings?.max || 12}. Нужно минимум 4.` };
    case 'night':
      return { cls: 'phase-night', ico: '🌙', title: `Ночь ${n}`, text: 'Город спит. Мафия выбирает жертву.' };
    case 'day':
      return { cls: 'phase-day', ico: '☀️', title: `День ${n}`, text: 'Обсуждение: кто из вас мафия?' };
    case 'vote':
      return { cls: 'phase-vote', ico: '🗳', title: 'Голосование', text: 'Нажмите на игрока, которого изгоняете.' };
    case 'last_word':
      return { cls: 'phase-vote', ico: '🎤', title: 'Последнее слово', text: `Говорит ${nameOf(r.speaker)}` };
    case 'ended':
      return { cls: 'phase-ended', ico: '🏆', title: 'Игра окончена', text: '' };
    default:
      return { cls: '', ico: '', title: '', text: '' };
  }
}

function renderRoom() {
  if (S.screen !== 'room' || !S.room) return;
  if (!document.getElementById('room-root')) {
    $app.innerHTML = `<div class="screen" id="room-root">
      <div class="topbar">
        <button class="btn small ghost" data-act="leave">✕</button>
        <div class="title"><b id="room-title-text"></b><small id="room-sub"></small></div>
        <div class="timer" id="timer"></div>
      </div>
      <div id="banner"></div>
      <div id="panel"></div>
      <div class="players" id="players"></div>
      <div class="feed">
        <div class="chat-tabs" id="chat-tabs"></div>
        <div class="feed-list" id="feed"></div>
        <div class="chat-input"><input class="input" id="chat-text" maxlength="500" placeholder="Сообщение…" enterkeyhint="send"><button class="btn primary" data-act="send">➤</button></div>
      </div>
      <div class="dock" id="dock"></div>
    </div>`;
    document.getElementById('chat-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
  }
  const r = S.room;
  document.getElementById('room-title-text').textContent = r.title;
  document.getElementById('room-sub').innerHTML = `Код <span style="color:var(--gold);letter-spacing:2px">${esc(r.code)}</span> · ${S.players.length} игр.`;
  const ph = phaseInfo();
  document.getElementById('banner').innerHTML = `<div class="phase-banner ${ph.cls}"><div class="ico">${ph.ico}</div><div><h2>${esc(ph.title)}</h2><p>${esc(ph.text)}</p></div></div>`;
  renderPanel();
  renderPlayers();
  renderFeed();
  renderDock();
  clock();
}

function renderPanel() {
  const el = document.getElementById('panel');
  if (!el) return;
  const r = S.room;
  let html = '';
  if (r.status === 'lobby') {
    html = `<div class="panel">
      <h3>Позовите друзей</h3>
      <p>Код комнаты: <span class="code">${esc(r.code)}</span></p>
      <p>Роли: ${rolesLine(r.settings)} · день ${Math.round((r.settings?.day || 120) / 60)} мин</p>
      <div class="row" style="margin-top:10px">
        <button class="btn gold" data-act="invite">📨 Пригласить</button>
        ${isHost() ? `<button class="btn primary" data-act="start" ${S.players.length < 4 ? 'disabled' : ''}>▶ Начать</button>` : ''}
      </div>
      ${isHost() ? '' : '<p style="margin-top:8px">Игру начнёт создатель комнаты 👑</p>'}
    </div>`;
  } else if (r.status === 'finished') {
    const w = { town: ['🎉', 'Победили мирные жители'], mafia: ['🕶', 'Победила мафия'], maniac: ['🔪', 'Победил маньяк'] }[r.winner] || ['🏁', 'Игра окончена'];
    const myTeam = ROLES[me()?.role_public || S.role]?.team;
    const iWon = myTeam && myTeam === r.winner;
    html = `<div class="panel"><div class="winner"><div class="big">${w[0]}</div><h2>${w[1]}</h2>
      <p>${iWon ? 'Вы победили! 🏆' : 'В этот раз не повезло'}</p></div>
      <div class="roles-table">${S.players
        .map((p) => `<div><span>${esc(p.name)}${p.alive ? '' : ' 💀'}</span><span>${ROLES[p.role_public]?.emoji || ''} ${esc(ROLES[p.role_public]?.name || '')}</span></div>`)
        .join('')}</div>
      <div class="row" style="margin-top:12px">
        ${isHost() ? '<button class="btn primary" data-act="reset">🔄 Ещё партию</button>' : '<p>Создатель комнаты может начать новую партию</p>'}
      </div></div>`;
  } else {
    const acts = availableActions();
    const act = currentAction();
    if (!alive()) {
      html = `<div class="panel"><h3>💀 Вы выбыли</h3><p>Наблюдайте за игрой. Писать можно в чат выбывших.</p></div>`;
    } else if (r.phase === 'night' && !acts.length) {
      html = `<div class="panel"><h3>😴 Вы спите</h3><p>Ждите утра. Микрофон выключен.</p></div>`;
    } else if (act) {
      const chosen = act === 'vote' ? S.votes.find((v) => v.voter === S.user.id)?.target : S.myActions[act];
      const tabs = acts.length > 1
        ? `<div class="tabs">${acts.map((a) => `<button class="${a === act ? 'on' : ''}" data-act="tab" data-tab="${a}">${ACTIONS[a].icon} ${ACTIONS[a].label}${S.myActions[a] ? ' ✓' : ''}</button>`).join('')}</div>`
        : '';
      const prompt = act === 'vote' ? 'Нажмите на игрока, против которого голосуете' : ACTIONS[act].prompt;
      let extra = '';
      if (act === 'kill' && isMafia() && S.teamVotes.length) {
        extra = `<p>Голоса мафии: ${S.teamVotes.map((v) => `${esc(nameOf(v.actor))} → <b>${esc(nameOf(v.target))}</b>`).join(', ')}</p>`;
      }
      html = `<div class="panel">${tabs}<h3>${prompt}</h3>
        <p>${chosen ? `Ваш выбор: <b style="color:var(--text)">${esc(nameOf(chosen))}</b> — можно изменить до конца фазы` : 'Нажмите на карточку игрока ниже'}</p>${extra}</div>`;
    } else if (r.phase === 'day') {
      html = `<div class="panel"><h3>🗣 Обсуждение</h3><p>Говорите по очереди, ищите мафию. Потом — голосование.</p>
        ${isHost() ? '<button class="btn small" data-act="skip" style="margin-top:6px">⏭ Сразу к голосованию</button>' : ''}</div>`;
    } else if (r.phase === 'last_word') {
      html = `<div class="panel"><h3>🎤 Последнее слово</h3><p>${esc(nameOf(r.speaker))} может сказать, кого подозревает.</p>
        ${isHost() ? '<button class="btn small" data-act="skip" style="margin-top:6px">⏭ Дальше</button>' : ''}</div>`;
    }
  }
  el.innerHTML = html;
}

function renderPlayers() {
  const el = document.getElementById('players');
  if (!el || !S.room) return;
  const r = S.room;
  const act = currentAction();
  const votes = {};
  if (r.phase === 'vote' || r.phase === 'last_word') for (const v of S.votes) votes[v.target] = (votes[v.target] || 0) + 1;
  const team = new Set(S.team.map((t) => t.user_id));
  const myChoice = act === 'vote' ? S.votes.find((v) => v.voter === S.user.id)?.target : act ? S.myActions[act] : null;
  el.innerHTML = S.players
    .map((p) => {
      const cls = ['player'];
      if (!p.alive) cls.push('dead');
      if (canPick(p)) cls.push('pickable');
      if (myChoice === p.user_id) cls.push('target');
      if (team.has(p.user_id) && isMafia()) cls.push('team');
      if (S.voice?.speaking(p.user_id)) cls.push('speaking');
      let sub = '';
      if (p.role_public) sub = `${ROLES[p.role_public]?.emoji || ''} ${ROLES[p.role_public]?.name || ''}`;
      else if (team.has(p.user_id) && isMafia() && p.user_id !== S.user.id) sub = '🕶 союзник';
      else if (p.user_id === S.user.id) sub = 'это вы';
      else if (r.status !== 'playing' && Date.now() - new Date(p.last_seen).getTime() > 60000) sub = 'не в сети';
      const badge = r.host === p.user_id && r.status !== 'playing' ? '👑' : !p.alive ? '💀' : '';
      return `<div class="${cls.join(' ')}" data-act="pick" data-id="${p.user_id}">
        <span class="seat">${p.seat}</span>${badge ? `<span class="badge">${badge}</span>` : ''}
        ${votes[p.user_id] ? `<span class="votes">${votes[p.user_id]}</span>` : ''}
        ${avatar(p)}<div class="name">${esc(p.name)}</div><div class="sub">${esc(sub)}</div>
        ${isHost() && r.status === 'lobby' && p.user_id !== S.user.id ? `<button class="btn small ghost" data-act="kick" data-id="${p.user_id}" style="margin-top:4px;padding:2px 8px">убрать</button>` : ''}
      </div>`;
    })
    .join('');
}

function chatChannels() {
  const r = S.room;
  const list = [['all', 'Общий']];
  if (r?.status === 'playing' && isMafia() && alive()) list.push(['mafia', '🕶 Мафия']);
  if (r?.status === 'playing' && !alive()) list.push(['dead', '💀 Выбывшие']);
  if (r?.status === 'finished') list.push(['mafia', '🕶 Мафия'], ['dead', '💀 Выбывшие']);
  return list;
}

function renderFeed() {
  const tabsEl = document.getElementById('chat-tabs');
  const feed = document.getElementById('feed');
  if (!feed) return;
  const chans = chatChannels();
  if (!chans.some(([c]) => c === S.chatTab)) S.chatTab = 'all';
  tabsEl.innerHTML = chans.length > 1 ? chans.map(([c, t]) => `<button class="${c === S.chatTab ? 'on' : ''}" data-act="chat-tab" data-tab="${c}">${t}</button>`).join('') : '';
  // ведущий + чат выбранного канала, по времени
  const items = [
    ...S.events.map((e) => ({ t: new Date(e.created_at).getTime(), html: `<div class="msg host ${esc(e.kind)}">${esc(e.text)}</div>` })),
    ...S.chat
      .filter((c) => c.channel === S.chatTab)
      .map((c) => ({ t: new Date(c.created_at).getTime(), html: `<div class="msg ${esc(c.channel)}"><b>${esc(c.name)}:</b> ${esc(c.text)}</div>` })),
  ].sort((a, b) => a.t - b.t);
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.innerHTML = items.map((i) => i.html).join('') || '<div class="msg" style="color:var(--muted)">Здесь будут сообщения ведущего и чат</div>';
  if (atBottom) feed.scrollTop = feed.scrollHeight;
  const input = document.getElementById('chat-text');
  if (input) {
    const r = S.room;
    const blocked = S.chatTab === 'all' && r.status === 'playing' && (!alive() || r.phase === 'night');
    input.disabled = blocked;
    input.placeholder = blocked ? (alive() ? 'Ночью общий чат молчит' : 'Пишите в чат выбывших') : 'Сообщение…';
  }
}

function renderDock() {
  const el = document.getElementById('dock');
  if (!el || !S.room) return;
  const v = S.voice;
  const rule = speakRule();
  let micCls = 'mic';
  let micIco = '🎙';
  let label = 'Подключить голос';
  if (v?.active) {
    if (!rule.can) {
      micCls += ' blocked';
      micIco = '🔇';
      label = rule.note || 'Сейчас нельзя говорить';
    } else if (S.micOn) {
      micCls += ' on';
      label = rule.note || 'Микрофон включён';
    } else {
      micIco = '🔇';
      label = 'Микрофон выключен';
    }
  }
  const peers = v?.active ? [...v.peers.keys()].filter((id) => v.connected(id)).length : 0;
  el.innerHTML = `
    <button class="${micCls}" data-act="mic">${micIco}</button>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center">
      <b style="font-size:14px">${esc(label)}</b>
      <small style="color:var(--muted)">${v?.active ? `На связи: ${peers} · <a href="#" data-act="unlock" style="color:var(--muted)">нет звука?</a>` : 'Нажмите 🎙 — и говорите голосом'}</small>
    </div>
    ${S.room.status === 'playing' ? '<button class="btn small" data-act="role">🃏 Роль</button>' : ''}
    ${inTelegram ? '<button class="btn small ghost" data-act="browser" title="Открыть в браузере">🌐</button>' : ''}`;
}

// ═══════════════════════════ Модальные окна ═══════════════════════════

function openModal(html) {
  $modal.innerHTML = html;
  $modal.hidden = false;
}
function closeModal() {
  $modal.hidden = true;
  $modal.innerHTML = '';
}
$modal.addEventListener('click', (e) => {
  if (e.target === $modal) closeModal();
});

// ═══════════════════════════ Нажатия ═══════════════════════════

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const a = t.dataset.act;
  if (a === 'unlock') e.preventDefault();
  switch (a) {
    case 'create':
      showCreate();
      break;
    case 'create-go':
      createRoom();
      break;
    case 'toggle':
      S.createSettings[t.dataset.key] = !S.createSettings[t.dataset.key];
      S.createSettings.title = document.getElementById('room-title')?.value ?? S.createSettings.title;
      renderCreate();
      break;
    case 'set':
      S.createSettings[t.dataset.key] = Number(t.dataset.val);
      S.createSettings.title = document.getElementById('room-title')?.value ?? S.createSettings.title;
      renderCreate();
      break;
    case 'home':
      showHome();
      break;
    case 'enter-code':
      askCode();
      break;
    case 'code-go': {
      const code = document.getElementById('code-input')?.value.trim();
      if (code) joinRoom(code);
      break;
    }
    case 'join':
      joinRoom(t.dataset.code);
      break;
    case 'refresh':
      refreshRooms();
      break;
    case 'rules':
      showRules();
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'invite':
      invite();
      break;
    case 'start':
      try {
        await rpc('mafia_start', { p_room: S.room.id });
      } catch (err) {
        toast(errText(err));
      }
      break;
    case 'reset':
      try {
        await rpc('mafia_reset', { p_room: S.room.id });
        S.events = [];
        S.chat = [];
      } catch (err) {
        toast(errText(err));
      }
      break;
    case 'skip':
      rpc('mafia_skip_day', { p_room: S.room.id }).catch((err) => toast(errText(err)));
      break;
    case 'kick':
      e.stopPropagation();
      rpc('mafia_kick', { p_room: S.room.id, p_user: t.dataset.id }).then(() => loadPlayers().then(renderRoom)).catch((err) => toast(errText(err)));
      break;
    case 'pick':
      pick(t.dataset.id);
      break;
    case 'tab':
      S.actionTab = t.dataset.tab;
      renderRoom();
      break;
    case 'chat-tab':
      S.chatTab = t.dataset.tab;
      renderFeed();
      break;
    case 'send':
      sendChat();
      break;
    case 'mic':
      toggleMic();
      break;
    case 'unlock':
      S.voice?.unlockAudio();
      toast('Звук включён');
      break;
    case 'role':
      showRole();
      break;
    case 'browser':
      openInBrowser();
      break;
    case 'leave':
      leave();
      break;
  }
});

tg?.BackButton?.onClick(() => {
  if (!$modal.hidden) closeModal();
  else if (S.screen === 'create') showHome();
  else if (S.screen === 'room') leave();
});

// вернулись в приложение — сразу догружаем
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.screen === 'room') refreshAll();
});

boot();
