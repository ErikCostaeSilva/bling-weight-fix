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
 * true  = não escreve no Bling
 * false = reservar para escrita futura
 */
const SIMULATION_MODE = true;

/**
 * TTL em ms para deduplicação de webhook
 */
const WEBHOOK_DEDUPE_TTL_MS = 60 * 60 * 1000;

/**
 * Memória simples em runtime
 */
const processedWebhookEvents = new Map();

/**
 * Fallback por SKU em gramas
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

// raw body só para webhook Shopify
app.use("/webhooks", express.raw({ type: "application/json" }));

// json/urlencoded para o resto
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function cleanupProcessedWebhookEvents() {
  const now = Date.now();

  for (const [eventId, timestamp] of processedWebhookEvents.entries()) {
    if (now - timestamp > WEBHOOK_DEDUPE_TTL_MS) {
      processedWebhookEvents.delete(eventId);
    }
  }
}

function markWebhookEventProcessed(eventId) {
  cleanupProcessedWebhookEvents();
  processedWebhookEvents.set(eventId, Date.now());
}

function isWebhookEventAlreadyProcessed(eventId) {
  cleanupProcessedWebhookEvents();
  if (!eventId) return false;
  return processedWebhookEvents.has(eventId);
}

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
  console.log(
    "ATENÇÃO: atualize BLING_ACCESS_TOKEN e BLING_REFRESH_TOKEN no Render manualmente se quiser persistir após restart."
  );

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

function normalizeShopifyOrderNumber(orderNumberRaw) {
  const normalized = String(orderNumberRaw || "").replace("#", "").trim();

  if (!normalized) {
    throw new Error("Número do pedido Shopify inválido.");
  }

  return normalized;
}

async function findBlingOrderByShopifyNumber(orderNumberRaw) {
  const orderNumber = normalizeShopifyOrderNumber(orderNumberRaw);

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

function pickTransportDebug(orderData) {
  if (!orderData || typeof orderData !== "object") return null;

  const result = {
    id: orderData.id ?? null,
    numero: orderData.numero ?? null,
    numeroLoja: orderData.numeroLoja ?? null,
    situacao: orderData.situacao ?? null,
    loja: orderData.loja ?? null,
    transporte: orderData.transporte ?? null,
    volumes: orderData.volumes ?? null,
    parcelas: orderData.parcelas ?? null,
    camposRelacionados: {},
  };

  const interestingKeys = [
    "transporte",
    "transportador",
    "volumes",
    "volume",
    "objeto",
    "objetos",
    "postagem",
    "postagens",
    "remessa",
    "remessas",
    "rastreamento",
    "tracking",
    "etiqueta",
    "etiquetas",
    "logistica",
    "logisticas",
    "servico",
    "servicos",
  ];

  for (const [key, value] of Object.entries(orderData)) {
    const normalized = key.toLowerCase();
    if (interestingKeys.some((term) => normalized.includes(term))) {
      result.camposRelacionados[key] = value;
    }
  }

  return result;
}

function extractAllVolumesFromOrder(orderData) {
  const transportVolumes = Array.isArray(orderData?.transporte?.volumes)
    ? orderData.transporte.volumes
    : [];

  const topLevelVolumes = Array.isArray(orderData?.volumes)
    ? orderData.volumes
    : [];

  const allVolumes = [...transportVolumes, ...topLevelVolumes];

  const uniqueMap = new Map();
  for (const volume of allVolumes) {
    if (volume?.id != null) {
      uniqueMap.set(String(volume.id), volume);
    }
  }

  return Array.from(uniqueMap.values());
}

function extractVolumeFromOrder(orderData, volumeId) {
  const allVolumes = extractAllVolumesFromOrder(orderData);
  const volumeIdString = String(volumeId);

  return allVolumes.find((volume) => String(volume?.id) === volumeIdString) || null;
}

async function buildSnapshotByShopifyOrderNumber(orderNumberRaw) {
  const pedidoBling = await findBlingOrderByShopifyNumber(orderNumberRaw);

  if (!pedidoBling) {
    return {
      ok: false,
      message: "Pedido não encontrado no Bling.",
      numeroShopify: `#${normalizeShopifyOrderNumber(orderNumberRaw)}`,
    };
  }

  const pedidoCompleto = await getBlingOrderById(pedidoBling.id);
  const debug = pickTransportDebug(pedidoCompleto);
  const allVolumes = extractAllVolumesFromOrder(pedidoCompleto);

  return {
    ok: true,
    numeroShopify: `#${normalizeShopifyOrderNumber(orderNumberRaw)}`,
    pedidoBlingId: pedidoBling.id,
    numeroBling: pedidoCompleto?.numero ?? null,
    numeroLoja: pedidoCompleto?.numeroLoja ?? null,
    situacao: pedidoCompleto?.situacao ?? null,
    transporte: pedidoCompleto?.transporte ?? null,
    volumes: allVolumes,
    debug,
  };
}

app.get("/", (req, res) => {
  res.status(200).send("Servidor online");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    simulationMode: SIMULATION_MODE,
    hasShopifySecret: Boolean(SHOPIFY_WEBHOOK_SECRET),
    hasBlingClientId: Boolean(BLING_CLIENT_ID),
    hasBlingClientSecret: Boolean(BLING_CLIENT_SECRET),
    hasBlingAccessToken: Boolean(BLING_ACCESS_TOKEN),
    hasBlingRefreshToken: Boolean(BLING_REFRESH_TOKEN),
    processedWebhookEventsCount: processedWebhookEvents.size,
  });
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

app.get("/debug/pedido/:numeroShopify", async (req, res) => {
  try {
    const numeroShopify = String(req.params.numeroShopify || "").trim();
    const pedidoBling = await findBlingOrderByShopifyNumber(numeroShopify);

    if (!pedidoBling) {
      return res.status(404).json({
        ok: false,
        message: "Pedido não encontrado no Bling.",
        numeroShopify: `#${normalizeShopifyOrderNumber(numeroShopify)}`,
      });
    }

    const pedidoCompleto = await getBlingOrderById(pedidoBling.id);
    const debugData = pickTransportDebug(pedidoCompleto);

    console.log("=== DEBUG PEDIDO BLING ===");
    console.log(JSON.stringify(debugData, null, 2));

    return res.status(200).json({
      ok: true,
      numeroShopify: `#${normalizeShopifyOrderNumber(numeroShopify)}`,
      pedidoBlingId: pedidoBling.id,
      debug: debugData,
    });
  } catch (error) {
    console.error("Erro no debug do pedido:", error);
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

/**
 * Exemplo:
 * /debug/volume/15853758446?numeroShopify=1065
 */
app.get("/debug/volume/:volumeId", async (req, res) => {
  try {
    const volumeId = String(req.params.volumeId || "").trim();
    const numeroShopify = String(req.query.numeroShopify || "").trim();

    if (!volumeId) {
      return res.status(400).json({
        ok: false,
        message: "volumeId é obrigatório.",
      });
    }

    if (!numeroShopify) {
      return res.status(400).json({
        ok: false,
        message: "numeroShopify é obrigatório na query string. Exemplo: ?numeroShopify=1065",
      });
    }

    const pedidoBling = await findBlingOrderByShopifyNumber(numeroShopify);

    if (!pedidoBling) {
      return res.status(404).json({
        ok: false,
        message: "Pedido não encontrado no Bling.",
        numeroShopify: `#${normalizeShopifyOrderNumber(numeroShopify)}`,
      });
    }

    const pedidoCompleto = await getBlingOrderById(pedidoBling.id);
    const volume = extractVolumeFromOrder(pedidoCompleto, volumeId);

    if (!volume) {
      return res.status(404).json({
        ok: false,
        message: "Volume não encontrado dentro do pedido.",
        numeroShopify: `#${normalizeShopifyOrderNumber(numeroShopify)}`,
        pedidoBlingId: pedidoBling.id,
        volumeId,
      });
    }

    const responseData = {
      ok: true,
      numeroShopify: `#${normalizeShopifyOrderNumber(numeroShopify)}`,
      pedidoBlingId: pedidoBling.id,
      volumeId,
      volume,
      transporte: pedidoCompleto?.transporte || null,
    };

    console.log("=== DEBUG VOLUME BLING ===");
    console.log(JSON.stringify(responseData, null, 2));

    return res.status(200).json(responseData);
  } catch (error) {
    console.error("Erro no debug do volume:", error);
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

/**
 * Snapshot completo do pedido + transporte + volumes.
 * Exemplo:
 * /snapshot/1065
 */
app.get("/snapshot/:numeroShopify", async (req, res) => {
  try {
    const numeroShopify = String(req.params.numeroShopify || "").trim();
    const snapshot = await buildSnapshotByShopifyOrderNumber(numeroShopify);

    console.log("=== SNAPSHOT PEDIDO BLING ===");
    console.log(JSON.stringify(snapshot, null, 2));

    return res.status(snapshot.ok ? 200 : 404).json(snapshot);
  } catch (error) {
    console.error("Erro no snapshot do pedido:", error);
    return res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
});

app.post("/webhooks/orders-create", async (req, res) => {
  const hmacHeader = req.get("x-shopify-hmac-sha256");
  const topic = req.get("x-shopify-topic");
  const shop = req.get("x-shopify-shop-domain");
  const eventId = req.get("x-shopify-event-id");

  const rawBody = req.body;
  const valid = verifyShopifyWebhook(rawBody, hmacHeader);

  if (!valid) {
    console.error("Webhook inválido");
    return res.status(401).send("Unauthorized");
  }

  if (eventId && isWebhookEventAlreadyProcessed(eventId)) {
    console.warn("Webhook duplicado ignorado:", eventId);
    return res.status(200).send("ok - webhook duplicado ignorado");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("JSON inválido:", err);
    return res.status(400).send("Invalid JSON");
  }

  if (eventId) {
    markWebhookEventProcessed(eventId);
  }

  console.log("=== WEBHOOK RECEBIDO ===");
  console.log("Event ID:", eventId || "sem-event-id");
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

    if (SIMULATION_MODE) {
      console.log("=== MODO SIMULAÇÃO ATIVO ===");
      console.log("Nenhuma alteração será enviada ao Bling.");
      console.log({
        pedidoBlingId: pedidoBling.id,
        numeroPedidoShopify: payload.name || payload.order_number || payload.id,
        pesoCalculadoKg: totalWeightKg,
        itensRecebidos: lineItems.length,
      });

      return res.status(200).send("ok - simulacao");
    }

    console.log("Escrita automática desativada nesta versão por segurança.");
    return res.status(200).send("ok - escrita desativada");
  } catch (error) {
    console.error("Erro ao processar sincronização com Bling:", error);
    return res.status(500).send("Erro ao processar sincronização com Bling");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});