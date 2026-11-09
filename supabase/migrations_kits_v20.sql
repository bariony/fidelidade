-- v20: kits (Start / Médio / Completo), custo fixo por item e link único de bastão NFC por loja nova.
-- Lojas e pedidos antigos continuam exatamente como estão (kit 'medio', 2 bastões + QR).

-- 1) Catálogo de kits. Preço, frete e custo ficam no banco (fonte única de verdade).
create table if not exists public.fid_kits (
  code text primary key,
  name text not null,
  sort int not null default 0,
  wands int not null check (wands >= 0),
  plates int not null check (plates >= 0),
  price numeric(10,2) not null check (price >= 0),
  shipping numeric(10,2) not null default 15.99 check (shipping >= 0),
  unit_cost numeric(10,2) not null default 12 check (unit_cost >= 0),
  active boolean not null default true
);
alter table public.fid_kits enable row level security;
drop policy if exists fid_kits_read on public.fid_kits;
create policy fid_kits_read on public.fid_kits for select to anon, authenticated using (active);
insert into public.fid_kits (code, name, sort, wands, plates, price, shipping, unit_cost) values
  ('start',    'Start',    1, 1, 1,  79.97, 15.99, 12),
  ('medio',    'Médio',    2, 2, 1,  99.97, 15.99, 12),
  ('completo', 'Completo', 3, 3, 2, 169.97,  0.00, 12)
on conflict (code) do nothing;

-- 2) Pedido guarda o kit comprado (pedidos antigos = 'medio').
alter table public.fid_orders add column if not exists kit text not null default 'medio' references public.fid_kits(code);

-- 3) Tag passa a ter tipo: bastão NFC ou QR. Antigas: 'QR Code' vira qr, o resto nfc.
alter table public.fid_tags add column if not exists kind text not null default 'nfc';
alter table public.fid_tags drop constraint if exists fid_tags_kind_chk;
alter table public.fid_tags add constraint fid_tags_kind_chk check (kind in ('nfc','qr'));
update public.fid_tags set kind = 'qr' where lower(trim(label)) = 'qr code' and kind <> 'qr';

-- 4) Lojas NOVAS ganham só 2 links: um para todos os bastões e um para o QR.
create or replace function public.fid_default_tags() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if not exists (select 1 from public.fid_tags where store_id = new.id) then
    insert into public.fid_tags (id, store_id, label, kind) values (public.fid_make_tag_id(), new.id, 'Bastão NFC', 'nfc');
    insert into public.fid_tags (id, store_id, label, kind) values (public.fid_make_tag_id(), new.id, 'QR Code', 'qr');
  end if;
  return new;
end $function$;

-- 5) Catálogo público para a tela de compra.
create or replace function public.fid_kits_state() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'wands', wands, 'plates', plates, 'price', price, 'shipping', shipping) order by sort), '[]'::jsonb)
  from public.fid_kits where active
$$;
grant execute on function public.fid_kits_state() to anon, authenticated;

-- 6) Criar pedido com kit (p_kit com padrão 'medio': tela antiga em cache continua funcionando).
drop function if exists public.fid_order_create(text, text, text, text, text, text, text, text, text, text, text, text, text);
create or replace function public.fid_order_create(p_code text, p_store_name text, p_buyer_name text, p_whatsapp text, p_delivery text, p_cep text default null, p_street text default null, p_number text default null, p_complement text default null, p_district text default null, p_city text default null, p_state text default null, p_coupon text default null, p_kit text default 'medio')
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare uid uuid := auth.uid(); rp public.fid_reps; sid uuid; oid uuid; mail text; wa text; v_code text; cep text; addr text; ship numeric := 0; uf text; pct int := public.fid_coupon_pct(p_coupon); amt numeric; is_promo boolean := false;
  k public.fid_kits; ex public.fid_orders;
begin
  if uid is null then return jsonb_build_object('error','entre_primeiro'); end if;
  select * into k from public.fid_kits where code = coalesce(nullif(trim(p_kit), ''), 'medio') and active;
  if not found then return jsonb_build_object('error','kit_invalido'); end if;
  p_store_name := trim(coalesce(p_store_name, '')); p_buyer_name := trim(coalesce(p_buyer_name, ''));
  wa := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  if char_length(p_store_name) < 2 or char_length(p_store_name) > 80 then return jsonb_build_object('error','nome_da_loja_invalido'); end if;
  if char_length(p_buyer_name) < 2 or char_length(p_buyer_name) > 80 then return jsonb_build_object('error','nome_invalido'); end if;
  if char_length(wa) < 10 or char_length(wa) > 13 then return jsonb_build_object('error','whatsapp_invalido'); end if;
  if p_delivery <> 'correios' then return jsonb_build_object('error','forma_de_entrega_invalida'); end if;
  if coalesce(trim(p_coupon), '') <> '' and pct = 0 then return jsonb_build_object('error','cupom_invalido'); end if;
  cep := regexp_replace(coalesce(p_cep, ''), '\D', '', 'g'); uf := upper(trim(coalesce(p_state, '')));
  if char_length(cep) <> 8 then return jsonb_build_object('error','cep_invalido'); end if;
  if char_length(trim(coalesce(p_street, ''))) < 3 then return jsonb_build_object('error','rua_invalida'); end if;
  if char_length(trim(coalesce(p_number, ''))) < 1 then return jsonb_build_object('error','numero_invalido'); end if;
  if char_length(trim(coalesce(p_city, ''))) < 2 then return jsonb_build_object('error','cidade_invalida'); end if;
  if uf !~ '^[A-Z]{2}$' then return jsonb_build_object('error','estado_invalido'); end if;
  addr := left(trim(p_street) || ', ' || trim(p_number) || coalesce(' - ' || nullif(trim(coalesce(p_complement, '')), ''), '') ||
    coalesce(', ' || nullif(trim(coalesce(p_district, '')), ''), '') || ', ' || trim(p_city) || '/' || uf || ', CEP ' || substr(cep,1,5) || '-' || substr(cep,6,3), 300);
  v_code := lower(trim(coalesce(p_code, '')));
  if v_code <> '' then select * into rp from public.fid_reps r where r.code = v_code and r.active; end if;
  select email into mail from auth.users where id = uid;
  perform pg_advisory_xact_lock(7710);
  -- pedido igual em aberto (mesma loja, mesmo kit, últimos 5 min): reaproveita
  select o.* into ex from public.fid_orders o
   where o.owner = uid and o.status = 'aguardando_pagamento' and o.buyer_whatsapp = wa and o.delivery = p_delivery and o.created_at > now() - interval '5 minutes'
     and exists (select 1 from public.fid_stores s2 where s2.id = o.store_id and s2.name = p_store_name) order by o.created_at desc limit 1;
  if found and ex.kit = k.code then return jsonb_build_object('ok', true, 'order', ex.id, 'store', ex.store_id, 'dup', true); end if;
  -- promoção de lançamento vale só para o kit Médio, sem cupom
  is_promo := pct = 0 and k.code = 'medio' and public.fid_promo_left(case when ex.id is not null then ex.id end) > 0;
  if is_promo then amt := 39.97; ship := 0; else amt := round(k.price * (100 - pct) / 100, 2); ship := k.shipping; end if;
  -- mesmo pedido, mas a pessoa trocou de kit antes de gerar a cobrança: atualiza no lugar (sem criar loja duplicada)
  if ex.id is not null and ex.asaas_invoice_url is null then
    update public.fid_orders set kit = k.code, amount = amt, shipping = ship, promo = is_promo, coupon_code = case when pct > 0 then lower(trim(p_coupon)) end, discount_pct = pct where id = ex.id;
    return jsonb_build_object('ok', true, 'order', ex.id, 'store', ex.store_id, 'shipping', ship, 'total', amt + ship, 'promo', is_promo, 'kit', k.code);
  end if;
  insert into public.fid_stores (owner, name, rep_id, is_trial, blocked, pending_payment) values (uid, p_store_name, rp.id, false, true, true) returning id into sid;
  insert into public.fid_orders (store_id, owner, rep_id, rep_code, buyer_name, buyer_whatsapp, buyer_email, ship_address, amount, delivery, shipping, ship_cep, coupon_code, discount_pct, promo, kit)
  values (sid, uid, rp.id, nullif(v_code, ''), p_buyer_name, wa, mail, addr, amt, p_delivery, ship, cep, case when pct > 0 then lower(trim(p_coupon)) end, pct, is_promo, k.code) returning id into oid;
  return jsonb_build_object('ok', true, 'order', oid, 'store', sid, 'shipping', ship, 'total', amt + ship, 'promo', is_promo, 'kit', k.code);
end $function$;
revoke all on function public.fid_order_create(text, text, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.fid_order_create(text, text, text, text, text, text, text, text, text, text, text, text, text, text) to authenticated, service_role;

-- 7) Comissão do kit: lucro = valor pago − (R$ 12 × nº de bastões e placas do kit); representante recebe kit_share_pct (50%) do lucro.
--    Pedido da promoção de lançamento não gera comissão (como já era). Venda sem pedido (lançada à mão) usa o custo antigo do representante.
create or replace function public.fid_make_commission(b fid_billing) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare s public.fid_stores; r public.fid_reps; amt numeric; k text; ev date; rel date; o public.fid_orders; kt public.fid_kits; cost numeric; has_o boolean := false;
begin
  if b.kind not in ('sale','renewal') then return; end if;
  if coalesce(b.amount, 0) <= 0 then return; end if;
  select * into s from public.fid_stores where id = b.store_id;
  if not found or s.rep_id is null then return; end if;
  select * into r from public.fid_reps where id = s.rep_id;
  if not found then return; end if;
  ev := (b.created_at at time zone 'America/Sao_Paulo')::date;
  if b.kind = 'sale' then
    select * into o from public.fid_orders x where x.store_id = b.store_id and x.status not in ('cancelado','reembolsado') order by x.created_at desc limit 1;
    has_o := found;
    if has_o and o.promo then return; end if;
    if has_o then select * into kt from public.fid_kits where code = o.kit; end if;
    cost := case when has_o and kt.code is not null then (kt.wands + kt.plates) * kt.unit_cost else r.kit_cost end;
    amt := round(greatest(b.amount - cost, 0) * r.kit_share_pct / 100, 2);
    k := 'aquisicao'; rel := ev + r.release_kit_days;
  else
    if not exists (select 1 from public.fid_billing x where x.store_id = b.store_id and x.kind in ('sale','trial') and x.id < b.id) then return; end if;
    amt := round(b.amount * r.recur_pct / 100, 2);
    k := 'recorrencia'; rel := ev + r.release_recur_days;
  end if;
  if amt <= 0 then return; end if;
  insert into public.fid_commissions (rep_id, store_id, store_name, billing_id, kind, base_amount, amount, event_date, release_date)
  values (r.id, s.id, s.name, b.id, k, b.amount, amt, ev, rel)
  on conflict (billing_id) do nothing;
end $function$;

-- 8) Admin: pedidos com kit e tipo da tag.
create or replace function public.fid_super_orders() returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
    'id', o.id, 'created_at', o.created_at, 'paid_at', o.paid_at, 'prep_at', o.prep_at, 'shipped_at', o.shipped_at, 'status', o.status,
    'buyer_name', o.buyer_name, 'whatsapp', o.buyer_whatsapp, 'email', o.buyer_email, 'address', o.ship_address,
    'delivery', o.delivery, 'shipping', o.shipping, 'upgrade', o.upgrade, 'loaner', o.loaner,
    'amount', o.amount, 'tracking', o.tracking, 'store_id', o.store_id, 'store_name', s.name,
    'kit', o.kit, 'kit_name', k.name, 'wands', k.wands, 'plates', k.plates,
    'rep_id', o.rep_id, 'rep_name', r.name, 'rep_code', o.rep_code, 'invoice_url', o.asaas_invoice_url, 'asaas', (o.asaas_payment_id is not null), 'plan_status', case when s.id is null then null else public.fid_plan_status(s) end,
    'tags', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'active', t.active, 'kind', t.kind) order by t.created_at, t.label) from public.fid_tags t where t.store_id = o.store_id), '[]'::jsonb))
    order by o.created_at desc)
    from (select * from public.fid_orders order by created_at desc limit 300) o
    left join public.fid_stores s on s.id = o.store_id
    left join public.fid_kits k on k.code = o.kit
    left join public.fid_reps r on r.id = o.rep_id), '[]'::jsonb));
end $function$;
