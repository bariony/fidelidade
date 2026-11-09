// Avisa o dono quando entra uma venda paga (kit ou mensalidade).
// - Chamada interna pelo asaas-webhook (Authorization: Bearer service role).
// - Canal 1: e-mail (Resend). Canal 2: WhatsApp via CallMeBot, só se o secret CALLMEBOT_APIKEY existir.
// - Canal 3: push no celular/PWA, SÓ para superadmins (fid_superadmins).
// - Idempotente por pagamento (fid_email_log kind='sale_alert', ref=payment id).
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const OWNER_EMAIL = Deno.env.get("SALE_ALERT_EMAIL") ?? "igor.barioni@hotmail.com";
const OWNER_PHONE = Deno.env.get("SALE_ALERT_PHONE") ?? "5511986683737";
const FROM = Deno.env.get("EMAIL_FROM") ?? "Carimbô <nao-responda@carimbo.io>";
const brl = (n: number) => "R$ " + Number(n).toFixed(2).replace(".", ",");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL")!, SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if ((req.headers.get("Authorization") ?? "") !== `Bearer ${SRK}`) return new Response("forbidden", { status: 403 });
  try {
    const b = await req.json();
    const payment = String(b.payment ?? ""), kind = b.kind === "renewal" ? "renewal" : "kit";
    if (!payment) return new Response("sem_payment", { status: 400 });
    const admin = createClient(url, SRK);

    let loja = "", quem = "", fone = "", extra = "";
    const valor = Number(b.value ?? 0);
    if (kind === "kit" && b.order_id) {
      const { data: o } = await admin.from("fid_orders").select("*").eq("id", b.order_id).maybeSingle();
      if (o) {
        quem = o.buyer_name ?? ""; fone = o.buyer_whatsapp ?? "";
        if (o.store_id) { const { data: st } = await admin.from("fid_stores").select("name").eq("id", o.store_id).maybeSingle(); loja = st?.name ?? ""; }
        extra = o.delivery === "correios" ? "Envio pelos Correios" : "Entrega em mãos";
      }
    } else if (b.subscription) {
      const { data: s } = await admin.from("fid_stores").select("name").eq("asaas_subscription_id", b.subscription).maybeSingle();
      loja = s?.name ?? "";
    }
    const titulo = kind === "kit" ? "Venda de kit paga" : "Mensalidade paga";
    const linhas = [["Valor", brl(valor)], ["Loja", loja || "-"], ...(quem ? [["Comprador", quem]] : []), ...(fone ? [["WhatsApp", fone]] : []), ...(extra ? [["Entrega", extra]] : [])];
    const subject = `💰 ${titulo}: ${brl(valor)}${loja ? " · " + loja : ""}`;
    const text = `${titulo}\n` + linhas.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\nPainel: https://carimbo.io/super";
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;color:#14296B"><h2 style="margin:0 0 12px">💰 ${titulo}</h2><table cellpadding="6" style="border-collapse:collapse">${linhas.map(([k, v]) => `<tr><td style="color:#3D4C80">${k}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table><p><a href="https://carimbo.io/super">Abrir o painel admin</a></p></div>`;

    // idempotência: só envia uma vez por pagamento
    const { error: le } = await admin.from("fid_email_log").insert({ kind: "sale_alert", ref: payment, to_email: OWNER_EMAIL });
    if (le) return new Response("duplicado", { status: 200 });

    const out: string[] = [];
    const RK = Deno.env.get("RESEND_API_KEY");
    if (RK) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RK}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [OWNER_EMAIL], subject, html, text }),
      });
      out.push("email:" + r.status);
    }
    const CM = Deno.env.get("CALLMEBOT_APIKEY");
    if (CM) {
      const data = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
      const msg = `Nova venda realizada\nData: ${data}\nValor: ${brl(valor)}`;
      const r = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${OWNER_PHONE}&apikey=${encodeURIComponent(CM)}&text=${encodeURIComponent(msg)}`);
      out.push("whatsapp:" + r.status);
    }
    // push só para superadmins (nunca para lojistas)
    try {
      const { data: sa } = await admin.from("fid_superadmins").select("user_id");
      const uids = (sa ?? []).map((r: any) => r.user_id);
      const { data: sec } = await admin.from("fid_app_secrets").select("key, value").in("key", ["vapid_public", "vapid_private", "vapid_subject"]);
      const m = Object.fromEntries((sec ?? []).map((r: any) => [r.key, r.value]));
      if (uids.length && m.vapid_public && m.vapid_private) {
        webpush.setVapidDetails(m.vapid_subject || "mailto:contato@carimbo.io", m.vapid_public, m.vapid_private);
        const { data: subs } = await admin.from("fid_push_subs").select("id, endpoint, p256dh, auth").in("user_id", uids);
        const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
        const payload = JSON.stringify({ kind: "sale", title: "💰 Nova venda realizada", body: `${brl(valor)} · ${dia}`, url: "https://carimbo.io/super" });
        let ok = 0;
        await Promise.all((subs ?? []).map(async (x: any) => {
          try { await webpush.sendNotification({ endpoint: x.endpoint, keys: { p256dh: x.p256dh, auth: x.auth } }, payload, { TTL: 3600, urgency: "high" }); ok++; }
          catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("fid_push_subs").delete().eq("id", x.id); else console.error("push", e?.statusCode); }
        }));
        out.push("push:" + ok);
      }
    } catch (e) { console.error("push", String(e)); }
    return new Response(out.join(",") || "nenhum_canal", { status: 200 });
  } catch (e) {
    console.error("notify-sale", String(e));
    return new Response("erro", { status: 500 });
  }
});
