// Recebe os avisos do Asaas. Confirma pedido, registra mensalidade e estornos.
// verify_jwt = false: a autenticação é o token do webhook (header asaas-access-token).
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = Deno.env.get("ASAAS_ENV") === "prod" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY") ?? "";
const TOKEN = Deno.env.get("ASAAS_WEBHOOK_TOKEN") ?? "";

async function asaas(path: string, body: unknown, method = "POST") {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", access_token: KEY, "User-Agent": "carimbo.io" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`asaas ${path} ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const ok = (m = "ok") => new Response(m, { status: 200 });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (!TOKEN || !same(req.headers.get("asaas-access-token") ?? "", TOKEN)) return new Response("unauthorized", { status: 401 });

  let ev: any;
  try { ev = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const eventId: string = ev.id ?? `${ev.event}:${ev.payment?.id}:${ev.dateCreated ?? ""}`;
  const pay = ev.payment ?? {};

  // idempotência: evento já processado com sucesso não roda de novo
  const { data: prev } = await admin.from("fid_asaas_events").select("processed_at").eq("event_id", eventId).maybeSingle();
  if (prev?.processed_at) return ok("duplicado");
  if (!prev) {
    await admin.from("fid_asaas_events").insert({ event_id: eventId, event: ev.event, payment_id: pay.id, payload: ev });
  }

  try {
    let result = "ignorado";
    const paid = ev.event === "PAYMENT_RECEIVED" || ev.event === "PAYMENT_CONFIRMED";
    const refunded = ev.event === "PAYMENT_REFUNDED" || ev.event === "PAYMENT_CHARGEBACK_REQUESTED";

    if (paid) {
      if (pay.subscription) {
        const { data, error } = await admin.rpc("fid_asaas_pay_renewal", { p_subscription: pay.subscription, p_payment: pay.id, p_value: pay.value });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        result = "mensalidade";
      } else if (pay.externalReference) {
        const { data, error } = await admin.rpc("fid_asaas_pay_order", { p_order: pay.externalReference, p_payment: pay.id, p_value: pay.value });
        if (error) throw error;
        if (data?.error && data.error !== "pedido_nao_esta_aguardando_pagamento") throw new Error(data.error);
        result = data?.error ? "pedido_ja_tratado" : "kit_pago";
        if (!data?.error) {
          // e-mail "pedido confirmado" ao comprador (não bloqueia o webhook se falhar)
          try {
            const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-email`, {
              method: "POST",
              headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
              body: JSON.stringify({ kind: "order_paid", order_id: pay.externalReference }),
            });
            if (!r.ok) console.error("email order_paid", r.status, await r.text());
          } catch (e) { console.error("email order_paid", String(e)); }
        }

        // cria a assinatura da mensalidade (começa quando acaba o mês incluso)
        const storeId = data?.store_id;
        if (storeId) {
          const { data: s } = await admin.from("fid_stores").select("asaas_subscription_id, renews_at").eq("id", storeId).maybeSingle();
          const { data: o } = await admin.from("fid_orders").select("asaas_customer_id").eq("id", pay.externalReference).maybeSingle();
          if (s && !s.asaas_subscription_id && o?.asaas_customer_id) {
            const sub = await asaas("/subscriptions", {
              customer: o.asaas_customer_id,
              billingType: "UNDEFINED",
              value: 49.97,
              nextDueDate: s.renews_at,
              cycle: "MONTHLY",
              description: "Carimbô — mensalidade",
              externalReference: storeId,
            });
            await admin.rpc("fid_asaas_set_subscription", { p_store: storeId, p_customer: o.asaas_customer_id, p_subscription: sub.id });
            result += "+assinatura";
          }
          // loja de teste que já tinha assinatura: a 1ª cobrança passa para depois do período pago
          if (s && s.asaas_subscription_id && data?.renews_at) {
            try {
              await asaas(`/subscriptions/${s.asaas_subscription_id}`, { nextDueDate: data.renews_at, updatePendingPayments: true }, "PUT");
            } catch (e) { console.error("sub due update", String(e)); }
          }
        }
      }
    } else if (refunded) {
      const { data, error } = await admin.rpc("fid_asaas_refund", { p_payment: pay.id, p_note: ev.event === "PAYMENT_REFUNDED" ? "Asaas" : "Chargeback" });
      if (error) throw error;
      result = data?.error ? `estorno:${data.error}` : `estorno:${data?.resultado}`;
      // kit reembolsado: a loja foi bloqueada no banco; cancela também a mensalidade no Asaas
      if (!data?.error && data?.billing_kind === "sale" && data?.subscription) {
        const r = await fetch(`${BASE}/subscriptions/${data.subscription}`, {
          method: "DELETE", headers: { access_token: KEY, "User-Agent": "carimbo.io" },
        });
        result += r.ok ? "+assinatura_cancelada" : `+assinatura_nao_cancelada(${r.status})`;
      }
    } else if (ev.event === "PAYMENT_PARTIALLY_REFUNDED") {
      result = "reembolso_parcial_manual";
    }

    await admin.from("fid_asaas_events").update({ processed_at: new Date().toISOString(), result }).eq("event_id", eventId);
    return ok(result);
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    console.error(msg);
    await admin.from("fid_asaas_events").update({ result: "erro: " + msg.slice(0, 300) }).eq("event_id", eventId);
    return new Response("erro", { status: 500 }); // Asaas tenta de novo
  }
});
