const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || "";
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || "";
const BLING_REDIRECT_URI =
  process.env.BLING_REDIRECT_URI || "https://bling-weight-fix.onrender.com/callback";

let BLING_ACCESS_TOKEN = process.env.BLING_ACCESS_TOKEN || "";
let BLING_REFRESH_TOKEN = process.env.BLING_REFRESH_TOKEN || "";

/**
 * Fallback por SKU somente quando a Shopify mandar grams = 0
 */
const SKU_WEIGHT_FALLBACK_GRAMS = {
  "KIT-NOBUGS-CASA-SEGURA": 1250,
  "KIT-ZERO-INSETO": 950,
  "KIT-NOBUGS-DIA-A-DIA": 850,
  "KIT-NOBUGS-DEFESA": 1100,
  "NOBUGS-ONE-5ML": 70,
  "NOBUGS-DIFUSOR-100ML": 118,
  "NOBUGS-LIMPADOR-140ML": 158,
  "NOBUGS-SPRAY-01": 130,
  "NOBUGS-REPELENTE-FAMILY-100ML": 130,
};

// Raw body só no webhook Shopify
app.use("/webhooks", express.raw({ type: "application/json" }));

// JSON/urlencoded para o restante
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  if (!hmacHeader || !SHOPIFY_WEBHOOK_SECRET) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBodyBuffer)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

function getBlingBasicAuthHeader() {
  const credentials = `${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

async function refreshBlingToken() {
  if (!BLING_REFRESH_TOKEN) {
    throw new Error("BLING_REFRESH_TOKEN não configurado.");
  }

  const response = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: {
      Authorization: getBlingBasicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: BLING_REFRESH_TOKEN,
    }).toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Erro ao renovar token Bling: ${response.status} - ${text}`);
  }

  const data = JSON.parse(text);

  BLING_ACCESS_TOKEN = data.access_token;
  BLING_REFRESH_TOKEN = data.refresh_token || BLING_REFRESH_TOKEN;

  console.log("Token do Bling renovado com sucesso.");
  console.log("ATENÇÃO: atualize essas env vars no Render manualmente se quiser persistir após restart.");

  return data;
}

async function blingFetch(url, options = {}, retry = true) {
  if (!BLING_ACCESS_TOKEN) {
    throw new Error("BLING_ACCESS_TOKEN não configurado.");
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${BLING_ACCESS_TOKEN}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && retry) {
    console.warn("Access token expirado. Tentando renovar...");
    await refreshBlingToken();
    return blingFetch(url, options, false);
  }

  return response;
}

async function findBlingOrderByShopifyNumber(orderNumberRaw) {
  const orderNumber = String(orderNumberRaw || "")
    .replace("#", "")
    .trim();

  if (!orderNumber) {
    throw new Error("Número do pedido Shopify inválido.");
  }

  const response = await blingFetch(
    `https://api.bling.com.br/Api/v3/pedidos/vendas?numero=${encodeURIComponent(orderNumber)}`
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Erro ao buscar pedido no Bling: ${response.status} - ${text}`);
  }

  const data = JSON.parse(text);
  return data?.data?.[0] || null;
}

async function getBlingOrderById(orderId) {
  const response = await blingFetch(
    `https://api.bling.com.br/Api/v3/pedidos/vendas/${orderId}`
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Erro ao buscar detalhes do pedido no Bling: ${response.status} - ${text}`);
  }

  const data = JSON.parse(text);
  return data?.data || null;
}

/**
 * Remove campos inúteis/arriscados e preserva o essencial para o PUT do Bling.
 * Aqui está a parte mais sensível do fluxo.
 */
function buildSafeBlingOrderPayload(orderData, weightKg) {
  if (!orderData) {
    throw new Error("Pedido do Bling ausente para montagem do payload.");
  }

  const payload = {};

  // Campos básicos comuns
  if (orderData.numero !== undefined) payload.numero = orderData.numero;
  if (orderData.numeroLoja !== undefined) payload.numeroLoja = orderData.numeroLoja;
  if (orderData.data !== undefined) payload.data = orderData.data;
  if (orderData.dataSaida !== undefined) payload.dataSaida = orderData.dataSaida;
  if (orderData.dataPrevista !== undefined) payload.dataPrevista = orderData.dataPrevista;
  if (orderData.totalProdutos !== undefined) payload.totalProdutos = orderData.totalProdutos;
  if (orderData.total !== undefined) payload.total = orderData.total;
  if (orderData.contato !== undefined) payload.contato = orderData.contato;
  if (orderData.situacao !== undefined) payload.situacao = orderData.situacao;
  if (orderData.loja !== undefined) payload.loja = orderData.loja;
  if (orderData.observacoes !== undefined) payload.observacoes = orderData.observacoes;
  if (orderData.observacoesInternas !== undefined) payload.observacoesInternas = orderData.observacoesInternas;
  if (orderData.desconto !== undefined) payload.desconto = orderData.desconto;
  if (orderData.categoria !== undefined) payload.categoria = orderData.categoria;
  if (orderData.outrasDespesas !== undefined) payload.outrasDespesas = orderData.outrasDespesas;

  // Itens são obrigatórios no seu erro
  payload.itens = Array.isArray(orderData.itens) ? orderData.itens : [];

  if (!payload.itens.length) {
    throw new Error("Pedido do Bling veio sem itens. Não é seguro atualizar.");
  }

  if (orderData.parcelas !== undefined) payload.parcelas = orderData.parcelas;
  if (orderData.intermediador !== undefined) payload.intermediador = orderData.intermediador;
  if (orderData.taxaComissao !== undefined) payload.taxaComissao = orderData.taxaComissao;
  if (orderData.transporte !== undefined || weightKg !== undefined) {
    payload.transporte = {
      ...(orderData.transporte || {}),
      pesoBruto: weightKg,
    };
  }

  return payload;
}

async function updateBlingOrderWeight(orderId, weightKg) {
  const pedidoCompleto = await getBlingOrderById(orderId);

  if (!pedidoCompleto) {
    throw new Error("Pedido completo não encontrado no Bling.");
  }

  const payload = buildSafeBlingOrderPayload(pedidoCompleto, weightKg);

  console.log("Enviando atualização do pedido para o Bling...");
  console.log(
    JSON.stringify(
      {
        id: orderId,
        numero: payload.numero,
        itens: payload.itens?.length || 0,
        pesoBruto: payload.transporte?.pesoBruto,
      },
      null,
      2
    )
  );

  const response = await blingFetch(
    `https://api.bling.com.br/Api/v3/pedidos/vendas/${orderId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Erro ao atualizar pedido no Bling: ${response.status} - ${text}`);
  }

  return text;
}

function calculateOrderWeight(lineItems) {
  let totalWeightGrams = 0;
  const debugItems = [];

  for (const item of lineItems) {
    const title = item.title || "";
    const sku = item.sku || "";
    const quantity = Number(item.quantity || 0);
    const gramsFromShopify = Number(item.grams || 0);

    let unitWeightGrams = 0;
    let source = "none";

    if (gramsFromShopify > 0) {
      unitWeightGrams = gramsFromShopify;
      source = "shopify_grams";
    } else if (SKU_WEIGHT_FALLBACK_GRAMS[sku]) {
      unitWeightGrams = SKU_WEIGHT_FALLBACK_GRAMS[sku];
      source = "fallback_map";
    }

    const lineWeightGrams = unitWeightGrams * quantity;
    totalWeightGrams += lineWeightGrams;

    debugItems.push({
      title,
      sku,
      quantity,
      gramsFromShopify,
      unitWeightGrams,
      lineWeightGrams,
      source,
    });
  }

  return {
    totalWeightGrams,
    totalWeightKg: Number((totalWeightGrams / 1000).toFixed(3)),
    debugItems,
  };
}

app.get("/", (req, res) => {
  res.status(200).send("Servidor online");
});

app.get("/start-auth", (req, res) => {
  if (!BLING_CLIENT_ID || !BLING_REDIRECT_URI) {
    return res.status(500).send("Faltam variáveis do Bling no ambiente.");
  }

  const state = crypto.randomBytes(16).toString("hex");

  const authUrl =
    `https://www.bling.com.br/Api/v3/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(BLING_CLIENT_ID)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`Erro no retorno do Bling: ${error}`);
  }

  if (!code) {
    return res.status(400).send("Code não recebido.");
  }

  try {
    const tokenResponse = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
      method: "POST",
      headers: {
        Authorization: getBlingBasicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
      }).toString(),
    });

    const text = await tokenResponse.text();

    if (!tokenResponse.ok) {
      console.error("Erro ao obter token Bling:", tokenResponse.status, text);
      return res.status(500).send(`Falha ao obter token: ${text}`);
    }

    const data = JSON.parse(text);

    BLING_ACCESS_TOKEN = data.access_token;
    BLING_REFRESH_TOKEN = data.refresh_token;

    console.log("=== TOKENS BLING RECEBIDOS ===");
    console.log({
      expires_in: data.expires_in,
      token_type: data.token_type,
      scope: data.scope,
    });
    console.log("ATENÇÃO: salve os novos tokens nas env vars do Render.");

    return res.status(200).send("Autorização concluída.");
  } catch (err) {
    console.error("Erro no callback do Bling:", err);
    return res.status(500).send("Erro interno no callback.");
  }
});

app.post("/webhooks/orders-create", async (req, res) => {
  const hmacHeader = req.get("x-shopify-hmac-sha256");
  const topic = req.get("x-shopify-topic");
  const shop = req.get("x-shopify-shop-domain");

  const rawBody = req.body;
  const valid = verifyShopifyWebhook(rawBody, hmacHeader);

  if (!valid) {
    console.error("Webhook inválido");
    return res.status(401).send("Unauthorized");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("JSON inválido:", err);
    return res.status(400).send("Invalid JSON");
  }

  console.log("=== WEBHOOK RECEBIDO ===");
  console.log("Topic:", topic);
  console.log("Shop:", shop);
  console.log("Pedido Shopify:", payload.name || payload.order_number || payload.id);

  const lineItems = payload.line_items || [];
  const { totalWeightGrams, totalWeightKg, debugItems } = calculateOrderWeight(lineItems);

  for (const debugItem of debugItems) {
    console.log(debugItem);
  }

  console.log("Peso total em gramas:", totalWeightGrams);
  console.log("Peso total em kg:", totalWeightKg);

  try {
    const pedidoBling = await findBlingOrderByShopifyNumber(
      payload.name || payload.order_number || payload.id
    );

    if (!pedidoBling) {
      console.warn("Pedido não encontrado no Bling.");
      return res.status(200).send("ok - pedido não encontrado no Bling");
    }

    console.log("Pedido encontrado no Bling:", pedidoBling.id);

    const result = await updateBlingOrderWeight(pedidoBling.id, totalWeightKg);
    console.log("Pedido atualizado no Bling:", result);

    return res.status(200).send("ok");
  } catch (error) {
    console.error("Erro ao sincronizar com Bling:", error);
    return res.status(500).send("Erro ao sincronizar com Bling");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});