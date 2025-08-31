// src/index.js

const cors = require('cors');
const { verifyShopifyJWT } = require('./authShopifyJwt');

app.use(cors({
  origin: [/^https:\/\/.*\.myshopify\.com$/, /^https:\/\/admin\.shopify\.com$/],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Authorization','Content-Type'],
}));

require("dotenv").config();
const express = require("express");
const { shopifyRest, shopifyGql } = require("./shopify");
const { riin } = require("./riin");
const { mapOrderToRiin } = require("./mapping");
const { verifyWebhook } = require("./verifyWebhook");

// 用于 PNG 写入 pHYs（DPI）
const extract = require("png-chunks-extract");
const encode = require("png-chunks-encode");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// false=只下单，不自动推送；true=下单后立刻 push
const AUTO_PUSH =
  (process.env.FACTORY_AUTO_PUSH || "true").toLowerCase() === "true";

app.get("/healthz", (req, res) => res.send("ok"));

/* -------------- Shopify 标签 / metafield 工具 -------------- */
async function addTags(orderGid, tags) {
  await shopifyGql(
    `mutation($id:ID!, $tags:[String!]!){
      tagsAdd(id:$id, tags:$tags){ userErrors{message} }
    }`,
    { id: orderGid, tags }
  );
}
async function removeTags(orderGid, tags) {
  await shopifyGql(
    `mutation($id:ID!, $tags:[String!]!){
      tagsRemove(id:$id, tags:$tags){ userErrors{message} }
    }`,
    { id: orderGid, tags }
  );
}
async function setOrderError(orderGid, msg) {
  await shopifyGql(
    `mutation($m:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$m){ userErrors{message} }
    }`,
    {
      m: [
        {
          ownerId: orderGid,
          namespace: "factory",
          key: "last_error",
          type: "single_line_text_field",
          value: String(msg).slice(0, 250),
        },
      ],
    }
  );
}

/* ------------------ 预检：每一行必须有图片 ------------------ */
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

/* ---------- 下单 +（可选）推送（对“已存在”容错） ---------- */
async function placeThenMaybePush(order) {
  const platformOid = String(order.id);
  const payload = await mapOrderToRiin(order);
  assertImagesOrThrow(payload);

  try {
    await riin.placeOrder(payload);
    console.log(
      `[factory] place OK ${platformOid}  lines=${payload.goodsList?.length || 0}`
    );
  } catch (e) {
    const msg = String(e || "");
    // 工厂已存在的单，忽略报错继续走（关键词：already/exist/存在）
    if (!/already|exist|存在/i.test(msg)) {
      throw e;
    } else {
      console.warn(`[factory] place exists ${platformOid} -> continue`);
    }
  }

  if (AUTO_PUSH) {
    await riin.pushOrder([platformOid]);
    console.log(`[factory] push OK ${platformOid}`);
    return { placed: true, pushed: true };
  }
  return { placed: true, pushed: false };
}

/* ---------------- Webhook：orders/paid ---------------- */
app.post(
  "/webhooks/orders_paid",
  express.raw({ type: "application/json" }),
  async (req, res) => {
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

        console.log(
          `[factory] order ${orderId} placed${result.pushed ? " & pushed" : ""}`
        );
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
  }
);

/* -------- 轮询：已推送未履约 -> 查询面单 -> 创建履约 -------- */
app.post("/api/tasks/poll", verifyShopifyJWT, express.json(), async (req, res) => {
  try {
    const q =
      "tag:'factory:pushed' -tag:'factory:fulfilled' financial_status:paid";
    const data = await shopifyGql(
      `query($q:String!){
        orders(first:50, query:$q){ edges{ node{ id name } } }
      }`,
      { q }
    );
    const nodes = data?.orders?.edges?.map((e) => e.node) || [];
    if (!nodes.length)
      return res.json({ ok: true, checked: 0, created: 0 });

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

/* --------------------- 手动批量推送 --------------------- */
app.post("/api/tasks/push", verifyShopifyJWT, express.json(), async (req, res) => {
  try {
    let ids = [];

    // 兼容：单笔 ?orderId=gid 或数字ID
    const one = (req.query.orderId || req.body.orderId || '').toString();
    if (one) {
      const numeric = one.split('/').pop().replace(/\D/g, '');
      if (numeric) ids = [numeric];
    }

    // 兼容：批量 ?ids=1,2,3 或 body.ids
    if (!ids.length) {
      const raw = (req.query.ids || req.body.ids || '').trim();
      if (raw) {
        ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }

    // 若仍为空：按你原逻辑查询“已下单未推送”
    if (!ids.length) {
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

/* ----------------- 注册 webhook（开发辅助） ----------------- */
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

/* --------------- 调试：只“下单”（不推送） --------------- */
app.post("/dev/place", verifyShopifyJWT, express.json(), async (req, res) => {
  try {
    const id = (req.query.id || req.body.id || "").replace(/\D/g, "");
    if (!id) return res.status(400).send("pass ?id=<shopify订单数字ID>");
    const r = await shopifyRest(`orders/${id}.json`);
    const order = r.order;
    const payload = await mapOrderToRiin(order);

    // 打一份关键字段日志便于核对
    console.log("[dev/place] order:", order.id, order.name);
    console.log(
      "[dev/place] first imageList:",
      payload.goodsList?.[0]?.imageList || []
    );

    assertImagesOrThrow(payload);
    await riin.placeOrder(payload);
    res.send("ok");
  } catch (e) {
    console.error("dev/place error:", e);
    res.status(500).send(String(e));
  }
});

/* -------- 调试：查看 Shopify 原始订单（精简） -------- */
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
app.get("/dev/order", verifyShopifyJWT, async (req, res) => {
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
        firstHttp(
          liProp(li, [
            "print_png_url",
            "print_url",
            "design_url",
            "artwork_url",
            "image",
            "print",
          ])
        ) || "",
      detected_mock_url: firstHttp(liProp(li, ["mockup_url", "preview", "mockup"])) || "",
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

/* ------ 调试：预览映射后的 payload + 缺图行（含示例图） ------ */
app.get("/dev/inspect", verifyShopifyJWT, async (req, res) => {
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
      payloadPreview: payload,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* --------------- PNG DPI 代理：/img/pngdpi --------------- */
/**
 * 用法：
 *   GET /img/pngdpi?src=<远程pngurl>&dpi=300
 * 作用：
 *   下载远程 PNG，如果缺少 pHYs，则写入 pHYs（x/y 均为 dpi 换算的像素/米），然后返回。
 *   非 PNG 或下载失败均按原样/错误处理。
 */
app.get("/img/pngdpi", async (req, res) => {
  try {
    const src = String(req.query.src || "");
    const dpi = Number(req.query.dpi || 300);
    if (!/^https?:\/\//i.test(src)) return res.status(400).send("bad src");

    const r = await fetch(src);
    if (!r.ok) return res.status(502).send("fetch src failed");
    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);

    // 非 PNG 直接透传
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.slice(0, 8).equals(sig)) {
      res.set(
        "Content-Type",
        r.headers.get("content-type") || "application/octet-stream"
      );
      return res.send(buf);
    }

    // 写入/替换 pHYs（像素/米）
    const ppm = Math.max(1, Math.round(dpi / 0.0254)); // dpi -> pixels per meter
    const chunks = extract(buf).filter((c) => c.name !== "pHYs");
    const ihdrIdx = chunks.findIndex((c) => c.name === "IHDR");
    const phys = {
      name: "pHYs",
      data: Buffer.from([
        (ppm >>> 24) & 0xff,
        (ppm >>> 16) & 0xff,
        (ppm >>> 8) & 0xff,
        ppm & 0xff,
        (ppm >>> 24) & 0xff,
        (ppm >>> 16) & 0xff,
        (ppm >>> 8) & 0xff,
        ppm & 0xff,
        1, // 单位：米
      ]),
    };
    chunks.splice(ihdrIdx + 1, 0, phys);
    const out = Buffer.from(encode(chunks));

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(out);
  } catch (e) {
    console.error("pngdpi error:", e);
    res.status(500).send("err");
  }
});

/* ----------------------------- 启动 ----------------------------- */
app.listen(PORT, () => console.log(`order-bridge listening on :${PORT}`));
