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

  std::cout << (ok ? "generated 8 golden parts" : "generation had errors") << std::endl;
  return ok ? 0 : 1;
}


