// src/riin.js
const CryptoJS = require("crypto-js");

const BASE = process.env.RIIN_BASE_URL;     // 测试: https://tshirt-test.riin.com  生产: https://tshirt.riin.com
const SECRET = process.env.RIIN_SECRET_KEY;

// 轻量节流：同一时间不超过 10 个请求；间隔做个缓冲
const queue = [];
let active = 0;
const MAX = 10;
const next = () => {
  if (active >= MAX || queue.length === 0) return;
  active++;
  const job = queue.shift();
  job().finally(() => {
    active--;
    setTimeout(next, 120); // 约 ~8~10 QPS
  });
};
function runThrottled(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    next();
  });
}

const md5 = (s) => CryptoJS.MD5(s).toString(CryptoJS.enc.Hex);

async function post(path, payload) {
  const body = JSON.stringify(payload);
  const sign = md5(`${body}::${SECRET}`);
  return runThrottled(async () => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        secretKey: SECRET,
        sign
      },
      body
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`RIIN ${res.status} ${path}: ${JSON.stringify(data)}`);
    }
    return data;
  });
}

module.exports.riin = {
  // 1) 下单
  placeOrder: (order) => post("/trade/api/interface/placeOrder", order),

  // 2) 修改订单/商品
  updateOrder: (order) => post("/trade/api/interface/updateOrder", order),

  // 3) 预发货（不一定用得到）
  preShipped: (order) => post("/trade/api/interface/preShipped", order),

  // 4) 获取快递面单/运单
  queryOrderDelivery: (ids) =>
    post("/trade/api/interface/queryOrderDelivery", { platformOidList: ids }),

  // 5) 查询订单状态
  queryOrderStatus: (ids) =>
    post("/trade/api/interface/queryOrderStatus", { platformOidList: ids }),

  // 6~10) 基础资料（可选）
  queryProduct: (page = { pageIndex: 1, pageSize: 1000 }) =>
    post("/trade/api/interface/queryProduct", page),
  queryStyle: (page = { pageIndex: 1, pageSize: 1000 }) =>
    post("/trade/api/interface/queryStyle", page),
  queryColor: (page = { pageIndex: 1, pageSize: 1000 }) =>
    post("/trade/api/interface/queryColor", page),
  querySize: (page = { pageIndex: 1, pageSize: 1000 }) =>
    post("/trade/api/interface/querySize", page),
  queryShipAddress: () =>
    post("/trade/api/interface/queryShipAddress", {}),

  // 11) 关闭订单
  closeOrder: (platformOid) =>
    post("/trade/api/interface/closeOrder", { platformOid }),

  // 12) 根据产品编码查可用发货地址
  queryProductShipAddress: (productCodeList) =>
    post("/trade/api/interface/queryProductShipAddress", { productCodeList }),

  // 13) 查询订单
  queryOrderInfo: (ids) =>
    post("/trade/api/interface/queryOrderInfo", { platformOidList: ids }),

  // 14) 修改订单图片
  updatePrintImage: (payload) =>
    post("/trade/api/interface/updatePrintImage", payload),

  // 15) 已发货订单地址脱敏
  maskAddress: (payload) =>
    post("/trade/api/interface/maskAddress", payload),

  // 16) 推送订单（下单后必须推送才会流转）
  pushOrder: (ids) =>
    post("/trade/api/interface/pushOrder", { platformOidList: ids }),

  // 17) 查询异常图片（可选）
  queryAbnormalImagePage: (params) =>
    post("/trade/api/interface/queryAbnormalImagePage", params),

  // 18) 上传异常图片并置为“已处理待同步”
  uploadAbnormalImage: (payload) =>
    post("/trade/api/interface/uploadAbnormalImage", payload),

  // 19) 同步异常图片处理到工厂
  syncImageToFactory: (ids) =>
    post("/trade/api/interface/syncImageToFactory", { ids }),

  // 20) 查询订单售后详情
  queryAfterSalesInfo: (platformOid) =>
    post("/trade/api/interface/queryAfterSalesInfo", { platformOid }),

  // 21) 申请售后
  createAfterSales: (payload) =>
    post("/trade/api/interface/createAfterSales", payload),
};
