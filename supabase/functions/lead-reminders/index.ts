// Lembrete de carrinho abandonado: 30 min depois do último preenchimento, 1 e-mail por lead.
// Chamada a cada 5 min pelo pg_cron (sem entrada, idempotente: cada lead é "reservado" no banco antes do envio).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { leadReminder } from "./templates.ts";

const FROM = Deno.env.get("EMAIL_FROM") ?? "Carimbô <nao-responda@carimbo.io>";
const SITE = "https://carimbo.io";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  try {
    const KEY = Deno.env.get("RESEND_API_KEY") ?? "";
    if (!KEY) return json({ error: "email_nao_configurado" }, 503);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: leads, error } = await admin.rpc("fid_leads_claim_due", { p_limit: 20 });
    if (error) throw error;
    let sent = 0, failed = 0;
    for (const l of leads ?? []) {
      try {
        // se tem pedido em aberto, o botão leva direto ao pagamento; senão, ao formulário
        let payUrl = `${SITE}/comprar`;
        if (l.order_id) {
          const { data: o } = await admin.from("fid_orders").select("status, asaas_invoice_url").eq("id", l.order_id).maybeSingle();
          if (o && o.status === "aguardando_pagamento" && o.asaas_invoice_url) payUrl = o.asaas_invoice_url;
        }
        const m = leadReminder({ name: l.name, payUrl });
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM, to: [l.email], subject: m.subject, html: m.html, text: m.text }),
        });
        if (!r.ok) throw new Error(`resend ${r.status}`);
        await admin.from("fid_leads").update({ email_status: "enviado" }).eq("id", l.id);
        sent++;
      } catch (e) {
        console.error("lead-reminders", l.id, e);
        await admin.from("fid_leads").update({ email_status: "erro", email_sent_at: null }).eq("id", l.id);
        failed++;
      }
    }
    return json({ ok: true, sent, failed });
  } catch (e) {
    console.error("lead-reminders", e);
    return json({ error: "falha" }, 500);
  }
});
