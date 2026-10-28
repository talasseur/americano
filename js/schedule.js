// Génération du planning Americano.
// Objectif : chacun joue autant de matchs, avec un maximum de partenaires différents,
// et des adversaires aussi variés que possible.

// Nombre de joueurs en jeu par tour et nombre de tours.
export function planShape(playerCount, courtCount) {
  const courtsUsed = Math.min(courtCount, Math.floor(playerCount / 4));
  const playing = courtsUsed * 4;
  if (playing === 0) return { courtsUsed: 0, playing: 0, resting: playerCount, rounds: 0, matchesPerPlayer: 0 };
  // Plus petit nombre de tours >= N-1 (pour croiser tout le monde) tel que tout le monde joue autant.
  let rounds = Math.max(1, playerCount - 1);
  while ((rounds * playing) % playerCount !== 0) rounds++;
  return {
    courtsUsed,
    playing,
    resting: playerCount - playing,
    rounds,
    matchesPerPlayer: (rounds * playing) / playerCount,
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Toutes les façons de découper une liste (taille paire) en paires.
function allPairings(list) {
  if (list.length === 0) return [[]];
  const [first, ...rest] = list;
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const others = rest.slice(0, i).concat(rest.slice(i + 1));
    for (const sub of allPairings(others)) out.push([[first, rest[i]], ...sub]);
  }
  return out;
}

function randomPairing(list) {
  const s = shuffle(list);
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push([s[i], s[i + 1]]);
  return out;
}

// Toutes les façons de regrouper des paires en matchs (2 paires par match).
function allGroupings(pairs) {
  return allPairings(pairs.map((_, i) => i)).map((g) => g.map(([x, y]) => [pairs[x], pairs[y]]));
}

const key = (a, b) => (a < b ? a * 1000 + b : b * 1000 + a);

// players : tableau d'identifiants. Retourne [{ round, matches: [{ court, teamA, teamB }], resting }]
export function generateSchedule(players, courtCount, { timeBudgetMs = 1500 } = {}) {
  const n = players.length;
  const shape = planShape(n, courtCount);
  if (shape.rounds === 0) return { shape, rounds: [] };

  const deadline = Date.now() + timeBudgetMs;
  let best = null;

  do {
    const attempt = buildAttempt(n, shape);
    if (!best || attempt.cost < best.cost) best = attempt;
    if (best.cost === best.floor) break;
  } while (Date.now() < deadline);

  const rounds = best.rounds.map((r, idx) => ({
    round: idx + 1,
    matches: r.matches.map((m, c) => ({
      court: c,
      teamA: m[0].map((i) => players[i]),
      teamB: m[1].map((i) => players[i]),
    })),
    resting: r.resting.map((i) => players[i]),
  }));
  return { shape, rounds };
}

function buildAttempt(n, shape) {
  const order = shuffle([...Array(n).keys()]);
  const partner = new Map();
  const opponent = new Map();
  const courtUse = Array.from({ length: n }, () => Array(shape.courtsUsed).fill(0));
  const get = (m, a, b) => m.get(key(a, b)) || 0;
  const rounds = [];

  for (let r = 0; r < shape.rounds; r++) {
    // Pauses réparties en tournant : chacun se repose le même nombre de fois, bien espacées.
    const resting = [];
    for (let k = 0; k < shape.resting; k++) resting.push(order[(r * shape.resting + k) % n]);
    const playing = order.filter((p) => !resting.includes(p));

    const candidates = playing.length <= 8 ? allPairings(playing) : Array.from({ length: 4000 }, () => randomPairing(playing));
    let bestRound = null;
    for (const pairs of shuffle(candidates)) {
      let pc = 0;
      for (const [a, b] of pairs) pc += (get(partner, a, b) + 1) ** 2 * 100;
      if (bestRound && pc > bestRound.cost) continue;
      for (const grouping of allGroupings(pairs)) {
        let oc = 0;
        for (const [[a, b], [c, d]] of grouping) {
          for (const x of [a, b]) for (const y of [c, d]) oc += (get(opponent, x, y) + 1) ** 2;
        }
        if (!bestRound || pc + oc < bestRound.cost) bestRound = { cost: pc + oc, matches: grouping };
      }
    }

    for (const [[a, b], [c, d]] of bestRound.matches) {
      partner.set(key(a, b), get(partner, a, b) + 1);
      partner.set(key(c, d), get(partner, c, d) + 1);
      for (const x of [a, b]) for (const y of [c, d]) opponent.set(key(x, y), get(opponent, x, y) + 1);
    }

    // Terrains : on place chaque match sur le terrain où ses joueurs sont le moins allés.
    const matches = assignCourts(bestRound.matches, courtUse);
    rounds.push({ matches, resting });
  }

  // Coût global : répétitions de partenaires (très pénalisées) + déséquilibre des adversaires.
  let cost = 0;
  for (const v of partner.values()) cost += (v - 1) ** 2 * 100 + 0;
  let oppSq = 0;
  for (const v of opponent.values()) oppSq += v * v;
  cost += oppSq;
  // Borne basse approximative des adversaires (répartition parfaitement uniforme).
  const totalOpp = shape.rounds * shape.courtsUsed * 4;
  const slots = (n * (n - 1)) / 2;
  const q = Math.floor(totalOpp / slots);
  const rem = totalOpp - q * slots;
  const floor = rem * (q + 1) ** 2 + (slots - rem) * q * q;
  return { rounds, cost, floor, partner, opponent };
}

function assignCourts(matches, courtUse) {
  const courts = matches.length;
  let bestPerm = null;
  let bestScore = Infinity;
  for (const perm of permutations([...Array(courts).keys()])) {
    let s = 0;
    matches.forEach((m, i) => {
      for (const p of m.flat()) s += courtUse[p][perm[i]];
    });
    if (s < bestScore) {
      bestScore = s;
      bestPerm = perm;
    }
  }
  const out = Array(courts);
  matches.forEach((m, i) => {
    out[bestPerm[i]] = m;
    for (const p of m.flat()) courtUse[p][bestPerm[i]]++;
  });
  return out;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) => permutations(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x, ...p]));
}
