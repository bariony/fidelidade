// E-mails transacionais do Carimbô via Resend.
// Auth: chamada interna (service role, ex.: asaas-webhook) ou usuário logado.
//  - order_paid:   interna ou superadmin (e-mail ao comprador do pedido)
//  - order_pending: interna ou dono do pedido
//  - welcome_shop / welcome_rep: usuário logado, sempre para o próprio e-mail
// Idempotência: fid_email_log (kind, ref) único; cada e-mail sai uma vez.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { orderPaid, orderPending, welcomeShop, welcomeRep } from "./templates.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const FROM = Deno.env.get("EMAIL_FROM") ?? "Carimbô <nao-responda@carimbo.io>";
const SITE = "https://carimbo.io";

async function resend(key: string, to: string, m: { subject: string; html: string; text: string }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject: m.subject, html: m.html, text: m.text }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const KEY = Deno.env.get("RESEND_API_KEY") ?? "";
    if (!KEY) return json({ error: "email_nao_configurado" }, 503);
    const url = Deno.env.get("SUPABASE_URL")!;
    const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("Authorization") ?? "";
    const internal = auth === `Bearer ${SRK}`;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const admin = createClient(url, SRK);

    let user: { id: string; email?: string } | null = null;
    if (!internal) {
      const { data } = await userClient.auth.getUser();
      user = data?.user ?? null;
      if (!user) return json({ error: "nao_autenticado" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const kind = String(body?.kind ?? "");
    let ref = "", to = "", mail: { subject: string; html: string; text: string } | null = null;

    if (kind === "order_paid" || kind === "order_pending") {
      const oid = String(body?.order_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(oid)) return json({ error: "pedido_invalido" }, 400);
      const { data: o } = await admin.from("fid_orders").select("*").eq("id", oid).maybeSingle();
      if (!o) return json({ error: "pedido_nao_encontrado" }, 404);
      if (!internal) {
        const isOwner = o.owner === user!.id;
        let isSuper = false;
        if (kind === "order_paid") { const { data } = await userClient.rpc("fid_is_super"); isSuper = data === true; }
        if (!(kind === "order_pending" ? isOwner : isSuper)) return json({ error: "sem_permissao" }, 403);
      }
      if (!o.buyer_email) return json({ ok: true, skipped: "sem_email" });
      to = o.buyer_email; ref = oid;
      if (kind === "order_paid") {
        if (!o.paid_at) return json({ error: "pedido_nao_pago" }, 409);
        mail = orderPaid({ name: o.buyer_name, orderId: oid, kit: Number(o.amount), shipping: Number(o.shipping ?? 0), delivery: o.delivery, paidAt: o.paid_at, email: o.buyer_email });
      } else {
        if (!o.asaas_invoice_url || o.paid_at) return json({ ok: true, skipped: "nada_a_enviar" });
        mail = orderPending({ name: o.buyer_name, orderId: oid, total: Number(o.amount) + Number(o.shipping ?? 0), payUrl: o.asaas_invoice_url });
      }
    } else if (kind === "welcome_shop" || kind === "welcome_rep") {
      if (!user?.email) return json({ error: "sem_email" }, 400);
      to = user.email; ref = user.id;
      if (kind === "welcome_shop") {
        mail = welcomeShop({ name: "", email: to });
      } else {
        const { data: r } = await admin.from("fid_reps").select("name, code").eq("user_id", user.id).maybeSingle();
        if (!r) return json({ error: "nao_e_representante" }, 403);
        mail = welcomeRep({ name: r.name, email: to, saleLink: r.code ? `${SITE}/comprar.html?r=${r.code}` : "" });
      }
    } else return json({ error: "tipo_invalido" }, 400);

    const { error: le } = await admin.from("fid_email_log").insert({ kind, ref, to_email: to });
    if (le) {
      if ((le as any).code === "23505") return json({ ok: true, skipped: "ja_enviado" });
      throw le;
    }
    try { await resend(KEY, to, mail!); }
    catch (e) { await admin.from("fid_email_log").delete().eq("kind", kind).eq("ref", ref); throw e; }
    return json({ ok: true });
  } catch (e) {
    console.error("send-email", e);
    return json({ error: "falha_email" }, 500);
  }
});
