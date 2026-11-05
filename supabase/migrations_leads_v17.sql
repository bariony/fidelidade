-- v17: carrinho abandonado (leads), e-mail 30 min depois, controle de WhatsApp manual
create table if not exists public.fid_leads (
  id uuid primary key default gen_random_uuid(),
  whatsapp text not null unique,            -- só dígitos (10 ou 11)
  name text not null,
  email text,
  store_name text,
  order_id uuid references public.fid_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  converted_at timestamptz,                  -- comprou (pedido pago)
  email_sent_at timestamptz,                 -- lembrete por e-mail já enviado
  email_status text,                         -- enviando | enviado | erro
  wa_done_at timestamptz,                    -- você já mandou o WhatsApp
  wa_note text
);
alter table public.fid_leads enable row level security;   -- sem policies: tudo por RPC

create or replace function public.fid_digits(t text) returns text language sql immutable as $$
  select case when length(regexp_replace(coalesce(t,''),'\D','','g')) > 11
              then right(regexp_replace(t,'\D','','g'), 11)
              else regexp_replace(coalesce(t,''),'\D','','g') end $$;

-- captura pública (anon): chamada pelo /comprar quando nome + WhatsApp estão válidos
create or replace function public.fid_capture_lead(p_name text, p_whatsapp text, p_email text default null, p_store text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w text := public.fid_digits(p_whatsapp); n text := left(btrim(coalesce(p_name,'')), 80);
        e text := nullif(lower(btrim(coalesce(p_email,''))), ''); s text := nullif(left(btrim(coalesce(p_store,'')), 80), '');
begin
  if length(n) < 2 or length(w) not in (10,11) then return jsonb_build_object('ok', false); end if;
  if e is not null and e !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then e := null; end if;
  insert into public.fid_leads(whatsapp, name, email, store_name) values (w, n, e, s)
  on conflict (whatsapp) do update set
    name = excluded.name,
    email = coalesce(excluded.email, public.fid_leads.email),
    store_name = coalesce(excluded.store_name, public.fid_leads.store_name),
    -- se ainda não comprou e ainda não mandamos e-mail, reinicia a contagem dos 30 min
    updated_at = case when public.fid_leads.converted_at is null and public.fid_leads.email_sent_at is null then now() else public.fid_leads.updated_at end,
    -- mudou o e-mail depois de um erro: libera novo envio
    email_status = case when public.fid_leads.email_status = 'erro' then null else public.fid_leads.email_status end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.fid_capture_lead(text,text,text,text) from public;
grant execute on function public.fid_capture_lead(text,text,text,text) to anon, authenticated;

-- pedido criado/pago vira lead vinculado; pago = convertido
create or replace function public.fid_leads_from_order() returns trigger language plpgsql security definer set search_path = public as $$
declare w text := public.fid_digits(new.buyer_whatsapp);
begin
  if length(w) not in (10,11) then return new; end if;
  insert into public.fid_leads(whatsapp, name, email, order_id, converted_at)
  values (w, left(coalesce(new.buyer_name,'-'),80), lower(new.buyer_email), new.id,
          case when new.status in ('pago','enviado') then coalesce(new.paid_at, now()) end)
  on conflict (whatsapp) do update set
    order_id = new.id,
    email = coalesce(public.fid_leads.email, lower(new.buyer_email)),
    converted_at = case when new.status in ('pago','enviado') then coalesce(public.fid_leads.converted_at, now()) else public.fid_leads.converted_at end;
  return new;
end $$;
drop trigger if exists fid_leads_from_order_t on public.fid_orders;
create trigger fid_leads_from_order_t after insert or update of status on public.fid_orders
  for each row execute function public.fid_leads_from_order();

-- admin: lista (últimos 14 dias)
create or replace function public.fid_super_leads() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return jsonb_build_object('leads', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'whatsapp', l.whatsapp, 'email', l.email, 'store', l.store_name,
      'created_at', l.created_at, 'updated_at', l.updated_at, 'converted_at', l.converted_at,
      'email_sent_at', l.email_sent_at, 'email_status', l.email_status, 'wa_done_at', l.wa_done_at, 'wa_note', l.wa_note,
      'order_status', o.status) order by l.updated_at desc)
    from public.fid_leads l left join public.fid_orders o on o.id = l.order_id
    where l.updated_at > now() - interval '14 days' or l.created_at > now() - interval '14 days'), '[]'::jsonb));
end $$;
revoke all on function public.fid_super_leads() from public; grant execute on function public.fid_super_leads() to authenticated;

create or replace function public.fid_super_lead_wa(p_id uuid, p_done boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  update public.fid_leads set wa_done_at = case when p_done then now() end, wa_note = nullif(left(btrim(coalesce(p_note,'')),200),'') where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.fid_super_lead_wa(uuid,boolean,text) from public; grant execute on function public.fid_super_lead_wa(uuid,boolean,text) to authenticated;

-- fila do e-mail (só service role): leads parados há 30 min+, com e-mail, sem compra, até 24 h
create or replace function public.fid_leads_claim_due(p_limit int default 20)
returns setof public.fid_leads language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.fid_leads l set email_status = 'enviando', email_sent_at = now()
  where l.id in (
    select x.id from public.fid_leads x
    where x.converted_at is null and x.email is not null and x.email_sent_at is null and coalesce(x.email_status,'') <> 'erro'
      and x.updated_at <= now() - interval '30 minutes' and x.updated_at > now() - interval '24 hours'
      and not exists (select 1 from public.fid_orders o where o.status in ('pago','enviado') and (lower(o.buyer_email) = x.email or public.fid_digits(o.buyer_whatsapp) = x.whatsapp))
    order by x.updated_at limit p_limit for update skip locked)
  returning l.*;
end $$;
revoke all on function public.fid_leads_claim_due(int) from public, anon, authenticated;
grant execute on function public.fid_leads_claim_due(int) to service_role;
