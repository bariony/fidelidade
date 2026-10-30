// Tum: assistente pessoal da loja (chat com IA) dentro do painel do lojista.
// - verify_jwt = true: só lojista logado chama.
// - Os dados vêm de RPCs tum_* executadas com o JWT do usuário, então o escopo
//   (só a loja dele) é garantido pelo banco, não pelo prompt.
// - A chave da Anthropic fica no secret ANTHROPIC_API_KEY (o lojista nunca vê).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { KNOWLEDGE } from "./knowledge.ts";

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
const MAX_CHARS = 2000;

const TOOLS = [
  {
    name: "tum_overview",
    description:
      "Visão geral da loja num período: configuração (prêmio, meta de carimbos, regras), totais (clientes, carimbos, prêmios ganhos/pedidos/entregues/expirados), carimbos por dia da semana, por hora do dia, por dia (ou mês) e por tag. Use para: dia/horário mais cheio, resumo do mês, quantos prêmios foram dados, movimento. Datas no formato YYYY-MM-DD.",
    input_schema: {
      type: "object",
      properties: {
        p_days: { type: "integer", description: "Últimos N dias (padrão 30). Use 365 para o ano, 7 para a semana." },
        p_from: { type: "string", description: "Início do período (YYYY-MM-DD). Se informado com p_to, ignora p_days." },
        p_to: { type: "string", description: "Fim do período (YYYY-MM-DD)." },
      },
    },
  },
  {
    name: "tum_customers",
    description:
      "Lista clientes ordenados, com carimbos, prêmios, visitas, intervalo médio entre visitas e última visita. Use para rankings (quem mais volta, mais tem prêmio, mais visitas) e para achar quem está há X dias sem visitar (p_inactive_days). Não traz WhatsApp.",
    input_schema: {
      type: "object",
      properties: {
        p_search: { type: "string", description: "Filtra por parte do nome." },
        p_inactive_days: { type: "integer", description: "Só clientes sem visita há pelo menos N dias." },
        p_sort: {
          type: "string",
          enum: ["last", "visits", "total", "rewards", "inactive", "frequency"],
          description:
            "last=visitou mais recentemente; visits=mais dias de visita no período; total=mais carimbos no total; rewards=mais prêmios; inactive=mais tempo sem visitar; frequency=menor intervalo médio entre visitas.",
        },
        p_limit: { type: "integer", description: "Máximo de linhas (padrão 15, máx 40)." },
        p_days: { type: "integer", description: "Janela, em dias, para visit_days_in_period (padrão 30). Use 7 para 'na semana'." },
      },
    },
  },
  {
    name: "tum_customer",
    description:
      "Ficha detalhada de UM cliente pelo nome (até 5 resultados): visitas nos últimos 30/90 dias e total, prêmios, última visita e dia da semana, WhatsApp e últimos eventos. Use para perguntas sobre uma pessoa específica.",
    input_schema: {
      type: "object",
      properties: { p_search: { type: "string", description: "Nome (ou parte do nome) do cliente." } },
      required: ["p_search"],
    },
  },
];

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
  return `Você é o Tum, assistente pessoal da loja "${storeName}", dentro do painel do Carimbô (cartão fidelidade por toque NFC). O nome vem do som do carimbo batendo: "Tum!".

HOJE: ${n.wd}, ${n.br}, ${n.time} (horário de Brasília). Use isso para "ontem", "essa semana", "mês passado" etc.

COMO RESPONDER
- Português do Brasil, tom simpático e direto, como um sócio que entende do negócio. Respostas curtas; o lojista está no balcão, no celular.
- Pouca formatação: frases curtas, no máximo uma lista simples quando ajudar. Sem títulos grandes.
- NUNCA invente números, nomes ou datas. Dados da loja só vêm das ferramentas. Se a ferramenta não trouxer, diga que não tem essa informação.
- Antes de responder qualquer pergunta sobre dados, chame a ferramenta adequada. Pode chamar mais de uma.
- Se houver mais de um cliente com o nome citado, pergunte qual deles (mostre nome e última visita) antes de afirmar algo.
- "Visita" = um dia em que o cliente bateu carimbo (vários carimbos no mesmo dia contam uma visita).
- Datas e horas já vêm em horário de Brasília. Fale "terça-feira", "entre 8h e 12h", "12/10".
- Quando a loja tem poucos dados, diga isso com honestidade em vez de tirar conclusões fortes.
- Você só enxerga ESTA loja. Se pedirem dados de outras lojas ou de qualquer coisa fora do Carimbô, explique gentilmente que não é seu papel.
- Você não envia mensagens nem altera nada no sistema. Escreve textos e orienta; o lojista é quem envia e configura.

O QUE VOCÊ FAZ
1. Responde sobre o negócio: frequência, dia e horário mais cheio, quem são os clientes, quem mais volta, quem tem mais prêmios, resumo do mês, prêmios dados.
2. Escreve mensagens de campanha de WhatsApp (ex.: clientes sumidos há X dias). Use os dados reais (nome, carimbos que faltam, prêmio da loja). Ofereça 2 versões curtas com tons diferentes. Nunca inclua o número de WhatsApp na resposta, o lojista usa o botão de WhatsApp na ficha do cliente. Se pedir a lista de quem contatar, use tum_customers com p_inactive_days.
3. Recomenda prêmio e meta de carimbos, olhando a configuração atual e a frequência real (tum_overview e tum_customers).
4. Orienta a configurar o Carimbô: regras, tags, NFC Tools, onde encostar o celular, testes. Sempre que falar de segurança ou fraude, recomende ativar "exigir que o cliente esteja na loja" (localização), intervalo entre carimbos e máximo por dia.
Se a pergunta for de configuração, responda com o manual abaixo, em passos curtos. Se não souber, diga e sugira o botão "Preciso de ajuda" do painel.

MANUAL E FAQ DO CARIMBÔ
${KNOWLEDGE}`;
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
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, tools: TOOLS, messages }),
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
    let inTok = 0, outTok = 0, calls = 0, reply = "";

    for (let i = 0; i < MAX_LOOPS; i++) {
      const resp = await anthropic(KEY, system, msgs);
      inTok += resp.usage?.input_tokens ?? 0;
      outTok += resp.usage?.output_tokens ?? 0;
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
        if (!TOOLS.some((t) => t.name === tu.name)) {
          out = { error: "ferramenta_desconhecida" };
        } else {
          const { data, error } = await userClient.rpc(tu.name, tu.input ?? {});
          out = error ? { error: error.message } : data;
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 24000) });
      }
      msgs.push({ role: "user", content: results });
    }
    if (!reply) reply = "Não consegui fechar essa resposta agora. Pode perguntar de outro jeito?";

    // Uso (sem limite por enquanto; serve para custo e para limitar depois).
    try {
      const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await admin.from("fid_tum_usage").insert({
        store_id: storeId, question: history[history.length - 1].content.slice(0, 500),
        input_tokens: inTok, output_tokens: outTok, tool_calls: calls,
      });
    } catch (e) { console.error("usage", e); }

    return json({ reply });
  } catch (e) {
    console.error("tum-chat", e);
    return json({ error: "falha_tum" }, 500);
  }
});
