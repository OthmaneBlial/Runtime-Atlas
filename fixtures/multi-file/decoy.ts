declare const atlas: {
  service: (descriptor: object, handler: () => Promise<unknown>) => () => Promise<unknown>;
};

// Intentionally duplicates the imported symbol name in orders.ts. The analyzer
// must follow route.ts's import rather than guessing from a global name map.
export const ordersService = atlas.service(
  { id: "service.decoy", label: "Decoy service" },
  async () => ({ decoy: true }),
);
