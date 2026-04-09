const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || "";
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || "";
const BLING_REDIRECT_URI =
  process.env.BLING_REDIRECT_URI || "https://bling-weight-fix.onrender.com/callback";

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

// raw body para webhook Shopify
app.use("/webhooks", express.raw({ type: "application/json" }));

// json/urlencoded para demais rotas
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
  const { code, state, error } = req.query;

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

    console.log("=== TOKENS BLING RECEBIDOS ===");
    console.log({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      token_type: data.token_type,
      scope: data.scope,
      state,
    });

    return res.status(200).send(
      "Autorização concluída. Veja os logs do Render para copiar access_token e refresh_token."
    );
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
  console.log("Pedido:", payload.name || payload.order_number || payload.id);

  const lineItems = payload.line_items || [];

  let totalWeightGrams = 0;

  for (const item of lineItems) {
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

    console.log({
      title: item.title || "",
      sku,
      quantity,
      gramsFromShopify,
      unitWeightGrams,
      lineWeightGrams,
      source,
    });
  }

  const totalWeightKg = Number((totalWeightGrams / 1000).toFixed(3));

  console.log("Peso total em gramas:", totalWeightGrams);
  console.log("Peso total em kg:", totalWeightKg);

  return res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});