// =====================================================================
// Lumière Beauty — Edge Function "lb-loja" (site de vendas online)
// Função PÚBLICA (Verify JWT desligado): o site chama sem login.
// Ela só entrega o catálogo (sem custo/margem/clientes) e recebe pedidos
// validados no servidor — o site nunca acessa o banco direto.
//
// Usa automaticamente: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
// Opcional (pagamento online): MP_ACCESS_TOKEN (Mercado Pago)
//
// Ações (POST JSON { action, data }):
//   ping | catalogo | pedido | status
// Webhook do Mercado Pago: POST ...?webhook=mp
// =====================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const env = (k: string) => Deno.env.get(k) || "";
const SB = env("SUPABASE_URL");
const SR = env("SUPABASE_SERVICE_ROLE_KEY");
const TABLE = "lb_records";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const digits = (s: string) => String(s || "").replace(/\D/g, "");
const todayBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const rid = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

const SITE_DEFAULTS = {
  enabled: false, retirada: true, entrega: true, taxaEntrega: 10, entregaGratisAcima: 300, cidadesEntrega: "Ponta Grossa",
  pedidoMinimo: 0, pixOnline: true, cartaoOnline: true, pagarNaRetirada: true,
  prazoRetirada: "Pronto para retirar em até 2 horas (horário comercial)", prazoEntrega: "Entrega no mesmo dia para pedidos até 16h",
  whatsapp: "", siteUrl: "", avisoTopo: "", instagram: "",
};

// ------------------------- banco (service role) -------------------------
const H = () => ({ apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" });
async function load(colls: string[], extra = "") {
  const out: any[] = []; const page = 1000;
  for (let from = 0; ; from += page) {
    const r = await fetch(`${SB}/rest/v1/${TABLE}?select=coll,id,data&deleted=eq.false&coll=in.(${colls.join(",")})${extra}&order=id.asc`, { headers: { ...H(), Range: `${from}-${from + page - 1}`, "Range-Unit": "items" } });
    if (!r.ok) throw new Error("Banco indisponível (" + r.status + ")");
    const rows = await r.json(); out.push(...rows);
    if (rows.length < page) break;
  }
  const by: Record<string, any[]> = {}; colls.forEach((c) => (by[c] = []));
  out.forEach((x) => by[x.coll] && by[x.coll].push(x.data));
  return by;
}
async function put(coll: string, id: string, data: unknown) {
  const r = await fetch(`${SB}/rest/v1/${TABLE}?on_conflict=coll,id`, {
    method: "POST", headers: { ...H(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ coll, id, data, deleted: false, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error("Não foi possível gravar (" + r.status + "): " + (await r.text()).slice(0, 200));
}
const settingsOf = (by: any) => (by.settings && by.settings[0]) || {};
const siteCfg = (s: any) => Object.assign({}, SITE_DEFAULTS, (s.integrations && s.integrations.site) || {});

// ------------------------- catálogo -------------------------
function buildCatalog(by: any) {
  const s = settingsOf(by); const cfg = siteCfg(s); const today = todayBR();
  const pays: Record<string, any> = {}; (by.webPayments || []).forEach((p: any) => (pays[p.id] = p));
  // reserva: pedidos do site ainda não faturados nem cancelados
  const reserved: Record<string, number> = {};
  (by.webOrders || []).forEach((o: any) => {
    if (["concluido", "cancelado"].includes(o.status)) return;
    const p = pays[o.id];
    const online = o.pagamento === "pix" || o.pagamento === "cartao";
    const old = Date.now() - new Date(o.createdAt).getTime() > 60 * 60000;
    if (online && (!p || p.status !== "pago") && old) return; // pagamento online abandonado
    (o.itens || []).forEach((i: any) => (reserved[i.variationId] = (reserved[i.variationId] || 0) + Number(i.qtd || 0)));
  });
  const lotsBy: Record<string, number> = {};
  (by.lots || []).forEach((l: any) => {
    if (!(l.qty > 0)) return;
    if (l.expiryDate && l.expiryDate < today) return;
    if (l.entryDate && l.entryDate > today) return;
    lotsBy[l.variationId] = (lotsBy[l.variationId] || 0) + Number(l.qty);
  });
  const promo: Record<string, number> = {};
  (by.promotions || []).forEach((p: any) => { if (p.active) promo[p.variationId] = Number(p.pct) || 0; });
  const vars: Record<string, any[]> = {};
  (by.variations || []).forEach((v: any) => { if (v.status === "inativo") return; (vars[v.productId] = vars[v.productId] || []).push(v); });
  const produtos = (by.products || [])
    .filter((p: any) => (p.status || "ativo") === "ativo" && p.channels !== "Somente PDV")
    .map((p: any) => ({
      id: p.id, nome: p.name, marca: p.brand || "", linha: p.line || "", categoria: p.category || "", descricao: p.description || "", imagem: p.image || "", selo: p.tag || "", tipo: p.attrType || "unitario",
      variacoes: (vars[p.id] || []).map((v: any) => {
        const pct = promo[v.id] || 0; const preco = r2(v.price * (1 - pct / 100));
        return { id: v.id, sku: v.sku, nome: v.name || "Padrão", imagem: v.image || "", preco, precoCheio: r2(v.price), promo: pct, estoque: Math.max(0, (lotsBy[v.id] || 0) - (reserved[v.id] || 0)) };
      }),
    }))
    .filter((p: any) => p.variacoes.length);
  const st = s.store || {};
  return {
    aberta: !!cfg.enabled,
    loja: { nome: st.name || "Lumière Beauty", unidade: st.unit || "", cidade: st.city || "", uf: st.uf || "", endereco: st.address || "", telefone: st.phone || "", whatsapp: digits(cfg.whatsapp || st.phone || ""), instagram: cfg.instagram || "" },
    config: {
      retirada: !!cfg.retirada, entrega: !!cfg.entrega, taxaEntrega: r2(cfg.taxaEntrega), entregaGratisAcima: r2(cfg.entregaGratisAcima),
      cidadesEntrega: String(cfg.cidadesEntrega || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean),
      pedidoMinimo: r2(cfg.pedidoMinimo), prazoRetirada: cfg.prazoRetirada, prazoEntrega: cfg.prazoEntrega, avisoTopo: cfg.avisoTopo,
      pagamentos: { pix: !!cfg.pixOnline && !!env("MP_ACCESS_TOKEN"), cartao: !!cfg.cartaoOnline && !!env("MP_ACCESS_TOKEN"), naRetirada: !!cfg.pagarNaRetirada },
    },
    categorias: [...new Set(produtos.map((p: any) => p.categoria).filter(Boolean))],
    produtos,
  };
}

// ------------------------- Mercado Pago -------------------------
const MP = "https://api.mercadopago.com";
const mpH = (x: Record<string, string> = {}) => ({ Authorization: `Bearer ${env("MP_ACCESS_TOKEN")}`, "Content-Type": "application/json", ...x });
const isoBR = (d: Date) => new Date(d.getTime() - 3 * 3600e3).toISOString().replace("Z", "-03:00");
const webhookUrl = () => `${SB}/functions/v1/lb-loja?webhook=mp`;

async function mpPix(order: any, email: string) {
  const exp = new Date(Date.now() + 30 * 60000);
  const r = await fetch(`${MP}/v1/payments`, {
    method: "POST", headers: mpH({ "X-Idempotency-Key": `lbweb-${order.id}` }),
    body: JSON.stringify({ transaction_amount: order.total, description: `Pedido ${order.numero} — Lumière Beauty`, payment_method_id: "pix", external_reference: order.id, notification_url: webhookUrl(), date_of_expiration: isoBR(exp), payer: { email: email || `cliente+${order.numero}@lumiere.local`, first_name: order.cliente.nome.split(" ")[0] } }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Pix: " + (b.message || r.status));
  const td = (b.point_of_interaction && b.point_of_interaction.transaction_data) || {};
  return { mpPaymentId: String(b.id), copiaECola: td.qr_code, qrBase64: td.qr_code_base64, expiresAt: exp.toISOString() };
}
async function mpCheckout(order: any, siteUrl: string) {
  const back = `${siteUrl || ""}#/pedido/${order.id}?t=${order.token}`;
  const items = order.itens.map((i: any) => ({ id: i.sku, title: i.nome, quantity: i.qtd, unit_price: i.preco, currency_id: "BRL" }));
  if (order.frete > 0) items.push({ id: "frete", title: "Entrega", quantity: 1, unit_price: order.frete, currency_id: "BRL" });
  const r = await fetch(`${MP}/checkout/preferences`, {
    method: "POST", headers: mpH(),
    body: JSON.stringify({ items, external_reference: order.id, notification_url: webhookUrl(), payer: { name: order.cliente.nome, email: order.cliente.email || undefined }, payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 6 }, ...(siteUrl ? { back_urls: { success: back, pending: back, failure: back }, auto_return: "approved" } : {}) }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Cartão: " + (b.message || r.status));
  return { prefId: b.id, initPoint: b.init_point };
}
/** Consulta o MP e atualiza o pagamento do pedido */
async function syncPayment(order: any, pay: any) {
  if (!pay || pay.status === "pago" || !env("MP_ACCESS_TOKEN")) return pay;
  let approved: any = null; let expired = false;
  if (pay.mpPaymentId) {
    const r = await fetch(`${MP}/v1/payments/${pay.mpPaymentId}`, { headers: mpH() }); const b = await r.json().catch(() => ({}));
    if (b.status === "approved") approved = b; else if (["cancelled", "rejected", "expired"].includes(b.status)) expired = true;
  } else {
    const r = await fetch(`${MP}/v1/payments/search?external_reference=${encodeURIComponent(order.id)}&sort=date_created&criteria=desc`, { headers: mpH() });
    const b = await r.json().catch(() => ({}));
    approved = (b.results || []).find((x: any) => x.status === "approved") || null;
  }
  if (approved) {
    pay = { ...pay, status: "pago", paidAt: new Date().toISOString(), mpPaymentId: String(approved.id), metodo: approved.payment_type_id, bandeira: approved.payment_method_id || "", parcelas: approved.installments || 1, autorizacao: approved.authorization_code || "", valorPago: approved.transaction_amount };
    await put("webPayments", order.id, pay);
  } else if (expired && pay.status !== "expirado") { pay = { ...pay, status: "expirado" }; await put("webPayments", order.id, pay); }
  return pay;
}

// ------------------------- pedido -------------------------
async function createOrder(d: any) {
  const by = await load(["settings", "products", "variations", "lots", "promotions", "webOrders", "webPayments"]);
  const cat = buildCatalog(by); const cfg = siteCfg(settingsOf(by));
  if (!cat.aberta) throw new Error("A loja online está fechada no momento.");
  const c = d.cliente || {}; const e = d.entrega || {};
  if (!c.nome || String(c.nome).trim().length < 3) throw new Error("Informe seu nome completo.");
  if (digits(c.telefone).length < 10) throw new Error("Informe um WhatsApp/telefone válido com DDD.");
  if (!Array.isArray(d.itens) || !d.itens.length || d.itens.length > 40) throw new Error("Carrinho vazio.");
  const vmap: Record<string, any> = {}; cat.produtos.forEach((p: any) => p.variacoes.forEach((v: any) => (vmap[v.id] = { ...v, produto: p })));
  const itens = d.itens.map((i: any) => {
    const v = vmap[i.variationId]; const qtd = Math.floor(Number(i.qtd) || 0);
    if (!v) throw new Error("Um produto do carrinho não está mais disponível.");
    if (qtd < 1 || qtd > 30) throw new Error("Quantidade inválida.");
    if (qtd > v.estoque) throw new Error(`Só temos ${v.estoque} un de ${v.produto.nome}${v.nome !== "Padrão" ? " — " + v.nome : ""}.`);
    return { variationId: v.id, sku: v.sku, nome: v.produto.nome + (v.nome && v.nome !== "Padrão" ? " — " + v.nome : ""), qtd, preco: v.preco, total: r2(v.preco * qtd) };
  });
  const subtotal = r2(itens.reduce((a: number, i: any) => a + i.total, 0));
  if (cfg.pedidoMinimo && subtotal < cfg.pedidoMinimo) throw new Error(`Pedido mínimo de R$ ${cfg.pedidoMinimo.toFixed(2).replace(".", ",")}.`);
  let frete = 0;
  if (e.tipo === "entrega") {
    if (!cat.config.entrega) throw new Error("Entrega indisponível.");
    if (!e.rua || !e.numero || !e.bairro) throw new Error("Preencha o endereço de entrega.");
    const cities = cat.config.cidadesEntrega.map(norm);
    if (cities.length && !cities.includes(norm(e.cidade))) throw new Error("Ainda não entregamos nessa cidade. Escolha retirada na loja.");
    frete = cat.config.entregaGratisAcima && subtotal >= cat.config.entregaGratisAcima ? 0 : cat.config.taxaEntrega;
  } else if (!cat.config.retirada) throw new Error("Retirada indisponível.");
  const pg = d.pagamento;
  if (!({ pix: cat.config.pagamentos.pix, cartao: cat.config.pagamentos.cartao, na_retirada: cat.config.pagamentos.naRetirada } as any)[pg]) throw new Error("Forma de pagamento indisponível.");
  const numero = Math.max(1000, ...(by.webOrders || []).map((o: any) => Number(o.numero) || 0)) + 1;
  const id = "web_" + rid(14);
  const order: any = {
    id, numero, token: rid(24), createdAt: new Date().toISOString(), status: "novo",
    cliente: { nome: String(c.nome).trim().slice(0, 80), cpf: digits(c.cpf).slice(0, 11), telefone: digits(c.telefone).slice(0, 13), email: String(c.email || "").trim().slice(0, 120) },
    entrega: e.tipo === "entrega" ? { tipo: "entrega", rua: e.rua, numero: e.numero, complemento: e.complemento || "", bairro: e.bairro, cidade: e.cidade, cep: digits(e.cep), referencia: e.referencia || "" } : { tipo: "retirada" },
    pagamento: pg, itens, subtotal, frete: r2(frete), total: r2(subtotal + frete), obs: String(d.obs || "").slice(0, 400), origem: "site",
  };
  await put("webOrders", id, order);
  let pay: any = { id, orderId: id, method: pg, amount: order.total, status: pg === "na_retirada" ? "na_entrega" : "pendente", createdAt: order.createdAt };
  try {
    if (pg === "pix") Object.assign(pay, await mpPix(order, order.cliente.email));
    if (pg === "cartao") Object.assign(pay, await mpCheckout(order, cfg.siteUrl || d.siteUrl || ""));
  } catch (err) { pay.status = "erro"; pay.error = (err as Error).message; }
  await put("webPayments", id, pay);
  return publicView(order, pay);
}
function publicView(o: any, p: any) {
  return {
    id: o.id, token: o.token, numero: o.numero, status: o.status, createdAt: o.createdAt, cliente: { nome: o.cliente.nome }, entrega: o.entrega,
    itens: o.itens.map((i: any) => ({ nome: i.nome, qtd: i.qtd, preco: i.preco, total: i.total })), subtotal: o.subtotal, frete: o.frete, total: o.total,
    pagamento: { metodo: o.pagamento, status: p ? p.status : "pendente", copiaECola: p && p.status === "pendente" ? p.copiaECola : undefined, qrBase64: p && p.status === "pendente" ? p.qrBase64 : undefined, initPoint: p && p.status === "pendente" ? p.initPoint : undefined, expiresAt: p && p.expiresAt, erro: p && p.error },
  };
}
async function getOrder(id: string) {
  const by = await load(["webOrders", "webPayments"], `&id=eq.${encodeURIComponent(id)}`);
  return { order: by.webOrders[0], pay: by.webPayments[0] };
}

// ------------------------- roteador -------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (!SB || !SR) throw new Error("Função sem acesso ao banco (SUPABASE_SERVICE_ROLE_KEY).");
    // Webhook do Mercado Pago (pagamento aprovado)
    if (url.searchParams.get("webhook") === "mp") {
      const b = await req.json().catch(() => ({}));
      const payId = (b.data && b.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id");
      if (payId && env("MP_ACCESS_TOKEN")) {
        const r = await fetch(`${MP}/v1/payments/${payId}`, { headers: mpH() }); const p = await r.json().catch(() => ({}));
        if (p.external_reference) { const { order, pay } = await getOrder(p.external_reference); if (order) await syncPayment(order, { ...(pay || { id: order.id, orderId: order.id, method: order.pagamento }), mpPaymentId: String(p.id) }); }
      }
      return json({ ok: true });
    }
    if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
    const { action, data } = await req.json();
    const d = data || {};
    if (action === "ping") { const by = await load(["settings"]); return json({ ok: true, result: { message: siteCfg(settingsOf(by)).enabled ? "Loja online aberta" : "Função ok — loja online desligada no sistema", mp: !!env("MP_ACCESS_TOKEN") } }); }
    if (action === "catalogo") { const by = await load(["settings", "products", "variations", "lots", "promotions", "webOrders", "webPayments"]); return json({ ok: true, result: buildCatalog(by) }); }
    if (action === "pedido") return json({ ok: true, result: await createOrder(d) });
    if (action === "status") {
      const { order, pay } = await getOrder(String(d.id || ""));
      if (!order || order.token !== d.token) throw new Error("Pedido não encontrado.");
      const p2 = await syncPayment(order, pay);
      return json({ ok: true, result: publicView(order, p2) });
    }
    throw new Error("Ação desconhecida.");
  } catch (e) {
    return json({ ok: false, error: (e as Error).message || String(e) });
  }
});
