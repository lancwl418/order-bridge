require("dotenv").config();
const express = require("express");
const { shopifyRest, shopifyGql } = require("./shopify");
const { riin } = require("./riin");
const { mapOrderToRiin } = require("./mapping");
const { verifyWebhook } = require("./verifyWebhook");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// false=只下单，不自动推送
const AUTO_PUSH = (process.env.FACTORY_AUTO_PUSH || "true").toLowerCase() === "true";

app.get("/healthz", (req, res) => res.send("ok"));

/* Shopify 标签 / metafield 工具 */
async function addTags(orderGid, tags) {
  await shopifyGql(
    `mutation($id:ID!, $tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{message} } }`,
    { id: orderGid, tags }
  );
}
async function removeTags(orderGid, tags) {
  await shopifyGql(
    `mutation($id:ID!, $tags:[String!]!){ tagsRemove(id:$id, tags:$tags){ userErrors{message} } }`,
    { id: orderGid, tags }
  );
}
async function setOrderError(orderGid, msg) {
  await shopifyGql(
    `mutation($m:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$m){ userErrors{message} }
    }`,
    {
      m: [{
        ownerId: orderGid,
        namespace: "factory",
        key: "last_error",
        type: "single_line_text_field",
        value: String(msg).slice(0, 250),
      }],
    }
  );
}

/* 预检：每一行必须有图片（严格模式）；否则给出明确错误 */
function assertImagesOrThrow(riinPayload) {
  const missing = [];
  for (const g of riinPayload.goodsList || []) {
    if (!Array.isArray(g.imageList) || g.imageList.length === 0) {
      missing.push(g.title || g.platformOllId || "unknown");
    }
  }
  if (missing.length) {
    throw new Error(
      `缺少打印图：${missing.join("，")}。` +
      `请在行项目 properties 里提供 print_png_url/design_url（或设 RIIN_ALLOW_FALLBACK_IMAGE=true 使用商品图占位）。`
    );
  }
}

/* 下单 +（可选）推送（对“已存在”容错） */
async function placeThenMaybePush(order) {
  const platformOid = String(order.id);
  const payload = await mapOrderToRiin(order);
  assertImagesOrThrow(payload);

  try {
    await riin.placeOrder(payload);
  } catch (e) {
    const msg = String(e);
    if (!/already|exist|存在/i.test(msg)) throw e;
  }

  if (AUTO_PUSH) {
    await riin.pushOrder([platformOid]);
    return { placed: true, pushed: true };
  }
  return { placed: true, pushed: false };
}

/* Webhook：已付款 → 下单（可选推送）→ 打标签/错误写回 */
app.post("/webhooks/orders_paid", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const { ok, rawText } = await verifyWebhook(req);
    if (!ok) return res.status(401).send("invalid hmac");

    const payload = JSON.parse(rawText);
    const orderId = String(payload.id).replace(/\D/g, "");
    const orderGid = `gid://shopify/Order/${orderId}`;

    const r = await shopifyRest(`orders/${orderId}.json`);
    const order = r.order;

    try {
      const result = await placeThenMaybePush(order);
      await addTags(orderGid, ["factory:placed"]);
      if (result.pushed) await addTags(orderGid, ["factory:pushed"]);
      else await removeTags(orderGid, ["factory:pushed"]);

      console.log(`[factory] order ${orderId} placed${result.pushed ? " & pushed" : ""}`);
    } catch (err) {
      await addTags(orderGid, ["factory:error"]);
      await setOrderError(orderGid, err);
      console.error(`[factory] place/push FAIL ${orderId}`, err);
    }

    res.send("ok");
  } catch (e) {
    console.error("webhook error:", e);
    res.status(500).send("err");
  }
});

/* 轮询：已推送未履约 -> 查询面单/快递 -> 创建履约 */
app.post("/api/tasks/poll", express.json(), async (req, res) => {
  try {
    const q = "tag:'factory:pushed' -tag:'factory:fulfilled' financial_status:paid";
    const data = await shopifyGql(
      `query($q:String!){
        orders(first:50, query:$q){ edges{ node{ id name } } }
      }`,
      { q }
    );
    const nodes = data?.orders?.edges?.map((e) => e.node) || [];
    if (!nodes.length) return res.json({ ok: true, checked: 0, created: 0 });

    const ids = nodes.map((n) => n.id.split("/").pop());
    const delivery = await riin.queryOrderDelivery(ids.slice(0, 100));
    const list = Array.isArray(delivery?.data) ? delivery.data : [];

    let created = 0;
    for (const row of list) {
      const orderId = String(row.platformOid).replace(/\D/g, "");
      const orderGid = `gid://shopify/Order/${orderId}`;

      const fo = await shopifyGql(
        `query($id:ID!){
          order(id:$id){ fulfillmentOrders(first:5){edges{node{id}}} }
        }`,
        { id: orderGid }
      );
      const foId = fo?.order?.fulfillmentOrders?.edges?.[0]?.node?.id;
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

      await addTags(orderGid, ["factory:fulfilled"]);
      await removeTags(orderGid, ["factory:pushed", "factory:error"]);
      created++;
    }

    res.json({ ok: true, checked: nodes.length, created });
  } catch (e) {
    console.error("poll error:", e);
    res.status(500).send("err");
  }
});

/* 手动推送（当 FACTORY_AUTO_PUSH=false 时使用） */
app.post("/api/tasks/push", express.json(), async (req, res) => {
  try {
    let ids = [];
    const raw = (req.query.ids || req.body.ids || "").trim();
    if (raw) {
      ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      const data = await shopifyGql(
        `query($q:String!){
          orders(first:50, query:$q){ edges{ node{ id } } }
        }`,
        { q: "tag:'factory:placed' -tag:'factory:pushed' financial_status:paid" }
      );
      ids = (data?.orders?.edges || []).map((e) => e.node.id.split("/").pop());
    }
    if (!ids.length) return res.json({ pushed: 0 });

    let pushed = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      await riin.pushOrder(batch);
      pushed += batch.length;

      for (const oid of batch) {
        const gid = `gid://shopify/Order/${oid}`;
        await addTags(gid, ["factory:pushed"]);
        await removeTags(gid, ["factory:error"]);
      }
    }
    res.json({ pushed, ids });
  } catch (e) {
    console.error("push error:", e);
    res.status(500).send("err");
  }
});

/* 注册 webhook（开发辅助） */
app.post("/dev/register-webhooks", express.json(), async (req, res) => {
  try {
    const host = req.query.host || req.body.host;
    if (!host) return res.status(400).send("pass ?host=<your.trycloudflare.com>");
    await shopifyRest("webhooks.json", {
      method: "POST",
      body: JSON.stringify({
        webhook: {
          topic: "orders/paid",
          address: `https://${host}/webhooks/orders_paid`,
          format: "json",
        },
      }),
    });
    res.send("ok");
  } catch (e) {
    console.error("register webhook error:", e);
    res.status(500).send("err");
  }
});

/* 调试：只“下单”（不推送）复测同一订单 */
app.post("/dev/place", express.json(), async (req, res) => {
  try {
    const id = (req.query.id || req.body.id || "").replace(/\D/g, "");
    if (!id) return res.status(400).send("pass ?id=<shopify订单数字ID>");
    const r = await shopifyRest(`orders/${id}.json`);
    const payload = await mapOrderToRiin(r.order);
    assertImagesOrThrow(payload);
    await riin.placeOrder(payload);
    res.send("ok");
  } catch (e) {
    res.status(500).send(String(e));
  }
});

/* 调试：查看 Shopify 原始订单（精简） */
function liProp(line, keys) {
  const kv = {};
  (line.properties || []).forEach((p) => {
    if (p?.name) kv[p.name.toLowerCase()] = String(p.value ?? "");
  });
  for (const k of keys) {
    const v = kv[k.toLowerCase()];
    if (v) return v;
  }
  return "";
}
function firstHttp(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}
app.get("/dev/order", async (req, res) => {
  try {
    const id = (req.query.id || "").replace(/\D/g, "");
    if (!id) return res.status(400).json({ error: "pass ?id=<shopify数字订单ID>" });
    const r = await shopifyRest(`orders/${id}.json`);
    const o = r.order || {};
    const lines = (o.line_items || []).map((li) => ({
      id: li.id,
      title: li.title,
      sku: li.sku,
      variant_title: li.variant_title,
      quantity: li.quantity,
      image_src: li.image?.src || "",
      properties: li.properties || [],
      detected_print_url:
        firstHttp(liProp(li, ["print_png_url", "print_url", "design_url", "artwork_url", "image", "print"])) || "",
      detected_mock_url:
        firstHttp(liProp(li, ["mockup_url", "preview", "mockup"])) || "",
    }));
    res.json({
      id: o.id,
      name: o.name,
      financial_status: o.financial_status,
      created_at: o.created_at,
      processed_at: o.processed_at,
      shipping_address: o.shipping_address || null,
      line_items: lines,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* 调试：预览映射后的 payload + 缺图行 */
app.get("/dev/inspect", async (req, res) => {
  try {
    const id = (req.query.id || "").replace(/\D/g, "");
    if (!id) return res.status(400).json({ error: "pass ?id=<shopify数字订单ID>" });

    const r = await shopifyRest(`orders/${id}.json`);
    const order = r.order;
    const payload = await mapOrderToRiin(order);

    const missing = [];
    for (const g of payload.goodsList || []) {
      if (!Array.isArray(g.imageList) || g.imageList.length === 0) {
        missing.push(g.title || g.platformOllId || "unknown");
      }
    }

    res.json({
      platformOid: String(order.id),
      goodsCount: payload.goodsList?.length || 0,
      missingImageLines: missing,
      sampleFirstLineImages: payload.goodsList?.[0]?.imageList || [],
      payloadPreview: payload
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`order-bridge listening on :${PORT}`));
