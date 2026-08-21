import { AtlasBuilder, type AtlasRuntime } from "./runtime.js";

export interface DemoApplication {
  checkoutRoute: () => Promise<unknown>;
  searchRoute: () => Promise<unknown>;
  paymentFailureRoute: () => Promise<unknown>;
}

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createDemoApplication(runtime: AtlasRuntime): DemoApplication {
  const atlas = new AtlasBuilder(runtime);

  const sessionGuard = atlas.middleware(
    {
      id: "middleware.session",
      label: "Session guard",
      description:
        "Authenticates the bearer session and attaches the customer context.",
      meta: { layer: "edge", policy: "signed cookie" },
    },
    async () => {
      await wait(28);
      return { customerId: "cus_atlas_84" };
    },
  );

  const rateLimit = atlas.middleware(
    {
      id: "middleware.rate-limit",
      label: "Rate limit",
      description:
        "Applies the checkout burst policy before expensive work begins.",
      meta: { layer: "edge", window: "60s" },
    },
    async () => {
      await wait(16);
      return { remaining: 47 };
    },
  );

  const redisSession = atlas.cache(
    {
      id: "cache.redis-session",
      label: "Redis / sessions",
      description: "Loads the current shopping cart from the session cache.",
      meta: { engine: "Redis", operation: "GET cart:*" },
    },
    async () => {
      await wait(42);
      return { items: 3, subtotal: 128.4 };
    },
  );

  const productDatabase = atlas.database(
    {
      id: "db.catalog",
      label: "Catalog DB",
      description: "Reads product availability and warehouse allocation.",
      meta: { engine: "PostgreSQL", table: "inventory" },
    },
    async () => {
      await wait(76);
      return { reserved: true, warehouse: "eu-west-3" };
    },
  );

  const orderDatabase = atlas.database(
    {
      id: "db.orders",
      label: "Orders DB",
      description: "Commits the paid order and its immutable audit row.",
      meta: { engine: "PostgreSQL", table: "orders" },
    },
    async () => {
      await wait(88);
      return { orderId: "ord_demo_atlas" };
    },
  );

  const taxProvider = atlas.external(
    {
      id: "external.tax",
      label: "Tax service",
      description: "Calculates destination tax through an external HTTP API.",
      meta: { provider: "TaxJar", protocol: "HTTPS" },
    },
    async () => {
      await wait(112);
      return { tax: 10.27 };
    },
  );

  const paymentProvider = atlas.external(
    {
      id: "external.payment",
      label: "Payment API",
      description: "Authorizes the card payment with the external processor.",
      meta: { provider: "Stripe", protocol: "HTTPS" },
    },
    async (mode: "ok" | "fail" = "ok") => {
      await wait(148);
      if (mode === "fail") throw new Error("Simulated payment provider outage");
      return { paymentId: "pi_demo_atlas", authorized: true };
    },
  );

  const fulfillmentQueue = atlas.queue(
    {
      id: "queue.fulfillment",
      label: "Fulfillment",
      description: "Publishes an order-ready event for warehouse workers.",
      meta: { broker: "Kafka", topic: "order.created" },
    },
    async () => {
      await wait(44);
      return { partition: 4 };
    },
  );

  const cartService = atlas.service(
    {
      id: "service.cart",
      label: "Cart service",
      description:
        "Hydrates the cart and verifies that every item can be fulfilled.",
      meta: { owner: "commerce" },
    },
    async () => {
      const [cart, inventory] = await Promise.all([
        redisSession(),
        productDatabase(),
      ]);
      return { ...cart, ...inventory };
    },
  );

  const pricingService = atlas.service(
    {
      id: "service.pricing",
      label: "Pricing service",
      description:
        "Combines promotions and destination tax into a final total.",
      meta: { owner: "revenue" },
    },
    async () => {
      const tax = await taxProvider();
      await wait(34);
      return { total: 138.67, ...tax };
    },
  );

  const checkoutService = atlas.service(
    {
      id: "service.checkout",
      label: "Checkout service",
      description:
        "Coordinates payment, persistence, and asynchronous fulfillment.",
      meta: { owner: "commerce" },
    },
    async () => {
      const payment = await paymentProvider();
      const order = await orderDatabase();
      await fulfillmentQueue();
      return { ...payment, ...order };
    },
  );

  const checkoutRoute = atlas.route(
    {
      id: "route.checkout",
      label: "POST /checkout",
      description:
        "Public checkout endpoint receiving the request shown on the atlas.",
      meta: { method: "POST", path: "/api/demo/checkout" },
    },
    async () => {
      await sessionGuard();
      await rateLimit();
      const [cart, pricing] = await Promise.all([
        cartService(),
        pricingService(),
      ]);
      const order = await checkoutService();
      return { ok: true, cart, pricing, order };
    },
  );

  const searchRoute = atlas.route(
    {
      id: "route.search",
      label: "GET /search",
      description:
        "Catalog search endpoint sharing cache and catalog infrastructure.",
      meta: { method: "GET", path: "/api/demo/search" },
    },
    async () => {
      await rateLimit();
      const [cart, inventory] = await Promise.all([
        redisSession(),
        productDatabase(),
      ]);
      return { ok: true, results: cart.items * 4, inventory };
    },
  );

  const paymentFailureRoute = atlas.route(
    {
      id: "route.payment-failure",
      label: "POST /payment-failure",
      description:
        "Deterministic demo scenario showing a failed dependency propagating back through a request.",
      meta: { method: "POST", path: "/api/demo/failure" },
    },
    async () => paymentProvider("fail"),
  );

  return { checkoutRoute, searchRoute, paymentFailureRoute };
}
