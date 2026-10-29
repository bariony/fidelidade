// Cria cliente + cobrança no Asaas para um pedido e devolve o link de pagamento.
// Chamada pelo comprar.html com o login do comprador (verify_jwt = true).
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

async function asaas(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", access_token: KEY, "User-Agent": "carimbo.io" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j: any = {};
  try { j = JSON.parse(t); } catch { /* */ }
  if (!r.ok) throw new Error(`asaas ${path} ${r.status}: ${t.slice(0, 300)}`);
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
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: ud } = await userClient.auth.getUser();
    const user = ud?.user;
    if (!user) return json({ error: "nao_autenticado" }, 401);

    const { order_id, cpf_cnpj } = await req.json();
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: o } = await admin.from("fid_orders").select("*").eq("id", order_id).maybeSingle();
    if (!o || o.owner !== user.id) return json({ error: "pedido_nao_encontrado" }, 404);
    if (o.status !== "aguardando_pagamento") return json({ error: "pedido_ja_pago" }, 409);
    if (o.asaas_invoice_url) return json({ ok: true, url: o.asaas_invoice_url });

    const doc = String(cpf_cnpj ?? "").replace(/\D/g, "");
    if (!validDoc(doc)) return json({ error: "cpf_cnpj_invalido" }, 400);

    const customer = await asaas("/customers", {
      name: o.buyer_name,
      cpfCnpj: doc,
      email: user.email,
      mobilePhone: String(o.buyer_whatsapp ?? "").replace(/\D/g, ""),
      externalReference: o.id,
      notificationDisabled: false,
    });

    const due = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const value = Number(o.amount) + Number(o.shipping ?? 0);
    const pay = await asaas("/payments", {
      customer: customer.id,
      billingType: "UNDEFINED",
      value,
      dueDate: due,
      description: `Carimbô — kit de fidelidade${o.delivery === "correios" ? " + envio" : ""}`,
      externalReference: o.id,
    });

    await admin.from("fid_orders").update({
      cpf_cnpj: doc, asaas_customer_id: customer.id, asaas_payment_id: pay.id, asaas_invoice_url: pay.invoiceUrl,
    }).eq("id", o.id);

    return json({ ok: true, url: pay.invoiceUrl });
  } catch (e) {
    console.error(String(e));
    return json({ error: "falha_ao_criar_cobranca" }, 502);
  }
});
