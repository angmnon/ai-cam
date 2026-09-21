/**
 * NC Validator 四层校验（P3-7）：
 * L1 Parser：NC 文本语法（未知代码/非法数值/行结构）
 * L2 Semantic：程序完整性（头/尾/单位/模态）+ 与 CAM IR 一致（主轴/进给/换刀/运动点）
 * L3 Machine：机床/控制器限制（主轴上限/进给上限/行程）
 * L4 Simulation：NC 运动点 vs 仿真报告一致性 + 仿真无碰撞
 */
import type { CamIR, ToolpathIR } from "@ai-cam/cam-ir";
import { seedMachines } from "@ai-cam/master-data";
import { parseNc, type ParsedNc } from "./parser.js";
import type { SimulationReport } from "@ai-cam/stock-sim";

export const NC_VALIDATOR_VERSION = "0.1.0";

export type LayerName = "PARSER" | "SEMANTIC" | "MACHINE" | "SIMULATION";
export type Severity = "INFO" | "WARN" | "ERROR";

export interface Check {
  code: string;
  severity: Severity;
  message: string;
  layer: LayerName;
  line?: number;
}

export interface LayerResult {
  layer: LayerName;
  status: "PASS" | "WARN" | "FAIL";
  checks: Check[];
}

export interface ValidationReport {
  schema_version: "1.0.0";
  report_id: string;
  nc_program: string;
  ir_id: string;
  job_id: string;
  part_id: string;
  validator_version: string;
  status: "PASS" | "WARN" | "FAIL";
  layers: LayerResult[];
}

const TOL = 1e-2;

/**
 * P1-09：IR move.type → 期望 NC G 代码映射（与 post-core emitMove 一致）。
 * RAPID→G00；RETRACT→G00（post.ts 退刀按快速输出）；LINEAR/PLUNGE→G01；
 * ARC_CW→G02；ARC_CCW→G03。post 把 RAPID 错写成 G01 即触发 MOTION_TYPE_MISMATCH。
 */
function irTypeToG(t: string): string {
  switch (t) {
    case "RAPID":
      return "G00";
    case "RETRACT":
      return "G00";
    case "ARC_CW":
      return "G02";
    case "ARC_CCW":
      return "G03";
    case "LINEAR":
    case "PLUNGE":
    default:
      return "G01";
  }
}

export function validateNc(input: {
  cam: CamIR;
  ncText: string;
  programNumber: string;
  simulation?: SimulationReport;
}): ValidationReport {
  const { cam, ncText, programNumber } = input;
  const parsed: ParsedNc = parseNc(ncText);
  const checks: Check[] = [];
  const layers: LayerResult[] = [];

  // ---------- L1 Parser ----------
  const l1: Check[] = parsed.errors.map((e) => ({ code: "PARSE_ERROR", severity: "ERROR", message: e.message, layer: "PARSER", line: e.lineNo }));
  if (!parsed.programNumber) l1.push({ code: "NO_PROGRAM_NUMBER", severity: "ERROR", message: "缺少程序号 Oxxxx", layer: "PARSER" });
  if (parsed.programNumber !== programNumber.replace(/^O/, "")) l1.push({ code: "PROGRAM_NUMBER_MISMATCH", severity: "WARN", message: `程序号 ${parsed.programNumber} 与预期 ${programNumber} 不一致`, layer: "PARSER" });
  // 行号递增
  const lineNums = parsed.lines.filter((l) => l.words.some((w) => w.key === "N")).map((l) => Number(l.words.find((w) => w.key === "N")!.value));
  for (let i = 1; i < lineNums.length; i++) {
    if (lineNums[i] <= lineNums[i - 1]) l1.push({ code: "LINE_NUMBER_ORDER", severity: "ERROR", message: `行号未递增: ${lineNums[i]} ≤ ${lineNums[i - 1]}`, layer: "PARSER" });
  }
  layers.push({ layer: "PARSER", status: l1.some((c) => c.severity === "ERROR") ? "FAIL" : l1.some((c) => c.severity === "WARN") ? "WARN" : "PASS", checks: l1 });
  checks.push(...l1);

  // ---------- L2 Semantic ----------
  const l2: Check[] = [];
  const text = ncText;
  if (!/G21/.test(text)) l2.push({ code: "NO_METRIC", severity: "ERROR", message: "缺少 G21 公制单位", layer: "SEMANTIC" });
  if (!/G90/.test(text)) l2.push({ code: "NO_ABSOLUTE", severity: "ERROR", message: "缺少 G90 绝对坐标", layer: "SEMANTIC" });
  if (!/G17/.test(text)) l2.push({ code: "NO_XY_PLANE", severity: "WARN", message: "缺少 G17 平面选择", layer: "SEMANTIC" });
  if (!/M30/.test(text)) l2.push({ code: "NO_M30", severity: "ERROR", message: "缺少程序结束 M30", layer: "SEMANTIC" });
  // IR 一致性：每 op 主轴
  const toolpaths = new Map<string, ToolpathIR>((cam.toolpaths ?? []).map((tp) => [tp.operation_id, tp]));
  // P2-25：主轴校验改为基于解析行的 G/M 字匹配——遍历解析后的行，
  // 跳过括号/分号整行注释并剥离行内括号/分号注释；区分 M03 正转 / M04 反转。
  // 不再用全文本正则扫描（注释里的 M03/S 不再误命中）。
  const spindleCmds: Array<{ dir: "M03" | "M04"; s: number | null; lineNo: number }> = [];
  for (const line of parsed.lines) {
    if (/^\s*[;(%]/.test(line.raw)) continue; // 整行注释（括号/分号）或 % 行
    const codeOnly = line.raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, ""); // 剥离行内注释
    const sMatch = /S([+-]?(?:\d+\.?\d*|\.\d+))/.exec(codeOnly);
    const s = sMatch ? Number(sMatch[1]) : null;
    for (const m of codeOnly.match(/M\d{2}/g) ?? []) {
      if (m === "M03" || m === "M04") spindleCmds.push({ dir: m as "M03" | "M04", s, lineNo: line.lineNo });
    }
  }
  for (const op of cam.operations) {
    if (!toolpaths.has(op.id)) continue;
    const s = Math.round(op.parameters.spindle_speed_rpm);
    // IR 主轴转速恒为正 → 期望正转 M03；M04 为反转，方向不符不计数
    const found = spindleCmds.some((c) => c.dir === "M03" && c.s === s);
    if (!found) l2.push({ code: "SPINDLE_MISMATCH", severity: "ERROR", message: `op ${op.id} 正转主轴 M03 S${s}rpm 未在 NC 代码行中找到（M04 为反转，注释行不计）`, layer: "SEMANTIC" });
  }
  // NC 运动点 vs IR 点序列（确定性生成应完全一致）；P1-09 同时比对 G 代码类型
  const ncPts = parsed.points.map((p) => ({ x: p.x, y: p.y, z: p.z, g: p.g }));
  const irPts: Array<{ x: number; y: number; z: number; g: string }> = [];
  for (const op of cam.operations) {
    const tp = toolpaths.get(op.id);
    if (tp) for (const m of tp.moves) irPts.push({ x: m.x, y: m.y, z: m.z, g: irTypeToG(m.type) });
  }
  if (ncPts.length !== irPts.length) {
    l2.push({ code: "POINT_COUNT_MISMATCH", severity: "ERROR", message: `NC 运动点数 ${ncPts.length} ≠ IR ${irPts.length}`, layer: "SEMANTIC" });
  } else {
    let diff = 0;
    let typeDiff = 0;
    for (let i = 0; i < ncPts.length; i++) {
      const d = Math.hypot(ncPts[i].x - irPts[i].x, ncPts[i].y - irPts[i].y, ncPts[i].z - irPts[i].z);
      if (d > TOL) diff++;
      if (ncPts[i].g !== irPts[i].g) typeDiff++;
    }
    if (diff > 0) l2.push({ code: "POINT_SEQUENCE_MISMATCH", severity: "ERROR", message: `${diff}/${ncPts.length} 个运动点与 IR 不一致`, layer: "SEMANTIC" });
    if (typeDiff > 0) l2.push({ code: "MOTION_TYPE_MISMATCH", severity: "ERROR", message: `${typeDiff}/${ncPts.length} 个运动点 G 代码类型与 IR 不一致（RAPID/LINEAR/PLUNGE/RETRACT/ARC 映射）`, layer: "SEMANTIC" });
  }
  layers.push({ layer: "SEMANTIC", status: l2.some((c) => c.severity === "ERROR") ? "FAIL" : l2.some((c) => c.severity === "WARN") ? "WARN" : "PASS", checks: l2 });
  checks.push(...l2);

  // ---------- L3 Machine ----------
  const l3: Check[] = [];
  const machine = seedMachines.find((m) => m.id === cam.machine.machine_id);
  const maxRpm = machine?.kinematics.max_spindle_rpm ?? 10000;
  const maxFeed = machine?.kinematics.max_feed_mm_min ?? 12000;
  for (const op of cam.operations) {
    if (op.parameters.spindle_speed_rpm > maxRpm) l3.push({ code: "SPINDLE_OVER_LIMIT", severity: "ERROR", message: `op ${op.id} 主轴 ${op.parameters.spindle_speed_rpm} > 机床上限 ${maxRpm}`, layer: "MACHINE" });
    const f = op.parameters.feed_mm_min;
    if (f > maxFeed) l3.push({ code: "FEED_OVER_LIMIT", severity: "ERROR", message: `op ${op.id} 进给 ${f} > 机床上限 ${maxFeed}`, layer: "MACHINE" });
  }
  // 行程：NC 坐标在机床 travel 内（P1-10：优先 min/max 区间；无区间字段时对称假设 [-t,+t] 并降级提示）
  const travel = machine?.kinematics.travel as (Record<string, number | undefined> | undefined);
  if (travel) {
    type Axis = "x" | "y" | "z";
    const axes: Axis[] = ["x", "y", "z"];
    const bounds = {} as Record<Axis, { min: number; max: number }>;
    let symmetricFallback = false;
    for (const axis of axes) {
      const mag = travel[axis];
      const lo = travel[`min${axis.toUpperCase()}`];
      const hi = travel[`max${axis.toUpperCase()}`];
      if (typeof lo === "number" && Number.isFinite(lo) && typeof hi === "number" && Number.isFinite(hi)) {
        bounds[axis] = { min: lo, max: hi };
      } else if (typeof mag === "number" && Number.isFinite(mag) && mag > 0) {
        bounds[axis] = { min: -mag, max: mag };
        symmetricFallback = true;
      } else {
        bounds[axis] = { min: -Infinity, max: Infinity };
      }
    }
    // 降级检查：seed 机床 travel 仅给对称行程量，未提供 min/max 区间（INFO，不翻转 PASS 门禁）
    if (symmetricFallback) {
      l3.push({ code: "TRAVEL_SYMMETRIC_ASSUMPTION", severity: "INFO", message: "机床 travel 无 min/max 区间字段，按对称假设 [-t,+t] 判定行程（P1-10 降级检查）", layer: "MACHINE" });
    }
    for (const p of parsed.points) {
      const outOf = (axis: Axis): boolean => p[axis] < bounds[axis].min || p[axis] > bounds[axis].max;
      if (outOf("x") || outOf("y") || outOf("z")) {
        l3.push({ code: "TRAVEL_EXCEEDED", severity: "ERROR", message: `NC 点 (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) 超出机床行程 X[${bounds.x.min},${bounds.x.max}] Y[${bounds.y.min},${bounds.y.max}] Z[${bounds.z.min},${bounds.z.max}]`, layer: "MACHINE" });
        break;
      }
    }
  }
  // P2-26：机床不在种子库时 L3 限制检查静默降级，必须把"降级事实"写入 report
  // （WARN，code=MACHINE_NOT_IN_SEED），避免静默放行导致超限限制被遗漏。
  if (!machine) l3.push({ code: "MACHINE_NOT_IN_SEED", severity: "WARN", message: `机床 ${cam.machine.machine_id} 不在种子库，L3 主轴/进给/行程限制检查按默认上限降级（P2-26）`, layer: "MACHINE" });
  layers.push({ layer: "MACHINE", status: l3.some((c) => c.severity === "ERROR") ? "FAIL" : l3.some((c) => c.severity === "WARN") ? "WARN" : "PASS", checks: l3 });
  checks.push(...l3);

  // ---------- L4 Simulation ----------
  const l4: Check[] = [];
  if (input.simulation) {
    const sim = input.simulation;
    l4.push({ code: "SIM_STATUS", severity: sim.status === "FAIL" ? "ERROR" : sim.status === "WARN" ? "WARN" : "INFO", message: `仿真状态 ${sim.status}`, layer: "SIMULATION" });
    for (const e of sim.events) {
      if (e.kind === "COLLISION" || e.kind === "GOUGE") l4.push({ code: `SIM_${e.kind}`, severity: "ERROR", message: e.message, layer: "SIMULATION" });
    }
  } else {
    // P1-08：未提供仿真报告由 WARN 软门禁升级为 ERROR 硬门禁，L4 必 FAIL、整体 FAIL
    l4.push({ code: "SIM_NOT_PROVIDED", severity: "ERROR", message: "未提供仿真报告，L4 仿真门禁失败（P1-08 软门禁升级为硬门禁）", layer: "SIMULATION" });
  }
  layers.push({ layer: "SIMULATION", status: l4.some((c) => c.severity === "ERROR") ? "FAIL" : l4.some((c) => c.severity === "WARN") ? "WARN" : "PASS", checks: l4 });
  checks.push(...l4);

  const hasError = checks.some((c) => c.severity === "ERROR");
  const hasWarn = checks.some((c) => c.severity === "WARN");
  return {
    schema_version: "1.0.0",
    report_id: `val_${cam.part_id}_${NC_VALIDATOR_VERSION}`,
    nc_program: programNumber,
    ir_id: cam.ir_id,
    job_id: cam.job_id,
    part_id: cam.part_id,
    validator_version: NC_VALIDATOR_VERSION,
    status: hasError ? "FAIL" : hasWarn ? "WARN" : "PASS",
    layers,
  };
}
