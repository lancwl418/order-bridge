// Qstomizer v3 适配：优先从 sides 拿 design_png(打印图) 与 image_url(效果图)。
// 返回形如：{ front: { print, mock }, back: { print, mock } }；失败/缺少则返回 null。

const SHOP = (process.env.QSTOMIZER_SHOP || process.env.SHOP || "").trim();
const API_KEY = (process.env.QSTOMIZER_API_KEY || "").trim();
const ENDPOINT = "https://api.bigvanet.com/v3/order";

const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

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

function pickSides(sides = []) {
  const by = (kw) =>
    sides.find((s) => new RegExp(kw, "i").test(String(s?.side_name || "")));

  // 兼容英文 Front/Back 以及中文“前/后/背”
  const front = by("front|^t.*front|前");
  const back = by("back|^t.*back|后|背");

  const map = (s) => {
    if (!s) return null;
    const print = isHttp(s.design_png) ? s.design_png : ""; // 打印图（PNG）
    const mock = isHttp(s.image_url) ? s.image_url : ""; // 效果图（JPG）
    if (!print && !mock) return null;
    return { print, mock, raw: s };
  };

  return { front: map(front), back: map(back) };
}

async function fetchQstomizer(orderId) {
  if (!SHOP || !API_KEY) {
    throw new Error("Qstomizer shop 或 API_KEY 未配置");
  }
  const url = `${ENDPOINT}?shop=${encodeURIComponent(SHOP)}&orderId=${encodeURIComponent(orderId)}`;
  const res = await fetch(url, { headers: { API_KEY } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qstomizer ${res.status} ${res.statusText}: ${text}`);
  }
  const json = await res.json();
  const data = json?.body?.data || json?.data || json;
  if (!data) throw new Error("Qstomizer: empty body.data");
  return data;
}

// 简单缓存
const cache = new Map();

async function fetchDesignsFromPlugin(order, line) {
  const customOrderId = liGet(line, [
    "_customorderid",
    "custom_order_id",
    "order_id",
    "qstomizer_orderid",
  ]);
  if (!customOrderId) return null;

  const key = `${SHOP}:${customOrderId}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const data = await fetchQstomizer(customOrderId);
    const picked = pickSides(data.sides || []);
    const result =
      picked.front || picked.back
        ? {
            ...picked,
            extra: {
              qstomizer: {
                template_id: data.template_id,
                hex_color: data.hex_color,
              },
            },
          }
        : null;
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("[podPlugin] qstomizer fetch failed:", e.message || e);
    cache.set(key, null);
    return null;
  }
}

// 对外：优先插件；否则从行属性兜底（打印图优先）
async function getDesigns(order, line) {
  const r = await fetchDesignsFromPlugin(order, line);
  if (r && (r.front || r.back)) return r;

  // 兜底：行属性
  const pick = (u) => (isHttp(u) ? u : "");
  const frontPrint = pick(
    liGet(line, ["print_png_url", "design_png", "design_url", "print_url"])
  );
  const backPrint = pick(
    liGet(line, [
      "back_print_png_url",
      "back_design_png",
      "back_design_url",
      "back_print_url",
    ])
  );
  const frontMock = pick(
    liGet(line, [
      "_customimagefront",
      "custom image:",
      "customimage",
      "artwork_url",
      "image",
      "print",
    ])
  );
  const backMock = pick(
    liGet(line, ["_customimageback", "back_image", "image_back", "mockup_url", "preview", "mockup"])
  );

  if (!frontPrint && !backPrint && !frontMock && !backMock) return null;

  const front = frontPrint || frontMock ? { print: frontPrint, mock: frontMock } : null;
  const back = backPrint || backMock ? { print: backPrint, mock: backMock } : null;
  return { front, back, extra: {} };
}

module.exports = { getDesigns };
