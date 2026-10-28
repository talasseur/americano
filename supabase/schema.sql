-- Schéma Supabase de l'app Americano.
-- Lecture publique ; toutes les écritures passent par des fonctions qui vérifient le PIN admin
-- (sauf l'ajout d'une photo de joueur, ouvert à tous).

create extension if not exists pgcrypto with schema extensions;

create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'UMA Americano',
  status text not null default 'setup' check (status in ('setup', 'running', 'finished')),
  current_round int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists courts (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  position int not null,
  name text not null,
  color text not null
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  position int not null default 0,
  name text not null,
  photo_url text
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  round int not null,
  court int not null,
  a1 uuid not null references players(id) on delete cascade,
  a2 uuid not null references players(id) on delete cascade,
  b1 uuid not null references players(id) on delete cascade,
  b2 uuid not null references players(id) on delete cascade,
  score_a int,
  score_b int
);

-- Le PIN (haché) : aucune policy, donc illisible depuis l'app.
create table if not exists admin_secret (
  id int primary key default 1 check (id = 1),
  pin_hash text not null
);

alter table tournaments enable row level security;
alter table courts enable row level security;
alter table players enable row level security;
alter table matches enable row level security;
alter table admin_secret enable row level security;

drop policy if exists "lecture publique" on tournaments;
drop policy if exists "lecture publique" on courts;
drop policy if exists "lecture publique" on players;
drop policy if exists "lecture publique" on matches;
create policy "lecture publique" on tournaments for select using (true);
create policy "lecture publique" on courts for select using (true);
create policy "lecture publique" on players for select using (true);
create policy "lecture publique" on matches for select using (true);

-- Temps réel
alter publication supabase_realtime add table tournaments, courts, players, matches;

-- ---------- Fonctions ----------

create or replace function check_pin(p_pin text) returns boolean
language sql security definer set search_path = public, extensions as $$
  select exists (select 1 from admin_secret where pin_hash = crypt(p_pin, pin_hash));
$$;

create or replace function assert_pin(p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not check_pin(p_pin) then
    raise exception 'PIN incorrect';
  end if;
end;
$$;

-- Crée (p_tournament_id null) ou met à jour un tournoi en préparation.
-- p_courts : [{name, color}] ; p_players : [{id?, name, photo_url?}]
create or replace function admin_save_setup(p_pin text, p_tournament_id uuid, p_name text, p_courts jsonb, p_players jsonb)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  t_id uuid := p_tournament_id;
  p jsonb;
  i int := 0;
begin
  perform assert_pin(p_pin);

  if t_id is null then
    insert into tournaments (name) values (coalesce(nullif(trim(p_name), ''), 'UMA Americano')) returning id into t_id;
  else
    if (select status from tournaments where id = t_id) is distinct from 'setup' then
      raise exception 'Le tournoi a déjà commencé';
    end if;
    update tournaments set name = coalesce(nullif(trim(p_name), ''), 'UMA Americano') where id = t_id;
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

-- p_matches : [{round, court, a1, a2, b1, b2}]
create or replace function admin_launch(p_pin text, p_tournament_id uuid, p_matches jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform assert_pin(p_pin);
  if (select status from tournaments where id = p_tournament_id) is distinct from 'setup' then
    raise exception 'Le tournoi a déjà commencé';
  end if;
  delete from matches where tournament_id = p_tournament_id;
  insert into matches (tournament_id, round, court, a1, a2, b1, b2)
    select p_tournament_id, (m->>'round')::int, (m->>'court')::int,
           (m->>'a1')::uuid, (m->>'a2')::uuid, (m->>'b1')::uuid, (m->>'b2')::uuid
    from jsonb_array_elements(p_matches) m;
  update tournaments set status = 'running', current_round = 1 where id = p_tournament_id;
end;
$$;

create or replace function admin_set_score(p_pin text, p_match_id uuid, p_score_a int, p_score_b int)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform assert_pin(p_pin);
  if p_score_a is null and p_score_b is null then
    update matches set score_a = null, score_b = null where id = p_match_id;
    return;
  end if;
  if p_score_a < 0 or p_score_b < 0 or p_score_a + p_score_b <> 16 then
    raise exception 'Le total doit faire 16 points';
  end if;
  update matches set score_a = p_score_a, score_b = p_score_b where id = p_match_id;
end;
$$;

-- Passe à un tour donné ; au-delà du dernier tour, le tournoi est terminé.
create or replace function admin_goto_round(p_pin text, p_tournament_id uuid, p_round int)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  last_round int;
begin
  perform assert_pin(p_pin);
  select max(round) into last_round from matches where tournament_id = p_tournament_id;
  if p_round > last_round then
    update tournaments set status = 'finished', current_round = last_round where id = p_tournament_id;
  else
    update tournaments set status = 'running', current_round = greatest(1, p_round) where id = p_tournament_id;
  end if;
end;
$$;

-- Ouvert à tous : chacun peut mettre sa photo.
create or replace function set_player_photo(p_player_id uuid, p_url text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_url not like '%/storage/v1/object/public/photos/%' then
    raise exception 'URL de photo invalide';
  end if;
  update players set photo_url = p_url where id = p_player_id;
end;
$$;

revoke execute on function assert_pin(text) from public, anon, authenticated;

-- ---------- Photos ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "photos upload" on storage.objects;
create policy "photos upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'photos');
