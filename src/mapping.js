function mapOrderToRiin(order) {
    const platformOid = String(order.id);
    const ship = order.shipping_address || {};
    const toTs = s => new Date(s ?? Date.now()).toISOString().slice(0,19).replace("T"," ");
    const goodsList = (order.line_items || []).map((li, i) => {
      const parts = (li.variant_title || "").split("/").map(s => s.trim());
      const colorCode = parts[0] || "BLACK";
      const sizeCode  = parts[1] || "L";
      const styleCode = li.sku || "STYLE001";
      const printPng  = li.properties?.find(p => p?.name === "print_png_url")?.value || (li.image?.src || "");
      return {
        platformOid, platformOllId: `${platformOid}-${i+1}`, goodsType: 1,
        title: li.title, specification: li.variant_title || "",
        goodsStatus: "NOT_SHIPPED", refundStatus: "NO_REFUND",
        sizeCode, sizeName: sizeCode, colorCode, colorName: colorCode,
        styleCode, styleName: styleCode, craftType: 1, num: li.quantity,
        platformSpuId: String(li.product_id || ""), platformSkuId: String(li.variant_id || ""),
        imageList: [
          { type:1, imageUrl:printPng, imageCode:`${platformOid}-${li.id}-P`, imageName:`${platformOid}-${li.id}-P` },
          { type:2, imageUrl:li.image?.src||"", imageCode:`${platformOid}-${li.id}-M`, imageName:`${platformOid}-${li.id}-M` }
        ]
      };
    });
    return {
      platformType: 15, sourcePlatformOid: platformOid,
      platformOrderStatus: "NOT_SHIPPED", platformRefundStatus: "NO_REFUND",
      platformOid,
      consigneeName: `${ship.first_name||""} ${ship.last_name||""}`.trim() || order.customer?.first_name || "Unknown",
      phone: ship.phone || order.phone || "",
      address: [ship.address1, ship.address2].filter(Boolean).join(", "),
      receiverCountry: ship.country_code || ship.country || "US",
      receiverProvince: ship.province || "", receiverCity: ship.city || "",
      postCode: ship.zip || "",
      orderPayTime: toTs(order.processed_at || order.created_at),
      orderTime: toTs(order.created_at),
      goodsList
    };
  }
  module.exports = { mapOrderToRiin };
  