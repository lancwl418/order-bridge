// Shopify 订单 → RIIN placeOrder payload
// 约定：type=1(打印图) 来自 design_png（PNG），必要时走 /img/pngdpi 注入 DPI；type=2(效果图) 来自 image_url 或行属性上的 JPG

const { getDesigns } = require("./podPlugin");

const ALLOW_FALLBACK_IMAGE =
  (process.env.RIIN_ALLOW_FALLBACK_IMAGE || "false").toLowerCase() === "true";

const FORCE_PNG_DPI =
  (process.env.RIIN_FORCE_PNG_DPI || "0").toLowerCase() !== "0";
const PRINT_DPI = Number(process.env.RIIN_PRINT_DPI || 300);
const IMAGE_PROXY_BASE = String(process.env.IMAGE_PROXY_BASE || "").replace(
  /\/+$/,
  ""
);

// 允许：数字/字母/下划线/中文/英文中括号
function sanitizeImageName(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/[^0-9A-Za-z_\u4e00-\u9fa5\[\]]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function normKey(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9_]+/g, "");
}
function getProp(line, keys) {
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

function firstHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : "";
}

function deriveColorSize(line) {
  let color = getProp(line, ["print_color", "color", "颜色"]);
  let size = getProp(line, ["print_size", "size", "尺寸"]);
  if ((!color || !size) && typeof line.variant_title === "string") {
    const parts = line.variant_title.split("/").map((s) => s.trim());
    if (!color && parts[0]) color = parts[0];
    if (!size && parts[1]) size = parts[1];
  }
  return { color: color || "NA", size: size || "ONE" };
}

function withPngDpiProxy(url) {
  if (!url) return "";
  if (!FORCE_PNG_DPI) return url;
  // 仅对 PNG 处理
  if (!/\.png(\?|#|$)/i.test(url)) return url;
  if (!IMAGE_PROXY_BASE) return url;
  const src = encodeURIComponent(url);
  return `${IMAGE_PROXY_BASE}/img/pngdpi?src=${src}&dpi=${PRINT_DPI}`;
}

// 取某一行的图片列表；先走插件（Qstomizer），不成就用 properties 兜底
async function buildImageList(order, line) {
  const orderId = String(order.id);
  const lineKey = String(line.id || line.variant_id || line.product_id || "1");

  const pushUniq = (arr, obj) => {
    if (!obj?.imageUrl) return;
    if (arr.some((x) => x.imageUrl === obj.imageUrl && x.type === obj.type)) return;
    arr.push(obj);
  };

  const list = [];

  // 1) 插件：分别取 print/mock 生成 type=1/2
  const plugin = await getDesigns(order, line);
  if (plugin?.front || plugin?.back) {
    if (plugin.front?.print) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_P0`);
      pushUniq(list, {
        type: 1,
        imageUrl: withPngDpiProxy(plugin.front.print),
        imageCode: name,
        imageName: name,
      });
    }
    if (plugin.back?.print && plugin.back.print !== plugin.front?.print) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_P1`);
      pushUniq(list, {
        type: 1,
        imageUrl: withPngDpiProxy(plugin.back.print),
        imageCode: name,
        imageName: name,
      });
    }
    if (plugin.front?.mock && plugin.front.mock !== plugin.front?.print) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_M0`);
      pushUniq(list, {
        type: 2,
        imageUrl: plugin.front.mock,
        imageCode: name,
        imageName: name,
      });
    }
    if (
      plugin.back?.mock &&
      plugin.back.mock !== plugin.back?.print &&
      plugin.back.mock !== plugin.front?.mock
    ) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_M1`);
      pushUniq(list, {
        type: 2,
        imageUrl: plugin.back.mock,
        imageCode: name,
        imageName: name,
      });
    }
  }

  // 2) 插件没拿到打印图时，从行属性补齐
  if (!list.some((x) => x.type === 1)) {
    const fp =
      firstHttp(
        getProp(line, [
          "print_png_url",
          "design_png",
          "design_url",
          "print_url",
        ])
      ) || "";
    const bp =
      firstHttp(
        getProp(line, [
          "back_print_png_url",
          "back_design_png",
          "back_design_url",
          "back_print_url",
        ])
      ) || "";
    if (fp) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_P0`);
      pushUniq(list, {
        type: 1,
        imageUrl: withPngDpiProxy(fp),
        imageCode: name,
        imageName: name,
      });
    }
    if (bp && bp !== fp) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_P1`);
      pushUniq(list, {
        type: 1,
        imageUrl: withPngDpiProxy(bp),
        imageCode: name,
        imageName: name,
      });
    }
  }

  // 3) 补效果图（若还没有）
  if (!list.some((x) => x.type === 2)) {
    const fm =
      firstHttp(
        getProp(line, [
          "_customimagefront",
          "custom image:",
          "customimage",
          "artwork_url",
          "image",
          "print",
          "mockup_url",
          "preview",
          "mockup",
        ])
      ) || "";
    const bm =
      firstHttp(
        getProp(line, ["_customimageback", "back_image", "image_back"])
      ) || "";
    if (fm) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_M0`);
      pushUniq(list, {
        type: 2,
        imageUrl: fm,
        imageCode: name,
        imageName: name,
      });
    }
    if (bm && bm !== fm) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_M1`);
      pushUniq(list, {
        type: 2,
        imageUrl: bm,
        imageCode: name,
        imageName: name,
      });
    }
  }

  // 4) 最终兜底（可选，用商品主图）
  if (list.length === 0 && ALLOW_FALLBACK_IMAGE) {
    const fb = firstHttp(line?.image_src || line?.image?.src) || "";
    if (fb) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_M0`);
      pushUniq(list, { type: 2, imageUrl: fb, imageCode: name, imageName: name });
    }
  }

  return list;
}

function toDateTime(s) {
  if (!s) return "";
  const d = new Date(s);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

exports.mapOrderToRiin = async function mapOrderToRiin(order) {
  const ship = order.shipping_address || {};
  const orderId = String(order.id);
  const orderNo = order.name || order.order_number || orderId;

  const goodsList = await Promise.all(
    (order.line_items || []).map(async (line, idx) => {
      const { color, size } = deriveColorSize(line);
      const imageList = await buildImageList(order, line);

      const craftProp = getProp(line, ["craft", "craftType", "工艺"]);
      const craftType = /直喷|dtg/i.test(craftProp) ? 2 : 1;
      const subId = String(line.id || line.variant_id || `${orderId}-${idx + 1}`);

      return {
        platformOid: orderId,
        platformOllId: subId,
        goodsType: 1,
        title: line.title || orderNo,
        goodsStatus: "NOT_SHIPPED",
        refundStatus: "NO_REFUND",
        sizeCode: String(size).toUpperCase(),
        sizeName: size,
        colorCode: String(color).toUpperCase(),
        colorName: color,
        styleCode: String(line.sku || line.product_id || "STYLE"),
        styleName: line.title || "Style",
        craftType,
        num: line.quantity || 1,

        platformSpuId: String(line.product_id || ""),
        platformSkuId: String(line.variant_id || ""),
        specification: `${color}/${size}`,

        imageList,
      };
    })
  );

  const address = [ship.address1, ship.address2].filter(Boolean).join(" ");

  return {
    platformType: 15,
    sourcePlatformOid: orderId,
    platformOrderStatus: "NOT_SHIPPED",
    platformRefundStatus: "NO_REFUND",
    platformOid: orderId,

    consigneeName: `${ship.first_name || ""} ${ship.last_name || ""}`.trim(),
    phone: ship.phone || "0000000000",
    address,
    receiverCountry: ship.country || ship.country_code || "",
    receiverProvince: ship.province || "",
    receiverCity: ship.city || "",
    receiverTown: ship.city || "",
    postCode: ship.zip || "",

    orderPayTime: toDateTime(order.processed_at || order.updated_at || order.created_at),
    orderTime: toDateTime(order.created_at),

    selfWaybillFlag: false,
    goodsList,
  };
};
