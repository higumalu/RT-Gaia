// 產生 GPU Monte Carlo 引擎用的物理資料表：每個材質、每個能量的截面與阻擋本領。
//
// 在 OpenTOPAS 的官方映像裡編譯、執行（同一版 Geant4 11.4.2、同一套 G4EMLOW 資料、同一個物理列表
// G4EmStandardPhysics_option4 —— 跟參考引擎一樣）。用 G4EmCalculator 算，結果寫成純文字表。
//
// 輸入（stdin）：
//   cuts <電子 δ 射線門檻 MeV> <制動輻射光子門檻 MeV>
//   grid <最低 MeV> <最高 MeV> <點數>
//   material <名稱> <密度 g/cm3> <元素數> <符號 質量分率> ...
// 輸出（stdout）：每個材質一段
//   material <名稱> <密度>
//   <E MeV> <光電 1/mm> <康普頓 1/mm> <成對 1/mm> <雷利 1/mm>
//           <e- 受限阻擋本領 MeV/mm> <e- 全阻擋本領 MeV/mm> <e- 硬 Møller 1/mm> <e- 硬制動 1/mm> <e- 1/λ1 1/mm>
//           <e+ 受限阻擋本領> <e+ 硬 Bhabha 1/mm> <e+ 硬制動 1/mm> <e+ 1/λ1> <e+ 互毀 1/mm>
//   end
#include <cmath>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "G4Box.hh"
#include "G4EmCalculator.hh"
#include "G4EmParameters.hh"
#include "G4Electron.hh"
#include "G4EmStandardPhysics_option4.hh"
#include "G4Gamma.hh"
#include "G4LogicalVolume.hh"
#include "G4Material.hh"
#include "G4NistManager.hh"
#include "G4PVPlacement.hh"
#include "G4ParticleGun.hh"
#include "G4Positron.hh"
#include "G4ProductionCutsTable.hh"
#include "G4RunManager.hh"
#include "G4SystemOfUnits.hh"
#include "G4VModularPhysicsList.hh"
#include "G4VUserDetectorConstruction.hh"
#include "G4VUserPrimaryGeneratorAction.hh"

namespace {

struct MaterialSpec {
  std::string name;
  double density;
  std::vector<std::pair<std::string, double>> fractions;
};

std::vector<G4Material*> gMaterials;

class Detector : public G4VUserDetectorConstruction {
 public:
  explicit Detector(const std::vector<MaterialSpec>& specs) : fSpecs(specs) {}
  G4VPhysicalVolume* Construct() override {
    auto nist = G4NistManager::Instance();
    auto world = new G4LogicalVolume(new G4Box("W", 10 * m, 10 * m, 10 * m), nist->FindOrBuildMaterial("G4_Galactic"), "W");
    auto worldPV = new G4PVPlacement(nullptr, {}, world, "W", nullptr, false, 0);
    int i = 0;
    for (const auto& s : fSpecs) {
      auto mat = new G4Material(s.name, s.density * g / cm3, static_cast<int>(s.fractions.size()));
      for (const auto& [sym, w] : s.fractions) mat->AddElement(nist->FindOrBuildElement(sym), w);
      gMaterials.push_back(mat);
      // 每個材質一個小盒子：G4EmCalculator 的 Get* 要材質真的在幾何裡（才有 couple）
      auto lv = new G4LogicalVolume(new G4Box(s.name, 1 * cm, 1 * cm, 1 * cm), mat, s.name);
      new G4PVPlacement(nullptr, {-9 * m + i * 3 * cm, 0, 0}, lv, s.name, world, false, i);
      ++i;
    }
    return worldPV;
  }

 private:
  std::vector<MaterialSpec> fSpecs;
};

class Physics : public G4VModularPhysicsList {
 public:
  Physics() { RegisterPhysics(new G4EmStandardPhysics_option4()); }
};

class Gun : public G4VUserPrimaryGeneratorAction {
 public:
  Gun() : fGun(new G4ParticleGun(1)) { fGun->SetParticleDefinition(G4Gamma::Definition()); }
  ~Gun() override { delete fGun; }
  void GeneratePrimaries(G4Event* e) override { fGun->GeneratePrimaryVertex(e); }

 private:
  G4ParticleGun* fGun;
};

}  // namespace

int main() {
  double tcut = 0.1, kcut = 0.05, e_lo = 0.001, e_hi = 25.0;
  int n = 300;
  std::vector<MaterialSpec> specs;
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream in(line);
    std::string key;
    if (!(in >> key)) continue;
    if (key == "cuts") {
      in >> tcut >> kcut;
    } else if (key == "grid") {
      in >> e_lo >> e_hi >> n;
    } else if (key == "material") {
      MaterialSpec s;
      int k = 0;
      in >> s.name >> s.density >> k;
      for (int j = 0; j < k; ++j) {
        std::string sym;
        double w = 0;
        in >> sym >> w;
        if (w > 0) s.fractions.emplace_back(sym, w);
      }
      specs.push_back(s);
    }
  }

  auto run = new G4RunManager();
  run->SetUserInitialization(new Detector(specs));
  run->SetUserInitialization(new Physics());
  run->SetUserAction(new Gun());
  // 表的上下限要包住我們的能量格子；cut 給得很小，讓 Get* 用的 couple 不影響我們自己算的受限量
  G4EmParameters::Instance()->SetLowestElectronEnergy(1 * keV);
  G4EmParameters::Instance()->SetMaxEnergy(100 * MeV);
  run->Initialize();
  run->BeamOn(0);  // 建物理表

  G4EmCalculator calc;
  const auto* em = G4Electron::Definition();
  const auto* ep = G4Positron::Definition();
  const auto* gm = G4Gamma::Definition();
  std::cout.precision(8);
  for (auto* mat : gMaterials) {
    std::cout << "material " << mat->GetName() << " " << mat->GetDensity() / (g / cm3) << "\n";
    for (int i = 0; i < n; ++i) {
      const double e = e_lo * std::pow(e_hi / e_lo, static_cast<double>(i) / (n - 1)) * MeV;
      const double kc = std::min(kcut * MeV, e), tc = std::min(tcut * MeV, e);
      const double phot = calc.ComputeCrossSectionPerVolume(e, gm, "phot", mat);
      const double compt = calc.ComputeCrossSectionPerVolume(e, gm, "compt", mat);
      const double conv = calc.ComputeCrossSectionPerVolume(e, gm, "conv", mat);
      const double rayl = calc.ComputeCrossSectionPerVolume(e, gm, "Rayl", mat);
      const double s_res_m = calc.ComputeDEDX(e, em, "eIoni", mat, tc) + calc.ComputeDEDX(e, em, "eBrem", mat, kc);
      const double s_tot_m = calc.ComputeTotalDEDX(e, em, mat);
      const double moller = calc.ComputeCrossSectionPerVolume(e, em, "eIoni", mat, tc);
      const double brem_m = calc.ComputeCrossSectionPerVolume(e, em, "eBrem", mat, kc);
      const double tr_m = calc.GetCrossSectionPerVolume(e, em, "msc", mat);
      const double s_res_p = calc.ComputeDEDX(e, ep, "eIoni", mat, tc) + calc.ComputeDEDX(e, ep, "eBrem", mat, kc);
      const double bhabha = calc.ComputeCrossSectionPerVolume(e, ep, "eIoni", mat, tc);
      const double brem_p = calc.ComputeCrossSectionPerVolume(e, ep, "eBrem", mat, kc);
      const double tr_p = calc.GetCrossSectionPerVolume(e, ep, "msc", mat);
      const double annih = calc.ComputeCrossSectionPerVolume(e, ep, "annihil", mat);
      std::cout << e / MeV << " " << phot * mm << " " << compt * mm << " " << conv * mm << " " << rayl * mm << " "
                << s_res_m / (MeV / mm) << " " << s_tot_m / (MeV / mm) << " " << moller * mm << " " << brem_m * mm << " "
                << tr_m * mm << " " << s_res_p / (MeV / mm) << " " << bhabha * mm << " " << brem_p * mm << " "
                << tr_p * mm << " " << annih * mm << "\n";
    }
    std::cout << "end\n";
  }
  delete run;
  return 0;
}
