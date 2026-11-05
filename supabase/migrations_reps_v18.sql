-- v18: pedidos de representante (formulário público -> aprovação no admin)
create table if not exists public.fid_rep_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  whatsapp text not null,
  status text not null default 'pendente' check (status in ('pendente','aprovado','recusado')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  rep_id uuid references public.fid_reps(id) on delete set null,
  email_sent_at timestamptz,
  wa_done_at timestamptz
);
alter table public.fid_rep_requests enable row level security;
create index if not exists fid_rep_requests_status on public.fid_rep_requests(status, created_at desc);

-- pedido público (anon). Mesma resposta para duplicado, sem vazar quem já existe.
create or replace function public.fid_rep_request(p_name text, p_email text, p_whatsapp text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n text := left(btrim(coalesce(p_name,'')), 80); e text := lower(btrim(coalesce(p_email,''))); w text := public.fid_digits(p_whatsapp);
begin
  if length(n) < 5 or position(' ' in n) = 0 then return jsonb_build_object('error','nome_completo'); end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then return jsonb_build_object('error','email_invalido'); end if;
  if length(w) not in (10,11) then return jsonb_build_object('error','whatsapp_invalido'); end if;
  if (select count(*) from public.fid_rep_requests where created_at > now() - interval '1 hour') > 40 then return jsonb_build_object('error','muitas_tentativas'); end if;
  if exists (select 1 from public.fid_rep_requests where status in ('pendente','aprovado') and (lower(email) = e or public.fid_digits(whatsapp) = w))
     or exists (select 1 from public.fid_reps where lower(coalesce(email,'')) = e) then
    return jsonb_build_object('ok', true);
  end if;
  insert into public.fid_rep_requests(name, email, whatsapp) values (n, e, w);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.fid_rep_request(text,text,text) to anon, authenticated;

create or replace function public.fid_super_rep_requests()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(q) order by (q.status='pendente') desc, q.created_at desc)
    from (select id, name, email, whatsapp, status, created_at, decided_at, email_sent_at, wa_done_at from public.fid_rep_requests
          order by created_at desc limit 100) q), '[]'::jsonb));
end $$;

-- aprova (cria o representante com as regras padrão) ou recusa
create or replace function public.fid_super_rep_request_decide(p_id uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.fid_rep_requests; base text; code text; i int := 0; inv text; rid uuid;
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  select * into r from public.fid_rep_requests where id = p_id for update;
  if not found then return jsonb_build_object('error','pedido_nao_encontrado'); end if;
  if r.status <> 'pendente' then return jsonb_build_object('error','pedido_ja_decidido'); end if;
  if not p_approve then
    update public.fid_rep_requests set status='recusado', decided_at=now() where id = p_id;
    return jsonb_build_object('ok', true, 'status', 'recusado');
  end if;
  base := left(regexp_replace(lower(translate(split_part(r.name,' ',1),'áàâãäéèêëíìîïóòôõöúùûüçñ','aaaaaeeeeiiiiooooouuuucn')),'[^a-z0-9]','','g'), 14);
  if length(base) < 3 then base := 'rep'; end if;
  code := base;
  while exists (select 1 from public.fid_reps where fid_reps.code = code) loop i := i + 1; code := base || (floor(random()*900)+100)::int; exit when i > 20; end loop;
  inv := substr(replace(gen_random_uuid()::text,'-',''),1,10);
  insert into public.fid_reps(name,email,whatsapp,code,kit_cost,kit_share_pct,recur_pct,release_kit_days,release_recur_days,active,invite)
  values (r.name, r.email, r.whatsapp, code, 45, 50, 20, 15, 7, true, inv) returning id into rid;
  update public.fid_rep_requests set status='aprovado', decided_at=now(), rep_id=rid where id = p_id;
  return jsonb_build_object('ok', true, 'status', 'aprovado', 'rep_id', rid, 'invite', inv, 'code', code);
end $$;

create or replace function public.fid_super_rep_request_wa(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.fid_is_super() then return jsonb_build_object('error','sem_permissao'); end if;
  update public.fid_rep_requests set wa_done_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
