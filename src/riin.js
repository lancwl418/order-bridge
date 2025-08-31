 // src/riin.js
// RIIN API 封装：签名、节流、错误统一处理 + 常用接口
const CryptoJS = require("crypto-js");

const BASE = (process.env.RIIN_BASE_URL || "").trim(); // 例： https://tshirt.riin.com / https://tshirt-test.riin.com
const SECRET = (process.env.RIIN_SECRET_KEY || process.env.RIIN_SECRET || "").trim();

// --- 轻量节流：最多并发 10，调用间隔 ~120ms ---
const queue = [];
let active = 0;
const MAX = 10;
const next = () => {
  if (active >= MAX || queue.length === 0) return;
  active++;
  const job = queue.shift();
  job().finally(() => {
    active--;
    setTimeout(next, 120);
  });
};
function runThrottled(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    next();
  });
}

// --- 工具 ---
const md5 = (s) => CryptoJS.MD5(String(s)).toString(CryptoJS.enc.Hex);
const joinUrl = (base, path) => String(base).replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");

// 统一抛错，带 message / traceId
function throwRiinError(status, path, rawText, json) {
  const msg = json?.message || json?.msg || json?.error_message || "";
  const trace = json?.traceId || json?.traceID || "";
  const bodyStr = rawText || (json ? JSON.stringify(json) : "");
  const suffix = [msg && `message="${msg}"`, trace && `traceId=${trace}`].filter(Boolean).join(" ");
  const detail = suffix ? `${suffix} | ${bodyStr}` : bodyStr;
  throw new Error(`RIIN ${status} ${path}: ${detail}`);
}

async function post(path, payload) {
  if (!BASE || !SECRET) throw new Error("RIIN_BASE_URL / RIIN_SECRET_KEY 未配置");
  const url = joinUrl(BASE, path);
  const body = JSON.stringify(payload || {});
  const sign = md5(`${body}::${SECRET}`); // 按工厂要求：body + '::' + secret

  return runThrottled(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json;charset=utf-8",
        // 注意：工厂要求两个 header 都带上
        secretKey: SECRET,
        sign,
      },
      body,
    });

    const text = await res.text().catch(() => "");
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }

    // HTTP 层面错误
    if (!res.ok) {
      throwRiinError(res.status, path, text, json);
    }
    // 业务层面错误（很多接口即便 200 也会 successful=false）
    if (json && json.successful === false) {
      // 用 400 表示业务失败
      throwRiinError(400, path, text, json);
    }
    return json ?? {};
  });
}

/* ================== 对外 API ================== */

module.exports.riin = {
  // 下单 / 推送 / 查询
  placeOrder: (order) => post("/trade/api/interface/placeOrder", order),
  pushOrder: (ids) => post("/trade/api/interface/pushOrder", { platformOidList: ids }),
  queryOrderDelivery: (ids) => post("/trade/api/interface/queryOrderDelivery", { platformOidList: ids }),
  queryOrderStatus: (ids) => post("/trade/api/interface/queryOrderStatus", { platformOidList: ids }),
  queryOrderInfo: (ids) => post("/trade/api/interface/queryOrderInfo", { platformOidList: ids }),

  // 修改（仅允许：收货信息 / 将状态改回待推送 / 商品数量规格颜色尺寸工艺 / 新增商品 / 标签&欧代URL）
  updateOrder: (order) => post("/trade/api/interface/updateOrder", order),

  // 修改订单图片（仅待推送或反审回电商）
  updatePrintImage: (payload) => post("/trade/api/interface/updatePrintImage", payload),

  // 关闭订单（兼容单个 / 列表）
  closeOrder: (platformOidOrList) => {
    if (Array.isArray(platformOidOrList)) {
      return post("/trade/api/interface/closeOrder", { platformOidList: platformOidOrList });
    }
    return post("/trade/api/interface/closeOrder", { platformOid: platformOidOrList });
  },

  // 预发货（可选）
  preShipped: (order) => post("/trade/api/interface/preShipped", order),

  // 基础资料（可选）
  queryProduct: (page = { pageIndex: 1, pageSize: 1000 }) => post("/trade/api/interface/queryProduct", page),
  queryStyle: (page = { pageIndex: 1, pageSize: 1000 }) => post("/trade/api/interface/queryStyle", page),
  queryColor: (page = { pageIndex: 1, pageSize: 1000 }) => post("/trade/api/interface/queryColor", page),
  querySize: (page = { pageIndex: 1, pageSize: 1000 }) => post("/trade/api/interface/querySize", page),
  queryShipAddress: () => post("/trade/api/interface/queryShipAddress", {}),
  queryProductShipAddress: (productCodeList) =>
    post("/trade/api/interface/queryProductShipAddress", { productCodeList }),

  // 异常图片（可选）
  queryAbnormalImagePage: (params) => post("/trade/api/interface/queryAbnormalImagePage", params),
  uploadAbnormalImage: (payload) => post("/trade/api/interface/uploadAbnormalImage", payload),
  syncImageToFactory: (ids) => post("/trade/api/interface/syncImageToFactory", { ids }),

  // 售后（可选）
  queryAfterSalesInfo: (platformOid) => post("/trade/api/interface/queryAfterSalesInfo", { platformOid }),
  createAfterSales: (payload) => post("/trade/api/interface/createAfterSales", payload),

  /* ====== helpers: 给后台用的状态解析/前置判断 ====== */
  parseRiinStatusRow(row = {}) {
    const code = Number(
      row.factoryOrderStatusCode ?? row.factoryOrderStatus ?? row.status ?? row.statusCode ?? 0
    );
    const text = String(row.factoryOrderStatusDesc ?? row.statusDesc ?? row.status ?? row.desc ?? "");
    return { code, text };
  },
  isModifiableStatus({ code, text }) {
    if (/待推送|反审|回电商/i.test(text)) return true;
    if ([1, 10].includes(code)) return true; // 经验值：工厂侧“未推送/可改”常见编码
    return false;
  },
};
