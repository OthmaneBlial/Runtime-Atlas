import {
  Boxes,
  Cable,
  Database,
  Globe2,
  HardDrive,
  RadioTower,
  Route,
  ShieldCheck,
} from "lucide-react";
import type { NodeKind } from "../types";

const ICONS = {
  route: Route,
  middleware: ShieldCheck,
  service: Boxes,
  database: Database,
  cache: HardDrive,
  external: Globe2,
  queue: RadioTower,
} satisfies Record<NodeKind, typeof Cable>;

export function KindIcon({ kind, size = 16 }: { kind: NodeKind; size?: number }) {
  const Icon = ICONS[kind];
  return <Icon aria-hidden="true" size={size} strokeWidth={1.7} />;
}
