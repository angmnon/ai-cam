/**
 * geometry_worker — Phase 0 OCCT 解析 POC（P0-8）
 *
 * 输入：第一个参数为 STEP 文件路径（或 "-" 从 stdin 读取）
 * 输出：JSON { status, file, solid_count, bbox_mm, volume_mm3, occt_version }
 *
 * 验收（M0）：10+ 个样例 STEP 解析成功，BBox 误差 < 0.01mm（与 CAD 系统对比）。
 */
#include <STEPControl_Reader.hxx>

#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Standard_Version.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Solid.hxx>

#include <cmath>
#include <iostream>
#include <sstream>
#include <string>

namespace {

std::string readStdin() {
  std::ostringstream oss;
  oss << std::cin.rdbuf();
  return oss.str();
}

void printJsonEscape(const std::string& s) {
  for (char c : s) {
    switch (c) {
      case '"': std::cout << "\\\""; break;
      case '\\': std::cout << "\\\\"; break;
      case '\n': std::cout << "\\n"; break;
      case '\r': std::cout << "\\r"; break;
      case '\t': std::cout << "\\t"; break;
      default: std::cout << c;
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: geometry_worker <step-file | ->" << std::endl;
    return 2;
  }

  const std::string input = argv[1];
  std::string path = input;

  STEPControl_Reader reader;
  IFSelect_ReturnStatus status = IFSelect_RetVoid;

  if (input == "-") {
    const std::string data = readStdin();
    // STEPControl_Reader 不直接读内存字符串：写入临时文件是跨平台稳妥做法
    const char* tmp = "/tmp/geometry_worker_input.step";
    FILE* f = std::fopen(tmp, "wb");
    if (!f) {
      std::cout << "{\"status\":\"error\",\"message\":\"cannot write temp file\"}" << std::endl;
      return 1;
    }
    std::fwrite(data.data(), 1, data.size(), f);
    std::fclose(f);
    path = tmp;
  }

  status = reader.ReadFile(path.c_str());
  if (status != IFSelect_RetDone) {
    std::cout << "{\"status\":\"error\",\"message\":\"STEP read failed: "
              << static_cast<int>(status) << "\",\"file\":\"";
    printJsonEscape(path);
    std::cout << "\"}" << std::endl;
    return 1;
  }

  reader.TransferRoots();
  TopoDS_Shape shape = reader.OneShape();
  if (shape.IsNull()) {
    std::cout << "{\"status\":\"error\",\"message\":\"no shape transferred\"}" << std::endl;
    return 1;
  }

  // 实体现有数（含多实体）
  int solidCount = 0;
  for (TopExp_Explorer ex(shape, TopAbs_SOLID); ex.More(); ex.Next()) {
    ++solidCount;
  }

  // 包围盒
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  double xmin = 0, ymin = 0, zmin = 0, xmax = 0, ymax = 0, zmax = 0;
  if (box.IsVoid()) {
    std::cout << "{\"status\":\"error\",\"message\":\"bounding box is void\"}" << std::endl;
    return 1;
  }
  box.Get(xmin, ymin, zmin, xmax, ymax, zmax);

  // 体积
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  const double volume = std::fabs(props.Mass());

  std::cout << "{"
            << "\"status\":\"ok\","
            << "\"file\":\"";
  printJsonEscape(path);
  std::cout << "\","
            << "\"occt_version\":\"" << OCC_VERSION_STRING_EXT << "\","
            << "\"solid_count\":" << solidCount << ","
            << "\"bbox_mm\":{\"min\":[" << xmin << "," << ymin << "," << zmin << "],"
            << "\"max\":[" << xmax << "," << ymax << "," << zmax << "]},"
            << "\"volume_mm3\":" << volume << "}"
            << std::endl;

  return 0;
}
