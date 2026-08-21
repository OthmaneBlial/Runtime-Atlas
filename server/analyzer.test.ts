import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeApplication, analyzeProject } from "./analyzer.js";

describe("static application analyzer", () => {
  const topology = analyzeApplication(
    path.resolve("server/demo-application.ts"),
  );

  it("discovers every instrumented runtime node", () => {
    expect(topology.nodes).toHaveLength(14);
    expect(
      topology.nodes
        .filter((node) => node.kind === "route")
        .map((node) => node.id),
    ).toEqual(["route.checkout", "route.search", "route.payment-failure"]);
    expect(
      topology.nodes.find((node) => node.id === "db.orders"),
    ).toMatchObject({
      label: "Orders DB",
      kind: "database",
      meta: { engine: "PostgreSQL", table: "orders" },
    });
  });

  it("derives call edges from handler ASTs", () => {
    const edges = new Set(topology.edges.map((edge) => edge.id));
    expect(edges).toContain("route.checkout->service.cart");
    expect(edges).toContain("route.checkout->service.pricing");
    expect(edges).toContain("service.cart->cache.redis-session");
    expect(edges).toContain("service.cart->db.catalog");
    expect(edges).toContain("service.checkout->external.payment");
    expect(topology.edges).toHaveLength(15);
  });

  it("attaches navigable source evidence", () => {
    for (const node of topology.nodes) {
      expect(node.source.file).toBe("server/demo-application.ts");
      expect(node.source.line).toBeGreaterThan(0);
      expect(node.symbol.length).toBeGreaterThan(0);
    }
  });

  it("links declarations across a configurable source glob", () => {
    const multiFile = analyzeProject([
      path.resolve("fixtures/multi-file/*.ts"),
    ]);
    expect(multiFile.nodes).toHaveLength(4);
    expect(multiFile.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "route.fixture-orders->service.fixture-orders",
        "service.fixture-orders->db.fixture-orders",
      ]),
    );
    expect(multiFile.edges).not.toContainEqual(
      expect.objectContaining({
        source: "route.fixture-orders",
        target: "service.decoy",
      }),
    );
  });
});
