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

const AVATAR_COLORS = ['#fde3d3', '#d6f3f5', '#fbf0c4', '#e6defd', '#d8f3e6', '#eaf7c8', '#fbdbe8'];
const DEFAULT_COURTS = [
  { name: 'Center Court', color: 'noir' },
  { name: 'Terrain 2', color: 'vert' },
];
const DEFAULT_NAME = 'UMA Americano';
const PIN_KEY = 'americano-pin';
const MAX_COURTS = 4;

const ICONS = {
  tour: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M3 12h18"/></svg>',
  programme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>',
  classement: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 16v5M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
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
    if (prev?.id !== data.tournament?.id || prev?.status !== data.tournament?.status) {
      state.tab = null;
      state.celebrated = false;
    }
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

// Ne touche au DOM que si le contenu change : remplacer la barre d'onglets pendant
// un tap (rafraîchissement automatique) faisait perdre le clic.
function setHTML(el, html) {
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
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

  // Confettis à chaque ouverture du classement final (pas aux simples rafraîchissements).
  if (currentTab() === 'classement' && state.tournament?.status === 'finished' && !state.celebrated) {
    state.celebrated = true;
    celebrate();
  }
}

let confetti;
async function celebrate() {
  try {
    confetti ??= (await import('https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/+esm')).default;
    const opts = { colors: ['#e5487b', '#f6dd8c', '#121212', '#d6f3f5', '#e6defd'], disableForReducedMotion: true };
    confetti({ ...opts, particleCount: 120, spread: 80, origin: { y: 0.3 } });
    setTimeout(() => confetti({ ...opts, particleCount: 70, angle: 60, spread: 60, origin: { x: 0, y: 0.65 } }), 250);
    setTimeout(() => confetti({ ...opts, particleCount: 70, angle: 120, spread: 60, origin: { x: 1, y: 0.65 } }), 400);
  } catch {
    // Pas de confettis si la librairie ne se charge pas : ce n'est pas bloquant.
  }
}

function currentTab() {
  if (state.tab) return state.tab;
  const s = state.tournament?.status;
  return s === 'finished' ? 'classement' : 'tour';
}

function renderHero() {
  const name = state.tournament?.name || DEFAULT_NAME;
  setHTML($('#hero'), `
    <div class="topbar">
      <div class="brand"><i></i><span>${esc(name)}</span></div>
      ${isAdmin() ? '<button class="admin-pill" data-action="lock">Admin</button>' : ''}
    </div>`);
}

function renderTabs() {
  const tab = currentTab();
  const item = (id, label) =>
    `<button class="tab ${tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}" aria-label="${label}">${ICONS[id]}<span>${label}</span></button>`;
  setHTML($('#tabs'), item('tour', 'Tour') + item('programme', 'Programme') + item('classement', 'Classement'));
}

// En-tête centré de chaque écran : petit libellé + grand chiffre.
function pageHero(label, big, unit = '', extra = '') {
  return `
    <div class="page-hero">
      <small>${label}</small>
      <div class="big num">${big}${unit ? `<span>${unit}</span>` : ''}</div>
      ${extra}
    </div>`;
}

function roundDots(current, total, finished = false) {
  let html = '<div class="dots">';
  for (let r = 1; r <= total; r++) {
    const cls = finished || r < current ? 'done' : r === current ? 'now' : '';
    html += `<i class="${cls}"></i>`;
  }
  return html + '</div>';
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
    const total = totalRounds();
    return `
      ${pageHero('Tournoi terminé', total, 'tours joués', roundDots(total, total, true))}
      <button class="btn" data-action="tab" data-tab="classement">Voir les résultats</button>`;
  }

  const r = t.current_round;
  const total = totalRounds();
  const matches = roundMatches(r);
  const resting = restingIn(r);
  const allDone = matches.every(isScored);

  let html = pageHero('Tour en cours', r, `/ ${total}`, roundDots(r, total));
  html += matches.map(courtCard).join('');
  if (resting.length) {
    html += `
      <div class="rest">
        <small>En pause ce tour</small>
        <b>${resting.map((p) => esc(p.name)).join(', ')}</b>
      </div>`;
  }
  if (isAdmin()) {
    const last = r >= total;
    html += `<button class="btn" data-action="next-round" ${allDone ? '' : 'disabled'}>${last ? 'Terminer le tournoi' : 'Tour suivant'}</button>`;
    if (!allDone) html += '<p class="hint">Entre tous les scores pour passer à la suite.</p>';
    if (r > 1) html += '<button class="link-btn" data-action="prev-round">Revenir au tour précédent</button>';
  } else if (r < total) {
    html += '<p class="hint">Les prochains tours sont dans l’onglet Programme.</p>';
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
    const lost = done && score < other;
    let right;
    if (isAdmin()) {
      const d = draftFor(m);
      right = `<input class="score-input" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="16"
        data-score="${m.id}" data-side="${side}" value="${esc(d[side])}" aria-label="Score">`;
    } else {
      right = `<span class="score num ${done ? (lost ? 'lose' : '') : 'pending'}">${done ? score : '–'}</span>`;
    }
    return `
      <div class="team">
        <div class="avatar-pair">${players.map((p) => avatar(p)).join('')}</div>
        <div class="names ${lost ? 'lose' : ''}">${players.map((p) => esc(p?.name)).join(' &amp; ')}</div>
        ${right}
      </div>`;
  };

  let actions = '';
  if (isAdmin()) {
    const s = scoreStatus(m);
    actions = `
      <div class="score-actions">
        <span class="score-total num ${s.bad ? 'bad' : ''}" data-total="${m.id}">Total ${s.sum} / 16</span>
        <button class="btn small ${s.saved ? 'saved' : ''}" data-action="save-score" data-id="${m.id}">${s.saved ? 'Enregistré ✓' : 'Valider'}</button>
      </div>`;
  }

  return `
    <article class="card" data-card="${m.id}">
      <div class="card-head">
        <span class="dot" style="--c:${c.bg}"></span>${esc(c.name)}
        ${done ? '<span class="badge">Terminé</span>' : '<span class="badge live">● En jeu</span>'}
      </div>
      ${team([m.a1, m.a2], m.score_a, m.score_b, 'a')}
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
    total.textContent = `Total ${s.sum} / 16`;
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
  if (playerCount < 4) return { title: 'En attente de joueurs', text: 'Il faut au moins 4 joueurs pour lancer le tournoi.' };
  const s = planShape(playerCount, courtCount);
  const rest = s.resting === 0 ? 'personne en pause' : `${s.resting} en pause à chaque tour`;
  return {
    title: `${s.rounds} tours · ${s.matchesPerPlayer} matchs chacun`,
    text: `${s.courtsUsed} terrain${s.courtsUsed > 1 ? 's' : ''}, ${rest}`,
  };
}

const plural = (n, word) => `${word}${n > 1 ? 's' : ''}`;

function summaryCard(sum) {
  return `<div class="rest"><small>Format</small><b>${esc(sum.title)}</b><p>${esc(sum.text)}</p></div>`;
}

function viewSetupEditor() {
  const d = setupData();
  const sum = shapeSummary(d.players.length, d.courts.length);
  const players = d.players.map((p) => ({ ...p }));

  return `
    ${pageHero('Préparation', players.length, plural(players.length, 'joueur'))}

    <div class="card pad">
      <h2 class="card-title">Nom du tournoi</h2>
      <input class="field" data-field="name" value="${esc(d.name)}" maxlength="40" autocomplete="off">
    </div>

    <div class="card pad">
      <h2 class="card-title">Terrains</h2>
      ${d.courts
        .map((c, i) => {
          const col = COURT_COLORS[c.color] || COURT_COLORS.noir;
          return `
          <div class="row-line">
            <button class="swatch" data-action="court-color" data-index="${i}" aria-label="Couleur du terrain"><i style="--c:${col.bg}"></i></button>
            <input class="field" data-court-name="${i}" value="${esc(c.name)}" maxlength="40" autocomplete="off">
            ${d.courts.length > 1 ? `<button class="icon-btn" data-action="remove-court" data-index="${i}" aria-label="Supprimer">✕</button>` : ''}
          </div>`;
        })
        .join('')}
      ${d.courts.length < MAX_COURTS ? '<button class="link-btn" data-action="add-court">Ajouter un terrain</button>' : ''}
    </div>

    <div class="card pad">
      <h2 class="card-title">Joueurs</h2>
      <form class="add-row" data-form="add-player">
        <input class="field" name="name" placeholder="Prénom" maxlength="40" autocomplete="off" enterkeyhint="done">
        <button class="btn small" type="submit">Ajouter</button>
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
    </div>
    ${players.length ? '<p class="hint">Chacun peut déjà ajouter sa photo en touchant son rond.</p>' : ''}

    ${summaryCard(sum)}
    <button class="btn" data-action="launch" ${players.length >= 4 && d.id ? '' : 'disabled'}>Lancer le tournoi</button>`;
}

function viewSetupPublic() {
  const t = state.tournament;
  if (!t) return `${pageHero('Aucun tournoi pour l’instant', '–')}<p class="hint">Reviens un peu plus tard !</p>`;
  const n = state.players.length;
  return `
    ${pageHero('Le tournoi commence bientôt', n, plural(n, 'joueur'))}
    <p class="hint">Touche ton rond pour ajouter ta photo.</p>
    <div class="card pad">
      <div class="player-grid">
        ${state.players.map((p) => `<div class="tile">${avatar(p)}<span>${esc(p.name)}</span></div>`).join('') || '<span class="hint">Liste en cours…</span>'}
      </div>
    </div>
    ${summaryCard(shapeSummary(n, state.courts.length))}`;
}

// ---------- Onglet Programme ----------

function viewProgramme() {
  const t = state.tournament;
  if (!t || t.status === 'setup' || !state.matches.length) {
    return `${pageHero('Programme', '–')}<p class="hint">Le programme apparaîtra au lancement du tournoi.</p>`;
  }
  const total = totalRounds();
  const finished = t.status === 'finished';
  let html = pageHero('Programme', total, 'tours', roundDots(t.current_round, total, finished));
  if (isAdmin()) html += '<p class="hint">Touche un match pour corriger son score.</p>';

  for (let r = 1; r <= total; r++) {
    const live = t.status === 'running' && r === t.current_round;
    const done = finished || r < t.current_round;
    const badge = live ? '<span class="badge live">● En cours</span>' : done ? '<span class="badge">Joué</span>' : '<span class="badge">À venir</span>';
    const resting = restingIn(r);

    html += `<section class="card round ${live ? 'current' : ''} ${!live && !done ? 'upcoming' : ''}" data-round="${r}">
      <div class="card-head">Tour ${r}${badge}</div>`;
    for (const m of roundMatches(r)) {
      const c = courtInfo(m.court);
      const scored = isScored(m);
      const lostA = scored && m.score_a < m.score_b;
      const lostB = scored && m.score_b < m.score_a;
      const tag = isAdmin() ? 'button' : 'div';
      html += `
        <${tag} class="match-row" ${isAdmin() ? `data-action="edit-match" data-id="${m.id}"` : ''}>
          <span class="court-dot"><span class="dot" style="--c:${c.bg}"></span>${esc(c.name)}</span>
          <span class="side ${lostA ? 'lost' : ''}">${esc(nameOf(m.a1))} &amp; ${esc(nameOf(m.a2))}</span>
          <span class="mid num ${scored ? '' : 'pending'}">${scored ? `${m.score_a} – ${m.score_b}` : 'vs'}</span>
          <span class="side right ${lostB ? 'lost' : ''}">${esc(nameOf(m.b1))} &amp; ${esc(nameOf(m.b2))}</span>
        </${tag}>`;
    }
    if (resting.length) html += `<div class="round-rest">En pause : ${resting.map((p) => esc(p.name)).join(', ')}</div>`;
    html += '</section>';
  }
  return html;
}

// ---------- Onglet Classement ----------

const record = (r) => `${r.wins} V · ${r.draws} N · ${r.losses} D`;
const placeLabel = (rank, tied) => (rank === 1 ? (tied ? '1er ex æquo' : '1er') : `${rank}e${tied ? ' ex æquo' : ''}`);

// medals : affiche la couleur du podium sur le numéro de place (seulement une fois des scores saisis).
function rankRow(r, { medals = false } = {}) {
  const medal = medals && r.rank <= 3 ? `medal-${r.rank}` : '';
  return `
    <div class="row">
      <span class="rank num ${medal}">${r.rank}</span>
      ${avatar(r.player)}
      <span class="who"><b>${esc(r.player.name)}</b><small>${record(r)}</small></span>
      <span class="pts num">${r.points}<small>pts</small></span>
    </div>`;
}

function viewPodium(rows) {
  const tied = (r) => rows.filter((x) => x.rank === r.rank).length > 1;
  const [first, ...others] = rows.slice(0, 3);
  const side = (r) => `
    <div class="podium-card">
      <div class="top-row">${avatar(r.player)}<span class="place medal-${Math.min(r.rank, 3)}">${placeLabel(r.rank, tied(r))}</span></div>
      <b>${esc(r.player.name)}</b>
      <div class="pts num">${r.points}<small>pts</small></div>
      <small>${record(r)}</small>
    </div>`;
  return `
    <div class="page-hero"><small>Tournoi terminé</small><h1 class="page-title">Résultats</h1></div>
    <div class="champ-card">
      ${avatar(first.player)}
      <div class="info"><small>${tied(first) ? 'Vainqueur ex æquo' : 'Vainqueur'}</small><b>${esc(first.player.name)}</b><small>${record(first)}</small></div>
      <div class="big num">${first.points}<span>pts</span></div>
    </div>
    ${others.length ? `<div class="podium-duo">${others.map(side).join('')}</div>` : ''}
    ${rows.length > 3 ? `<div class="card list">${rows.slice(3).map((r) => rankRow(r)).join('')}</div>` : ''}
    <p class="hint">V victoires · N nuls · D défaites</p>
    ${isAdmin() ? '<button class="btn ghost" data-action="new-tournament">Nouveau tournoi</button>' : ''}`;
}

function viewClassement() {
  const t = state.tournament;
  if (!t || !state.players.length) return `${pageHero('Classement', '–')}<p class="hint">Pas encore de joueurs.</p>`;

  const rows = computeRanking(state.players, state.matches);
  if (t.status === 'finished') return viewPodium(rows);

  const leaders = rows.filter((r) => r.rank === 1);
  const names = leaders.map((r) => esc(r.player.name)).join(' &amp; ');
  const anyScore = state.matches.some(isScored);
  let completed = 0;
  for (let r = 1; r <= totalRounds() && roundMatches(r).every(isScored); r++) completed = r;
  const hero = anyScore
    ? pageHero(
        `${leaders.length > 1 ? 'En tête' : 'Leader'} ${completed ? `après ${completed} ${plural(completed, 'tour')}` : 'provisoire'}`,
        rows[0].points,
        'pts',
        `<small>${names} · ${rows[0].wins} ${plural(rows[0].wins, 'victoire')}</small>`,
      )
    : pageHero('Classement', 0, 'pts', '<small>Aucun score pour l’instant</small>');

  return `
    ${hero}
    <div class="card list">${rows.map((r) => rankRow(r, { medals: anyScore })).join('')}</div>
    <p class="hint">Total des points marqués. À égalité, le plus de victoires passe devant.<br>V victoires · N nuls · D défaites</p>`;
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
         ${canRestart ? '<button class="btn" data-action="new-tournament">Nouveau tournoi</button>' : ''}
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
       <button class="btn" type="submit">Déverrouiller</button>
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
     <label class="btn" data-photo-label>
       📸 ${p.photo_url ? 'Reprendre un selfie' : 'Prendre un selfie'}
       <input type="file" accept="image/*" capture="user" data-photo-input="${p.id}" hidden>
     </label>`,
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
         .map(([id, c]) => `<button class="${id === current ? 'sel' : ''}" style="--c:${c.bg};--fg:${c.fg}" data-action="pick-color" data-index="${index}" data-color="${id}"><i></i>${c.label}</button>`)
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
       <button class="btn" type="submit">Enregistrer</button>
     </form>
     ${isScored(m) ? `<button class="link-btn" data-action="clear-score" data-id="${m.id}">Effacer le score</button>` : ''}`,
  );
}

function openConfirm(title, text, label, onConfirm) {
  openSheet(
    `<h2>${esc(title)}</h2>
     <p class="hint">${esc(text)}</p>
     <div class="stack">
       <button class="btn" data-confirm>${esc(label)}</button>
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

// Accès admin caché : trois taps rapides sur l'onglet Tour.
let tourTaps = [];

const actions = {
  tab(el) {
    if (el.dataset.tab === 'tour' && el.classList.contains('tab')) {
      const now = Date.now();
      tourTaps = tourTaps.filter((t) => now - t < 1200).concat(now);
      if (tourTaps.length >= 3) {
        tourTaps = [];
        openLockSheet();
      }
    }
    if (state.tab !== el.dataset.tab) state.celebrated = false;
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
      'Un nouveau tournoi est créé avec les mêmes terrains, et une liste de joueurs vide. Le tournoi actuel ne sera plus affiché.',
      'Créer',
      async () => {
        const t = state.tournament;
        await api.saveSetup(
          state.pin,
          null,
          t?.name || DEFAULT_NAME,
          state.courts.map((c) => ({ name: c.name, color: c.color })),
          [],
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
    // Safari iOS : après fermeture du clavier, les éléments fixes peuvent rester décalés
    // de leur zone cliquable. Un défilement nul force le recalcul.
    if (!editingInView()) window.scrollTo(window.scrollX, window.scrollY);
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
