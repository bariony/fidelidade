# Fidelidade NFC (MVP)

Cartão de fidelidade por toque NFC: o cliente encosta o celular no bastão, a página abre, registra o carimbo e solta confete. Sem app e sem wallet.

- `c.html?t=TAG` página do cliente (URL gravada na tag NFC)
- `admin.html` painel do lojista (login, tags, clientes, regras)
- `schema.sql` banco (Supabase), com RLS e funções públicas para o cliente
- `config.js` URL e chave publicável do Supabase
