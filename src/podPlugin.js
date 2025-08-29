// src/podPlugin.js
// Qstomizer v3 适配：按行读取 _customorderid，调用官方 API 拿 design_png / image_url。
// 成功则返回 { front: {url,...}, back: {url,...} }；失败/缺少就返回 null，外层会走 properties 兜底。

const SHOP = (process.env.QSTOMIZER_SHOP || process.env.SHOP || "").trim();
const API_KEY = (process.env.QSTOMIZER_API_KEY || "").trim();
const ENDPOINT = "https://api.bigvanet.com/v3/order";

function normKey(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9_]+/g, "");
}
function liGet(line, keys) {
  const kv = {};
  (line.properties || []).forEach((p) => {
    if (p?.name) kv[normKey(p.name)] = String(p.value ?? "");
  });
  for (const k of keys) {
    const v = kv[normKey(k)];
    if (v) return v;
  }
  return "";
}
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

// 从 sides 中挑前后图；优先 design_png，没有则 image_url
function pickSides(sides = []) {
  const name = (s) => String(s?.side_name || "").toLowerCase();
  const byName = Object.fromEntries(sides.map((s) => [name(s), s]));

  const front = byName["front"] || sides.find((s) => /front/i.test(s.side_name || ""));
  const back  = byName["back"]  || sides.find((s) => /back/i.test(s.side_name || ""));

  const take = (s) => {
    if (!s) return null;
    const url = s.design_png || s.image_url || "";
    return isHttp(url) ? { url, raw: s } : null;
  };

  return { front: take(front), back: take(back) };
}

async function fetchQstomizer(orderId) {
  if (!SHOP || !API_KEY) {
    throw new Error("Qstomizer shop 或 API_KEY 未配置");
  }
  const url = `${ENDPOINT}?shop=${encodeURIComponent(SHOP)}&orderId=${encodeURIComponent(orderId)}`;
  const res = await fetch(url, { headers: { "API_KEY": API_KEY } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qstomizer ${res.status} ${res.statusText}: ${text}`);
  }
  const json = await res.json();
  const data = json?.body?.data || json?.data || json;
  if (!data) throw new Error("Qstomizer: empty body.data");
  return data;
}

// 简单内存缓存，避免同一 customization 多次请求
const cache = new Map();

async function fetchDesignsFromPlugin(order, line) {
  const customOrderId = liGet(line, ["_customorderid", "custom_order_id", "order_id", "qstomizer_orderid"]);
  if (!customOrderId) return null;

  const key = `${SHOP}:${customOrderId}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const data = await fetchQstomizer(customOrderId);
    const { front, back } = pickSides(data.sides || []);
    const result = (front || back) ? { front, back, extra: { qstomizer: { template_id: data.template_id, hex_color: data.hex_color } } } : null;
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("[podPlugin] qstomizer fetch failed:", e.message || e);
    cache.set(key, null);
    return null;
  }
}

// 对外：优先插件，其次 properties 兜底
async function getDesigns(order, line) {
  const r = await fetchDesignsFromPlugin(order, line);
  if (r && (r.front?.url || r.back?.url)) return r;

  // 兜底：读行属性（你当前已验证可用）
  const front = liGet(line, ["_customimagefront", "custom image:", "customimage", "design_url", "print_png_url", "print_url"]);
  const back  = liGet(line, ["_customimageback", "back_image", "image_back"]);
  const res = {
    front: isHttp(front) ? { url: front } : null,
    back:  isHttp(back)  ? { url: back }  : null,
    extra: {}
  };
  if (!res.front && !res.back) return null;
  return res;
}

module.exports = { getDesigns };
