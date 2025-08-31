// 轻量 JWT 校验：仅依赖 SHOPIFY_API_SECRET（可选校验 aud==SHOPIFY_API_KEY）
const jwt = require('jsonwebtoken');

function verifyShopifyJWT(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const payload = jwt.verify(token, process.env.SHOPIFY_API_SECRET, {
      algorithms: ['HS256'],
    });

    // 可选：若你配置了 SHOPIFY_API_KEY，则校验 aud
    if (process.env.SHOPIFY_API_KEY && payload.aud && payload.aud !== process.env.SHOPIFY_API_KEY) {
      return res.status(401).json({ error: 'Bad audience' });
    }

    req.shop = String(payload.dest || '').replace(/^https?:\/\//, '');
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { verifyShopifyJWT };
