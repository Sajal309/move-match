create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create type public.exercise_key as enum ('push_up', 'pull_up');
create type public.match_mode as enum ('friend', 'ranked');
create type public.match_state as enum ('WAITING_READY', 'COUNTDOWN', 'ACTIVE', 'SETTLING', 'COMPLETED', 'CANCELLED', 'VOIDED');
create type public.invite_state as enum ('OPEN', 'REDEEMED', 'EXPIRED', 'CANCELLED');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  normalized_handle text unique,
  display_name text not null default 'New player' check (char_length(display_name) between 3 and 20),
  avatar_id text not null default 'move-01',
  adult_confirmed_at timestamptz,
  consent_version text,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleting', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  audio boolean not null default true,
  haptics boolean not null default true,
  spoken_count boolean not null default false,
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  locale text not null default 'en',
  analytics_opt_in boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (end_at > start_at),
  exclude using gist (tstzrange(start_at, end_at, '[)') with &&)
);

insert into public.seasons(name, start_at, end_at)
select 'Season starting ' || to_char(start_utc, 'YYYY-MM-DD'), start_utc, start_utc + interval '8 weeks'
from (select date_trunc('week', now() at time zone 'utc') at time zone 'utc' as start_utc) current_week;

create table public.exercise_rules (
  exercise public.exercise_key not null,
  version text not null,
  model_version text not null,
  config jsonb not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (exercise, version)
);

create table public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  mode public.match_mode not null,
  exercise public.exercise_key not null,
  rule_version text not null,
  model_version text not null,
  season_id uuid references public.seasons(id) on delete set null,
  state public.match_state not null default 'WAITING_READY',
  duration_ms integer not null default 45000 check (duration_ms = 45000),
  ready_deadline_at timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (exercise, rule_version) references public.exercise_rules(exercise, version)
);

create table public.match_participants (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  slot smallint not null check (slot in (1, 2)),
  display_name_snapshot text not null,
  avatar_id_snapshot text not null,
  ready_at timestamptz,
  ready_expires_at timestamptz,
  last_seen_at timestamptz,
  accepted_count integer not null default 0 check (accepted_count >= 0),
  connection_state text not null default 'connected' check (connection_state in ('connected', 'disconnected', 'forfeit')),
  session_nonce_hash text not null,
  created_at timestamptz not null default now(),
  unique (match_id, slot),
  unique (match_id, user_id)
);
create index match_participants_user_history on public.match_participants(user_id, match_id) where user_id is not null;

create table public.queue_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  exercise public.exercise_key not null,
  rule_version text not null,
  app_protocol integer not null default 1,
  rating integer not null default 1000,
  state text not null default 'WAITING' check (state in ('WAITING', 'RESERVED', 'CANCELLED', 'EXPIRED', 'MATCHED')),
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (exercise, rule_version) references public.exercise_rules(exercise, version)
);
create unique index queue_entries_one_waiting on public.queue_entries(user_id) where state in ('WAITING', 'RESERVED');
create index queue_entries_pairing on public.queue_entries(exercise, state, created_at) where state = 'WAITING';

create table public.active_sessions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  match_id uuid references public.matches(id) on delete cascade,
  queue_id uuid references public.queue_entries(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (num_nonnulls(match_id, queue_id) = 1)
);

create table public.rep_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  seq integer not null check (seq > 0),
  cycle_start_ms integer not null,
  cycle_end_ms integer not null,
  status text not null check (status in ('accepted', 'rejected')),
  reason text,
  summary jsonb not null,
  received_at timestamptz not null default now(),
  unique (match_id, user_id, seq)
);
create index rep_events_match_score on public.rep_events(match_id, user_id, status);
create index rep_events_retention on public.rep_events(received_at);

create table public.match_results (
  match_id uuid primary key references public.matches(id) on delete cascade,
  outcome text not null check (outcome in ('player_1_win', 'player_2_win', 'draw', 'forfeit', 'void')),
  winner_user_id uuid references public.profiles(id) on delete set null,
  score_player_1 integer not null check (score_player_1 >= 0),
  score_player_2 integer not null check (score_player_2 >= 0),
  settled_at timestamptz not null default now(),
  reason text,
  result_hash text not null
);

create table public.exercise_ratings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  exercise public.exercise_key not null,
  season_id uuid not null references public.seasons(id) on delete cascade,
  rating integer not null default 1000,
  games integer not null default 0,
  placement_opponents_count integer not null default 0,
  distinct_opponents uuid[] not null default '{}',
  eligible boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, exercise, season_id)
);

create table public.rating_ledger (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  before_rating integer not null,
  delta integer not null,
  after_rating integer not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

create table public.xp_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  reward_type text not null,
  amount integer not null check (amount >= 0),
  utc_day date not null,
  created_at timestamptz not null default now(),
  unique (user_id, source_type, source_id, reward_type)
);
create table public.user_progress (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  total_xp integer not null default 0,
  updated_at timestamptz not null default now()
);
create table public.badges (
  user_id uuid not null references public.profiles(id) on delete cascade,
  badge_key text not null,
  source_id uuid,
  awarded_at timestamptz not null default now(),
  primary key (user_id, badge_key)
);
create table public.activity_days (
  user_id uuid not null references public.profiles(id) on delete cascade,
  utc_date date not null,
  source_id uuid not null,
  primary key (user_id, utc_date)
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  host_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key uuid not null,
  match_id uuid not null unique references public.matches(id) on delete cascade,
  expires_at timestamptz not null,
  redeemed_by uuid references public.profiles(id) on delete set null,
  state public.invite_state not null default 'OPEN',
  created_at timestamptz not null default now(),
  unique (host_id, idempotency_key)
);

create table public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid references public.profiles(id) on delete set null,
  match_id uuid references public.matches(id) on delete set null,
  category text not null check (category in ('offensive_name', 'suspected_cheating', 'harassment', 'tracking_result')),
  description text check (description is null or char_length(description) <= 500),
  state text not null default 'open' check (state in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);
create index reports_open on public.reports(created_at) where state in ('open', 'reviewing');

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  actor_admin_id uuid,
  target_id uuid references public.profiles(id) on delete set null,
  reason text not null,
  action text not null,
  created_at timestamptz not null default now()
);
create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbox_unpublished on public.outbox(created_at) where published_at is null;
create table public.deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'processing', 'complete', 'failed')),
  attempts integer not null default 0,
  completion_at timestamptz,
  error_code text
);
create table public.practice_syncs (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  exercise public.exercise_key not null,
  duration_ms integer not null check (duration_ms >= 45000),
  accepted_reps integer not null check (accepted_reps >= 1),
  rule_version text not null,
  created_at timestamptz not null default now(),
  unique (user_id, id)
);

insert into public.exercise_rules (exercise, version, model_version, config, enabled) values
('push_up', 'push_up_v1', 'google-pose-landmarker-lite-float16', '{"top":155,"bottom":95,"bodyTop":160,"bodyBottom":155,"topHoldMs":150,"bottomHoldMs":120,"minCycleMs":600,"criticalGapMs":250}', false),
('pull_up', 'pull_up_v1', 'google-pose-landmarker-lite-float16', '{"hang":155,"top":80,"torsoRiseRatio":0.25,"hangHoldMs":200,"topHoldMs":120,"minCycleMs":900,"criticalGapMs":250}', false);
insert into public.feature_flags(key, enabled) values
('friend_matches_enabled', false), ('quick_match_enabled', false), ('ranked_push_up_enabled', false), ('ranked_pull_up_enabled', false)
on conflict (key) do nothing;

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.seasons enable row level security;
alter table public.exercise_rules enable row level security;
alter table public.feature_flags enable row level security;
alter table public.matches enable row level security;
alter table public.match_participants enable row level security;
alter table public.queue_entries enable row level security;
alter table public.active_sessions enable row level security;
alter table public.rep_events enable row level security;
alter table public.match_results enable row level security;
alter table public.exercise_ratings enable row level security;
alter table public.rating_ledger enable row level security;
alter table public.xp_ledger enable row level security;
alter table public.user_progress enable row level security;
alter table public.badges enable row level security;
alter table public.activity_days enable row level security;
alter table public.invites enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.outbox enable row level security;
alter table public.deletion_jobs enable row level security;
alter table public.practice_syncs enable row level security;

do $$ declare table_name text;
begin
  foreach table_name in array array['profiles','user_preferences','seasons','exercise_rules','feature_flags','matches','match_participants','queue_entries','active_sessions','rep_events','match_results','exercise_ratings','rating_ledger','xp_ledger','user_progress','badges','activity_days','invites','blocks','reports','moderation_actions','outbox','deletion_jobs','practice_syncs'] loop
    execute format('create policy deny_direct_client_access on public.%I for all to anon, authenticated using (false) with check (false)', table_name);
  end loop;
end $$;
