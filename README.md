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
