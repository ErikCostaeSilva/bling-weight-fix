const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";

// fallback por SKU quando a Shopify mandar grams = 0
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

// IMPORTANTE: usar raw body para validar assinatura do webhook
app.use(
  express.raw({
    type: "application/json",
  })
);

function verifyShopifyWebhook(rawBodyBuffer, hmacHeader) {
  if (!hmacHeader || !SHOPIFY_WEBHOOK_SECRET) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBodyBuffer)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}

app.get("/", (req, res) => {
  res.status(200).send("Servidor do webhook online");
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
  const weightDebug = [];

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

    const debugItem = {
      title,
      sku,
      quantity,
      gramsFromShopify,
      unitWeightGrams,
      lineWeightGrams,
      source,
    };

    weightDebug.push(debugItem);
    console.log(debugItem);
  }

  const totalWeightKg = Number((totalWeightGrams / 1000).toFixed(3));

  console.log("Peso total em gramas:", totalWeightGrams);
  console.log("Peso total em kg:", totalWeightKg);

  // Aqui depois vamos atualizar o Bling
  // await updateBlingOrderWeight(...)

  return res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});