const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";

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

app.post("/webhooks/orders-create", (req, res) => {
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
  for (const item of lineItems) {
    console.log({
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      grams: item.grams,
    });
  }

  return res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});