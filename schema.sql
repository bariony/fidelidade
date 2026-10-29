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

-- ===== v3: limite diário por cliente e checagem de localização (raio da loja) =====
alter table public.fid_stores
  add column if not exists max_per_day int not null default 3 check (max_per_day between 1 and 50),
  add column if not exists geo_required boolean not null default false,
  add column if not exists geo_lat double precision,
  add column if not exists geo_lng double precision,
  add column if not exists geo_radius_m int not null default 150 check (geo_radius_m between 20 and 5000);
alter table public.fid_stores drop constraint if exists fid_stores_geo_chk;
alter table public.fid_stores add constraint fid_stores_geo_chk
  check (not geo_required or (geo_lat is not null and geo_lng is not null));
-- fid_get_store passa a devolver 'geo_required'; fid_stamp(p_tag, p_token, p_lat, p_lng, p_acc) substitui a versão de 2 argumentos
-- (definições completas aplicadas via migration "daily_limit_and_geofence" no projeto).

-- ===== v4: estatísticas do painel =====
-- fid_stats(p_store uuid) -> jsonb (hoje, 7 dias, 30 dias, séries diárias e mensais). Só o dono da loja consegue chamar.
-- (definição completa aplicada via migration "fid_stats_dashboard" no projeto).

-- ===== v5: resgate pendente com prazo =====
-- fid_stores.reward_valid_days (1-90) e attendant_pin (opcional); tabela fid_redemptions (pending/redeemed/expired, code, expires_at).
-- Funções: fid_expire (interna), fid_redeem (cliente pede o resgate e abre o prazo), fid_confirm_redeem (atendente com PIN no celular do cliente),
-- fid_admin_pending e fid_admin_redeem (painel, aba Retiradas). fid_state_json passa a devolver 'pending', 'valid_days', 'has_pin'.
-- (definições completas aplicadas via migration "pending_redemption_flow" no projeto).

-- ===== v6: visual da loja, links e carimbo bônus =====
-- fid_stores: stamp_icon (emoji ou 'star'), stamp_color, show_links, instagram_url, facebook_url, site_url, google_url, bonus_instagram, bonus_facebook, bonus_site.
-- fid_claims(customer_id, kind) com chave primária composta: cada bônus só uma vez por cliente. fid_claim(p_tag,p_token,p_kind) concede o carimbo.
-- O Google fica sem bônus de propósito (política do Google proíbe recompensa por avaliação).
-- (definições completas aplicadas via migration "store_branding_links_bonus" no projeto).

-- ===== v7: WhatsApp na lista de links e tamanho do símbolo =====
-- fid_stores.whatsapp_url, fid_stores.stamp_scale (50-160, % do tamanho do símbolo); fid_state_json devolve 'scale' e o link 'whatsapp'
-- (aplicado via migration "whatsapp_link_and_stamp_scale" no projeto).

-- ===== v8: visibilidade por link =====
-- fid_stores.links_off text[] (links escondidos do cartão); show_links passa a valer true por padrão e não é mais usado na tela.
-- (aplicado via migration "links_per_row_visibility" no projeto).

-- ===== v9: superadmin, planos e cobrança manual =====
-- fid_superadmins(user_id); fid_stores: acquired_at, ship_days, plan_days, renews_at, is_trial, blocked, referred_by, admin_note.
-- fid_billing: histórico (venda, renovação, teste, bloqueio). O lojista só atualiza colunas de configuração (grant por coluna).
-- Funções: fid_is_super, fid_super_overview, fid_super_store, fid_super_sale, fid_super_renew, fid_super_trial, fid_super_block, fid_super_update,
-- fid_plan_status (ativa/trial/tolerancia 7 dias/vencida/bloqueada) e fid_store_active; fid_stamp e fid_claim param quando a loja está suspensa.
-- (aplicado via migrations "superadmin_plans_billing" e "superadmin_rpcs" no projeto). Painel: super.html.

-- ===== v10: visão geral do admin com mini-gráficos =====
-- fid_super_overview passa a devolver 'spark' (14 dias) por loja e 'spark_total' (todas as lojas)
-- (aplicado via migration "super_overview_spark" no projeto).

-- v11: identidade Carimbô — cores padrão de novas lojas
alter table public.fid_stores alter column color set default '#14296B', alter column stamp_color set default '#FBF7EE';


-- ===== v12: representantes, pedidos, livro-razão de comissões e repasses =====
-- (aplicado via migrations reps_tables, reps_functions_core, reps_functions_admin e super_overview_rep)
-- fid_super_overview também devolve rep_id e rep_name por loja.
-- ===== Representantes: tabelas =====
create table if not exists public.fid_reps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  invite text unique,
  name text not null check (char_length(name) between 2 and 80),
  email text check (email is null or char_length(email) <= 120),
  whatsapp text check (whatsapp is null or char_length(whatsapp) <= 30),
  code text not null unique check (code ~ '^[a-z0-9]{3,20}$'),
  pix_type text check (pix_type is null or pix_type in ('cpf','cnpj','email','telefone','aleatoria')),
  pix_key text check (pix_key is null or char_length(pix_key) <= 120),
  kit_cost numeric(10,2) not null default 45 check (kit_cost >= 0),
  kit_share_pct numeric(5,2) not null default 50 check (kit_share_pct between 0 and 100),
  recur_pct numeric(5,2) not null default 20 check (recur_pct between 0 and 100),
  release_kit_days int not null default 15 check (release_kit_days between 0 and 120),
  release_recur_days int not null default 7 check (release_recur_days between 0 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.fid_reps enable row level security;

alter table public.fid_stores add column if not exists rep_id uuid references public.fid_reps(id);
create index if not exists fid_stores_rep_idx on public.fid_stores(rep_id);

alter table public.fid_billing add column if not exists refund_of bigint references public.fid_billing(id);
alter table public.fid_billing drop constraint if exists fid_billing_kind_check;
alter table public.fid_billing add constraint fid_billing_kind_check
  check (kind in ('sale','renewal','trial','adjust','block','unblock','refund'));

create table if not exists public.fid_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.fid_stores(id) on delete set null,
  owner uuid references auth.users(id) on delete set null,
  rep_id uuid references public.fid_reps(id),
  rep_code text,
  buyer_name text not null,
  buyer_whatsapp text not null,
  buyer_email text,
  ship_address text not null,
  amount numeric(10,2) not null,
  status text not null default 'aguardando_pagamento'
    check (status in ('aguardando_pagamento','pago','enviado','cancelado','reembolsado')),
  tracking text,
  note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  shipped_at timestamptz
);
alter table public.fid_orders enable row level security;
create index if not exists fid_orders_rep_idx on public.fid_orders(rep_id);

create table if not exists public.fid_payouts (
  id bigint generated always as identity primary key,
  rep_id uuid not null references public.fid_reps(id),
  cycle date not null,
  total numeric(10,2) not null check (total > 0),
  pix_type text,
  pix_key text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  paid_note text
);
alter table public.fid_payouts enable row level security;

create table if not exists public.fid_commissions (
  id bigint generated always as identity primary key,
  rep_id uuid not null references public.fid_reps(id),
  store_id uuid references public.fid_stores(id) on delete set null,
  store_name text,
  billing_id bigint unique references public.fid_billing(id),
  ref_id bigint references public.fid_commissions(id),
  kind text not null check (kind in ('aquisicao','recorrencia','estorno')),
  base_amount numeric(10,2),
  amount numeric(10,2) not null,
  event_date date not null,
  release_date date not null,
  payout_id bigint references public.fid_payouts(id),
  cancelled_at timestamptz,
  cancel_reason text,
  note text,
  created_at timestamptz not null default now()
);
alter table public.fid_commissions enable row level security;
create index if not exists fid_comm_rep_idx on public.fid_commissions(rep_id);
create index if not exists fid_comm_store_idx on public.fid_commissions(store_id);
create index if not exists fid_comm_payout_idx on public.fid_commissions(payout_id);

-- ===== Auxiliares (não expostas) =====
create or replace function public.fid_comm_status(p_cancelled timestamptz, p_payout bigint, p_release date) returns text
language sql stable set search_path to 'public' as $$
  select case
    when p_cancelled is not null then 'cancelada'
    when p_payout is not null then (select case when p.paid_at is not null then 'paga' else 'em_repasse' end from public.fid_payouts p where p.id = p_payout)
    when p_release <= public.fid_today() then 'liberada'
    else 'prevista' end
$$;

create or replace function public.fid_next_payday() returns date
language sql stable set search_path to 'public' as $$
  select case when extract(day from public.fid_today()) <= 15
    then (date_trunc('month', public.fid_today())::date + 14)
    else (date_trunc('month', public.fid_today())::date + interval '1 month' + interval '14 days')::date end
$$;

-- cria a comissão de um lançamento de cobrança (venda do kit ou mensalidade paga)
create or replace function public.fid_make_commission(b public.fid_billing) returns void
language plpgsql security definer set search_path to 'public' as $$
declare s public.fid_stores; r public.fid_reps; amt numeric; k text; ev date; rel date;
begin
  if b.kind not in ('sale','renewal') then return; end if;
  if coalesce(b.amount, 0) <= 0 then return; end if;
  select * into s from public.fid_stores where id = b.store_id;
  if not found or s.rep_id is null then return; end if;
  select * into r from public.fid_reps where id = s.rep_id;
  if not found then return; end if;
  ev := (b.created_at at time zone 'America/Sao_Paulo')::date;
  if b.kind = 'sale' then
    amt := round(greatest(b.amount - r.kit_cost, 0) * r.kit_share_pct / 100, 2);
    k := 'aquisicao'; rel := ev + r.release_kit_days;
  else
    -- mensalidade só gera comissão se a loja já teve a venda do kit (1º mês fica fora)
    if not exists (select 1 from public.fid_billing x where x.store_id = b.store_id and x.kind = 'sale' and x.id < b.id) then return; end if;
    amt := round(b.amount * r.recur_pct / 100, 2);
    k := 'recorrencia'; rel := ev + r.release_recur_days;
  end if;
  if amt <= 0 then return; end if;
  insert into public.fid_commissions (rep_id, store_id, store_name, billing_id, kind, base_amount, amount, event_date, release_date)
  values (r.id, s.id, s.name, b.id, k, b.amount, amt, ev, rel)
  on conflict (billing_id) do nothing;
end $$;

create or replace function public.fid_billing_commission_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.fid_make_commission(new);
  return new;
end $$;
drop trigger if exists fid_billing_commission on public.fid_billing;
create trigger fid_billing_commission after insert on public.fid_billing
  for each row execute function public.fid_billing_commission_trg();

-- painel do representante (a MESMA visão para ele e para você)
create or replace function public.fid_rep_dash(p_rep uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r public.fid_reps; res jsonb;
begin
  select * into r from public.fid_reps where id = p_rep;
  if not found then return jsonb_build_object('error','representante_nao_encontrado'); end if;
  res := jsonb_build_object(
    'today', public.fid_today(),
    'next_payday', public.fid_next_payday(),
    'rep', jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code, 'whatsapp', r.whatsapp, 'email', r.email,
       'pix_type', r.pix_type, 'pix_key', r.pix_key, 'kit_cost', r.kit_cost, 'kit_share_pct', r.kit_share_pct,
       'recur_pct', r.recur_pct, 'release_kit_days', r.release_kit_days, 'release_recur_days', r.release_recur_days, 'active', r.active),
    'totals', (select jsonb_build_object(
        'prevista', coalesce(sum(amount) filter (where st = 'prevista'), 0),
        'liberada', coalesce(sum(amount) filter (where st = 'liberada'), 0),
        'em_repasse', coalesce(sum(amount) filter (where st = 'em_repasse'), 0),
        'paga', coalesce(sum(amount) filter (where st = 'paga'), 0))
      from (select c.amount, public.fid_comm_status(c.cancelled_at, c.payout_id, c.release_date) st from public.fid_commissions c where c.rep_id = p_rep) x),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'created_at', s.created_at,
        'whatsapp', coalesce(o.buyer_whatsapp, s.whatsapp_url),
        'order_status', o.status,
        'plan_status', public.fid_plan_status(s), 'renews_at', s.renews_at,
        'renewals_paid', (select count(*) from public.fid_billing b where b.store_id = s.id and b.kind = 'renewal' and not exists (select 1 from public.fid_billing rf where rf.refund_of = b.id)),
        'earned', coalesce((select sum(c.amount) from public.fid_commissions c where c.store_id = s.id and c.rep_id = p_rep and c.cancelled_at is null), 0))
        order by s.created_at desc)
      from public.fid_stores s
      left join lateral (select * from public.fid_orders o2 where o2.store_id = s.id order by o2.created_at desc limit 1) o on true
      where s.rep_id = p_rep), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'store_name', c.store_name, 'kind', c.kind, 'base_amount', c.base_amount, 'amount', c.amount,
        'event_date', c.event_date, 'release_date', c.release_date, 'status', public.fid_comm_status(c.cancelled_at, c.payout_id, c.release_date),
        'reason', c.cancel_reason, 'note', c.note, 'cycle', p.cycle) order by c.created_at desc, c.id desc)
      from (select * from public.fid_commissions where rep_id = p_rep order by created_at desc, id desc limit 300) c
      left join public.fid_payouts p on p.id = c.payout_id), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'cycle', p.cycle, 'total', p.total, 'paid_at', p.paid_at) order by p.cycle desc, p.id desc)
      from public.fid_payouts p where p.rep_id = p_rep), '[]'::jsonb)
  );
  return res;
end $$;

-- ===== Cliente: compra (cria a loja já vinculada ao representante) =====
create or replace function public.fid_order_create(p_code text, p_store_name text, p_buyer_name text, p_whatsapp text, p_ship_address text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); rp public.fid_reps; sid uuid; oid uuid; mail text; wa text; v_code text;
begin
  if uid is null then return jsonb_build_object('error','entre_primeiro'); end if;
  p_store_name := trim(coalesce(p_store_name, '')); p_buyer_name := trim(coalesce(p_buyer_name, '')); p_ship_address := trim(coalesce(p_ship_address, ''));
  wa := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  if char_length(p_store_name) < 2 or char_length(p_store_name) > 80 then return jsonb_build_object('error','nome_da_loja_invalido'); end if;
  if char_length(p_buyer_name) < 2 or char_length(p_buyer_name) > 80 then return jsonb_build_object('error','nome_invalido'); end if;
  if char_length(wa) < 10 or char_length(wa) > 13 then return jsonb_build_object('error','whatsapp_invalido'); end if;
  if char_length(p_ship_address) < 10 or char_length(p_ship_address) > 300 then return jsonb_build_object('error','endereco_invalido'); end if;
  v_code := lower(trim(coalesce(p_code, '')));
  if v_code <> '' then select * into rp from public.fid_reps r where r.code = v_code and r.active; end if;
  select email into mail from auth.users where id = uid;
  -- evita pedido duplicado por duplo clique
  select o.id, o.store_id into oid, sid from public.fid_orders o
   where o.owner = uid and o.status = 'aguardando_pagamento' and o.buyer_whatsapp = wa and o.created_at > now() - interval '5 minutes' limit 1;
  if oid is not null then return jsonb_build_object('ok', true, 'order', oid, 'store', sid, 'dup', true); end if;
  insert into public.fid_stores (owner, name, rep_id) values (uid, p_store_name, rp.id) returning id into sid;
  insert into public.fid_orders (store_id, owner, rep_id, rep_code, buyer_name, buyer_whatsapp, buyer_email, ship_address, amount)
  values (sid, uid, rp.id, nullif(v_code, ''), p_buyer_name, wa, mail, p_ship_address, 149.00) returning id into oid;
  return jsonb_build_object('ok', true, 'order', oid, 'store', sid);
end $$;

-- ===== Representante =====
create or replace function public.fid_rep_claim(p_invite text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then return jsonb_build_object('error','entre_primeiro'); end if;
  if exists (select 1 from public.fid_reps where user_id = uid) then return jsonb_build_object('ok', true); end if;
  update public.fid_reps set user_id = uid, invite = null where invite = lower(trim(coalesce(p_invite, ''))) and user_id is null;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('error','convite_invalido'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.fid_rep_dashboard() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare rid uuid;
begin
  select id into rid from public.fid_reps where user_id = auth.uid();
  if rid is null then return jsonb_build_object('error','sem_cadastro'); end if;
  return public.fid_rep_dash(rid);
end $$;

create or replace function public.fid_rep_save_pix(p_type text, p_key text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  p_key := trim(coalesce(p_key, ''));
  if p_type not in ('cpf','cnpj','email','telefone','aleatoria') or char_length(p_key) < 5 or char_length(p_key) > 120 then
    return jsonb_build_object('error','pix_invalido'); end if;
  update public.fid_reps set pix_type = p_type, pix_key = p_key where user_id = auth.uid();
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('error','sem_cadastro'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ===== Admin (super) =====
create or replace function public.fid_super_reps() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return jsonb_build_object('today', public.fid_today(), 'next_payday', public.fid_next_payday(), 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.name, 'code', r.code, 'email', r.email, 'whatsapp', r.whatsapp, 'active', r.active,
      'claimed', r.user_id is not null, 'invite', r.invite, 'pix_type', r.pix_type, 'pix_key', r.pix_key,
      'kit_cost', r.kit_cost, 'kit_share_pct', r.kit_share_pct, 'recur_pct', r.recur_pct,
      'release_kit_days', r.release_kit_days, 'release_recur_days', r.release_recur_days,
      'stores', (select count(*) from public.fid_stores s where s.rep_id = r.id),
      'prevista', coalesce(t.prevista, 0), 'liberada', coalesce(t.liberada, 0), 'em_repasse', coalesce(t.em_repasse, 0), 'paga', coalesce(t.paga, 0))
      order by r.created_at)
    from public.fid_reps r
    left join lateral (select
        sum(amount) filter (where st = 'prevista') prevista, sum(amount) filter (where st = 'liberada') liberada,
        sum(amount) filter (where st = 'em_repasse') em_repasse, sum(amount) filter (where st = 'paga') paga
      from (select c.amount, public.fid_comm_status(c.cancelled_at, c.payout_id, c.release_date) st from public.fid_commissions c where c.rep_id = r.id) x) t on true), '[]'::jsonb));
end $$;

create or replace function public.fid_super_rep_save(p_id uuid, p_name text, p_email text, p_whatsapp text, p_code text,
  p_kit_cost numeric, p_kit_share numeric, p_recur numeric, p_rel_kit int, p_rel_recur int, p_active boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare rid uuid; inv text;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  p_code := lower(trim(coalesce(p_code, '')));
  if p_code !~ '^[a-z0-9]{3,20}$' then return jsonb_build_object('error','codigo_invalido_use_3_a_20_letras_ou_numeros'); end if;
  if exists (select 1 from public.fid_reps where code = p_code and id is distinct from p_id) then return jsonb_build_object('error','codigo_ja_existe'); end if;
  if p_id is null then
    inv := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    insert into public.fid_reps (name, email, whatsapp, code, kit_cost, kit_share_pct, recur_pct, release_kit_days, release_recur_days, active, invite)
    values (trim(p_name), nullif(trim(coalesce(p_email,'')), ''), nullif(trim(coalesce(p_whatsapp,'')), ''), p_code,
      p_kit_cost, p_kit_share, p_recur, p_rel_kit, p_rel_recur, coalesce(p_active, true), inv) returning id into rid;
    return jsonb_build_object('ok', true, 'id', rid, 'invite', inv);
  end if;
  update public.fid_reps set name = trim(p_name), email = nullif(trim(coalesce(p_email,'')), ''), whatsapp = nullif(trim(coalesce(p_whatsapp,'')), ''),
    code = p_code, kit_cost = p_kit_cost, kit_share_pct = p_kit_share, recur_pct = p_recur,
    release_kit_days = p_rel_kit, release_recur_days = p_rel_recur, active = coalesce(p_active, true)
   where id = p_id returning id, invite into rid, inv;
  if rid is null then return jsonb_build_object('error','representante_nao_encontrado'); end if;
  return jsonb_build_object('ok', true, 'id', rid, 'invite', inv);
end $$;

create or replace function public.fid_super_rep(p_rep uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return public.fid_rep_dash(p_rep);
end $$;

create or replace function public.fid_super_orders() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
    'id', o.id, 'created_at', o.created_at, 'paid_at', o.paid_at, 'shipped_at', o.shipped_at, 'status', o.status,
    'buyer_name', o.buyer_name, 'whatsapp', o.buyer_whatsapp, 'email', o.buyer_email, 'address', o.ship_address,
    'amount', o.amount, 'tracking', o.tracking, 'store_id', o.store_id, 'store_name', s.name,
    'rep_id', o.rep_id, 'rep_name', r.name, 'rep_code', o.rep_code, 'plan_status', case when s.id is null then null else public.fid_plan_status(s) end)
    order by o.created_at desc)
    from (select * from public.fid_orders order by created_at desc limit 300) o
    left join public.fid_stores s on s.id = o.store_id
    left join public.fid_reps r on r.id = o.rep_id), '[]'::jsonb));
end $$;

create or replace function public.fid_super_confirm_order(p_order uuid, p_amount numeric default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare o public.fid_orders; amt numeric; res jsonb; ref text;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  select * into o from public.fid_orders where id = p_order for update;
  if not found then return jsonb_build_object('error','pedido_nao_encontrado'); end if;
  if o.status <> 'aguardando_pagamento' then return jsonb_build_object('error','pedido_nao_esta_aguardando_pagamento'); end if;
  if o.store_id is null then return jsonb_build_object('error','pedido_sem_loja'); end if;
  amt := coalesce(p_amount, o.amount);
  select referred_by into ref from public.fid_stores where id = o.store_id;
  res := public.fid_super_sale(o.store_id, public.fid_today(), 7, 30, amt, ref);
  if res ? 'error' then return res; end if;
  update public.fid_orders set status = 'pago', paid_at = now(), amount = amt where id = p_order;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.fid_super_order_status(p_order uuid, p_status text, p_tracking text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare o public.fid_orders;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  select * into o from public.fid_orders where id = p_order for update;
  if not found then return jsonb_build_object('error','pedido_nao_encontrado'); end if;
  if p_status = 'enviado' and o.status = 'pago' then
    update public.fid_orders set status = 'enviado', shipped_at = now(), tracking = nullif(trim(coalesce(p_tracking,'')), '') where id = p_order;
  elsif p_status = 'cancelado' and o.status = 'aguardando_pagamento' then
    update public.fid_orders set status = 'cancelado' where id = p_order;
  else
    return jsonb_build_object('error','mudanca_de_status_nao_permitida');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.fid_super_set_rep(p_store uuid, p_rep uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare b public.fid_billing;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  if not exists (select 1 from public.fid_stores where id = p_store) then return jsonb_build_object('error','loja_nao_encontrada'); end if;
  if p_rep is not null and not exists (select 1 from public.fid_reps where id = p_rep) then return jsonb_build_object('error','representante_nao_encontrado'); end if;
  if exists (select 1 from public.fid_commissions where store_id = p_store) then return jsonb_build_object('error','loja_ja_tem_comissoes_nao_da_para_trocar'); end if;
  update public.fid_stores set rep_id = p_rep where id = p_store;
  update public.fid_orders set rep_id = p_rep where store_id = p_store;
  if p_rep is not null then
    for b in select * from public.fid_billing x where x.store_id = p_store and x.kind in ('sale','renewal')
        and not exists (select 1 from public.fid_billing rf where rf.refund_of = x.id) order by x.id loop
      perform public.fid_make_commission(b);
    end loop;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.fid_super_refund(p_billing bigint, p_note text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare b public.fid_billing; c public.fid_commissions; why text; res text;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  select * into b from public.fid_billing where id = p_billing;
  if not found or b.kind not in ('sale','renewal') then return jsonb_build_object('error','lancamento_invalido'); end if;
  if exists (select 1 from public.fid_billing where refund_of = p_billing) then return jsonb_build_object('error','ja_reembolsado'); end if;
  why := 'Cliente pediu reembolso' || case when nullif(trim(coalesce(p_note,'')), '') is not null then ' (' || trim(p_note) || ')' else '' end;
  insert into public.fid_billing (store_id, kind, amount, note, refund_of) values (b.store_id, 'refund', -coalesce(b.amount, 0), left(why, 200), p_billing);
  if b.kind = 'sale' then
    update public.fid_orders set status = 'reembolsado' where store_id = b.store_id and status in ('pago','enviado');
  end if;
  select * into c from public.fid_commissions where billing_id = p_billing and cancelled_at is null;
  if found then
    if c.payout_id is null then
      update public.fid_commissions set cancelled_at = now(), cancel_reason = why where id = c.id;
      res := 'comissao_cancelada';
    else
      insert into public.fid_commissions (rep_id, store_id, store_name, ref_id, kind, base_amount, amount, event_date, release_date, note)
      values (c.rep_id, c.store_id, c.store_name, c.id, 'estorno', -c.base_amount, -c.amount, public.fid_today(), public.fid_today(),
        'Estorno: ' || why || ' — a comissão de ' || to_char(c.event_date, 'DD/MM/YYYY') || ' já tinha entrado em repasse');
      res := 'estorno_lancado';
    end if;
  else
    res := 'sem_comissao';
  end if;
  return jsonb_build_object('ok', true, 'resultado', res);
end $$;

-- prévia do fechamento: o que entra no repasse da data
create or replace function public.fid_super_cycle_preview(p_date date default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare d date := coalesce(p_date, public.fid_today());
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return jsonb_build_object('date', d, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('rep_id', g.rep_id, 'name', r.name, 'pix_type', r.pix_type, 'pix_key', r.pix_key,
      'total', g.tot, 'pay', g.tot > 0, 'lines', g.lines) order by r.name)
    from (select c.rep_id, sum(c.amount) tot, jsonb_agg(jsonb_build_object('id', c.id, 'store_name', c.store_name, 'kind', c.kind, 'amount', c.amount,
            'event_date', c.event_date, 'release_date', c.release_date) order by c.release_date, c.id) lines
          from public.fid_commissions c where c.payout_id is null and c.cancelled_at is null and c.release_date <= d group by c.rep_id) g
    join public.fid_reps r on r.id = g.rep_id), '[]'::jsonb));
end $$;

create or replace function public.fid_super_close_cycle(p_date date default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare d date := coalesce(p_date, public.fid_today()); g record; pid bigint; made int := 0; rp public.fid_reps;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  if d > public.fid_today() then return jsonb_build_object('error','data_no_futuro'); end if;
  for g in select c.rep_id, sum(c.amount) tot from public.fid_commissions c
            where c.payout_id is null and c.cancelled_at is null and c.release_date <= d group by c.rep_id having sum(c.amount) > 0 loop
    select id into pid from public.fid_payouts where rep_id = g.rep_id and cycle = d and paid_at is null order by id desc limit 1;
    if pid is null then
      select * into rp from public.fid_reps where id = g.rep_id;
      insert into public.fid_payouts (rep_id, cycle, total, pix_type, pix_key) values (g.rep_id, d, g.tot, rp.pix_type, rp.pix_key) returning id into pid;
    else
      update public.fid_payouts set total = total + g.tot where id = pid;
    end if;
    update public.fid_commissions set payout_id = pid
     where rep_id = g.rep_id and payout_id is null and cancelled_at is null and release_date <= d;
    made := made + 1;
  end loop;
  return jsonb_build_object('ok', true, 'repasses', made);
end $$;

create or replace function public.fid_super_payouts() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
    'id', p.id, 'cycle', p.cycle, 'total', p.total, 'paid_at', p.paid_at, 'paid_note', p.paid_note, 'rep_name', r.name,
    'pix_type', p.pix_type, 'pix_key', p.pix_key,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'store_name', c.store_name, 'kind', c.kind, 'amount', c.amount,
        'event_date', c.event_date, 'release_date', c.release_date) order by c.release_date, c.id), '[]'::jsonb)
      from public.fid_commissions c where c.payout_id = p.id)) order by p.cycle desc, p.id desc)
    from (select * from public.fid_payouts order by cycle desc, id desc limit 100) p join public.fid_reps r on r.id = p.rep_id), '[]'::jsonb));
end $$;

create or replace function public.fid_super_payout_paid(p_payout bigint, p_note text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  update public.fid_payouts set paid_at = now(), paid_note = left(nullif(trim(coalesce(p_note,'')), ''), 200) where id = p_payout and paid_at is null;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('error','repasse_inexistente_ou_ja_pago'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ===== Permissões =====
revoke all on function public.fid_comm_status(timestamptz, bigint, date) from public, anon, authenticated;
revoke all on function public.fid_next_payday() from public, anon;
revoke all on function public.fid_make_commission(public.fid_billing) from public, anon, authenticated;
revoke all on function public.fid_billing_commission_trg() from public, anon, authenticated;
revoke all on function public.fid_rep_dash(uuid) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'fid_order_create(text,text,text,text,text)', 'fid_rep_claim(text)', 'fid_rep_dashboard()', 'fid_rep_save_pix(text,text)',
    'fid_super_reps()', 'fid_super_rep_save(uuid,text,text,text,text,numeric,numeric,numeric,int,int,boolean)', 'fid_super_rep(uuid)',
    'fid_super_orders()', 'fid_super_confirm_order(uuid,numeric)', 'fid_super_order_status(uuid,text,text)', 'fid_super_set_rep(uuid,uuid)',
    'fid_super_refund(bigint,text)', 'fid_super_cycle_preview(date)', 'fid_super_close_cycle(date)', 'fid_super_payouts()', 'fid_super_payout_paid(bigint,text)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
