import * as api from './api.js';
import { computeRanking } from './ranking.js';
import { generateSchedule, planShape } from './schedule.js';

// ---------- Constantes ----------

const COURT_COLORS = {
  noir: { label: 'Noir', bg: '#151515', fg: '#ffffff' },
  vert: { label: 'Vert', bg: '#3baa5f', fg: '#121212' },
  bleu: { label: 'Bleu', bg: '#2457e6', fg: '#ffffff' },
  rouge: { label: 'Rouge', bg: '#e63946', fg: '#ffffff' },
  orange: { label: 'Orange', bg: '#ff8a1f', fg: '#121212' },
  violet: { label: 'Violet', bg: '#7b4dff', fg: '#ffffff' },
  gris: { label: 'Gris', bg: '#9aa0a8', fg: '#121212' },
  blanc: { label: 'Blanc', bg: '#ffffff', fg: '#121212' },
};

const AVATAR_COLORS = ['#ffe14d', '#ff7eb6', '#c6f432', '#5ce1e6', '#ff9f43', '#b79cff'];
const DEFAULT_COURTS = [
  { name: 'Center Court', color: 'noir' },
  { name: 'Terrain 2', color: 'vert' },
];
const DEFAULT_NAME = 'UMA Americano';
const PIN_KEY = 'americano-pin';
const MAX_COURTS = 4;

const ICONS = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/></svg>',
  tour: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16M3 12h18M7.5 8v8M16.5 8v8"/></svg>',
  programme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="4.5" cy="18" r="1.3"/></svg>',
  classement: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 16v5M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
};

// ---------- État ----------

const state = {
  tournament: null,
  courts: [],
  players: [],
  matches: [],
  loaded: false,
  error: null,
  tab: null,
  pin: null,
  drafts: {}, // scores en cours de saisie, par match
  setupPending: null, // préparation affichée en attendant la réponse du serveur
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- Utilitaires ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isAdmin = () => !!state.pin;
const playerById = (id) => state.players.find((p) => p.id === id);
const nameOf = (id) => playerById(id)?.name ?? '?';
const totalRounds = () => state.matches.reduce((m, x) => Math.max(m, x.round), 0);
const roundMatches = (r) => state.matches.filter((m) => m.round === r).sort((a, b) => a.court - b.court);
const isScored = (m) => m.score_a != null && m.score_b != null;

function restingIn(r) {
  const playing = new Set(roundMatches(r).flatMap((m) => [m.a1, m.a2, m.b1, m.b2]));
  return state.players.filter((p) => !playing.has(p.id));
}

function courtInfo(index, courts = state.courts) {
  const c = courts[index];
  const col = COURT_COLORS[c?.color] || COURT_COLORS.noir;
  return { name: c?.name || `Terrain ${index + 1}`, ...col, dark: col.fg === '#121212' };
}

function avatarColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatar(player, size) {
  if (!player) return '';
  const style = `--av:${avatarColor(player.name)}${size ? `;--size:${size}px` : ''}`;
  const inner = player.photo_url
    ? `<img src="${esc(player.photo_url)}" alt="" loading="lazy">`
    : esc((player.name.trim()[0] || '?').toUpperCase());
  const attrs = player.id ? `data-action="photo" data-id="${player.id}" aria-label="Photo de ${esc(player.name)}"` : 'tabindex="-1"';
  return `<button class="avatar" style="${style}" ${attrs}>${inner}</button>`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function handleError(e) {
  const msg = e?.message || String(e);
  if (msg.includes('PIN incorrect')) {
    state.pin = null;
    store.del(PIN_KEY);
    render({ force: true });
  }
  toast(msg, true);
}

// ---------- Données ----------

async function refresh() {
  try {
    const data = await api.loadCurrent();
    const prev = state.tournament;
    Object.assign(state, data, { loaded: true, error: null });
    if (prev?.id !== data.tournament?.id || prev?.status !== data.tournament?.status) state.tab = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

// ---------- Rendu ----------

let pendingRender = false;

function editingInView() {
  const a = document.activeElement;
  return a && a.tagName === 'INPUT' && $('#view').contains(a);
}

function render({ force = false } = {}) {
  renderHero();
  renderTabs();
  if (!force && editingInView()) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  $('#view').innerHTML = renderView();
}

function currentTab() {
  if (state.tab) return state.tab;
  const s = state.tournament?.status;
  return s === 'finished' ? 'classement' : 'tour';
}

function renderHero() {
  const t = state.tournament;
  const words = (t?.name || DEFAULT_NAME).trim().split(/\s+/);
  const l2 = words.length > 1 ? words.pop() : '';
  const l1 = words.join(' ');

  let status = 'Bientôt';
  let live = false;
  if (t?.status === 'setup') status = 'En préparation';
  if (t?.status === 'running') {
    status = `Tour ${t.current_round} / ${totalRounds()}`;
    live = true;
  }
  if (t?.status === 'finished') status = 'Terminé';

  $('#hero').innerHTML = `
    <div class="hero-inner">
      <div>
        <h1><span class="l1">${esc(l1)}</span>${l2 ? `<span class="l2">${esc(l2)}</span>` : ''}</h1>
        <div class="hero-status ${live ? 'live' : ''}"><span class="dot"></span>${esc(status)}</div>
      </div>
      <button class="lock-btn ${isAdmin() ? 'on' : ''}" data-action="lock" aria-label="Mode admin">
        ${isAdmin() ? ICONS.unlock : ICONS.lock}
      </button>
    </div>`;
}

function renderTabs() {
  const tab = currentTab();
  const item = (id, label) =>
    `<button class="tab ${tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${ICONS[id]}<span>${label}</span></button>`;
  $('#tabs').innerHTML = item('tour', 'Tour') + item('programme', 'Programme') + item('classement', 'Classement');
}

function renderView() {
  if (!state.loaded) {
    return state.error
      ? `<div class="empty">Impossible de charger le tournoi.<br><small>${esc(state.error)}</small><button class="link-btn" data-action="retry">Réessayer</button></div>`
      : '<p class="loading">Chargement…</p>';
  }
  const tab = currentTab();
  if (tab === 'programme') return viewProgramme();
  if (tab === 'classement') return viewClassement();
  return viewTour();
}

// ---------- Onglet Tour ----------

function viewTour() {
  const t = state.tournament;
  if (!t || t.status === 'setup') return isAdmin() ? viewSetupEditor() : viewSetupPublic();
  if (t.status === 'finished') {
    return `
      <div class="section-title">Tournoi terminé</div>
      <p class="hint">Tous les tours ont été joués. Place au podium !</p>
      <button class="btn pink" data-action="tab" data-tab="classement">Voir le podium</button>`;
  }

  const r = t.current_round;
  const total = totalRounds();
  const matches = roundMatches(r);
  const resting = restingIn(r);
  const allDone = matches.every(isScored);

  let html = `<div class="section-title">Tour ${r} <small>/ ${total}</small></div>`;
  html += matches.map(courtCard).join('');
  if (resting.length) {
    html += `
      <div class="resting">
        <div class="label">En pause ce tour</div>
        <div class="resting-list">
          ${resting.map((p) => `<span class="chip-player">${avatar(p)}${esc(p.name)}</span>`).join('')}
        </div>
      </div>`;
  }
  if (isAdmin()) {
    const last = r >= total;
    html += `<button class="btn pink" data-action="next-round" ${allDone ? '' : 'disabled'}>${last ? 'Terminer le tournoi' : 'Tour suivant →'}</button>`;
    if (!allDone) html += `<p class="hint" style="text-align:center;margin-top:10px">Entre tous les scores pour passer à la suite.</p>`;
    if (r > 1) html += `<button class="link-btn" data-action="prev-round">Revenir au tour précédent</button>`;
  } else if (r < total) {
    html += `<p class="hint" style="text-align:center">Prochain tour visible dans l'onglet Programme.</p>`;
  }
  return html;
}

function draftFor(m) {
  return state.drafts[m.id] || { a: m.score_a ?? '', b: m.score_b ?? '' };
}

function scoreStatus(m) {
  const d = draftFor(m);
  const filled = d.a !== '' && d.b !== '';
  const sum = (Number(d.a) || 0) + (Number(d.b) || 0);
  const saved = isScored(m) && String(d.a) === String(m.score_a) && String(d.b) === String(m.score_b);
  return { filled, sum, saved, bad: filled && sum !== 16 };
}

function courtCard(m) {
  const c = courtInfo(m.court);
  const done = isScored(m);
  const team = (ids, score, other, side) => {
    const players = ids.map(playerById);
    let right;
    if (isAdmin()) {
      const d = draftFor(m);
      right = `<input class="score-input" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="16"
        data-score="${m.id}" data-side="${side}" value="${esc(d[side])}" aria-label="Score">`;
    } else {
      const win = done && score > other;
      right = `<div class="score ${done ? (win ? 'win' : '') : 'pending'}">${done ? score : '–'}</div>`;
    }
    return `
      <div class="team">
        <div class="avatar-pair">${players.map((p) => avatar(p)).join('')}</div>
        <div class="names">${players.map((p) => `<span>${esc(p?.name)}</span>`).join('')}</div>
        ${right}
      </div>`;
  };

  let actions = '';
  if (isAdmin()) {
    const s = scoreStatus(m);
    actions = `
      <div class="score-actions">
        <span class="score-total ${s.bad ? 'bad' : ''}" data-total="${m.id}">Total ${s.sum}/16</span>
        <button class="btn ${s.saved ? 'saved' : ''}" data-action="save-score" data-id="${m.id}">${s.saved ? 'Enregistré ✓' : 'Valider'}</button>
      </div>`;
  }

  return `
    <article class="court ${c.bg === COURT_COLORS.blanc.bg ? 'light-court' : ''}" data-fg="${c.dark ? 'dark' : 'light'}" data-card="${m.id}"
      style="--court-bg:${c.bg};--court-fg:${c.fg}">
      <div class="court-head">
        <span class="court-name">${esc(c.name)}</span>
      </div>
      ${team([m.a1, m.a2], m.score_a, m.score_b, 'a')}
      <div class="vs">VS</div>
      ${team([m.b1, m.b2], m.score_b, m.score_a, 'b')}
      ${actions}
    </article>`;
}

function updateScoreUI(matchId) {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return;
  const s = scoreStatus(m);
  const total = $(`[data-total="${matchId}"]`);
  if (total) {
    total.textContent = `Total ${s.sum}/16`;
    total.classList.toggle('bad', s.bad);
  }
  const btn = $(`[data-action="save-score"][data-id="${matchId}"]`);
  if (btn) {
    btn.textContent = s.saved ? 'Enregistré ✓' : 'Valider';
    btn.classList.toggle('saved', s.saved);
  }
}

function parseScores(a, b) {
  const sa = Number(a);
  const sb = Number(b);
  if (a === '' || b === '' || !Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0) {
    throw new Error('Entre les deux scores');
  }
  if (sa + sb !== 16) throw new Error(`Le total doit faire 16 points (là : ${sa + sb})`);
  return [sa, sb];
}

async function saveScore(matchId, a, b) {
  const [sa, sb] = parseScores(String(a).trim(), String(b).trim());
  await api.setScore(state.pin, matchId, sa, sb);
  delete state.drafts[matchId];
  const m = state.matches.find((x) => x.id === matchId);
  if (m) Object.assign(m, { score_a: sa, score_b: sb });
}

// ---------- Préparation ----------

function setupData() {
  if (state.setupPending) return state.setupPending;
  const t = state.tournament;
  if (t?.status === 'setup') {
    return {
      id: t.id,
      name: t.name,
      courts: state.courts.map((c) => ({ name: c.name, color: c.color })),
      players: state.players.map((p) => ({ id: p.id, name: p.name, photo_url: p.photo_url })),
    };
  }
  return { id: null, name: DEFAULT_NAME, courts: DEFAULT_COURTS.map((c) => ({ ...c })), players: [] };
}

let saveQueue = Promise.resolve();
let savesInFlight = 0;
function persistSetup(mutate) {
  const next = structuredClone(setupData());
  mutate(next);
  state.setupPending = next;
  savesInFlight++;
  render({ force: true });
  saveQueue = saveQueue
    .then(async () => {
      // Le premier enregistrement crée le tournoi : les suivants doivent réutiliser son id.
      if (!next.id && state.tournament?.status === 'setup') next.id = state.tournament.id;
      await api.saveSetup(state.pin, next.id, next.name, next.courts, next.players);
    })
    .catch(handleError)
    .then(async () => {
      if (--savesInFlight === 0) state.setupPending = null;
      await refresh();
    });
  return saveQueue;
}

function shapeSummary(playerCount, courtCount) {
  if (playerCount < 4) return { title: `${playerCount} joueur${playerCount > 1 ? 's' : ''}`, text: 'Ajoute au moins 4 joueurs pour lancer le tournoi.' };
  const s = planShape(playerCount, courtCount);
  const rest = s.resting === 0 ? 'Personne en pause' : `${s.resting} joueur${s.resting > 1 ? 's' : ''} en pause à chaque tour`;
  return {
    title: `${s.rounds} tours · ${s.matchesPerPlayer} matchs chacun`,
    text: `${playerCount} joueurs sur ${s.courtsUsed} terrain${s.courtsUsed > 1 ? 's' : ''}. ${rest}.`,
  };
}

function viewSetupEditor() {
  const d = setupData();
  const sum = shapeSummary(d.players.length, d.courts.length);
  const players = d.players.map((p) => ({ ...p }));

  return `
    <div class="section-title">Préparation</div>

    <div class="card">
      <h2>Nom du tournoi</h2>
      <input class="field" data-field="name" value="${esc(d.name)}" maxlength="40" autocomplete="off">
    </div>

    <div class="card">
      <h2>Terrains</h2>
      ${d.courts
        .map((c, i) => {
          const col = COURT_COLORS[c.color] || COURT_COLORS.noir;
          return `
          <div class="row">
            <button class="swatch" style="--c:${col.bg}" data-action="court-color" data-index="${i}" aria-label="Couleur du terrain"></button>
            <input class="field" data-court-name="${i}" value="${esc(c.name)}" maxlength="40" autocomplete="off">
            ${d.courts.length > 1 ? `<button class="icon-btn" data-action="remove-court" data-index="${i}" aria-label="Supprimer">✕</button>` : ''}
          </div>`;
        })
        .join('')}
      ${d.courts.length < MAX_COURTS ? '<button class="link-btn" data-action="add-court">+ Ajouter un terrain</button>' : ''}
    </div>

    <div class="card">
      <h2>Joueurs (${players.length})</h2>
      <form class="add-row" data-form="add-player">
        <input class="field" name="name" placeholder="Prénom" maxlength="40" autocomplete="off" enterkeyhint="done">
        <button class="btn pink" type="submit">Ajouter</button>
      </form>
      <ul class="player-list">
        ${players
          .map(
            (p, i) => `
          <li>${avatar(p)}<span class="grow">${esc(p.name)}</span>
            <button class="icon-btn" data-action="remove-player" data-index="${i}" aria-label="Retirer ${esc(p.name)}">✕</button></li>`,
          )
          .join('')}
      </ul>
      ${players.length ? '<p class="hint" style="margin:12px 0 0">Chacun peut déjà ajouter sa photo en touchant son rond.</p>' : ''}
    </div>

    <div class="summary"><strong>${esc(sum.title)}</strong>${esc(sum.text)}</div>
    <button class="btn" data-action="launch" ${players.length >= 4 && d.id ? '' : 'disabled'}>Lancer le tournoi</button>`;
}

function viewSetupPublic() {
  const t = state.tournament;
  if (!t) return '<div class="empty">Aucun tournoi pour l’instant.<br>Reviens un peu plus tard !</div>';
  const sum = shapeSummary(state.players.length, state.courts.length);
  return `
    <div class="section-title">Ça arrive !</div>
    <p class="hint">Le tournoi n'a pas encore commencé. Touche ton rond pour ajouter ta photo 📸</p>
    <div class="card">
      <h2>Joueurs (${state.players.length})</h2>
      <div class="player-grid">
        ${state.players.map((p) => `<div class="tile">${avatar(p)}<span>${esc(p.name)}</span></div>`).join('') || '<span class="hint">Liste en cours…</span>'}
      </div>
    </div>
    <div class="summary"><strong>${esc(sum.title)}</strong>${esc(sum.text)}</div>`;
}

// ---------- Onglet Programme ----------

function viewProgramme() {
  const t = state.tournament;
  if (!t || t.status === 'setup' || !state.matches.length) {
    return '<div class="section-title">Programme</div><div class="empty">Le programme apparaîtra au lancement du tournoi.</div>';
  }
  const total = totalRounds();
  let html = `<div class="section-title">Programme</div>`;
  if (isAdmin()) html += '<p class="hint">Touche un match pour corriger son score.</p>';

  for (let r = 1; r <= total; r++) {
    const live = t.status === 'running' && r === t.current_round;
    const done = t.status === 'finished' || r < t.current_round;
    const badge = live ? '<span class="badge live">En cours</span>' : done ? '<span class="badge done">Joué</span>' : '<span class="badge">À venir</span>';
    const resting = restingIn(r);

    html += `<section class="round ${live ? 'current' : ''} ${!live && !done ? 'upcoming' : ''}" data-round="${r}">
      <div class="round-head"><h3>Tour ${r}</h3>${badge}</div>`;
    for (const m of roundMatches(r)) {
      const c = courtInfo(m.court);
      const scored = isScored(m);
      const winA = scored && m.score_a > m.score_b;
      const winB = scored && m.score_b > m.score_a;
      const tag = isAdmin() ? 'button' : 'div';
      html += `
        <${tag} class="match-row" ${isAdmin() ? `data-action="edit-match" data-id="${m.id}"` : ''}>
          <span class="court-dot"><i style="--c:${c.bg}"></i>${esc(c.name)}</span>
          <span class="side ${winA ? 'won' : ''}">${esc(nameOf(m.a1))} &amp; ${esc(nameOf(m.a2))}</span>
          <span class="mid ${scored ? '' : 'pending'}">${scored ? `${m.score_a} – ${m.score_b}` : 'vs'}</span>
          <span class="side right ${winB ? 'won' : ''}">${esc(nameOf(m.b1))} &amp; ${esc(nameOf(m.b2))}</span>
        </${tag}>`;
    }
    if (resting.length) html += `<div class="round-rest">Pause : ${resting.map((p) => esc(p.name)).join(', ')}</div>`;
    html += '</section>';
  }
  return html;
}

// ---------- Onglet Classement ----------

function viewClassement() {
  const t = state.tournament;
  if (!t || !state.players.length) return '<div class="section-title">Classement</div><div class="empty">Pas encore de joueurs.</div>';

  const rows = computeRanking(state.players, state.matches);
  const row = (r) => `
    <li class="rank-row ${r.rank === 1 && r.player && r.points > 0 ? 'top1' : ''}">
      <span class="pos">${r.rank}</span>
      ${avatar(r.player)}
      <span class="who"><strong>${esc(r.player.name)}</strong><span>${r.played} match${r.played > 1 ? 's' : ''} · ${r.wins} victoire${r.wins > 1 ? 's' : ''}</span></span>
      <span class="pts">${r.points}<small>pts</small></span>
    </li>`;

  if (t.status === 'finished') {
    const winners = rows.filter((r) => r.rank === 1).map((r) => esc(r.player.name));
    const col = (r, cls) =>
      r
        ? `<div class="podium-col ${cls}">
            ${cls === 'p1' ? '<div class="crown">👑</div>' : ''}
            ${avatar(r.player)}
            <div class="pname">${esc(r.player.name)}</div>
            <div class="ppts">${r.points} pts · ${r.wins} V</div>
            <div class="podium-block">${r.rank}</div>
          </div>`
        : '<div></div>';
    return `
      <div class="champion-title">Bravo <span>${winners.join(' & ')}</span> !</div>
      <div class="podium">${col(rows[1], 'p2')}${col(rows[0], 'p1')}${col(rows[2], 'p3')}</div>
      ${rows.length > 3 ? `<ol class="rank-list">${rows.slice(3).map(row).join('')}</ol>` : ''}
      ${isAdmin() ? '<button class="btn yellow" style="margin-top:18px" data-action="new-tournament">Nouveau tournoi</button>' : ''}`;
  }

  return `
    <div class="section-title">Classement</div>
    <p class="hint">Total des points marqués. À égalité, le plus de victoires passe devant.</p>
    <ol class="rank-list">${rows.map(row).join('')}</ol>`;
}

// ---------- Fenêtres ----------

function openSheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop" data-sheet-backdrop><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const sheet = $('.sheet', root);
  onMount?.(sheet);
}

function closeSheet() {
  $('#sheet-root').innerHTML = '';
}

function openLockSheet() {
  if (isAdmin()) {
    const t = state.tournament;
    const canRestart = t && t.status !== 'setup';
    openSheet(
      `<h2>Mode admin</h2>
       <p class="hint">Tu peux saisir les scores et gérer le tournoi.</p>
       <div class="stack">
         ${canRestart ? '<button class="btn yellow" data-action="new-tournament">Nouveau tournoi</button>' : ''}
         <button class="btn ghost" data-action="logout">Quitter le mode admin</button>
       </div>`,
    );
    return;
  }
  openSheet(
    `<h2>Mode admin</h2>
     <p class="hint">Entre le code PIN pour saisir les scores.</p>
     <form class="stack" data-form="pin">
       <input class="field" type="password" name="pin" placeholder="Code PIN" autocomplete="off" required>
       <button class="btn pink" type="submit">Déverrouiller</button>
     </form>`,
    (sheet) => setTimeout(() => $('input', sheet).focus(), 50),
  );
}

function openPhotoSheet(playerId) {
  const p = playerById(playerId);
  if (!p) return;
  openSheet(
    `<h2>${esc(p.name)}</h2>
     <div class="big-avatar">${avatar({ ...p, id: null })}</div>
     <label class="btn pink" data-photo-label>
       📸 ${p.photo_url ? 'Changer la photo' : 'Ajouter une photo'}
       <input type="file" accept="image/*" data-photo-input="${p.id}" hidden>
     </label>
     <p class="hint" style="text-align:center;margin-top:12px">La photo sera visible par tous les participants.</p>`,
  );
}

function openColorSheet(index) {
  const d = setupData();
  const current = d.courts[index]?.color;
  openSheet(
    `<h2>Couleur du terrain</h2>
     <p class="hint">${esc(d.courts[index]?.name)}</p>
     <div class="palette">
       ${Object.entries(COURT_COLORS)
         .map(([id, c]) => `<button class="${id === current ? 'sel' : ''}" style="--c:${c.bg};--fg:${c.fg}" data-action="pick-color" data-index="${index}" data-color="${id}">${c.label}</button>`)
         .join('')}
     </div>`,
  );
}

function openScoreSheet(matchId) {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return;
  const c = courtInfo(m.court);
  const line = (ids, side, value) => `
    <div class="sheet-score">
      <div class="avatar-pair">${ids.map((id) => avatar({ ...playerById(id), id: null })).join('')}</div>
      <div class="names">${ids.map((id) => esc(nameOf(id))).join(' &amp; ')}</div>
      <input class="score-input" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="16" name="${side}" value="${value ?? ''}">
    </div>`;
  openSheet(
    `<h2>Tour ${m.round}</h2>
     <p class="hint">${esc(c.name)}</p>
     <form data-form="score" data-id="${m.id}">
       ${line([m.a1, m.a2], 'a', m.score_a)}
       ${line([m.b1, m.b2], 'b', m.score_b)}
       <button class="btn pink" type="submit">Enregistrer</button>
     </form>
     ${isScored(m) ? `<button class="link-btn" data-action="clear-score" data-id="${m.id}">Effacer le score</button>` : ''}`,
  );
}

function openConfirm(title, text, label, onConfirm) {
  openSheet(
    `<h2>${esc(title)}</h2>
     <p class="hint">${esc(text)}</p>
     <div class="stack">
       <button class="btn pink" data-confirm>${esc(label)}</button>
       <button class="btn ghost" data-action="close">Annuler</button>
     </div>`,
    (sheet) => {
      $('[data-confirm]', sheet).addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          await onConfirm();
          closeSheet();
        } catch (err) {
          e.currentTarget.disabled = false;
          handleError(err);
        }
      });
    },
  );
}

// ---------- Photos ----------

function resizeImage(file, size = 400) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas
        .getContext('2d')
        .drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image illisible'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = url;
  });
}

// ---------- Actions ----------

const actions = {
  tab(el) {
    state.tab = el.dataset.tab;
    render({ force: true });
    window.scrollTo(0, 0);
    if (state.tab === 'programme') {
      const cur = $('.round.current');
      if (cur) cur.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  },
  retry() {
    refresh();
  },
  close() {
    closeSheet();
  },
  lock() {
    openLockSheet();
  },
  logout() {
    state.pin = null;
    store.del(PIN_KEY);
    closeSheet();
    render({ force: true });
    toast('Mode admin désactivé');
  },
  photo(el) {
    openPhotoSheet(el.dataset.id);
  },
  async 'save-score'(el) {
    const id = el.dataset.id;
    const m = state.matches.find((x) => x.id === id);
    const d = draftFor(m);
    el.disabled = true;
    try {
      await saveScore(id, d.a, d.b);
      toast('Score enregistré');
      render({ force: true });
    } catch (e) {
      handleError(e);
    } finally {
      el.disabled = false;
    }
  },
  async 'next-round'(el) {
    const t = state.tournament;
    const last = t.current_round >= totalRounds();
    const go = async () => {
      await api.gotoRound(state.pin, t.id, t.current_round + 1);
      await refresh();
      window.scrollTo(0, 0);
    };
    if (last) {
      openConfirm('Terminer le tournoi ?', 'Le classement final et le podium seront affichés pour tout le monde.', 'Terminer', go);
    } else {
      el.disabled = true;
      try {
        await go();
      } catch (e) {
        el.disabled = false;
        handleError(e);
      }
    }
  },
  'prev-round'() {
    const t = state.tournament;
    openConfirm('Revenir au tour précédent ?', 'Les scores déjà saisis sont conservés.', 'Revenir', async () => {
      await api.gotoRound(state.pin, t.id, t.current_round - 1);
      await refresh();
    });
  },
  'edit-match'(el) {
    openScoreSheet(el.dataset.id);
  },
  'clear-score'(el) {
    const id = el.dataset.id;
    openConfirm('Effacer ce score ?', 'Le match repassera en « à jouer ».', 'Effacer', async () => {
      await api.setScore(state.pin, id, null, null);
      await refresh();
    });
  },
  'remove-player'(el) {
    const i = Number(el.dataset.index);
    persistSetup((d) => d.players.splice(i, 1));
  },
  'add-court'() {
    persistSetup((d) => {
      const used = new Set(d.courts.map((c) => c.color));
      const color = Object.keys(COURT_COLORS).find((k) => !used.has(k)) || 'noir';
      d.courts.push({ name: `Terrain ${d.courts.length + 1}`, color });
    });
  },
  'remove-court'(el) {
    const i = Number(el.dataset.index);
    persistSetup((d) => d.courts.splice(i, 1));
  },
  'court-color'(el) {
    openColorSheet(Number(el.dataset.index));
  },
  'pick-color'(el) {
    const i = Number(el.dataset.index);
    const color = el.dataset.color;
    closeSheet();
    persistSetup((d) => {
      d.courts[i].color = color;
    });
  },
  launch() {
    const d = setupData();
    const s = planShape(d.players.length, d.courts.length);
    openConfirm(
      'Lancer le tournoi ?',
      `${d.players.length} joueurs, ${s.rounds} tours. Le planning sera tiré au sort puis figé : vérifie bien la liste des joueurs.`,
      'C’est parti !',
      async () => {
        await saveQueue;
        const { rounds } = generateSchedule(state.players.map((p) => p.id), state.courts.length);
        const matches = rounds.flatMap((r) =>
          r.matches.map((m) => ({ round: r.round, court: m.court, a1: m.teamA[0], a2: m.teamA[1], b1: m.teamB[0], b2: m.teamB[1] })),
        );
        await api.launch(state.pin, state.tournament.id, matches);
        state.tab = 'tour';
        await refresh();
        window.scrollTo(0, 0);
        toast('Tournoi lancé, bon jeu !');
      },
    );
  },
  'new-tournament'() {
    openConfirm(
      'Nouveau tournoi ?',
      'Un nouveau tournoi est créé avec les mêmes joueurs et terrains (modifiables). Le tournoi actuel ne sera plus affiché.',
      'Créer',
      async () => {
        const t = state.tournament;
        await api.saveSetup(
          state.pin,
          null,
          t?.name || DEFAULT_NAME,
          state.courts.map((c) => ({ name: c.name, color: c.color })),
          state.players.map((p) => ({ name: p.name, photo_url: p.photo_url })),
        );
        state.drafts = {};
        await refresh();
      },
    );
  },
};

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-sheet-backdrop]')) {
    closeSheet();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();

  if (form.dataset.form === 'add-player') {
    const input = form.elements.name;
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const d = setupData();
    if (d.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      toast(`${name} est déjà dans la liste`, true);
      return;
    }
    input.value = '';
    persistSetup((x) => x.players.push({ name }));
    $('[data-form="add-player"] input')?.focus();
    return;
  }

  if (form.dataset.form === 'pin') {
    const pin = form.elements.pin.value;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      if (await api.checkPin(pin)) {
        state.pin = pin;
        store.set(PIN_KEY, pin);
        closeSheet();
        render({ force: true });
        toast('Mode admin activé');
      } else {
        toast('PIN incorrect', true);
        btn.disabled = false;
      }
    } catch (err) {
      btn.disabled = false;
      handleError(err);
    }
    return;
  }

  if (form.dataset.form === 'score') {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await saveScore(form.dataset.id, form.elements.a.value, form.elements.b.value);
      closeSheet();
      toast('Score enregistré');
      render({ force: true });
    } catch (err) {
      btn.disabled = false;
      handleError(err);
    }
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.score) {
    const m = state.matches.find((x) => x.id === el.dataset.score);
    const d = { ...draftFor(m) };
    d[el.dataset.side] = el.value;
    state.drafts[m.id] = d;
    updateScoreUI(m.id);
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.field === 'name') {
    const name = el.value.trim() || DEFAULT_NAME;
    if (name !== setupData().name) persistSetup((d) => (d.name = name));
  } else if (el.dataset.courtName != null) {
    const i = Number(el.dataset.courtName);
    const name = el.value.trim() || `Terrain ${i + 1}`;
    if (name !== setupData().courts[i]?.name) persistSetup((d) => (d.courts[i].name = name));
  } else if (el.dataset.photoInput) {
    const file = el.files?.[0];
    if (!file) return;
    const label = $('[data-photo-label]');
    if (label) label.firstChild.textContent = 'Envoi en cours… ';
    try {
      const blob = await resizeImage(file);
      await api.uploadPhoto(state.tournament.id, el.dataset.photoInput, blob);
      closeSheet();
      toast('Photo ajoutée 📸');
      await refresh();
    } catch (err) {
      if (label) label.firstChild.textContent = '📸 Réessayer ';
      handleError(err);
    }
  }
});

// Délai pour laisser passer le clic qui a fait perdre le focus (ex. bouton « Valider »).
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (pendingRender && !editingInView()) render();
  }, 400);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

// ---------- Démarrage ----------

async function start() {
  const saved = store.get(PIN_KEY);
  if (saved) state.pin = saved;
  render();
  await refresh();
  api.onChange(scheduleRefresh);
  setInterval(refresh, 30000); // filet de sécurité si le temps réel décroche
  if (saved) {
    api
      .checkPin(saved)
      .then((ok) => {
        if (!ok) {
          state.pin = null;
          store.del(PIN_KEY);
          render({ force: true });
        }
      })
      .catch(() => {});
  }
}

start();
