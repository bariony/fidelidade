# Fidelidade NFC (MVP)

Cartão de fidelidade por toque NFC: o cliente encosta o celular no bastão, a página abre, registra o carimbo e solta confete. Sem app e sem wallet.

- `c.html?t=TAG` página do cliente (URL gravada na tag NFC)
- `lojista.html` painel do lojista (`admin.html` só redireciona, links antigos) (login, tags, clientes, regras)
- `schema.sql` banco (Supabase), com RLS e funções públicas para o cliente
- `config.js` URL e chave publicável do Supabase

## Representantes (v12)

- **comprar.html?r=CODIGO**: página de compra do kit. O código do representante vem no link, fica guardado no aparelho por 60 dias e vai junto no pedido (o cliente não vê). Cria o login, a loja (já vinculada ao representante) e o pedido.
- **rep.html**: painel do representante (suas lojas, extrato de comissões, repasses e Pix). Primeiro acesso com código de convite criado no admin.
- **super.html**: abas Pedidos, Representantes e Repasses (confirmar pagamento, vincular representante, fechar repasses do dia 15, marcar como pago, reembolsos no detalhe da loja).
- Regras no banco (por representante): custo do kit, % do lucro do kit (50%), % da mensalidade (20%), liberação (15 dias kit, 7 dias mensalidade). Comissão só nasce de pagamento registrado em `fid_billing` (trigger). Reembolso antes do repasse cancela a comissão; depois vira estorno descontado do próximo repasse.
- `config.js`: preencha `SALES_WHATSAPP` para o botão de WhatsApp na tela de pedido recebido.

## Pagamento automático com Asaas (v13)
- `comprar.html` cria o pedido (`fid_order_create`) e chama a Edge Function `asaas-checkout`, que cria cliente + cobrança (`billingType UNDEFINED`: Pix, boleto ou cartão) e devolve o `invoiceUrl`. O comprador é levado a essa página.
- `asaas-webhook` (sem JWT; autenticada pelo header `asaas-access-token`) recebe os eventos: `PAYMENT_RECEIVED/CONFIRMED` → kit pago (`fid_asaas_pay_order`: confirma pedido, cria venda, gera comissão) e cria a assinatura mensal de R$ 49,97 (`nextDueDate` = fim do mês incluso); cobrança de assinatura paga → `fid_asaas_pay_renewal`; `PAYMENT_REFUNDED/CHARGEBACK_REQUESTED` → `fid_asaas_refund` (cancela comissão ou lança estorno). Idempotente por id do evento (`fid_asaas_events`) e por id da cobrança (`fid_billing.asaas_payment_id`).
- Segredos (Supabase → Edge Functions → Secrets): `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `ASAAS_ENV` (`sandbox` ou `prod`). Webhook URL: `https://qpdcffsessmxmkedrjyc.supabase.co/functions/v1/asaas-webhook`.
- Código em `supabase/functions/`. O admin continua com "Confirmar à mão" para pagamentos fora do Asaas.
- Admin, detalhe da loja: topo mostra "Kit pago pelo Asaas" e a assinatura; formulários manuais (venda do kit, renovação, teste) ficam em "Ajustes manuais".
- Reembolso de um kit bloqueia a loja e cancela a assinatura no Asaas (webhook).

## Assinatura, ajuda e cancelamento (v14)
- Carência: 10 dias depois do vencimento (quem cancelou não tem carência). `fid_plan_status` é a fonte única.
- Lojista (`lojista.html`, aba Assinatura): plano, "Pagar agora" (link da cobrança aberta no Asaas), cancelar (plano segue até o vencimento), histórico com "Pedir reembolso" (7 dias), pedidos de ajuda com respostas. Botão flutuante "Preciso de ajuda" (fechar esconde até recarregar).
- Admin (`super.html`, aba Atendimentos): fila de ajuda, cancelamentos e reembolsos; "Aprovar reembolso no Asaas" manda o estorno e o webhook faz o resto. Lojas que cancelaram têm selo e filtro.
- Edge Function `asaas-conta` (JWT): `pay_link`, `cancel`, `refund`. Tabelas `fid_tickets` e `fid_ticket_msgs` (só por RPC).
- Sem teste grátis: a loja do pedido nasce bloqueada (`pending_payment`) até o Asaas confirmar; `fid_stores` não aceita INSERT direto.
- Endereço por tela (v15): `lojista.html#/hoje|clientes|clientes/ID|retiradas|campanhas|tags|loja|regras|assinatura` e `super.html#/lojas|lojas/ID|pedidos|atendimentos|representantes|representantes/ID|repasses`. Botão voltar, F5 e links compartilháveis funcionam.

## v16 — Testes por convite (representante e admin)

- Representante gera link `teste.html?c=CODIGO` na área dele: cota de **3 testes por mês** (renova todo mês, fuso de São Paulo) e até **45 dias** cada. Admin muda os dois limites por representante e gera links sem limite, na aba **Testes** do super.html.
- O lojista abre o link, cria o painel (sem passar pela compra) e a loja nasce `is_trial` com o rep vinculado. Convite vale 14 dias, uso único; o mesmo WhatsApp não usa dois testes.
- Em **Assinatura → Assinar agora** (CPF/CNPJ) a function `asaas-conta` (`subscribe`) cria o cliente e a assinatura de R$ 49,97 com 1ª cobrança no último dia do teste. Pagando antes, o plano estende 30 dias a partir do fim do teste.
- Sem assinatura, o teste pausa no vencimento (sem carência de 10 dias). Com assinatura vale a carência normal.
- Comissão: sem kit, não há comissão de aquisição; o rep ganha só os 20% de cada mensalidade (teste conta como 1º período).
- Tabelas/RPCs: `fid_trial_invites`, `fid_rep_trial_create`, `fid_super_trial_create`, `fid_super_trials`, `fid_super_trial_cancel`, `fid_super_rep_trial_limits`, `fid_trial_peek`, `fid_trial_redeem`.

## v17 — Tum, assistente de IA da loja

- Botão **Tum** no painel do lojista (acima do botão de ajuda): chat em linguagem natural sobre a própria loja (dia/horário mais cheio, quem volta, quem tem prêmio, resumo do mês), mensagens de campanha para WhatsApp, sugestão de prêmio e meta, e orientação de configuração (manual, FAQ, NFC Tools, localização anti-fraude).
- Edge Function `tum-chat` (JWT): chama a Anthropic (Haiku, `TUM_MODEL` para trocar) com tool-use sobre as RPCs `tum_overview`, `tum_customers`, `tum_customer`, executadas com o JWT do lojista. O escopo (só a loja dele) é garantido pelo banco, não pelo prompt. O manual fica em `supabase/functions/tum-chat/knowledge.ts`.
- **Secret obrigatório:** `ANTHROPIC_API_KEY` (Supabase → Edge Functions → Secrets). O lojista nunca vê a chave.
- Uso por pergunta (tokens, ferramentas) em `fid_tum_usage`, sem limite por enquanto. SQL em `tum.sql`.
- Privacidade: nomes de clientes vão ao provedor de IA nas perguntas; o WhatsApp só entra na consulta de uma pessoa. Vale citar na política de privacidade.
- Admin (`super.html#/tum`): aba **Tum** com perguntas, tokens, custo estimado, uso por loja e últimas perguntas (RPC `fid_super_tum_usage`, só super). Visual do admin simplificado (sem cabeçalho escuro, sem sombras duras e sem ícones decorativos).
