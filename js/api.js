import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// Le tournoi affiché est le plus récent.
export async function loadCurrent() {
  const { data: t, error } = await db.from('tournaments').select('*').order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const tournament = t[0] || null;
  if (!tournament) return { tournament: null, courts: [], players: [], matches: [] };

  const [courts, players, matches] = await Promise.all([
    db.from('courts').select('*').eq('tournament_id', tournament.id).order('position'),
    db.from('players').select('*').eq('tournament_id', tournament.id).order('position'),
    db.from('matches').select('*').eq('tournament_id', tournament.id).order('round').order('court'),
  ]);
  for (const r of [courts, players, matches]) if (r.error) throw new Error(r.error.message);
  return { tournament, courts: courts.data, players: players.data, matches: matches.data };
}

export function onChange(callback) {
  return db
    .channel('americano')
    .on('postgres_changes', { event: '*', schema: 'public' }, callback)
    .subscribe();
}

export const checkPin = (pin) => rpc('check_pin', { p_pin: pin });

export const saveSetup = (pin, tournamentId, name, courts, players) =>
  rpc('admin_save_setup', {
    p_pin: pin,
    p_tournament_id: tournamentId,
    p_name: name,
    p_courts: courts,
    p_players: players,
  });

export const launch = (pin, tournamentId, matches) =>
  rpc('admin_launch', { p_pin: pin, p_tournament_id: tournamentId, p_matches: matches });

export const setScore = (pin, matchId, a, b) =>
  rpc('admin_set_score', { p_pin: pin, p_match_id: matchId, p_score_a: a, p_score_b: b });

export const gotoRound = (pin, tournamentId, round) =>
  rpc('admin_goto_round', { p_pin: pin, p_tournament_id: tournamentId, p_round: round });

export async function uploadPhoto(tournamentId, playerId, blob) {
  const path = `${tournamentId}/${playerId}-${Date.now()}.jpg`;
  const { error } = await db.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message);
  const { data } = db.storage.from('photos').getPublicUrl(path);
  await rpc('set_player_photo', { p_player_id: playerId, p_url: data.publicUrl });
}
