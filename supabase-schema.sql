-- So We've Got Time — Supabase schema
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Security model: there are no logins, so the browser uses the public
-- "anon" key and anyone holding it can talk to these tables. We limit the
-- damage that can do:
--   * no phone numbers or other contact info are stored
--   * photos/answers can't be bulk-browsed for long: games (and their
--     players, photos and answers) are deleted 24h after creation
--   * nobody can DELETE through the API
-- Stronger protection (only players in a room can read that room) needs
-- Supabase Anonymous Sign-Ins + per-room RLS; see README "Next steps".

-- ---------- tables ----------
create table if not exists swgt_games (
  code text primary key,
  host_id text not null,
  host_name text,
  duration_minutes integer not null default 15,
  status text not null default 'lobby',
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists swgt_players (
  id text primary key,
  game_code text not null references swgt_games(code) on delete cascade,
  name text not null,
  age integer,
  is_host boolean not null default false,
  avatar text,
  object_photo text,
  score integer not null default 0,
  profile_answers jsonb not null default '{}'::jsonb,
  profile_submitted boolean not null default false,
  joined_at timestamptz not null default now()
);

create table if not exists swgt_answers (
  id uuid primary key default gen_random_uuid(),
  game_code text not null references swgt_games(code) on delete cascade,
  round_id text not null,
  player_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists swgt_players_game_idx on swgt_players(game_code);
create index if not exists swgt_answers_round_idx on swgt_answers(game_code, round_id);

-- ---------- privacy: stop collecting phone numbers ----------
-- The phone field was never used. Remove existing numbers and the column.
alter table swgt_players drop column if exists phone;

-- ---------- sanity limits (cheap abuse guards) ----------
alter table swgt_players drop constraint if exists swgt_players_name_len;
alter table swgt_players add constraint swgt_players_name_len check (char_length(name) between 1 and 24);
alter table swgt_players drop constraint if exists swgt_players_photo_len;
alter table swgt_players add constraint swgt_players_photo_len
  check (coalesce(length(avatar),0) < 200000 and coalesce(length(object_photo),0) < 200000);

-- ---------- row level security ----------
alter table swgt_games   enable row level security;
alter table swgt_players enable row level security;
alter table swgt_answers enable row level security;

drop policy if exists "games read"     on swgt_games;
drop policy if exists "games write"    on swgt_games;
drop policy if exists "games update"   on swgt_games;
drop policy if exists "players read"   on swgt_players;
drop policy if exists "players write"  on swgt_players;
drop policy if exists "players update" on swgt_players;
drop policy if exists "answers read"   on swgt_answers;
drop policy if exists "answers write"  on swgt_answers;

-- only games from the last 24h are visible or writable at all
create policy "games read"     on swgt_games   for select using (created_at > now() - interval '24 hours');
create policy "games write"    on swgt_games   for insert with check (true);
create policy "games update"   on swgt_games   for update using (created_at > now() - interval '24 hours');
create policy "players read"   on swgt_players for select using (joined_at > now() - interval '24 hours');
create policy "players write"  on swgt_players for insert with check (true);
create policy "players update" on swgt_players for update using (joined_at > now() - interval '24 hours');
create policy "answers read"   on swgt_answers for select using (created_at > now() - interval '24 hours');
create policy "answers write"  on swgt_answers for insert with check (true);
-- (no delete policies: nothing can be deleted through the API)

-- ---------- cleanup: delete games older than 24h ----------
create or replace function swgt_cleanup() returns void
language sql security definer set search_path = public as $$
  delete from swgt_games where created_at < now() - interval '24 hours';
$$;
revoke all on function swgt_cleanup() from public, anon, authenticated;

-- hourly via pg_cron (enable the extension under Database → Extensions)
create extension if not exists pg_cron;
select cron.unschedule('swgt-cleanup') where exists (select 1 from cron.job where jobname='swgt-cleanup');
select cron.schedule('swgt-cleanup', '17 * * * *', $$select swgt_cleanup()$$);
