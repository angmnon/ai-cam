/** 主数据校验与查询入口 */
import { Controller, CuttingRule, Machine, Material, Tool } from "@ai-cam/domain-schemas";

import {
  MASTER_DATA_VERSION,
  seedControllers,
  seedCuttingRules,
  seedMachines,
  seedMaterials,
  seedTools,
} from "./seeds.js";

export * from "./seeds.js";

export interface MasterDataBundle {
  version: string;
  machines: Machine[];
  controllers: Controller[];
  tools: Tool[];
  materials: Material[];
  cutting_rules: CuttingRule[];
}

export function validateSeeds(): void {
  for (const m of seedMachines) Machine.parse(m);
  for (const c of seedControllers) Controller.parse(c);
  for (const t of seedTools) Tool.parse(t);
  for (const m of seedMaterials) Material.parse(m);
  for (const r of seedCuttingRules) CuttingRule.parse(r);
}

export function getMasterData(organizationId: string): MasterDataBundle {
  const filter = (id: string) => id === organizationId;
  return {
    version: MASTER_DATA_VERSION,
    machines: seedMachines.filter((m) => filter(m.organization_id)),
    controllers: seedControllers,
    tools: seedTools.filter((t) => filter(t.organization_id)),
    materials: seedMaterials.filter((m) => filter(m.organization_id)),
    cutting_rules: seedCuttingRules,
  };
}
