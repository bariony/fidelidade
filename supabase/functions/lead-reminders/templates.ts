// @ts-nocheck
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
    `Este e-mail é automático, não precisa responder.</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

const plain = (lines) => lines.filter((l) => l !== null && l !== undefined).join("\n");

/* ---------- Lembrete de carrinho abandonado (30 min depois) ---------- */
export function leadReminder({ name, payUrl }) {
  const first = esc((name || "").split(" ")[0] || "");
  const body = h1(first ? `${first}, o seu kit ficou esperando` : "O seu kit ficou esperando") +
    p("Você começou o pedido do <b>Kit Carimbô</b> e não chegou a finalizar. Sem problema: dá para continuar de onde parou, em menos de 2 minutos.") +
    kraftBox([["No kit", "2 bastões + placa Google"], ["Painel", "30 dias incluídos"], ["Entrega", "Correios, até 7 dias"]]) +
    button(esc(payUrl), "Finalizar meu pedido") +
    small("Enviamos este lembrete uma única vez, para não incomodar.");
  return {
    subject: first ? `${first}, seu kit Carimbô ficou esperando` : "Seu kit Carimbô ficou esperando",
    html: layout({ preheader: "Falta pouco para finalizar o seu pedido do Kit Carimbô.", body }),
    text: plain(["Você começou o pedido do Kit Carimbô e não finalizou.", "Continue de onde parou:", payUrl, "", "Enviamos este lembrete uma única vez.", "Carimbô · carimbo.io"]),
  };
}
