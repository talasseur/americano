-- 2026-11-11 : nombre de points par match réglable par tournoi (16 par défaut).
alter table tournaments add column if not exists points_per_match int not null default 16
  check (points_per_match between 4 and 99);

-- p_courts : [{name, color}] ; p_players : [{id?, name, photo_url?}] ; p_points : points par match (null = inchangé / 16)
drop function if exists admin_save_setup(text, uuid, text, jsonb, jsonb);
create or replace function admin_save_setup(p_pin text, p_tournament_id uuid, p_name text, p_courts jsonb, p_players jsonb, p_points int default null)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  t_id uuid := p_tournament_id;
  p jsonb;
  i int := 0;
begin
  perform assert_pin(p_pin);

  if t_id is null then
    insert into tournaments (name, points_per_match)
      values (coalesce(nullif(trim(p_name), ''), 'UMA Americano'), coalesce(p_points, 16))
      returning id into t_id;
  else
    if (select status from tournaments where id = t_id) is distinct from 'setup' then
      raise exception 'Le tournoi a déjà commencé';
    end if;
    update tournaments
      set name = coalesce(nullif(trim(p_name), ''), 'UMA Americano'),
          points_per_match = coalesce(p_points, points_per_match)
      where id = t_id;
  end if;

  delete from courts where tournament_id = t_id;
  insert into courts (tournament_id, position, name, color)
    select t_id, (ord - 1)::int, left(c->>'name', 40), left(c->>'color', 20)
    from jsonb_array_elements(p_courts) with ordinality as x(c, ord);

  delete from players
    where tournament_id = t_id
      and id not in (select (e->>'id')::uuid from jsonb_array_elements(p_players) e where e->>'id' is not null);

  for p in select * from jsonb_array_elements(p_players) loop
    if p->>'id' is not null and exists (select 1 from players where id = (p->>'id')::uuid and tournament_id = t_id) then
      update players set name = left(p->>'name', 40), position = i where id = (p->>'id')::uuid;
    else
      insert into players (tournament_id, position, name, photo_url)
        values (t_id, i, left(p->>'name', 40), p->>'photo_url');
    end if;
    i := i + 1;
  end loop;

  return t_id;
end;
$$;

create or replace function admin_set_score(p_pin text, p_match_id uuid, p_score_a int, p_score_b int)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  total int;
begin
  perform assert_pin(p_pin);
  if p_score_a is null and p_score_b is null then
    update matches set score_a = null, score_b = null where id = p_match_id;
    return;
  end if;
  select t.points_per_match into total
    from matches m join tournaments t on t.id = m.tournament_id
    where m.id = p_match_id;
  if p_score_a < 0 or p_score_b < 0 or p_score_a + p_score_b <> total then
    raise exception 'Le total doit faire % points', total;
  end if;
  update matches set score_a = p_score_a, score_b = p_score_b where id = p_match_id;
end;
$$;
