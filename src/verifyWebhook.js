const crypto = require("crypto");
async function verifyWebhook(req) {
  const raw = req.body; // Buffer（见 index.js 原样接收）
  const sent = req.get("x-shopify-hmac-sha256") || "";
  const digest = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET)
                       .update(raw).digest("base64");
  const ok = crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(digest));
  return { ok, rawText: raw.toString("utf8") };
}
module.exports = { verifyWebhook };
