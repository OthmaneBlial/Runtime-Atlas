import { AtlasBuilder, AtlasRuntime } from "./runtime.js";

export const runtime = new AtlasRuntime();
export const atlas = new AtlasBuilder(runtime);

const wait = (minimum: number, variance = 40) =>
  new Promise((resolve) => setTimeout(resolve, minimum + Math.random() * variance));

export const sessionGuard = atlas.middleware(
  {
    id: "middleware.session",
    label: "Session guard",
    description: "Authenticates the bearer session and attaches the customer context.",
    meta: { layer: "edge", policy: "signed cookie" },
  },
  async () => {
    await wait(24, 18);
    return { customerId: "cus_atlas_84" };
  },
);

export const rateLimit = atlas.middleware(
  {
    id: "middleware.rate-limit",
    label: "Rate limit",
    description: "Applies the checkout burst policy before expensive work begins.",
    meta: { layer: "edge", window: "60s" },
  },
  async () => {
    await wait(13, 12);
    return { remaining: 47 };
  },
);

export const redisSession = atlas.cache(
  {
    id: "cache.redis-session",
    label: "Redis / sessions",
    description: "Loads the current shopping cart from the session cache.",
    meta: { engine: "Redis", operation: "GET cart:*" },
  },
  async () => {
    await wait(31, 28);
    return { items: 3, subtotal: 128.4 };
  },
);

export const productDatabase = atlas.database(
  {
    id: "db.catalog",
    label: "Catalog DB",
    description: "Reads product availability and warehouse allocation.",
    meta: { engine: "PostgreSQL", table: "inventory" },
  },
  async () => {
    await wait(58, 42);
    return { reserved: true, warehouse: "eu-west-3" };
  },
);

export const orderDatabase = atlas.database(
  {
    id: "db.orders",
    label: "Orders DB",
    description: "Commits the paid order and its immutable audit row.",
    meta: { engine: "PostgreSQL", table: "orders" },
  },
  async () => {
    await wait(68, 30);
    return { orderId: `ord_${Date.now().toString(36)}` };
  },
);

export const taxProvider = atlas.external(
  {
    id: "external.tax",
    label: "Tax service",
    description: "Calculates destination tax through an external HTTP API.",
    meta: { provider: "TaxJar", protocol: "HTTPS" },
  },
  async () => {
    await wait(91, 75);
    return { tax: 10.27 };
  },
);

export const paymentProvider = atlas.external(
  {
    id: "external.payment",
    label: "Payment API",
    description: "Authorizes the card payment with the external processor.",
    meta: { provider: "Stripe", protocol: "HTTPS" },
  },
  async () => {
    await wait(126, 90);
    return { paymentId: "pi_live_atlas", authorized: true };
  },
);

export const fulfillmentQueue = atlas.queue(
  {
    id: "queue.fulfillment",
    label: "Fulfillment",
    description: "Publishes an order-ready event for warehouse workers.",
    meta: { broker: "Kafka", topic: "order.created" },
  },
  async () => {
    await wait(36, 24);
    return { partition: 4 };
  },
);

export const cartService = atlas.service(
  {
    id: "service.cart",
    label: "Cart service",
    description: "Hydrates the cart and verifies that every item can be fulfilled.",
    meta: { owner: "commerce" },
  },
  async () => {
    const [cart, inventory] = await Promise.all([redisSession(), productDatabase()]);
    return { ...cart, ...inventory };
  },
);

export const pricingService = atlas.service(
  {
    id: "service.pricing",
    label: "Pricing service",
    description: "Combines promotions and destination tax into a final total.",
    meta: { owner: "revenue" },
  },
  async () => {
    const tax = await taxProvider();
    await wait(28, 18);
    return { total: 138.67, ...tax };
  },
);

export const checkoutService = atlas.service(
  {
    id: "service.checkout",
    label: "Checkout service",
    description: "Coordinates payment, persistence, and asynchronous fulfillment.",
    meta: { owner: "commerce" },
  },
  async () => {
    const payment = await paymentProvider();
    const order = await orderDatabase();
    await fulfillmentQueue();
    return { ...payment, ...order };
  },
);

export const checkoutRoute = atlas.route(
  {
    id: "route.checkout",
    label: "POST /checkout",
    description: "Public checkout endpoint receiving the request shown on the atlas.",
    meta: { method: "POST", path: "/api/demo/checkout" },
  },
  async () => {
    await sessionGuard();
    await rateLimit();
    const [cart, pricing] = await Promise.all([cartService(), pricingService()]);
    const order = await checkoutService();
    return { ok: true, cart, pricing, order };
  },
);

export const searchRoute = atlas.route(
  {
    id: "route.search",
    label: "GET /search",
    description: "Catalog search endpoint sharing cache and catalog infrastructure.",
    meta: { method: "GET", path: "/api/demo/search" },
  },
  async () => {
    await rateLimit();
    const [cart, inventory] = await Promise.all([redisSession(), productDatabase()]);
    return { ok: true, results: cart.items * 4, inventory };
  },
);
