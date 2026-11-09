// Aviso do sistema para os lojistas: grava no sino (fid_notifications) e dispara push.
// Só o administrador chama (verify_jwt = true + fid_is_super). Sem store_id, vai para todas as lojas ativas.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const me = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: ud } = await me.auth.getUser();
    if (!ud?.user) return json({ error: "nao_autenticado" }, 401);
    const { data: isSuper } = await me.rpc("fid_is_super");
    if (isSuper !== true) return json({ error: "sem_permissao" }, 403);

    const b = await req.json().catch(() => ({}));
    const title = String(b.title ?? "").trim().slice(0, 80);
    const body = String(b.body ?? "").trim().slice(0, 500);
    let link = String(b.link ?? "").trim();
    const kind = /^[a-z_]{1,20}$/.test(String(b.kind ?? "")) ? String(b.kind) : "aviso";
    if (!title || !body) return json({ error: "titulo_e_mensagem_obrigatorios" }, 400);
    if (link && !/^https:\/\/([a-z0-9-]+\.)?carimbo\.io(\/|$)/i.test(link) && !/^\//.test(link)) return json({ error: "link_invalido_use_carimbo_io" }, 400);
    if (link.startsWith("/")) link = "https://carimbo.io" + link;

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let q = admin.from("fid_stores").select("id").eq("blocked", false).eq("pending_payment", false);
    if (b.store_id) q = admin.from("fid_stores").select("id").eq("id", String(b.store_id));
    const { data: stores, error: se } = await q;
    if (se) throw se;
    const ids = (stores ?? []).map((s: any) => s.id);
    if (!ids.length) return json({ ok: true, stores: 0, push_sent: 0, push_failed: 0 });

    const { error: ie } = await admin.from("fid_notifications").insert(ids.map((id: string) => ({ store_id: id, kind, title, body, link: link || null })));
    if (ie) throw ie;

    // push
    let sent = 0, failed = 0;
    const { data: sec } = await admin.from("fid_app_secrets").select("key, value").in("key", ["vapid_public", "vapid_private", "vapid_subject"]);
    const m = Object.fromEntries((sec ?? []).map((r: any) => [r.key, r.value]));
    if (m.vapid_public && m.vapid_private) {
      webpush.setVapidDetails(m.vapid_subject || "mailto:contato@carimbo.io", m.vapid_public, m.vapid_private);
      const { data: subs } = await admin.from("fid_push_subs").select("id, endpoint, p256dh, auth").in("store_id", ids);
      const payload = JSON.stringify({ title, body, url: link || "https://carimbo.io/lojista" });
      await Promise.all((subs ?? []).map(async (s: any) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
          sent++;
        } catch (e: any) {
          failed++;
          if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("fid_push_subs").delete().eq("id", s.id);
          else console.error("push", e?.statusCode, String(e?.body ?? e).slice(0, 200));
        }
      }));
    }
    return json({ ok: true, stores: ids.length, push_sent: sent, push_failed: failed });
  } catch (e) {
    console.error("notify", e);
    return json({ error: "falha_notify" }, 500);
  }
});
