# Lumière Beauty — Sistema de Gestão + Loja Online

Sistema de gestão (ERP/PDV) para loja de cosméticos e perfumaria, com site de vendas online integrado. Tudo roda no navegador, sem instalar nada, com os dados no Supabase.

## O que tem aqui

| Arquivo | O que é |
|---|---|
| `lumiere-beauty.html` | O sistema de gestão. É só abrir no navegador. |
| `loja-lumiere.html` | O site de vendas online. Abra direto por esse nome. |
| `sw.js` | Faz o sistema abrir como app no celular. Vai junto do HTML publicado. |
| `supabase/functions/lb-integrations/` | Função do Supabase: NFC-e/NF-e, Pix, maquininha, WhatsApp e loja virtual. |
| `supabase/functions/lb-loja/` | Função do Supabase: catálogo e pedidos do site de vendas. |
| `docs/` | Passo a passo de cada parte. |

## O que o sistema faz

**Operação**
- PDV com leitor de código de barras, desconto com liberação por senha, Pix, cartão, dinheiro, crediário e pagamento dividido
- Baixa de estoque por lote, sempre pelo que vence primeiro (PVPS)
- Bloqueio de venda de produto vencido e campanha de desconto para lote perto do vencimento
- Cupom não fiscal e NFC-e quando a integração fiscal está ligada

**Gestão**
- Produtos com variações (cor, volume, fragrância), custo, margem e markup
- Estoque com validade, inventário físico, alertas e relatório para a ANVISA
- Clientes com ficha estética, fidelidade por pontos, cupons, vouchers e listas de reativação
- Vendedoras com comissão e meta
- Financeiro: caixa com sangria e suprimento, contas a pagar e a receber, fluxo de caixa e DRE
- Relatórios: curva ABC, margem por SKU e por marca, canais, pagamentos

**Controle**
- Quatro perfis: Desenvolvedor, Administrador, Contabilidade e Vendedora
- A vendedora vê só as próprias vendas e comissões, sem custo, lucro ou faturamento da loja
- Auditoria: nada é apagado; cancelamento fica registrado com motivo e quem autorizou

**Loja online**
- Catálogo com preço e estoque vindos do sistema, sem mostrar custo nem margem
- Retirada na loja ou entrega local com frete automático
- Pix e cartão pelo Mercado Pago, ou pagar na retirada
- Pedido cai em Vendas → Pedidos do site, com alarme sonoro e notificação
- Pedido pago vira venda com um clique, com baixa por lote

## Como colocar para funcionar

1. **Supabase:** crie o projeto e a tabela `lb_records` (coll, id, data, deleted, updated_at).
2. **Chaves:** no `lumiere-beauty.html` e no `loja-lumiere.html`, ajuste a URL e a chave anônima do projeto.
3. **Funções:** publique `lb-integrations` e `lb-loja` (veja `docs/`). Na `lb-loja`, desligue o "Verify JWT".
4. **Integrações:** ligue o que for usar em Configurações → Integrações.
5. **Site:** publique o `loja-lumiere.html`. Só na hora de colocar no ar com o domínio do cliente é que ele vira `index.html` — enquanto estiver testando, mantenha o nome como está.

## Como abrir para testar

Os dois arquivos abrem direto, cada um pelo seu nome. Pelo GitHub Pages:

- Sistema de gestão: `https://fhabricioprojectop.github.io/LumiereBeauty/lumiere-beauty.html`
- Loja online: `https://fhabricioprojectop.github.io/LumiereBeauty/loja-lumiere.html`

Abrir só o endereço da raiz mostra este README, porque não existe um `index.html` no repositório — e não precisa existir enquanto o site não for publicado no domínio.

## Avisos

- A **chave anônima** do Supabase fica dentro dos HTML. Ela é pública por natureza, mas quem protege os dados são as regras de acesso (RLS) da tabela. Configure-as antes de usar com dados reais.
- A **chave de serviço** (`SUPABASE_SERVICE_ROLE_KEY`) e os tokens dos provedores nunca ficam nos arquivos: moram nos Secrets do Supabase.
- Antes de emitir nota fiscal de verdade, teste em homologação e confirme CFOP, CSOSN e regime tributário com o contador.
- Cada provedor muda a API de tempos em tempos. Teste no sandbox antes de usar com cliente.
