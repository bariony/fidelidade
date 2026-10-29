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
