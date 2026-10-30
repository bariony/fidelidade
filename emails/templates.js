// E-mails do Carimbô no estilo do kit: papel creme, azul-tinta, vermelho carimbo, borda grossa e sombra dura.
// Fonte única. O mesmo arquivo roda na Edge Function send-email (copiado como templates.ts) e gera a prévia.
// HTML com tabelas e estilos inline, para funcionar em Gmail, Outlook e celular.

const SITE = "https://carimbo.io";
const C = { paper: "#FBF7EE", ink: "#14296B", red: "#E03A2F", kraft: "#EAD9B6", line: "#E4D9C0", muted: "#3D4C80", white: "#FFFFFF" };
const FONT = "'Nunito','Trebuchet MS',Arial,Helvetica,sans-serif";
const HFONT = "'Fredoka','Nunito','Trebuchet MS',Arial,Helvetica,sans-serif";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => "R$ " + Number(v).toFixed(2).replace(".", ",");
export const orderCode = (id) => "CAR-" + String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
const fdate = (d) => new Date(d).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "long", year: "numeric" });

const button = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 8px"><tr><td style="background:${C.red};border:2.5px solid ${C.ink};border-radius:12px;box-shadow:3px 3px 0 ${C.ink}">` +
  `<a href="${href}" style="display:inline-block;padding:14px 28px;font-family:${HFONT};font-weight:700;font-size:17px;line-height:1;color:#ffffff;text-decoration:none">${label}</a></td></tr></table>`;

const p = (html, extra = "") => `<p style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.55;color:${C.ink};${extra}">${html}</p>`;
const h1 = (t) => `<h1 style="margin:0 0 14px;font-family:${HFONT};font-weight:700;font-size:28px;line-height:1.15;color:${C.ink}">${t}</h1>`;
const small = (html) => `<p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted}">${html}</p>`;

const kraftBox = (rows) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:${C.kraft};border:2px dashed ${C.ink};border-radius:14px"><tr><td style="padding:16px 18px">` +
  rows.map(([k, v], i) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${i ? ` style="border-top:1px dashed ${C.ink}55;margin-top:9px;padding-top:9px"` : ""}><tr>` +
    `<td style="font-family:${FONT};font-size:13px;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;vertical-align:top;padding-top:${i ? 9 : 0}px;width:40%">${k}</td>` +
    `<td align="right" style="font-family:${FONT};font-size:16px;font-weight:800;color:${C.ink};vertical-align:top;padding-top:${i ? 9 : 0}px">${v}</td></tr></table>`).join("") +
  `</td></tr></table>`;

const steps = (items) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0">` +
  items.map((t, i) => `<tr><td valign="top" style="padding:7px 12px 7px 0;width:34px"><div style="width:28px;height:28px;border-radius:50%;background:${C.ink};color:#fff;font-family:${HFONT};font-weight:700;font-size:15px;line-height:28px;text-align:center">${i + 1}</div></td>` +
    `<td valign="top" style="padding:7px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${C.ink}">${t}</td></tr>`).join("") + `</table>`;

function layout({ preheader, body }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Carimbô</title></head>` +
    `<body style="margin:0;padding:0;background:${C.paper}">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.paper}">${esc(preheader)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper}"><tr><td align="center" style="padding:28px 14px 40px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">` +
    // cabeçalho
    `<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle"><img src="${SITE}/icons/icon-192.png" width="40" height="40" alt="" style="display:block;border:0;border-radius:10px"></td>` +
    `<td valign="middle" style="padding-left:10px;font-family:${HFONT};font-weight:700;font-size:26px;color:${C.ink};letter-spacing:.01em">carimb<span style="color:${C.red}">ô</span></td></tr></table></td></tr>` +
    // cartão
    `<tr><td style="background:${C.white};border:3px solid ${C.ink};border-radius:20px;box-shadow:5px 5px 0 ${C.ink};padding:30px 28px 26px">${body}</td></tr>` +
    // rodapé
    `<tr><td style="padding:22px 8px 0;text-align:center;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${C.muted}">` +
    `Tum! É o som do carimbo batendo.<br>Cartão fidelidade por toque · <a href="${SITE}" style="color:${C.muted}">carimbo.io</a><br>` +
    `Este e-mail é automático, não precisa responder. Dúvidas? Entre no painel, abra o <b>Tum</b> e toque no <b>?</b>.</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

const plain = (lines) => lines.filter((l) => l !== null && l !== undefined).join("\n");

/* ---------- 1. Pedido recebido (aguardando pagamento) ---------- */
export function orderPending({ name, orderId, total, payUrl }) {
  const code = orderCode(orderId);
  const body = h1(`Quase lá, ${esc((name || "").split(" ")[0] || "")}!`) +
    p("Recebemos o seu pedido do <b>Kit Carimbô</b>. Falta só o pagamento para a gente separar o seu kit.") +
    kraftBox([["Pedido", code], ["Total", brl(total)]]) +
    button(esc(payUrl), "Pagar meu pedido") +
    small("Pode pagar por Pix, boleto ou cartão. Assim que o pagamento for confirmado, você recebe um novo e-mail com os próximos passos.");
  return {
    subject: `Pedido ${code} recebido: falta o pagamento`,
    html: layout({ preheader: `Seu pedido ${code} está esperando o pagamento.`, body }),
    text: plain([`Recebemos o seu pedido ${code} do Kit Carimbô (${brl(total)}).`, "Falta só o pagamento:", payUrl, "", "Carimbô · carimbo.io"]),
  };
}

/* ---------- 2. Pedido confirmado ---------- */
export function orderPaid({ name, orderId, kit, shipping, delivery, paidAt, email, loginUrl = SITE + "/lojista.html" }) {
  const code = orderCode(orderId), hand = delivery === "retirada", total = Number(kit) + Number(shipping || 0);
  const body = h1(`Pedido confirmado! 🎉`) +
    p(`Oi, ${esc((name || "").split(" ")[0] || "tudo bem")}! Recebemos o seu pagamento e o seu <b>Kit Carimbô</b> já está sendo preparado.`) +
    kraftBox([
      ["Pedido", code],
      ["Data", fdate(paidAt || new Date())],
      ["Kit", "2 bastões + placa Google"],
      ["Valor", brl(total)],
      ["Entrega", hand ? "Em mãos" : "Correios"],
      ["Prazo", "até 7 dias"],
    ]) +
    p(hand ? "Seu representante entrega o kit <b>em mãos em até 7 dias</b>." : "Seu kit chega no endereço informado <b>em até 7 dias</b>. Quando for postado, avisamos o código de rastreio no painel.") +
    `<p style="margin:20px 0 4px;font-family:${HFONT};font-weight:700;font-size:19px;color:${C.ink}">Enquanto o kit não chega</p>` +
    steps([
      `<b>Entre no painel</b> com o e-mail <b>${esc(email || "da compra")}</b> e a senha que você criou.`,
      "Monte o seu cartão em <b>Loja</b> (nome, símbolo, cores) e defina o prêmio em <b>Regras</b>.",
      "Em <b>Tags</b>, crie o ponto de toque (ex.: Balcão). Quando o kit chegar, é só gravar o link no bastão com o app NFC Tools.",
    ]) +
    button(esc(loginUrl), "Acessar minha loja") +
    small("Guarde o número do pedido. Se precisar de ajuda, ele agiliza o atendimento.");
  return {
    subject: `Pedido ${code} confirmado! Seu kit chega em até 7 dias`,
    html: layout({ preheader: `Pagamento recebido. Seu kit chega em até 7 dias. Pedido ${code}.`, body }),
    text: plain([
      `Pedido confirmado! Pedido ${code}`, `Recebemos o seu pagamento (${brl(total)}).`,
      hand ? "Entrega em mãos em até 7 dias." : "Entrega pelos Correios em até 7 dias.", "",
      `Acesse a sua loja: ${loginUrl}`, `Entre com o e-mail ${email || "da compra"} e a senha que você criou.`, "", "Carimbô · carimbo.io",
    ]),
  };
}

/* ---------- 3. Acesso criado: lojista ---------- */
export function welcomeShop({ name, email, loginUrl = SITE + "/lojista.html" }) {
  const body = h1("Seu acesso está pronto") +
    p(`Oi${name ? ", " + esc(name.split(" ")[0]) : ""}! Sua conta no <b>Carimbô</b> foi criada. Agora é só entrar no painel e montar o cartão fidelidade da sua loja.`) +
    kraftBox([["Seu acesso", esc(email)]]) +
    `<p style="margin:18px 0 4px;font-family:${HFONT};font-weight:700;font-size:19px;color:${C.ink}">Comece em 3 passos</p>` +
    steps(["Em <b>Loja</b>, coloque o nome, o símbolo e as cores do seu cartão.", "Em <b>Regras</b>, escolha o prêmio e quantos carimbos o cliente precisa.", "Em <b>Tags</b>, crie o ponto de toque e grave o link no bastão com o NFC Tools."]) +
    button(esc(loginUrl), "Entrar no painel") +
    small("Esqueceu a senha? Na tela de entrada, toque em <b>Esqueci minha senha</b>.");
  return {
    subject: "Seu acesso ao Carimbô está pronto",
    html: layout({ preheader: "Sua conta foi criada. Entre no painel e monte o cartão da sua loja.", body }),
    text: plain(["Seu acesso ao Carimbô está pronto.", `Entre com o e-mail ${email}:`, loginUrl, "", "Carimbô · carimbo.io"]),
  };
}

/* ---------- 4. Acesso criado: representante ---------- */
export function welcomeRep({ name, email, saleLink, loginUrl = SITE + "/rep.html" }) {
  const body = h1("Bem-vindo ao time Carimbô") +
    p(`Oi${name ? ", " + esc(name.split(" ")[0]) : ""}! Seu acesso de <b>representante</b> foi criado. No seu painel você acompanha as lojas que indicou, as comissões e os repasses.`) +
    kraftBox([["Seu acesso", esc(email)], ...(saleLink ? [["Seu link de venda", `<a href="${esc(saleLink)}" style="color:${C.ink}">${esc(saleLink.replace(/^https?:\/\//, ""))}</a>`]] : [])]) +
    `<p style="margin:18px 0 4px;font-family:${HFONT};font-weight:700;font-size:19px;color:${C.ink}">Como funciona</p>` +
    steps(["Compartilhe o seu <b>link de venda</b> ou gere um <b>teste grátis</b> para o lojista.", "Quando o lojista paga o kit e as mensalidades, a sua <b>comissão</b> é lançada.", "Cadastre a sua <b>chave Pix</b> no painel. Os repasses são fechados todo mês."]) +
    button(esc(loginUrl), "Abrir meu painel") +
    small("Esqueceu a senha? Na tela de entrada, toque em <b>Esqueci minha senha</b>.");
  return {
    subject: "Seu acesso de representante Carimbô está pronto",
    html: layout({ preheader: "Seu acesso de representante foi criado. Veja seu link de venda e suas comissões.", body }),
    text: plain(["Seu acesso de representante Carimbô está pronto.", `Entre com o e-mail ${email}:`, loginUrl, saleLink ? `Seu link de venda: ${saleLink}` : null, "", "Carimbô · carimbo.io"]),
  };
}

/* ---------- 5. E-mails do Supabase Auth (placeholders do Supabase, sem escape) ---------- */
export const AUTH_URL = "{{ .ConfirmationURL }}";
export function authReset() {
  const body = h1("Esqueceu a senha?") +
    p("Sem problema. Toque no botão abaixo para criar uma senha nova para o seu acesso ao Carimbô.") +
    button(AUTH_URL, "Criar nova senha") +
    small("O link vale por tempo limitado e só pode ser usado uma vez. Se você não pediu para trocar a senha, ignore este e-mail: nada muda na sua conta.");
  return { subject: "Crie uma nova senha no Carimbô", html: layout({ preheader: "Use o link para criar uma nova senha.", body }) };
}
export function authConfirm() {
  const body = h1("Confirme o seu e-mail") +
    p("Falta só um toque para ativar o seu acesso ao Carimbô.") + button(AUTH_URL, "Confirmar meu e-mail") +
    small("Se você não criou uma conta, é só ignorar este e-mail.");
  return { subject: "Confirme o seu e-mail no Carimbô", html: layout({ preheader: "Confirme o seu e-mail para ativar o acesso.", body }) };
}
export function authMagic() {
  const body = h1("Seu link de entrada") + p("Toque no botão para entrar no Carimbô sem digitar a senha.") + button(AUTH_URL, "Entrar no Carimbô") +
    small("O link vale por pouco tempo. Se não foi você, ignore este e-mail.");
  return { subject: "Seu link de entrada no Carimbô", html: layout({ preheader: "Use o link para entrar.", body }) };
}
export function authInvite() {
  const body = h1("Você foi convidado") + p("Alguém da equipe Carimbô convidou você. Toque no botão para criar o seu acesso.") + button(AUTH_URL, "Aceitar convite") +
    small("Se você não esperava este convite, ignore este e-mail.");
  return { subject: "Você foi convidado para o Carimbô", html: layout({ preheader: "Crie o seu acesso ao Carimbô.", body }) };
}
export function authEmailChange() {
  const body = h1("Confirme o novo e-mail") + p("Você pediu para trocar o e-mail do seu acesso ao Carimbô. Toque no botão para confirmar.") + button(AUTH_URL, "Confirmar novo e-mail") +
    small("Se você não pediu essa troca, ignore este e-mail e troque a sua senha por segurança.");
  return { subject: "Confirme a troca de e-mail no Carimbô", html: layout({ preheader: "Confirme a troca do e-mail do seu acesso.", body }) };
}
