// Tum: assistente pessoal da loja (chat com IA) dentro do painel do lojista.
// - verify_jwt = true: só lojista logado chama.
// - Os dados vêm de RPCs tum_* executadas com o JWT do usuário, então o escopo
//   (só a loja dele) é garantido pelo banco, não pelo prompt.
// - A chave da Anthropic fica no secret ANTHROPIC_API_KEY (o lojista nunca vê).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { MANUAL, MANUAL_TOPICS } from "./knowledge.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const MODEL = Deno.env.get("TUM_MODEL") ?? "claude-haiku-5-5";
const MAX_LOOPS = 5;
const MAX_TURNS = 12;
const MAX_CHARS = 1000;

const TOOLS: any[] = [
  {
    name: "tum_overview",
    description: "Resumo da loja num período: regras/prêmio, totais (clientes, carimbos, prêmios ganhos/entregues), carimbos por dia da semana, por hora, por dia/mês e por tag.",
    input_schema: {
      type: "object",
      properties: {
        p_days: { type: "integer", description: "Últimos N dias (padrão 30)." },
        p_from: { type: "string", description: "YYYY-MM-DD (usa com p_to)." },
        p_to: { type: "string", description: "YYYY-MM-DD." },
      },
    },
  },
  {
    name: "tum_customers",
    description: "Lista de clientes ordenada, com carimbos, prêmios, visitas, intervalo médio e última visita. Sem WhatsApp. Serve para rankings e para achar quem está sumido.",
    input_schema: {
      type: "object",
      properties: {
        p_search: { type: "string", description: "Parte do nome." },
        p_inactive_days: { type: "integer", description: "Só quem está há pelo menos N dias sem visitar." },
        p_sort: { type: "string", enum: ["last", "visits", "total", "rewards", "inactive", "frequency"], description: "last=mais recente; visits=mais visitas no período; total=mais carimbos; rewards=mais prêmios; inactive=mais tempo sumido; frequency=volta mais rápido." },
        p_limit: { type: "integer", description: "Máx. de linhas (padrão 8, máx 40)." },
        p_days: { type: "integer", description: "Janela das visitas (padrão 30; 7 = semana)." },
      },
    },
  },
  {
    name: "tum_customer",
    description: "Ficha de UM cliente pelo nome (até 5 resultados): visitas 30/90 dias e total, prêmios, última visita, WhatsApp, últimos eventos.",
    input_schema: { type: "object", properties: { p_search: { type: "string", description: "Nome do cliente." } }, required: ["p_search"] },
  },
  {
    name: "tum_manual",
    description: "Manual do Carimbô. Use SÓ para dúvidas de configuração, NFC, regras, fraude, prêmio, planos, problemas. Tópicos: " +
      Object.entries(MANUAL_TOPICS).map(([k, v]) => `${k} (${v})`).join("; ") + ".",
    input_schema: { type: "object", properties: { topic: { type: "string", enum: Object.keys(MANUAL) } }, required: ["topic"] },
  },
];
// cache_control no último item: tools + system viram prefixo em cache (lê a 10% do preço quando passa do mínimo).
TOOLS[TOOLS.length - 1].cache_control = { type: "ephemeral" };

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function nowBR() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long",
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const iso = `${g("year")}-${g("month")}-${g("day")}`;
  const wd = WEEKDAYS[new Date(iso + "T12:00:00Z").getUTCDay()];
  return { iso, br: `${g("day")}/${g("month")}/${g("year")}`, time: `${g("hour")}:${g("minute")}`, wd };
}

function systemPrompt(storeName: string) {
  const n = nowBR();
  return `Você é o Tum, assistente da loja "${storeName}" no Carimbô (cartão fidelidade por toque NFC). Hoje: ${n.wd}, ${n.br}, ${n.time} (Brasília).

Regras:
- Português do Brasil, simpático e direto. Respostas curtas (o lojista está no balcão, no celular). Pouca formatação.
- Números, nomes e datas só vêm das ferramentas; nunca invente. Chame a ferramenta antes de responder sobre dados, com o mínimo necessário (uma chamada costuma bastar).
- Dúvida de configuração/NFC/regras/prêmio/plano: chame tum_manual com o tópico certo e responda em passos curtos. Se não achar, sugira o "?" do chat para falar com a equipe.
- Várias pessoas com o mesmo nome: pergunte qual. "Visita" = dia com carimbo. Datas já em Brasília.
- Campanha de WhatsApp: use dados reais (nome, carimbos que faltam, prêmio), 2 versões curtas com tons diferentes, sem número de telefone.
- Prêmio/meta: use tum_overview e tum_customers. Segurança/fraude: recomende exigir localização na loja, intervalo e máximo por dia.
- Só enxerga esta loja. Não envia mensagens nem altera nada.`;
}

// Enxuga o resultado das ferramentas antes de mandar ao modelo (menos tokens por pergunta).
function slim(name: string, d: any): any {
  if (!d || typeof d !== "object") return d;
  if (name === "tum_customers" && Array.isArray(d.customers)) {
    const goal = d.customers[0]?.stamps_goal;
    return {
      stamps_goal: goal, total_matching: d.total_matching, visit_window_days: d.period_days_for_visits_in_period,
      customers: d.customers.map((c: any) => {
        const { stamps_goal: _g, customer_since: _s, rewards_delivered: _r, ...rest } = c;
        return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined));
      }),
    };
  }
  if (name === "tum_overview") {
    const o: any = { ...d };
    if (Array.isArray(o.by_day)) o.by_day = o.by_day.filter((x: any) => x.stamps > 0).map((x: any) => [x.date, String(x.weekday).slice(0, 3), x.stamps]);
    if (Array.isArray(o.by_hour)) o.by_hour = o.by_hour.map((x: any) => [x.hour, x.stamps]);
    if (o.store) {
      for (const k of ["bonus_instagram", "bonus_facebook", "bonus_site", "plan_renews_at", "is_trial", "tags_active", "has_attendant_pin"]) delete o.store[k];
    }
    for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
    return o;
  }
  if (name === "tum_customer" && Array.isArray(d.matches)) {
    return { matches: d.matches.map((m: any) => ({ ...m, recent_events: (m.recent_events ?? []).slice(0, 10) })) };
  }
  return d;
}

function clean(msgs: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(msgs)) return [];
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of msgs.slice(-MAX_TURNS)) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = typeof m?.content === "string" ? m.content.trim().slice(0, MAX_CHARS) : "";
    if (!role || !content) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n" + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function anthropic(key: string, system: string, messages: unknown[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], tools: TOOLS, messages }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!KEY) return json({ error: "tum_nao_configurado" }, 503);

    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") ?? "";
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "nao_autenticado" }, 401);

    const { data: storeId } = await userClient.rpc("tum_store");
    if (!storeId) return json({ error: "sem_loja" }, 403);
    const { data: st } = await userClient.rpc("tum_overview", { p_days: 1 });
    const storeName = st?.store?.name ?? "sua loja";

    const body = await req.json().catch(() => ({}));
    const history = clean(body?.messages);
    if (!history.length || history[history.length - 1].role !== "user") return json({ error: "mensagem_vazia" }, 400);

    const system = systemPrompt(storeName);
    const msgs: any[] = history.map((m) => ({ role: m.role, content: m.content }));
    let inTok = 0, outTok = 0, cRead = 0, cWrite = 0, calls = 0, reply = "";

    for (let i = 0; i < MAX_LOOPS; i++) {
      const resp = await anthropic(KEY, system, msgs);
      inTok += resp.usage?.input_tokens ?? 0;
      outTok += resp.usage?.output_tokens ?? 0;
      cRead += resp.usage?.cache_read_input_tokens ?? 0;
      cWrite += resp.usage?.cache_creation_input_tokens ?? 0;
      const content: any[] = resp.content ?? [];
      const uses = content.filter((c) => c.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || !uses.length) {
        reply = content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        break;
      }
      msgs.push({ role: "assistant", content });
      const results: any[] = [];
      for (const tu of uses) {
        calls++;
        let out: unknown;
        if (tu.name === "tum_manual") {
          out = MANUAL[tu.input?.topic as string] ?? { error: "topico_desconhecido" };
        } else if (!TOOLS.some((t) => t.name === tu.name)) {
          out = { error: "ferramenta_desconhecida" };
        } else {
          const args = { ...(tu.input ?? {}) };
          if (tu.name === "tum_customers" && args.p_limit == null) args.p_limit = 8;
          const { data, error } = await userClient.rpc(tu.name, args);
          out = error ? { error: error.message } : slim(tu.name, data);
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: (typeof out === "string" ? out : JSON.stringify(out)).slice(0, 12000) });
      }
      msgs.push({ role: "user", content: results });
    }
    if (!reply) reply = "Não consegui fechar essa resposta agora. Pode perguntar de outro jeito?";

    // Uso (sem limite por enquanto; serve para custo e para limitar depois).
    try {
      const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await admin.from("fid_tum_usage").insert({
        store_id: storeId, question: history[history.length - 1].content.slice(0, 500),
        input_tokens: inTok, output_tokens: outTok, cache_read_tokens: cRead, cache_write_tokens: cWrite, tool_calls: calls,
      });
    } catch (e) { console.error("usage", e); }

    return json({ reply });
  } catch (e) {
    console.error("tum-chat", e);
    return json({ error: "falha_tum" }, 500);
  }
});
