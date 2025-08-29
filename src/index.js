require("dotenv").config();
const express = require("express");
const { shopifyRest, shopifyGql } = require("./shopify");
const { riin } = require("./riin");
const { mapOrderToRiin } = require("./mapping");
const { verifyWebhook } = require("./verifyWebhook");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.get("/healthz", (req, res) => res.send("ok"));

app.post("/webhooks/orders_paid",
  express.raw({ type: "application/json" }), // 保留原始 body 供 HMAC
  async (req, res) => {
    try {
      const { ok, rawText } = await verifyWebhook(req);
      if (!ok) return res.status(401).send("invalid hmac");

      const payload = JSON.parse(rawText);
      const orderId = String(payload.id).replace(/\D/g, "");

      const r = await shopifyRest(`orders/${orderId}.json`);
      const order = r.order;

      const riinOrder = mapOrderToRiin(order);
      await riin.placeOrder(riinOrder);
      await riin.pushOrder([String(order.id)]);

      res.send("ok");
    } catch (e) {
      console.error("webhook error:", e);
      res.status(500).send("err");
    }
  }
);

app.post("/api/tasks/poll", express.json(), async (req, res) => {
  try {
    const ids = []; // TODO: 换成你DB里的“已push未履约”订单号
    if (!ids.length) return res.send("no orders");

    const delivery = await riin.queryOrderDelivery(ids.slice(0,100));
    for (const row of (delivery?.data || [])) {
      const orderId = String(row.platformOid).replace(/\D/g, "");
      const data = await shopifyGql(
        `query($id:ID!){ order(id:$id){ fulfillmentOrders(first:5){edges{node{id}}}}}`,
        { id: `gid://shopify/Order/${orderId}` }
      );
      const foId = data?.order?.fulfillmentOrders?.edges?.[0]?.node?.id;
      if (!foId) continue;
      await shopifyGql(
        `mutation($input:FulfillmentV2Input!){
          fulfillmentCreateV2(fulfillment:$input){ userErrors{message} }
        }`,
        {
          input: {
            fulfillmentOrderId: foId,
            trackingInfo: {
              number: row.trackingNumber || "",
              url: row.waybillDataPath || "",
              company: row.courierCompany || "Other",
            },
            notifyCustomer: false,
          },
        }
      );
    }
    res.send("ok");
  } catch (e) {
    console.error("poll error:", e);
    res.status(500).send("err");
  }
});

app.post("/dev/register-webhooks", express.json(), async (req, res) => {
  try {
    const host = req.query.host || req.body.host;
    if (!host) return res.status(400).send("pass ?host=your-domain.trycloudflare.com");
    await shopifyRest("webhooks.json", {
      method: "POST",
      body: JSON.stringify({
        webhook: { topic: "orders/paid", address: `https://${host}/webhooks/orders_paid`, format: "json" }
      })
    });
    res.send("ok");
  } catch (e) {
    console.error("register webhook error:", e);
    res.status(500).send("err");
  }
});

app.listen(PORT, () => console.log(`order-bridge listening on :${PORT}`));
