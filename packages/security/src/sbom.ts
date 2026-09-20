/**
 * SBOM 生成（P5-7）：从 monorepo 工作区包清单生成 SPDX 风格的组件清单（JSON）。
 * v1：本仓库自研包 + 直接依赖（name/version/license 可从 package.json 提取，缺失标 unknown）。
 */
export interface SbomComponent {
  name: string;
  version: string;
  supplier: "internal" | "third-party";
  license: string;
  purl: string;
}

export interface Sbom {
  specVersion: string;
  documentName: string;
  components: SbomComponent[];
  dependencyGraph: Record<string, string[]>;
}

export interface PkgInfo {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
}

export function generateSbom(packages: PkgInfo[], options: { documentName?: string } = {}): Sbom {
  const components: SbomComponent[] = [];
  const dependencyGraph: Record<string, string[]> = {};
  for (const pkg of packages) {
    const isInternal = pkg.name.startsWith("@ai-cam/");
    components.push({
      name: pkg.name,
      version: pkg.version,
      supplier: isInternal ? "internal" : "third-party",
      license: pkg.license ?? "unknown",
      purl: `pkg:npm/${pkg.name.replace("@", "%40").replace("/", "/")}@${pkg.version}`,
    });
    dependencyGraph[pkg.name] = Object.keys(pkg.dependencies ?? {});
  }
  return { specVersion: "SPDX-2.3", documentName: options.documentName ?? "ai-cam-monorepo", components, dependencyGraph };
}

/** 汇总统计：内部/三方组件数、license 分布（供合规检查） */
export function summarize(sbom: Sbom): { internal: number; third_party: number; unknown_license: number; licenses: Record<string, number> } {
  const licenses: Record<string, number> = {};
  let internal = 0;
  let third = 0;
  let unknown = 0;
  for (const c of sbom.components) {
    if (c.supplier === "internal") internal += 1;
    else third += 1;
    if (c.license === "unknown") unknown += 1;
    licenses[c.license] = (licenses[c.license] ?? 0) + 1;
  }
  return { internal, third_party: third, unknown_license: unknown, licenses };
}
