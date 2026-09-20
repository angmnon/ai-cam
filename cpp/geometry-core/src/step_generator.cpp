/**
 * step_generator — 生成 Phase 1 Golden 样本（AP203 STEP）
 *
 * 用法：step_generator <out-dir>
 * 生成：box / plate_with_hole / plate_with_blind_hole / pocket_block /
 *       slot_block / boss_block / stepped_block / circular_plate
 * 全部由 OCCT BRep 原语生成，保证 STEP 合法，供 geometry_worker 与 Golden 回归使用。
 */
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <Interface_Static.hxx>
#include <STEPControl_StepModelType.hxx>
#include <STEPControl_Writer.hxx>

#include <TopoDS_Shape.hxx>
#include <TopoDS_Solid.hxx>

#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>

namespace fs = std::filesystem;

namespace {

bool writeStep(const TopoDS_Shape& shape, const std::string& path, const std::string& name) {
  STEPControl_Writer writer;
  IFSelect_ReturnStatus st = writer.Transfer(shape, STEPControl_AsIs);
  if (st != IFSelect_RetDone) {
    std::cerr << "transfer failed for " << name << std::endl;
    return false;
  }
  st = writer.Write(path.c_str());
  if (st != IFSelect_RetDone) {
    std::cerr << "write failed for " << name << std::endl;
    return false;
  }
  return true;
}

void moveBy(TopoDS_Shape& shape, double dx, double dy, double dz) {
  gp_Trsf tr;
  tr.SetTranslation(gp_Vec(dx, dy, dz));
  shape.Move(tr);
}

void rotateBy(TopoDS_Shape& shape, double px, double py, double pz, double angleDeg, double ax, double ay, double az) {
  gp_Trsf tr;
  tr.SetRotation(gp_Ax1(gp_Pnt(px, py, pz), gp_Dir(ax, ay, az)), angleDeg * M_PI / 180.0);
  shape.Move(tr);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: step_generator <out-dir>" << std::endl;
    return 2;
  }
  fs::create_directories(argv[1]);

  // 收紧 STEP 写出精度，避免 bbox 因写出公差扩张（默认 ~0.05mm）
  Interface_Static::SetRVal("write.precision", 1e-5);

  bool ok = true;

  // 1) box.step — 80x50x30 六面体
  {
    TopoDS_Shape s = BRepPrimAPI_MakeBox(80, 50, 30).Shape();
    ok &= writeStep(s, (fs::path(argv[1]) / "box.step").string(), "box");
  }

  // 2) plate_with_hole.step — 100x60x15 板 + Ø20 通孔（BRepAlgoAPI_Cut）
  {
    TopoDS_Shape plate = BRepPrimAPI_MakeBox(100, 60, 15).Shape();
    TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(10, 20).Shape();
    moveBy(hole, 30, 30, -2.5);
    ok &= writeStep(BRepAlgoAPI_Cut(plate, hole).Shape(), (fs::path(argv[1]) / "plate_with_hole.step").string(), "plate_with_hole");
  }

  // 3) plate_with_blind_hole.step — 100x60x15 板 + Ø16 盲孔深 12（孔底 z=3）
  {
    TopoDS_Shape plate = BRepPrimAPI_MakeBox(100, 60, 15).Shape();
    TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(8, 12).Shape();
    moveBy(hole, 25, 25, 3);
    ok &= writeStep(BRepAlgoAPI_Cut(plate, hole).Shape(), (fs::path(argv[1]) / "plate_with_blind_hole.step").string(), "plate_with_blind_hole");
  }

  // 4) pocket_block.step — 90x60x25 基体 + 中央 40x24x12 口袋（底 z=13）
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(90, 60, 25).Shape();
    TopoDS_Shape pocket = BRepPrimAPI_MakeBox(40, 24, 14).Shape();
    moveBy(pocket, 25, 18, 13);
    ok &= writeStep(BRepAlgoAPI_Cut(base, pocket).Shape(), (fs::path(argv[1]) / "pocket_block.step").string(), "pocket_block");
  }

  // 5) slot_block.step — 80x50x20 基体 + 贯通长槽 82x12x10（±X 开放，底 z=10）
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(80, 50, 20).Shape();
    TopoDS_Shape slot = BRepPrimAPI_MakeBox(82, 12, 10).Shape();
    moveBy(slot, -1, 19, 10);
    ok &= writeStep(BRepAlgoAPI_Cut(base, slot).Shape(), (fs::path(argv[1]) / "slot_block.step").string(), "slot_block");
  }

  // 6) boss_block.step — 70x50x20 基体 + 上凸台 30x24x12
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(70, 50, 20).Shape();
    TopoDS_Shape boss = BRepPrimAPI_MakeBox(30, 24, 12).Shape();
    moveBy(boss, 20, 13, 20);
    ok &= writeStep(BRepAlgoAPI_Fuse(base, boss).Shape(), (fs::path(argv[1]) / "boss_block.step").string(), "boss_block");
  }

  // 7) stepped_block.step — 阶梯件（下 80x40x15，上 50x30x10，共 25 高）
  {
    TopoDS_Shape lower = BRepPrimAPI_MakeBox(80, 40, 15).Shape();
    TopoDS_Shape upper = BRepPrimAPI_MakeBox(50, 30, 10).Shape();
    moveBy(upper, 15, 5, 15);
    ok &= writeStep(BRepAlgoAPI_Fuse(lower, upper).Shape(), (fs::path(argv[1]) / "stepped_block.step").string(), "stepped_block");
  }

  // 8) circular_plate.step — Ø80 x 20 圆盘 + Ø30 通孔
  {
    TopoDS_Shape disc = BRepPrimAPI_MakeCylinder(40, 20).Shape();
    TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(15, 30).Shape();
    moveBy(hole, 0, 0, -5);
    ok &= writeStep(BRepAlgoAPI_Cut(disc, hole).Shape(), (fs::path(argv[1]) / "circular_plate.step").string(), "circular_plate");
  }

  // 9) plate_4holes.step — 100x60x15 板 + 4xØ10 通孔（2x2 阵列）
  {
    TopoDS_Shape plate = BRepPrimAPI_MakeBox(100, 60, 15).Shape();
    TopoDS_Shape s = plate;
    for (const double cx : {20.0, 80.0}) {
      for (const double cy : {20.0, 40.0}) {
        TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(5, 20).Shape();
        moveBy(hole, cx, cy, -2.5);
        s = BRepAlgoAPI_Cut(s, hole).Shape();
      }
    }
    ok &= writeStep(s, (fs::path(argv[1]) / "plate_4holes.step").string(), "plate_4holes");
  }

  // 10) counterbore_block.step — 80x50x20 块 + Ø20 沉头深 8 + Ø10 通孔
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(80, 50, 20).Shape();
    TopoDS_Shape cbore = BRepPrimAPI_MakeCylinder(10, 8).Shape();
    moveBy(cbore, 40, 25, 12);
    TopoDS_Shape through = BRepPrimAPI_MakeCylinder(5, 20).Shape();
    moveBy(through, 40, 25, -2.5);
    TopoDS_Shape s = BRepAlgoAPI_Cut(base, cbore).Shape();
    s = BRepAlgoAPI_Cut(s, through).Shape();
    ok &= writeStep(s, (fs::path(argv[1]) / "counterbore_block.step").string(), "counterbore_block");
  }

  // 11) two_step_block.step — 三级台阶（下 80x40x10、中 60x30x10、上 40x20x10）
  {
    TopoDS_Shape lower = BRepPrimAPI_MakeBox(80, 40, 10).Shape();
    TopoDS_Shape mid = BRepPrimAPI_MakeBox(60, 30, 10).Shape();
    moveBy(mid, 10, 5, 10);
    TopoDS_Shape upper = BRepPrimAPI_MakeBox(40, 20, 10).Shape();
    moveBy(upper, 20, 10, 20);
    TopoDS_Shape s = BRepAlgoAPI_Fuse(lower, mid).Shape();
    s = BRepAlgoAPI_Fuse(s, upper).Shape();
    ok &= writeStep(s, (fs::path(argv[1]) / "two_step_block.step").string(), "two_step_block");
  }

  // 12) l_bracket.step — L 形支架（底座 80x60x15 + 立板 40x60x15）
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(80, 60, 15).Shape();
    TopoDS_Shape upright = BRepPrimAPI_MakeBox(40, 60, 15).Shape();
    moveBy(upright, 40, 0, 15);
    ok &= writeStep(BRepAlgoAPI_Fuse(base, upright).Shape(), (fs::path(argv[1]) / "l_bracket.step").string(), "l_bracket");
  }

  // 13) ring.step — 厚壁圆环 Ø80 外径 x Ø40 内径 x 20 高
  {
    TopoDS_Shape disc = BRepPrimAPI_MakeCylinder(40, 20).Shape();
    TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(20, 30).Shape();
    moveBy(hole, 0, 0, -5);
    ok &= writeStep(BRepAlgoAPI_Cut(disc, hole).Shape(), (fs::path(argv[1]) / "ring.step").string(), "ring");
  }

  // 14) flange.step — 法兰 Ø100x15 + Ø20 中心孔 + 4xØ8 螺栓孔
  {
    TopoDS_Shape disc = BRepPrimAPI_MakeCylinder(50, 15).Shape();
    TopoDS_Shape s = BRepAlgoAPI_Cut(disc, [] {
      TopoDS_Shape h = BRepPrimAPI_MakeCylinder(10, 25).Shape();
      moveBy(h, 0, 0, -5);
      return h;
    }()).Shape();
    for (const double a : {0.0, 90.0, 180.0, 270.0}) {
      TopoDS_Shape bolt = BRepPrimAPI_MakeCylinder(4, 25).Shape();
      moveBy(bolt, 35 * cos(a * M_PI / 180.0), 35 * sin(a * M_PI / 180.0), -5);
      s = BRepAlgoAPI_Cut(s, bolt).Shape();
    }
    ok &= writeStep(s, (fs::path(argv[1]) / "flange.step").string(), "flange");
  }

  // 15) cross_block.step — 十字件（X 臂 80x20x20 + Y 臂 20x60x20）
  {
    TopoDS_Shape armX = BRepPrimAPI_MakeBox(80, 20, 20).Shape();
    TopoDS_Shape armY = BRepPrimAPI_MakeBox(20, 60, 20).Shape();
    moveBy(armY, 30, -20, 0);
    ok &= writeStep(BRepAlgoAPI_Fuse(armX, armY).Shape(), (fs::path(argv[1]) / "cross_block.step").string(), "cross_block");
  }

  // 16) corner_boss_block.step — 70x50x20 基体 + 角部凸台 25x20x10
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(70, 50, 20).Shape();
    TopoDS_Shape boss = BRepPrimAPI_MakeBox(25, 20, 10).Shape();
    moveBy(boss, 45, 30, 20);
    ok &= writeStep(BRepAlgoAPI_Fuse(base, boss).Shape(), (fs::path(argv[1]) / "corner_boss_block.step").string(), "corner_boss_block");
  }

  // 17) side_hole_block.step — 60x60x40 块 + 水平 Ø16 通孔（X 向贯通）
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(60, 60, 40).Shape();
    TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(8, 70).Shape();
    rotateBy(hole, 0, 0, 0, 90, 0, 1, 0);
    moveBy(hole, 30, 30, 20);
    ok &= writeStep(BRepAlgoAPI_Cut(base, hole).Shape(), (fs::path(argv[1]) / "side_hole_block.step").string(), "side_hole_block");
  }

  // 18) deep_pocket_block.step — 60x50x30 块 + 深腔 40x8x26（深/宽 3.25 → DFM-0102 WARNING）
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(60, 50, 30).Shape();
    TopoDS_Shape pocket = BRepPrimAPI_MakeBox(40, 8, 26).Shape();
    moveBy(pocket, 10, 21, 4);
    ok &= writeStep(BRepAlgoAPI_Cut(base, pocket).Shape(), (fs::path(argv[1]) / "deep_pocket_block.step").string(), "deep_pocket_block");
  }

  // 19) chamfered_block.step — 80x50x30 斜切一角（45° 斜面 → CHAMFER）
  {
    TopoDS_Shape base = BRepPrimAPI_MakeBox(80, 50, 30).Shape();
    TopoDS_Shape cut = BRepPrimAPI_MakeBox(50, 60, 50).Shape();
    moveBy(cut, 50, -5, -10);
    rotateBy(cut, 60, 25, 15, 45, 0, 1, 0);
    ok &= writeStep(BRepAlgoAPI_Cut(base, cut).Shape(), (fs::path(argv[1]) / "chamfered_block.step").string(), "chamfered_block");
  }

  // 20) slot_plate.step — 100x60x15 板 + 2 条贯通长槽 102x8x5
  {
    TopoDS_Shape plate = BRepPrimAPI_MakeBox(100, 60, 15).Shape();
    TopoDS_Shape s = plate;
    for (const double cy : {20.0, 40.0}) {
      TopoDS_Shape slot = BRepPrimAPI_MakeBox(102, 8, 5).Shape();
      moveBy(slot, -1, cy, 10);
      s = BRepAlgoAPI_Cut(s, slot).Shape();
    }
    ok &= writeStep(s, (fs::path(argv[1]) / "slot_plate.step").string(), "slot_plate");
  }

  std::cout << (ok ? "generated 20 golden parts" : "generation had errors") << std::endl;
  return ok ? 0 : 1;
}


