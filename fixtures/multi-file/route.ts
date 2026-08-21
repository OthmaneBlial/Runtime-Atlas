import { ordersService } from "./orders.js";

declare const atlas: {
  route: (
    descriptor: object,
    handler: () => Promise<unknown>,
  ) => () => Promise<unknown>;
};

export const ordersRoute = atlas.route(
  { id: "route.fixture-orders", label: "POST /fixture-orders" },
  async () => ordersService(),
);
