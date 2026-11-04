// Visitantes em tempo real (painel "Ao vivo" do admin).
// Recebe um "pulso" das páginas públicas a cada ~20s. Guarda só: id aleatório da visita, página, etapa, origem (utm)
// e localização aproximada (cidade/estado/país). O IP NUNCA é gravado: serve só para descobrir a cidade, uma vez por visita.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ok = () => new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
const STAGE: Record<string, number> = { visitando: 1, comprar: 2, preenchendo: 3, pagamento: 4, comprou: 5 };
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|headless|lighthouse|pingdom|monitor/i;

async function geo(ip: string) {
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,region,city`, { signal: AbortSignal.timeout(1800) });
    const j = await r.json();
    if (j?.success) return { country: String(j.country ?? "").slice(0, 40), region: String(j.region ?? "").slice(0, 40), city: String(j.city ?? "").slice(0, 60) };
  } catch (_) { /* sem localização: segue sem */ }
  return { country: null, region: null, city: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const ua = req.headers.get("user-agent") ?? "";
    if (BOT.test(ua)) return ok();
    const b = JSON.parse(await req.text());
    const sid = String(b?.sid ?? "");
    const step = String(b?.step ?? "");
    if (!/^[a-z0-9]{10,32}$/i.test(sid) || !(step in STAGE)) return ok();
    const page = String(b?.page ?? "").replace(/[^\w\-\/.]/g, "").slice(0, 40) || "/";
    const src = String(b?.src ?? "").replace(/[^\w\-.]/g, "").slice(0, 30) || null;
    const device = /mobile|android|iphone|ipad/i.test(ua) ? "celular" : "computador";

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: cur } = await admin.from("fid_live").select("sid,max_stage").eq("sid", sid).maybeSingle();
    const stage = STAGE[step];
    if (cur) {
      await admin.from("fid_live").update({ last_seen: new Date().toISOString(), page, step, max_stage: Math.max(cur.max_stage, stage) }).eq("sid", sid);
    } else {
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
      const g = ip ? await geo(ip) : { country: null, region: null, city: null };
      await admin.from("fid_live").insert({ sid, page, step, max_stage: stage, source: src, device, ...g });
      if (Math.random() < 0.02) await admin.from("fid_live").delete().lt("last_seen", new Date(Date.now() - 30 * 864e5).toISOString());
    }
    return ok();
  } catch (e) {
    console.error("live-ping", e);
    return ok(); // nunca atrapalha a página
  }
});
