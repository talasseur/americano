// Classement : total de points, puis nombre de matchs gagnés ; sinon égalité.
export function computeRanking(players, matches) {
  const stats = new Map(players.map((p) => [p.id, { player: p, points: 0, wins: 0, draws: 0, losses: 0, played: 0 }]));

  for (const m of matches) {
    if (m.score_a == null || m.score_b == null) continue;
    const sides = [
      [[m.a1, m.a2], m.score_a, m.score_b],
      [[m.b1, m.b2], m.score_b, m.score_a],
    ];
    for (const [ids, mine, theirs] of sides) {
      for (const id of ids) {
        const s = stats.get(id);
        if (!s) continue;
        s.points += mine;
        s.played += 1;
        if (mine > theirs) s.wins += 1;
        else if (mine === theirs) s.draws += 1;
        else s.losses += 1;
      }
    }
  }

  const rows = [...stats.values()].sort(
    (a, b) => b.points - a.points || b.wins - a.wins || a.player.name.localeCompare(b.player.name, 'fr'),
  );

  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    row.rank = prev && prev.points === row.points && prev.wins === row.wins ? prev.rank : i + 1;
  });
  return rows;
}
