// Shopify 订单 → RIIN placeOrder payload（含图片名合法化 & 可选占位图）
const { getDesigns } = require("./podPlugin");

const ALLOW_FALLBACK_IMAGE =
  (process.env.RIIN_ALLOW_FALLBACK_IMAGE || "false").toLowerCase() === "true";

// 允许：数字/字母/下划线/中文/英文中括号
function sanitizeImageName(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/[^0-9A-Za-z_\u4e00-\u9fa5\[\]]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// 统一规范化键名：小写、去空白和非字母数字下划线
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

function firstHttp(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}

// 取某一行的图片列表；先走 Qstomizer（或其它 POD 插件），不成就用 properties 兜底
async function buildImageList(order, line) {
  const orderId = String(order.id);
  const lineKey = String(line.id || line.variant_id || line.product_id || "1");

  // 1) 优先插件（Qstomizer）：会返回 { front:{url}, back:{url} }
  const plugin = await getDesigns(order, line);

  const list = [];
  if (plugin?.front?.url) {
    const name = sanitizeImageName(`P_${orderId}_${lineKey}_F`);
    list.push({ type: 1, imageUrl: plugin.front.url, imageCode: name, imageName: name });
  }
  if (plugin?.back?.url && plugin.back.url !== plugin?.front?.url) {
    const name = sanitizeImageName(`P_${orderId}_${lineKey}_B`);
    list.push({ type: 1, imageUrl: plugin.back.url, imageCode: name, imageName: name });
  }

  // 2) 插件没拿到则回退到行属性
  if (list.length === 0) {
    const firstHttp = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");
    const frontUrl =
      firstHttp(getProp(line, [
        "_customimagefront", "custom image:", "customimage",
        "design_url", "print_png_url", "print_url", "artwork_url", "image", "print"
      ])) || "";
    const backUrl =
      firstHttp(getProp(line, ["_customimageback", "back_image", "image_back"])) || "";

    if (frontUrl) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_F`);
      list.push({ type: 1, imageUrl: frontUrl, imageCode: name, imageName: name });
    }
    if (backUrl && backUrl !== frontUrl) {
      const name = sanitizeImageName(`P_${orderId}_${lineKey}_B`);
      list.push({ type: 1, imageUrl: backUrl, imageCode: name, imageName: name });
    }

    // 3) 最终兜底（可选）
    if (list.length === 0 && ALLOW_FALLBACK_IMAGE) {
      const fb = firstHttp(line?.image_src || line?.image?.src) || "";
      if (fb) {
        const name = sanitizeImageName(`P_${orderId}_${lineKey}`);
        list.push({ type: 1, imageUrl: fb, imageCode: name, imageName: name });
      }
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
      const { color, size } = deriveColorSize(line); // 你已有的解析函数
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
        styleCode: String(line.product_id || line.sku || "STYLE"),
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
    phone: ship.phone || "0000000000",  // 你若用了 pickOrderPhone，可替换为 pickOrderPhone(order)
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
