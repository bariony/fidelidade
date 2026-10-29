// Ações da conta ligadas ao Asaas, chamadas pelo painel com o login do usuário (verify_jwt = true):
//  pay_link  → lojista: link da cobrança em aberto da mensalidade ("Pagar agora")
//  subscribe → lojista em teste: cria a assinatura (1ª cobrança só quando o teste acaba)
//  cancel    → lojista: cancela a assinatura (o plano segue até o vencimento)
//  refund    → admin: aprova um pedido de reembolso e manda o estorno ao Asaas
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const BASE = Deno.env.get("ASAAS_ENV") === "prod" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY") ?? "";

async function asaas(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", access_token: KEY, "User-Agent": "carimbo.io" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j: any = {};
  try { j = JSON.parse(t); } catch { /* */ }
  if (!r.ok) throw new Error(`asaas ${method} ${path} ${r.status}: ${t.slice(0, 300)}`);
  return j;
}

function validDoc(d: string) {
  const n = d.replace(/\D/g, "");
  if (n.length === 11) {
    if (/^(\d)\1+$/.test(n)) return false;
    for (const t of [9, 10]) {
      let s = 0;
      for (let i = 0; i < t; i++) s += +n[i] * (t + 1 - i);
      if (((s * 10) % 11) % 10 !== +n[t]) return false;
    }
    return true;
  }
  if (n.length === 14) {
    if (/^(\d)\1+$/.test(n)) return false;
    for (const t of [12, 13]) {
      const w = t === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
      let s = 0;
      for (let i = 0; i < t; i++) s += +n[i] * w[i];
      const dv = s % 11 < 2 ? 0 : 11 - (s % 11);
      if (dv !== +n[t]) return false;
    }
    return true;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!KEY) return json({ error: "pagamento_nao_configurado" }, 503);
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") ?? "";
    const me = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: ud } = await me.auth.getUser();
    const user = ud?.user;
    if (!user) return json({ error: "nao_autenticado" }, 401);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { action, ticket, note, cpf_cnpj } = await req.json();

    if (action === "refund") {
      const { data: tgt } = await me.rpc("fid_super_refund_target", { p_ticket: ticket });
      if (!tgt || tgt.error) return json({ error: tgt?.error ?? "sem_permissao" }, 403);
      if (!tgt.payment) return json({ error: "sem_cobranca_asaas" }, 409);
      await asaas("POST", `/payments/${tgt.payment}/refund`, {});
      // o Asaas avisa por webhook (PAYMENT_REFUNDED) e o sistema faz o resto sozinho
      await me.rpc("fid_super_ticket_reply", { p_ticket: ticket, p_body: note || "Reembolso aprovado. O estorno foi enviado e aparece na sua fatura em alguns dias.", p_resolve: true });
      return json({ ok: true });
    }

    const { data: s } = await admin.from("fid_stores").select("id, name, renews_at, is_trial, blocked, asaas_subscription_id, pending_payment").eq("owner", user.id).order("created_at").limit(1).maybeSingle();
    if (!s) return json({ error: "sem_loja" }, 404);

    if (action === "subscribe") {
      if (s.asaas_subscription_id) return json({ error: "ja_assinou" }, 409);
      if (s.blocked || s.pending_payment) return json({ error: "loja_indisponivel" }, 409);
      const d = String(cpf_cnpj ?? "").replace(/\D/g, "");
      if (!validDoc(d)) return json({ error: "cpf_cnpj_invalido" }, 400);
      const customer = await asaas("POST", "/customers", {
        name: s.name, cpfCnpj: d, email: user.email, externalReference: s.id, notificationDisabled: false,
      });
      const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
      const first = String(s.renews_at) > today ? String(s.renews_at) : today;
      const sub = await asaas("POST", "/subscriptions", {
        customer: customer.id, billingType: "UNDEFINED", value: 49.97, nextDueDate: first,
        cycle: "MONTHLY", description: "Carimbô — mensalidade", externalReference: s.id,
      });
      await admin.rpc("fid_asaas_set_subscription", { p_store: s.id, p_customer: customer.id, p_subscription: sub.id });
      let invoice: string | null = null;
      try {
        const l = await asaas("GET", `/subscriptions/${sub.id}/payments`);
        invoice = l.data?.[0]?.invoiceUrl ?? null;
      } catch { /* o link também chega por e-mail do Asaas */ }
      return json({ ok: true, first_due: first, url: invoice });
    }

    if (action === "pay_link") {
      if (!s.asaas_subscription_id) return json({ error: "sem_assinatura" }, 404);
      const list = await asaas("GET", `/subscriptions/${s.asaas_subscription_id}/payments?status=PENDING`);
      const over = await asaas("GET", `/subscriptions/${s.asaas_subscription_id}/payments?status=OVERDUE`);
      const all = [...(over.data ?? []), ...(list.data ?? [])].sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
      const next = all[0];
      if (!next?.invoiceUrl) return json({ error: "sem_cobranca_aberta" }, 404);
      return json({ ok: true, url: next.invoiceUrl, due: next.dueDate, value: next.value });
    }

    if (action === "cancel") {
      if (s.asaas_subscription_id) await asaas("DELETE", `/subscriptions/${s.asaas_subscription_id}`);
      const { data } = await admin.rpc("fid_asaas_cancelled", { p_store: s.id });
      return json({ ok: true, renews_at: data?.renews_at ?? null });
    }
    return json({ error: "acao_invalida" }, 400);
  } catch (e) {
    console.error(String(e));
    return json({ error: "falha_no_asaas" }, 502);
  }
});
