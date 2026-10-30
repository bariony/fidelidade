-- v17: Tum, assistente de IA da loja (Edge Function tum-chat).
-- Aplicado via migration tum_assistant_functions. Todas as funções leem só a loja do usuário logado
-- (tum_store() = primeira loja onde owner = auth.uid()), então o escopo é garantido pelo banco.

create table if not exists public.fid_tum_usage (
  id bigint generated always as identity primary key,
  store_id uuid references public.fid_stores(id) on delete cascade,
  question text, input_tokens int, output_tokens int, tool_calls int,
  created_at timestamptz not null default now()
);
alter table public.fid_tum_usage enable row level security;
revoke all on public.fid_tum_usage from anon, authenticated;
create index if not exists fid_tum_usage_store_idx on public.fid_tum_usage (store_id, created_at desc);

CREATE OR REPLACE FUNCTION public.tum_store() RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ select id from public.fid_stores where owner = auth.uid() order by created_at limit 1 $$;

CREATE OR REPLACE FUNCTION public.tum_overview(p_days integer DEFAULT 30, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid uuid := public.tum_store();
  tz text := 'America/Sao_Paulo';
  names text[] := array['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  s record; d0 date; d1 date; r jsonb;
begin
  if sid is null then return jsonb_build_object('error','sem_loja'); end if;
  select * into s from public.fid_stores where id = sid;
  d1 := coalesce(p_to, (now() at time zone tz)::date);
  d0 := coalesce(p_from, d1 - (greatest(least(coalesce(p_days,30),365),1) - 1));
  if d0 > d1 then return jsonb_build_object('error','periodo_invalido'); end if;
  if d1 - d0 > 400 then d0 := d1 - 400; end if;

  with ev as (
    select e.*, (e.created_at at time zone tz) as lt
    from public.fid_events e
    where e.store_id = sid and (e.created_at at time zone tz)::date between d0 and d1
  ), stp as (select * from ev where kind = 'stamp'),
  vis as (select customer_id, lt::date as d from stp group by 1, 2)
  select jsonb_build_object(
    'period', jsonb_build_object('from', d0, 'to', d1, 'days', d1 - d0 + 1),
    'store', jsonb_build_object(
      'name', s.name, 'reward', s.reward, 'stamps_goal', s.stamps_goal, 'cooldown_minutes', s.cooldown_minutes,
      'max_per_day', s.max_per_day, 'geo_required', s.geo_required, 'reward_valid_days', s.reward_valid_days,
      'has_attendant_pin', s.attendant_pin is not null,
      'bonus_instagram', s.bonus_instagram, 'bonus_facebook', s.bonus_facebook, 'bonus_site', s.bonus_site,
      'tags_active', (select count(*) from public.fid_tags t where t.store_id = sid and t.active),
      'is_trial', s.is_trial, 'plan_renews_at', s.renews_at),
    'totals', jsonb_build_object(
      'customers_total', (select count(*) from public.fid_customers c where c.store_id = sid),
      'new_customers', (select count(*) from public.fid_customers c where c.store_id = sid and (c.created_at at time zone tz)::date between d0 and d1),
      'stamps', (select count(*) from stp),
      'bonus_stamps', (select count(*) from ev where kind = 'bonus'),
      'active_customers', (select count(distinct customer_id) from stp),
      'returning_customers', (select count(*) from (select customer_id from vis group by 1 having count(*) >= 2) q),
      'rewards_earned', (select count(*) from ev where kind = 'reward_earned'),
      'rewards_requested', (select count(*) from ev where kind = 'redeem_request'),
      'rewards_delivered', (select count(*) from ev where kind = 'redeem'),
      'rewards_expired', (select count(*) from ev where kind = 'redeem_expired'),
      'rewards_waiting_pickup_now', (select count(*) from public.fid_redemptions rd where rd.store_id = sid and rd.status = 'pending' and rd.expires_at > now())),
    'by_weekday', (
      select coalesce(jsonb_agg(jsonb_build_object('weekday', names[w.dow + 1], 'stamps', coalesce(x.n, 0), 'days_in_period', w.occ,
             'avg_stamps_per_day', round(coalesce(x.n, 0)::numeric / nullif(w.occ, 0), 1)) order by w.dow), '[]'::jsonb)
      from (select extract(dow from g)::int as dow, count(*) as occ from generate_series(d0::timestamp, d1::timestamp, interval '1 day') g group by 1) w
      left join (select extract(dow from lt)::int as dow, count(*) as n from stp group by 1) x using (dow)),
    'by_hour', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'stamps', n) order by h), '[]'::jsonb)
      from (select extract(hour from lt)::int as h, count(*) as n from stp group by 1) q),
    'by_day', case when d1 - d0 <= 61 then (
      select coalesce(jsonb_agg(jsonb_build_object('date', g.d, 'weekday', names[extract(dow from g.d)::int + 1], 'stamps', coalesce(x.n, 0)) order by g.d), '[]'::jsonb)
      from (select gs::date as d from generate_series(d0::timestamp, d1::timestamp, interval '1 day') gs) g
      left join (select lt::date as d, count(*) as n from stp group by 1) x on x.d = g.d) else null end,
    'by_month', case when d1 - d0 > 61 then (
      select coalesce(jsonb_agg(jsonb_build_object('month', m, 'stamps', n) order by m), '[]'::jsonb)
      from (select to_char(lt, 'YYYY-MM') as m, count(*) as n from stp group by 1) q) else null end,
    'by_tag', (
      select coalesce(jsonb_agg(jsonb_build_object('tag', coalesce(t.label, a.tag_id, '(sem tag)'), 'stamps', a.n) order by a.n desc), '[]'::jsonb)
      from (select tag_id, count(*) as n from stp group by 1) a left join public.fid_tags t on t.id = a.tag_id)
  ) into r;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.tum_customers(p_search text DEFAULT NULL, p_inactive_days integer DEFAULT NULL, p_sort text DEFAULT 'last', p_limit integer DEFAULT 15, p_days integer DEFAULT 30)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid uuid := public.tum_store();
  tz text := 'America/Sao_Paulo';
  v_goal int; v_lim int := greatest(1, least(coalesce(p_limit, 15), 40));
  v_days int := greatest(1, least(coalesce(p_days, 30), 365));
  v_today date := (now() at time zone tz)::date;
  r jsonb;
begin
  if sid is null then return jsonb_build_object('error','sem_loja'); end if;
  select stamps_goal into v_goal from public.fid_stores where id = sid;
  with vd as (
    select customer_id, (created_at at time zone tz)::date as d
    from public.fid_events where store_id = sid and kind = 'stamp' group by 1, 2
  ), gp as (
    select customer_id, d - lag(d) over (partition by customer_id order by d) as gap from vd
  ), agg as (
    select c.id, c.name, c.stamps, c.rewards_available, c.rewards_redeemed, c.total_stamps, c.last_stamp_at, c.created_at,
      (select count(*) from vd where vd.customer_id = c.id and vd.d > v_today - v_days) as visits_period,
      (select count(*) from vd where vd.customer_id = c.id) as visit_days_total,
      (select round(avg(gap), 1) from gp where gp.customer_id = c.id and gp.gap is not null) as avg_gap,
      (select count(*) from public.fid_events e where e.customer_id = c.id and e.kind = 'reward_earned') as rewards_earned,
      case when c.last_stamp_at is null then null else v_today - (c.last_stamp_at at time zone tz)::date end as days_since
    from public.fid_customers c
    where c.store_id = sid and (p_search is null or c.name ilike '%' || trim(p_search) || '%')
  ), f as (
    select * from agg where p_inactive_days is null or (days_since is not null and days_since >= p_inactive_days)
  )
  select jsonb_build_object(
    'period_days_for_visits_in_period', v_days,
    'total_matching', (select count(*) from f),
    'customers', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', x.name, 'stamps_now', x.stamps, 'stamps_goal', v_goal, 'rewards_available', x.rewards_available,
        'rewards_delivered', x.rewards_redeemed, 'rewards_earned_total', x.rewards_earned, 'total_stamps', x.total_stamps,
        'visit_days_total', x.visit_days_total, 'visit_days_in_period', x.visits_period, 'avg_days_between_visits', x.avg_gap,
        'last_visit', to_char(x.last_stamp_at at time zone tz, 'DD/MM/YYYY HH24:MI'), 'days_since_last_visit', x.days_since,
        'customer_since', (x.created_at at time zone tz)::date) ), '[]'::jsonb)
      from (select * from f order by
        case when p_sort = 'visits' then visits_period end desc nulls last,
        case when p_sort = 'total' then total_stamps end desc nulls last,
        case when p_sort = 'rewards' then rewards_earned end desc nulls last,
        case when p_sort = 'inactive' then last_stamp_at end asc nulls last,
        case when p_sort = 'frequency' then avg_gap end asc nulls last,
        last_stamp_at desc nulls last
        limit v_lim) x)
  ) into r;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.tum_customer(p_search text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid uuid := public.tum_store();
  tz text := 'America/Sao_Paulo';
  names text[] := array['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  v_goal int; v_today date := (now() at time zone tz)::date; r jsonb;
begin
  if sid is null then return jsonb_build_object('error','sem_loja'); end if;
  if p_search is null or char_length(trim(p_search)) < 2 then return jsonb_build_object('error','nome_curto'); end if;
  select stamps_goal into v_goal from public.fid_stores where id = sid;
  select coalesce(jsonb_agg(m), '[]'::jsonb) into r from (
    select jsonb_build_object(
      'name', c.name, 'whatsapp', c.whatsapp, 'customer_since', (c.created_at at time zone tz)::date,
      'stamps_now', c.stamps, 'stamps_goal', v_goal, 'rewards_available', c.rewards_available,
      'rewards_delivered', c.rewards_redeemed, 'total_stamps', c.total_stamps,
      'last_visit', to_char(c.last_stamp_at at time zone tz, 'DD/MM/YYYY HH24:MI'),
      'last_visit_weekday', case when c.last_stamp_at is null then null else names[extract(dow from c.last_stamp_at at time zone tz)::int + 1] end,
      'days_since_last_visit', case when c.last_stamp_at is null then null else v_today - (c.last_stamp_at at time zone tz)::date end,
      'visit_days_last_30', (select count(distinct (e.created_at at time zone tz)::date) from public.fid_events e where e.customer_id = c.id and e.kind = 'stamp' and e.created_at > now() - interval '30 days'),
      'visit_days_last_90', (select count(distinct (e.created_at at time zone tz)::date) from public.fid_events e where e.customer_id = c.id and e.kind = 'stamp' and e.created_at > now() - interval '90 days'),
      'visit_days_total', (select count(distinct (e.created_at at time zone tz)::date) from public.fid_events e where e.customer_id = c.id and e.kind = 'stamp'),
      'rewards_earned_total', (select count(*) from public.fid_events e where e.customer_id = c.id and e.kind = 'reward_earned'),
      'recent_events', (select coalesce(jsonb_agg(jsonb_build_object(
          'when', to_char(e.created_at at time zone tz, 'DD/MM/YYYY HH24:MI'),
          'weekday', names[extract(dow from e.created_at at time zone tz)::int + 1],
          'kind', e.kind, 'tag', coalesce(t.label, e.tag_id), 'detail', e.detail) order by e.created_at desc), '[]'::jsonb)
        from (select * from public.fid_events where customer_id = c.id order by created_at desc limit 20) e
        left join public.fid_tags t on t.id = e.tag_id)
    ) as m
    from public.fid_customers c
    where c.store_id = sid and c.name ilike '%' || trim(p_search) || '%'
    order by c.last_stamp_at desc nulls last limit 5) q;
  return jsonb_build_object('matches', r);
end $function$;

do $$
declare f text;
begin
  foreach f in array array['tum_store()', 'tum_overview(int,date,date)', 'tum_customers(text,int,text,int,int)', 'tum_customer(text)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
