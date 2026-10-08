create extension if not exists pgcrypto;  -- gen_random_uuid()

create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
-- case-insensitive uniqueness among non-archived categories
create unique index categories_name_active_uq
  on categories (lower(name)) where archived_at is null;

create table items (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id),
  title       text not null,
  status      text not null default 'active'
              check (status in ('active','paused','done')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index items_category_idx on items (category_id);

create table picks (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid not null references items(id),
  picked_at timestamptz not null default now()
);
create index picks_picked_at_idx on picks (picked_at desc);

create table settings (
  key   text primary key,
  value jsonb not null
);

-- Seed data lives here (not in boot code) so it runs exactly once.
insert into categories (name, sort_order) values
  ('Movies', 0),
  ('Shows', 1),
  ('Books', 2),
  ('Games', 3);

insert into settings (key, value) values
  ('lambda', '0.7'),
  ('k', '4'),
  ('floor', '0.03'),
  ('categoryFirst', 'false');
