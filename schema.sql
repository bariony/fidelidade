-- Fidelidade NFC (MVP). Tabelas com prefixo fid_ para não tocar em nada existente.

create table if not exists public.fid_stores (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null,
  reward text not null default 'Brinde grátis',
  stamps_goal int not null default 10 check (stamps_goal between 2 and 50),
  cooldown_minutes int not null default 30 check (cooldown_minutes >= 0),
  color text not null default '#7c3aed',
  created_at timestamptz not null default now()
);

create table if not exists public.fid_tags (
  id text primary key,
  store_id uuid not null references public.fid_stores(id) on delete cascade,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.fid_customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.fid_stores(id) on delete cascade,
  name text not null,
  whatsapp text not null,
  token uuid not null default gen_random_uuid(),
  stamps int not null default 0,
  rewards_available int not null default 0,
  rewards_redeemed int not null default 0,
  total_stamps int not null default 0,
  last_stamp_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, whatsapp),
  unique (token)
);

create table if not exists public.fid_events (
  id bigserial primary key,
  store_id uuid not null references public.fid_stores(id) on delete cascade,
  customer_id uuid not null references public.fid_customers(id) on delete cascade,
  tag_id text,
  kind text not null check (kind in ('stamp','reward_earned','redeem')),
  created_at timestamptz not null default now()
);

create index if not exists fid_events_store_idx on public.fid_events(store_id, created_at desc);
create index if not exists fid_customers_store_idx on public.fid_customers(store_id);

-- RLS: o lojista (owner) só enxerga o que é dele. O cliente final NÃO acessa tabelas direto: só via funções abaixo.
alter table public.fid_stores enable row level security;
alter table public.fid_tags enable row level security;
alter table public.fid_customers enable row level security;
alter table public.fid_events enable row level security;

create policy fid_stores_owner on public.fid_stores for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

create policy fid_tags_owner on public.fid_tags for all to authenticated
  using (exists (select 1 from public.fid_stores s where s.id = store_id and s.owner = auth.uid()))
  with check (exists (select 1 from public.fid_stores s where s.id = store_id and s.owner = auth.uid()));

create policy fid_customers_owner_read on public.fid_customers for select to authenticated
  using (exists (select 1 from public.fid_stores s where s.id = store_id and s.owner = auth.uid()));

create policy fid_events_owner_read on public.fid_events for select to authenticated
  using (exists (select 1 from public.fid_stores s where s.id = store_id and s.owner = auth.uid()));

-- ===== Funções públicas (chamadas pela página do cliente) =====

create or replace function public.fid_state_json(c public.fid_customers, s public.fid_stores)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'token', c.token, 'name', c.name, 'stamps', c.stamps,
    'goal', s.stamps_goal, 'rewards_available', c.rewards_available,
    'rewards_redeemed', c.rewards_redeemed, 'reward', s.reward,
    'store', s.name, 'color', s.color)
$$;

create or replace function public.fid_get_store(p_tag text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('store', s.name, 'color', s.color, 'reward', s.reward, 'goal', s.stamps_goal)
  from fid_tags t join fid_stores s on s.id = t.store_id
  where t.id = p_tag and t.active
$$;

create or replace function public.fid_register(p_tag text, p_name text, p_whatsapp text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s fid_stores; c fid_customers; w text;
begin
  select st.* into s from fid_tags t join fid_stores st on st.id = t.store_id where t.id = p_tag and t.active;
  if not found then return jsonb_build_object('error','tag_invalida'); end if;
  w := regexp_replace(coalesce(p_whatsapp,''), '\D', '', 'g');
  if length(w) < 10 or length(trim(coalesce(p_name,''))) < 2 then
    return jsonb_build_object('error','dados_invalidos');
  end if;
  insert into fid_customers (store_id, name, whatsapp) values (s.id, left(trim(p_name),80), w)
  on conflict (store_id, whatsapp) do update set name = fid_customers.name
  returning * into c;
  return fid_state_json(c, s);
end $$;

create or replace function public.fid_state(p_tag text, p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s fid_stores; c fid_customers;
begin
  select st.* into s from fid_tags t join fid_stores st on st.id = t.store_id where t.id = p_tag and t.active;
  if not found then return jsonb_build_object('error','tag_invalida'); end if;
  select * into c from fid_customers where token = p_token and store_id = s.id;
  if not found then return jsonb_build_object('error','cliente_nao_encontrado'); end if;
  return fid_state_json(c, s);
end $$;

create or replace function public.fid_stamp(p_tag text, p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s fid_stores; c fid_customers; wait_s int; earned boolean := false;
begin
  select st.* into s from fid_tags t join fid_stores st on st.id = t.store_id where t.id = p_tag and t.active;
  if not found then return jsonb_build_object('error','tag_invalida'); end if;
  select * into c from fid_customers where token = p_token and store_id = s.id for update;
  if not found then return jsonb_build_object('error','cliente_nao_encontrado'); end if;

  if c.last_stamp_at is not null and now() < c.last_stamp_at + make_interval(mins => s.cooldown_minutes) then
    wait_s := ceil(extract(epoch from (c.last_stamp_at + make_interval(mins => s.cooldown_minutes) - now())))::int;
    return fid_state_json(c, s) || jsonb_build_object('stamped', false, 'wait_seconds', wait_s);
  end if;

  c.stamps := c.stamps + 1;
  c.total_stamps := c.total_stamps + 1;
  if c.stamps >= s.stamps_goal then
    c.stamps := 0; c.rewards_available := c.rewards_available + 1; earned := true;
  end if;
  update fid_customers set stamps = c.stamps, total_stamps = c.total_stamps,
    rewards_available = c.rewards_available, last_stamp_at = now() where id = c.id;
  insert into fid_events (store_id, customer_id, tag_id, kind) values (s.id, c.id, p_tag, 'stamp');
  if earned then insert into fid_events (store_id, customer_id, tag_id, kind) values (s.id, c.id, p_tag, 'reward_earned'); end if;
  return fid_state_json(c, s) || jsonb_build_object('stamped', true, 'earned', earned);
end $$;

create or replace function public.fid_redeem(p_tag text, p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s fid_stores; c fid_customers;
begin
  select st.* into s from fid_tags t join fid_stores st on st.id = t.store_id where t.id = p_tag and t.active;
  if not found then return jsonb_build_object('error','tag_invalida'); end if;
  select * into c from fid_customers where token = p_token and store_id = s.id for update;
  if not found then return jsonb_build_object('error','cliente_nao_encontrado'); end if;
  if c.rewards_available < 1 then return fid_state_json(c, s) || jsonb_build_object('redeemed', false); end if;
  update fid_customers set rewards_available = rewards_available - 1, rewards_redeemed = rewards_redeemed + 1
    where id = c.id returning * into c;
  insert into fid_events (store_id, customer_id, tag_id, kind) values (s.id, c.id, p_tag, 'redeem');
  return fid_state_json(c, s) || jsonb_build_object('redeemed', true);
end $$;

-- Recuperar o cartão em outro celular pelo WhatsApp
create or replace function public.fid_recover(p_tag text, p_whatsapp text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s fid_stores; c fid_customers; w text;
begin
  select st.* into s from fid_tags t join fid_stores st on st.id = t.store_id where t.id = p_tag and t.active;
  if not found then return jsonb_build_object('error','tag_invalida'); end if;
  w := regexp_replace(coalesce(p_whatsapp,''), '\D', '', 'g');
  select * into c from fid_customers where store_id = s.id and whatsapp = w;
  if not found then return jsonb_build_object('error','cliente_nao_encontrado'); end if;
  return fid_state_json(c, s);
end $$;

revoke all on function public.fid_state_json(public.fid_customers, public.fid_stores) from public, anon, authenticated;
grant execute on function public.fid_get_store(text) to anon, authenticated;
grant execute on function public.fid_register(text, text, text) to anon, authenticated;
grant execute on function public.fid_state(text, uuid) to anon, authenticated;
grant execute on function public.fid_stamp(text, uuid) to anon, authenticated;
grant execute on function public.fid_redeem(text, uuid) to anon, authenticated;
grant execute on function public.fid_recover(text, text) to anon, authenticated;

-- ===== v2: ajuste manual pelo lojista + detalhe nos eventos =====
alter table public.fid_events drop constraint if exists fid_events_kind_check;
alter table public.fid_events add constraint fid_events_kind_check check (kind in ('stamp','reward_earned','redeem','adjust'));
alter table public.fid_events add column if not exists detail text;

create or replace function public.fid_admin_adjust(p_customer uuid, p_stamps int, p_rewards int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s fid_stores; c fid_customers; old_s int; old_r int;
begin
  if auth.uid() is null then return jsonb_build_object('error','nao_autenticado'); end if;
  select * into c from fid_customers where id = p_customer for update;
  if not found then return jsonb_build_object('error','cliente_nao_encontrado'); end if;
  select * into s from fid_stores where id = c.store_id and owner = auth.uid();
  if not found then return jsonb_build_object('error','sem_permissao'); end if;
  if p_stamps is null or p_stamps < 0 or p_stamps >= s.stamps_goal or p_rewards is null or p_rewards < 0 then
    return jsonb_build_object('error','valores_invalidos');
  end if;
  old_s := c.stamps; old_r := c.rewards_available;
  update fid_customers set stamps = p_stamps, rewards_available = p_rewards where id = c.id;
  insert into fid_events (store_id, customer_id, kind, detail)
    values (s.id, c.id, 'adjust', format('Carimbos %s→%s · Prêmios %s→%s', old_s, p_stamps, old_r, p_rewards));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.fid_admin_adjust(uuid, int, int) from public, anon;
grant execute on function public.fid_admin_adjust(uuid, int, int) to authenticated;

-- ===== v1 (auto-confirmação de e-mail no MVP; remover antes de abrir para muitos lojistas) =====
-- create trigger fid_auto_confirm_email before insert on auth.users for each row execute function public.fid_auto_confirm_email();
