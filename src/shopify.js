const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_API_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";

async function rest(path, init = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${VERSION}/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}
module.exports = { shopifyRest: rest, shopifyGql: gql };
