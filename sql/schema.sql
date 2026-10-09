create extension if not exists pgcrypto;

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'unsubscribed')),
  verification_token text unique,
  unsubscribe_token uuid unique,
  verified_at timestamptz,
  subscribed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint subscribers_verification_state_check check (
    (status = 'pending' and verification_token is not null and unsubscribe_token is null
      and verified_at is null and subscribed_at is null and unsubscribed_at is null)
    or (status = 'active' and verification_token is null and unsubscribe_token is not null
      and subscribed_at is not null and unsubscribed_at is null)
    or (status = 'unsubscribed' and verification_token is null and unsubscribe_token is not null
      and unsubscribed_at is not null)
  )
);

alter table public.subscribers
  drop constraint if exists subscribers_verification_state_check;
alter table public.subscribers
  add constraint subscribers_verification_state_check check (
    (status = 'pending' and verification_token is not null and unsubscribe_token is null
      and verified_at is null and subscribed_at is null and unsubscribed_at is null)
    or (status = 'active' and verification_token is null and unsubscribe_token is not null
      and subscribed_at is not null and unsubscribed_at is null)
    or (status = 'unsubscribed' and verification_token is null and unsubscribe_token is not null
      and unsubscribed_at is not null)
  );

create index if not exists subscribers_active_id_idx
  on public.subscribers (id)
  where status = 'active';

create table if not exists public.newsletters (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 300),
  subject text not null check (length(trim(subject)) between 1 and 998),
  html_content text not null check (length(trim(html_content)) > 0 and length(html_content) <= 450000),
  send_at timestamptz not null,
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists newsletters_due_idx
  on public.newsletters (send_at, id)
  where status in ('scheduled', 'sending');

create or replace function public.set_newsletters_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists newsletters_updated_at_trigger on public.newsletters;
create trigger newsletters_updated_at_trigger
  before update on public.newsletters
  for each row execute function public.set_newsletters_updated_at();

create table if not exists public.newsletter_deliveries (
  newsletter_id uuid not null references public.newsletters(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  status text not null check (status in ('sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  sent_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (newsletter_id, subscriber_id)
);

create index if not exists newsletter_deliveries_status_idx
  on public.newsletter_deliveries (newsletter_id, status);

alter table public.subscribers enable row level security;
alter table public.newsletters enable row level security;
alter table public.newsletter_deliveries enable row level security;

revoke all on public.subscribers from anon, authenticated;
revoke all on public.newsletters from anon, authenticated;
revoke all on public.newsletter_deliveries from anon, authenticated;
