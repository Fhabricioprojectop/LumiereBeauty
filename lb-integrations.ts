// =====================================================================
// Lumière Beauty — Edge Function "lb-integrations" (Supabase / Deno)
// Ponte segura entre o sistema e os provedores externos.
// Os tokens ficam nos Secrets do Supabase — o navegador nunca vê.
//
// Publicar:   supabase functions deploy lb-integrations
// Secrets:    supabase secrets set FOCUSNFE_TOKEN=xxxx MP_ACCESS_TOKEN=xxxx ...
//
// Corpo recebido: { service, action, provider, config, data }
// Resposta:       { ok: true, result } | { ok: false, error }
//
// IMPORTANTE: cada provedor muda a API com o tempo. Antes de usar em
// produção, teste em homologação/sandbox e confira a documentação atual.
// =====================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const env = (k: string) => Deno.env.get(k) || "";
const need = (...keys: string[]) => {
  const miss = keys.filter((k) => !env(k));
  if (miss.length) throw new Error(`Secret ausente no Supabase: ${miss.join(", ")}`);
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function http(url: string, init: RequestInit = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* texto puro */ }
  return { ok: r.ok, status: r.status, body };
}
const errMsg = (b: any, fallback: string) =>
  (b && (b.mensagem || b.message || b.error_description || b.error || (b.erros && b.erros.map((e: any) => e.mensagem).join("; ")) || (b.cause && b.cause[0] && b.cause[0].description))) || fallback;

// ---------------------------------------------------------------------
// Autenticação: só usuários logados no sistema podem chamar
// ---------------------------------------------------------------------
async function requireUser(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const r = await fetch(`${env("SUPABASE_URL")}/auth/v1/user`, { headers: { Authorization: auth, apikey: env("SUPABASE_ANON_KEY") } });
  if (!r.ok) throw Object.assign(new Error("Sessão inválida. Entre no sistema de novo."), { status: 401 });
  return await r.json();
}

// =====================================================================
// 1) FISCAL — Focus NFe (NFC-e modelo 65 e NF-e modelo 55)
// =====================================================================
const focusBase = (cfg: any) => (cfg.ambiente === "producao" ? "https://api.focusnfe.com.br" : "https://homologacao.focusnfe.com.br");
const focusAuth = () => ({ Authorization: "Basic " + btoa(env("FOCUSNFE_TOKEN") + ":"), "Content-Type": "application/json" });

function focusItems(d: any) {
  return d.itens.map((i: any) => ({
    numero_item: i.numero,
    codigo_produto: i.codigo,
    descricao: i.descricao,
    codigo_ncm: i.ncm,
    ...(i.cest ? { cest: i.cest } : {}),
    cfop: i.cfop,
    unidade_comercial: i.unidade,
    quantidade_comercial: i.quantidade,
    valor_unitario_comercial: i.valorUnitario,
    unidade_tributavel: i.unidade,
    quantidade_tributavel: i.quantidade,
    valor_unitario_tributavel: i.valorUnitario,
    valor_bruto: i.valorBruto,
    ...(i.desconto > 0 ? { valor_desconto: i.desconto } : {}),
    icms_origem: i.origem,
    icms_situacao_tributaria: i.csosn,
    pis_situacao_tributaria: "49",
    cofins_situacao_tributaria: "49",
  }));
}
function focusPayments(d: any) {
  return d.pagamentos.map((p: any) => ({
    forma_pagamento: p.forma,
    valor_pagamento: p.valor,
    ...(p.forma === "03" || p.forma === "04" ? { tipo_integracao: 2, ...(p.autorizacao ? { numero_autorizacao: p.autorizacao } : {}) } : {}),
  }));
}
function focusResult(b: any, base: string) {
  const abs = (u: string) => (u ? (u.startsWith("http") ? u : base + u) : "");
  const st = String(b.status || "");
  return {
    status: st === "autorizado" ? "autorizado" : st === "cancelado" ? "cancelado" : st.startsWith("processando") ? "processando" : st || "erro",
    numero: b.numero || "", serie: b.serie || "", chave: b.chave_nfe || "", protocolo: b.protocolo || "",
    qrcode: b.qrcode_url || "", urlConsulta: b.url_consulta_nf || "", danfe: abs(b.caminho_danfe), xml: abs(b.caminho_xml_nota_fiscal),
    message: b.mensagem_sefaz || b.mensagem || "",
  };
}

async function fiscal(provider: string, action: string, cfg: any, d: any) {
  if (provider !== "focusnfe") throw new Error(`Provedor fiscal "${provider}" ainda não implementado nesta versão (estrutura pronta).`);
  need("FOCUSNFE_TOKEN");
  const base = focusBase(cfg); const H = focusAuth();
  const path = (d.modelo === "nfe" ? "nfe" : "nfce");

  if (action === "ping") {
    const r = await http(`${base}/v2/nfce/LB-PING-TESTE`, { headers: H });
    if (r.status === 401 || r.status === 403) throw new Error("Token Focus NFe recusado.");
    return { message: `Focus NFe respondeu (${cfg.ambiente})` };
  }
  if (action === "emitir") {
    const body: any = {
      cnpj_emitente: cfg.store.cnpj,
      data_emissao: d.dataEmissao,
      natureza_operacao: "Venda de mercadoria",
      presenca_comprador: 1,
      modalidade_frete: 9,
      local_destino: 1,
      items: focusItems(d),
      formas_pagamento: focusPayments(d),
      ...(d.troco > 0 ? { valor_troco: d.troco } : {}),
      ...(d.infoAdic ? { informacoes_adicionais_contribuinte: d.infoAdic } : {}),
    };
    const dest = d.destinatario;
    if (path === "nfce") {
      if (dest && dest.cpf) { body.cpf_destinatario = dest.cpf; if (dest.nome) body.nome_destinatario = dest.nome; }
    } else {
      Object.assign(body, {
        tipo_documento: 1, finalidade_emissao: 1, consumidor_final: 1,
        ...(dest.cnpj ? { cnpj_destinatario: dest.cnpj } : { cpf_destinatario: dest.cpf }),
        nome_destinatario: dest.nome, logradouro_destinatario: dest.logradouro, numero_destinatario: "S/N",
        bairro_destinatario: dest.bairro, municipio_destinatario: dest.municipio, uf_destinatario: dest.uf, cep_destinatario: dest.cep,
        indicador_inscricao_estadual_destinatario: dest.ie && dest.ie.toUpperCase() !== "ISENTO" ? 1 : 9,
        ...(dest.ie && dest.ie.toUpperCase() !== "ISENTO" ? { inscricao_estadual_destinatario: dest.ie } : {}),
        ...(dest.email ? { email_destinatario: dest.email } : {}),
      });
    }
    const r = await http(`${base}/v2/${path}?ref=${encodeURIComponent(d.ref)}`, { method: "POST", headers: H, body: JSON.stringify(body) });
    if (!r.ok && !(r.body && r.body.status)) return { status: "rejeitado", message: errMsg(r.body, `Focus NFe HTTP ${r.status}`) };
    return focusResult(r.body, base);
  }
  if (action === "consultar") {
    const r = await http(`${base}/v2/${path}/${encodeURIComponent(d.ref)}?completa=0`, { headers: H });
    if (!r.ok) throw new Error(errMsg(r.body, `Consulta HTTP ${r.status}`));
    return focusResult(r.body, base);
  }
  if (action === "cancelar") {
    const r = await http(`${base}/v2/${path}/${encodeURIComponent(d.ref)}`, { method: "DELETE", headers: H, body: JSON.stringify({ justificativa: d.justificativa }) });
    if (!r.ok) throw new Error(errMsg(r.body, `Cancelamento HTTP ${r.status}`));
    return { ...focusResult(r.body, base), status: r.body.status === "cancelado" ? "cancelado" : (r.body.status || "cancelado") };
  }
  throw new Error(`Ação fiscal desconhecida: ${action}`);
}

// =====================================================================
// 2) PIX DINÂMICO — Mercado Pago
// =====================================================================
const MP = "https://api.mercadopago.com";
const mpH = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${env("MP_ACCESS_TOKEN")}`, "Content-Type": "application/json", ...extra });
const isoBR = (d: Date) => new Date(d.getTime() - 3 * 3600e3).toISOString().replace("Z", "-03:00");

async function pix(provider: string, action: string, cfg: any, d: any) {
  if (provider !== "mercadopago") throw new Error(`Provedor Pix "${provider}" ainda não implementado nesta versão (estrutura pronta).`);
  need("MP_ACCESS_TOKEN");
  if (action === "ping") {
    const r = await http(`${MP}/users/me`, { headers: mpH() });
    if (!r.ok) throw new Error(errMsg(r.body, "Token Mercado Pago recusado."));
    return { message: `Conta ${r.body.nickname || r.body.id}` };
  }
  if (action === "criar") {
    const exp = new Date(Date.now() + (Number(d.expiraMin) || 15) * 60000);
    const r = await http(`${MP}/v1/payments`, {
      method: "POST", headers: mpH({ "X-Idempotency-Key": `lb-${d.ref}-${d.amount}-${Date.now()}` }),
      body: JSON.stringify({
        transaction_amount: Number(d.amount), description: d.descricao, payment_method_id: "pix",
        external_reference: String(d.ref), date_of_expiration: isoBR(exp),
        payer: { email: d.email || `cliente+${d.ref}@lumiere.local` },
      }),
    });
    if (!r.ok) throw new Error(errMsg(r.body, `Mercado Pago HTTP ${r.status}`));
    const td = (r.body.point_of_interaction && r.body.point_of_interaction.transaction_data) || {};
    return { id: String(r.body.id), txid: String(r.body.id), copiaECola: td.qr_code, qrBase64: td.qr_code_base64, status: "pendente" };
  }
  if (action === "status") {
    const r = await http(`${MP}/v1/payments/${d.id}`, { headers: mpH() });
    if (!r.ok) throw new Error(errMsg(r.body, `Consulta HTTP ${r.status}`));
    const s = r.body.status;
    return { status: s === "approved" ? "pago" : ["cancelled", "rejected", "expired"].includes(s) ? "expirado" : "pendente", e2e: (r.body.transaction_details && r.body.transaction_details.transaction_id) || "" };
  }
  if (action === "cancelar") {
    await http(`${MP}/v1/payments/${d.id}`, { method: "PUT", headers: mpH(), body: JSON.stringify({ status: "cancelled" }) });
    return { status: "cancelado" };
  }
  throw new Error(`Ação Pix desconhecida: ${action}`);
}

// =====================================================================
// 2b) MAQUININHA — Mercado Pago Point (Smart)
// =====================================================================
async function tef(provider: string, action: string, cfg: any, d: any) {
  if (provider !== "mercadopago_point") throw new Error(`Maquininha "${provider}" ainda não implementada nesta versão (estrutura pronta).`);
  need("MP_ACCESS_TOKEN");
  const dev = d.deviceId || cfg.deviceId;
  if (action === "ping") {
    const r = await http(`${MP}/point/integration-api/devices`, { headers: mpH() });
    if (!r.ok) throw new Error(errMsg(r.body, "Não foi possível listar as maquininhas."));
    const list = (r.body.devices || []).map((x: any) => x.id);
    return { message: list.length ? `Maquininhas: ${list.join(", ")}` : "Nenhuma maquininha em modo integrado (PDV)" };
  }
  if (!dev) throw new Error("Informe o ID da maquininha em Configurações → Integrações.");
  if (action === "cobrar") {
    const r = await http(`${MP}/point/integration-api/devices/${dev}/payment-intents`, {
      method: "POST", headers: mpH(),
      body: JSON.stringify({
        amount: Math.round(Number(d.amount) * 100),
        additional_info: { external_reference: String(d.ref), print_on_terminal: true },
        payment: { type: d.method === "credito" ? "credit_card" : "debit_card", installments: d.method === "credito" ? Number(d.installments) || 1 : 1, installments_cost: "seller" },
      }),
    });
    if (!r.ok) throw new Error(errMsg(r.body, `Point HTTP ${r.status}`));
    return { id: r.body.id, status: "aguardando" };
  }
  if (action === "status") {
    const r = await http(`${MP}/point/integration-api/payment-intents/${d.id}`, { headers: mpH() });
    if (!r.ok) throw new Error(errMsg(r.body, `Consulta HTTP ${r.status}`));
    const st = r.body.state;
    if (st === "FINISHED" && r.body.payment && r.body.payment.id) {
      const p = await http(`${MP}/v1/payments/${r.body.payment.id}`, { headers: mpH() });
      const b = p.body || {};
      if (b.status === "approved") return { status: "aprovado", nsu: String(b.id || ""), autorizacao: b.authorization_code || "", bandeira: b.payment_method_id || "", operadora: "Mercado Pago" };
      return { status: "recusado", message: b.status_detail || b.status };
    }
    if (["CANCELED", "ABANDONED"].includes(st)) return { status: "cancelado" };
    if (st === "ERROR") return { status: "recusado", message: "Erro na maquininha" };
    return { status: "aguardando" };
  }
  if (action === "cancelar") {
    await http(`${MP}/point/integration-api/devices/${dev}/payment-intents/${d.id}`, { method: "DELETE", headers: mpH() });
    return { status: "cancelado" };
  }
  throw new Error(`Ação de maquininha desconhecida: ${action}`);
}

// =====================================================================
// 3) WHATSAPP — Z-API, Meta Cloud API ou Evolution API
// =====================================================================
const phoneBR = (p: string) => { const d = String(p || "").replace(/\D/g, ""); return d.length <= 11 ? "55" + d : d; };

async function whatsapp(provider: string, action: string, _cfg: any, d: any) {
  if (provider === "zapi") {
    need("ZAPI_INSTANCE", "ZAPI_TOKEN", "ZAPI_CLIENT_TOKEN");
    const base = `https://api.z-api.io/instances/${env("ZAPI_INSTANCE")}/token/${env("ZAPI_TOKEN")}`;
    const H = { "Client-Token": env("ZAPI_CLIENT_TOKEN"), "Content-Type": "application/json" };
    if (action === "ping") { const r = await http(`${base}/status`, { headers: H }); if (!r.ok) throw new Error(errMsg(r.body, "Z-API recusou.")); return { message: r.body.connected ? "WhatsApp conectado" : "Instância desconectada — leia o QR na Z-API" }; }
    if (action === "enviar") { const r = await http(`${base}/send-text`, { method: "POST", headers: H, body: JSON.stringify({ phone: phoneBR(d.phone), message: d.text }) }); if (!r.ok) throw new Error(errMsg(r.body, `Z-API HTTP ${r.status}`)); return { id: r.body.messageId || r.body.id || "" }; }
  }
  if (provider === "meta") {
    need("WA_TOKEN", "WA_PHONE_ID");
    const base = `https://graph.facebook.com/v20.0/${env("WA_PHONE_ID")}`;
    const H = { Authorization: `Bearer ${env("WA_TOKEN")}`, "Content-Type": "application/json" };
    if (action === "ping") { const r = await http(base, { headers: H }); if (!r.ok) throw new Error(errMsg(r.body && r.body.error, "Meta recusou o token.")); return { message: `Número ${r.body.display_phone_number || ""}` }; }
    if (action === "enviar") {
      // Atenção: mensagens iniciadas pela loja exigem template aprovado na Meta.
      // Se WA_TEMPLATE estiver definido, envia o template com o texto como parâmetro {{1}}.
      const tpl = env("WA_TEMPLATE");
      const body = tpl
        ? { messaging_product: "whatsapp", to: phoneBR(d.phone), type: "template", template: { name: tpl, language: { code: env("WA_TEMPLATE_LANG") || "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: d.text }] }] } }
        : { messaging_product: "whatsapp", to: phoneBR(d.phone), type: "text", text: { body: d.text } };
      const r = await http(`${base}/messages`, { method: "POST", headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(errMsg(r.body && r.body.error, `Meta HTTP ${r.status}`));
      return { id: r.body.messages && r.body.messages[0] && r.body.messages[0].id };
    }
  }
  if (provider === "evolution") {
    need("EVOLUTION_URL", "EVOLUTION_INSTANCE", "EVOLUTION_APIKEY");
    const base = env("EVOLUTION_URL").replace(/\/$/, ""); const inst = env("EVOLUTION_INSTANCE");
    const H = { apikey: env("EVOLUTION_APIKEY"), "Content-Type": "application/json" };
    if (action === "ping") { const r = await http(`${base}/instance/connectionState/${inst}`, { headers: H }); if (!r.ok) throw new Error(errMsg(r.body, "Evolution recusou.")); return { message: `Estado: ${(r.body.instance && r.body.instance.state) || r.body.state || "?"}` }; }
    if (action === "enviar") { const r = await http(`${base}/message/sendText/${inst}`, { method: "POST", headers: H, body: JSON.stringify({ number: phoneBR(d.phone), text: d.text }) }); if (!r.ok) throw new Error(errMsg(r.body, `Evolution HTTP ${r.status}`)); return { id: r.body.key && r.body.key.id }; }
  }
  throw new Error(`WhatsApp: provedor/ação não suportado (${provider}/${action}).`);
}

// =====================================================================
// 5) LOJA VIRTUAL — Nuvemshop, Shopify, Mercado Livre
// =====================================================================
type StockItem = { sku: string; qty: number };

async function ecommerce(provider: string, action: string, _cfg: any, d: any) {
  // ---------- Nuvemshop ----------
  if (provider === "nuvemshop") {
    need("NUVEMSHOP_STORE_ID", "NUVEMSHOP_TOKEN");
    const base = `https://api.tiendanube.com/v1/${env("NUVEMSHOP_STORE_ID")}`;
    const H = { Authentication: `bearer ${env("NUVEMSHOP_TOKEN")}`, "User-Agent": "Lumiere Beauty Gestao (suporte@lumierebeauty.com.br)", "Content-Type": "application/json" };
    if (action === "ping") { const r = await http(`${base}/store`, { headers: H }); if (!r.ok) throw new Error(errMsg(r.body, "Nuvemshop recusou.")); return { message: `Loja ${(r.body.name && (r.body.name.pt || Object.values(r.body.name)[0])) || ""}` }; }
    if (action === "stock") {
      const out: any[] = [];
      for (const it of (d.items || []) as StockItem[]) {
        const p = await http(`${base}/products/sku/${encodeURIComponent(it.sku)}`, { headers: H });
        if (!p.ok) { out.push({ sku: it.sku, ok: false, error: "SKU não encontrado na loja virtual" }); continue; }
        const v = (p.body.variants || []).find((x: any) => String(x.sku || "").toUpperCase() === it.sku.toUpperCase());
        if (!v) { out.push({ sku: it.sku, ok: false, error: "Variação não encontrada" }); continue; }
        const u = await http(`${base}/products/${p.body.id}/variants/${v.id}`, { method: "PUT", headers: H, body: JSON.stringify({ stock: it.qty }) });
        out.push({ sku: it.sku, ok: u.ok });
      }
      return { updated: out.filter((x) => x.ok).length, items: out };
    }
    if (action === "pedidos") {
      const r = await http(`${base}/orders?created_at_min=${encodeURIComponent(d.since)}&payment_status=paid&per_page=50`, { headers: H });
      if (!r.ok) throw new Error(errMsg(r.body, `Nuvemshop HTTP ${r.status}`));
      return { orders: (r.body || []).map((o: any) => ({ id: String(o.id), numero: o.number, cliente: o.customer && o.customer.name, telefone: o.customer && o.customer.phone, email: o.customer && o.customer.email, total: Number(o.total), itens: (o.products || []).map((p: any) => ({ sku: p.sku, nome: p.name, qtd: Number(p.quantity), preco: Number(p.price) })) })) };
    }
  }
  // ---------- Shopify ----------
  if (provider === "shopify") {
    need("SHOPIFY_SHOP", "SHOPIFY_TOKEN");
    const base = `https://${env("SHOPIFY_SHOP")}/admin/api/2024-10`;
    const H = { "X-Shopify-Access-Token": env("SHOPIFY_TOKEN"), "Content-Type": "application/json" };
    if (action === "ping") { const r = await http(`${base}/shop.json`, { headers: H }); if (!r.ok) throw new Error(errMsg(r.body, "Shopify recusou.")); return { message: `Loja ${r.body.shop && r.body.shop.name}` }; }
    if (action === "stock") {
      need("SHOPIFY_LOCATION_ID");
      const out: any[] = [];
      for (const it of (d.items || []) as StockItem[]) {
        const q = await http(`${base}/graphql.json`, { method: "POST", headers: H, body: JSON.stringify({ query: `{ productVariants(first: 1, query: "sku:${it.sku.replace(/"/g, "")}") { edges { node { inventoryItem { id } } } } }` }) });
        const gid = q.body && q.body.data && q.body.data.productVariants.edges[0] && q.body.data.productVariants.edges[0].node.inventoryItem.id;
        if (!gid) { out.push({ sku: it.sku, ok: false, error: "SKU não encontrado" }); continue; }
        const u = await http(`${base}/inventory_levels/set.json`, { method: "POST", headers: H, body: JSON.stringify({ location_id: Number(env("SHOPIFY_LOCATION_ID")), inventory_item_id: Number(String(gid).split("/").pop()), available: it.qty }) });
        out.push({ sku: it.sku, ok: u.ok });
      }
      return { updated: out.filter((x) => x.ok).length, items: out };
    }
    if (action === "pedidos") {
      const r = await http(`${base}/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(d.since)}&limit=50`, { headers: H });
      if (!r.ok) throw new Error(errMsg(r.body, `Shopify HTTP ${r.status}`));
      return { orders: (r.body.orders || []).map((o: any) => ({ id: String(o.id), numero: o.name, cliente: o.customer ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() : "", telefone: (o.customer && o.customer.phone) || o.phone, email: o.email, total: Number(o.total_price), itens: (o.line_items || []).map((p: any) => ({ sku: p.sku, nome: p.title, qtd: Number(p.quantity), preco: Number(p.price) })) })) };
    }
  }
  // ---------- Mercado Livre ----------
  if (provider === "mercadolivre") {
    need("ML_ACCESS_TOKEN", "ML_USER_ID");
    const base = "https://api.mercadolibre.com"; const H = { Authorization: `Bearer ${env("ML_ACCESS_TOKEN")}`, "Content-Type": "application/json" };
    if (action === "ping") { const r = await http(`${base}/users/me`, { headers: H }); if (!r.ok) throw new Error(errMsg(r.body, "Mercado Livre recusou (token expira a cada 6 h — renove).")); return { message: `Conta ${r.body.nickname}` }; }
    if (action === "stock") {
      const out: any[] = [];
      for (const it of (d.items || []) as StockItem[]) {
        const s = await http(`${base}/users/${env("ML_USER_ID")}/items/search?seller_sku=${encodeURIComponent(it.sku)}`, { headers: H });
        const ids: string[] = (s.body && s.body.results) || [];
        if (!ids.length) { out.push({ sku: it.sku, ok: false, error: "Anúncio não encontrado" }); continue; }
        for (const id of ids) { const u = await http(`${base}/items/${id}`, { method: "PUT", headers: H, body: JSON.stringify({ available_quantity: it.qty }) }); out.push({ sku: it.sku, item: id, ok: u.ok }); }
      }
      return { updated: out.filter((x) => x.ok).length, items: out };
    }
    if (action === "pedidos") {
      const r = await http(`${base}/orders/search?seller=${env("ML_USER_ID")}&order.status=paid&order.date_created.from=${encodeURIComponent(d.since)}`, { headers: H });
      if (!r.ok) throw new Error(errMsg(r.body, `Mercado Livre HTTP ${r.status}`));
      return { orders: (r.body.results || []).map((o: any) => ({ id: String(o.id), numero: o.id, cliente: o.buyer && o.buyer.nickname, total: Number(o.total_amount), itens: (o.order_items || []).map((p: any) => ({ sku: p.item && p.item.seller_sku, nome: p.item && p.item.title, qtd: Number(p.quantity), preco: Number(p.unit_price) })) })) };
    }
  }
  throw new Error(`Loja virtual: provedor/ação não suportado (${provider}/${action}).`);
}

// =====================================================================
// Roteador
// =====================================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  try {
    await requireUser(req);
    const { service, action, provider, config, data } = await req.json();
    const cfg = config || {}; const d = data || {};
    let result: unknown;
    if (service === "fiscal") result = await fiscal(provider, action, cfg, d);
    else if (service === "pix") result = await pix(provider, action, cfg, d);
    else if (service === "tef") result = await tef(provider, action, cfg, d);
    else if (service === "whatsapp") result = await whatsapp(provider, action, cfg, d);
    else if (service === "ecommerce") result = await ecommerce(provider, action, cfg, d);
    else if (service === "multiloja" && action === "ping") result = { message: "Multi-loja não depende de provedor externo." };
    else throw new Error(`Serviço desconhecido: ${service}`);
    return json({ ok: true, result });
  } catch (e) {
    const status = (e as any).status || 400;
    return json({ ok: false, error: (e as Error).message || String(e) }, status === 401 ? 401 : 200);
  }
});
