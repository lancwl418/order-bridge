const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true,
});

function verifyShopifyJWT(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const payload = shopify.session.decodeSessionToken(token);
    // 可选：限制特定店铺
    req.shop = (payload.dest || '').replace(/^https:\/\//, '');
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or missing Shopify token' });
  }
}

module.exports = { verifyShopifyJWT };
