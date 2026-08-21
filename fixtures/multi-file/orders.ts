declare const atlas: {
  database: (
    descriptor: object,
    handler: () => Promise<unknown>,
  ) => () => Promise<unknown>;
  service: (
    descriptor: object,
    handler: () => Promise<unknown>,
  ) => () => Promise<unknown>;
};

export const ordersDatabase = atlas.database(
  {
    id: "db.fixture-orders",
    label: "Fixture orders",
    meta: { engine: "PostgreSQL" },
  },
  async () => ({ id: 42 }),
);

export const ordersService = atlas.service(
  { id: "service.fixture-orders", label: "Fixture service" },
  async () => ordersDatabase(),
);
