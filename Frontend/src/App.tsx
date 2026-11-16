import { lazy, Suspense, type ComponentType } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ActiveSiteProvider } from './data/ActiveSiteContext.tsx'
import { AuthProvider } from './data/AuthContext.tsx'
import { CalibrationProvider } from './data/CalibrationContext.tsx'
import { createRepository } from './data/createRepository.ts'
import { MasterProvider } from './data/MasterContext.tsx'
import { OperationsProvider } from './data/OperationsContext.tsx'
import { LocaleProvider } from './i18n/LocaleContext.tsx'
import { AppShell } from './layout/AppShell.tsx'
import { PageGate, RequireAuth, SiteRequired } from './features/auth/guards.tsx'
import { LoginPage } from './features/login/LoginPage.tsx'
import { SsoErrorPage } from './features/login/SsoErrorPage.tsx'

// Each screen loads when first opened, so the first page does not download every other screen
// and the sample data some of them bundle.
function page<T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) {
  return lazy(() => load().then((module) => ({ default: module[name] as ComponentType })))
}

const ProductionLayout = page(() => import('./data/ProductionContext.tsx'), 'ProductionLayout')
const QcLayout = page(() => import('./data/QcContext.tsx'), 'QcLayout')
const AdminMenuPage = page(() => import('./features/admin/AdminMenuPage.tsx'), 'AdminMenuPage')
const RolesPage = page(() => import('./features/admin/RolesPage.tsx'), 'RolesPage')
const UsersPage = page(() => import('./features/admin/UsersPage.tsx'), 'UsersPage')
const DataHubPage = page(() => import('./features/admin/DataHubPage.tsx'), 'DataHubPage')
const SiteModulesPage = page(() => import('./features/admin/SiteModulesPage.tsx'), 'SiteModulesPage')
const LiveOpsPage = page(() => import('./features/live-ops/LiveOpsPage.tsx'), 'LiveOpsPage')
const CommoditiesPage = page(() => import('./features/master/masterPages.tsx'), 'CommoditiesPage')
const TankFarmPage = page(() => import('./features/master/masterPages.tsx'), 'TankFarmPage')
const CompaniesPage = page(() => import('./features/master/OrgPages.tsx'), 'CompaniesPage')
const SitesPage = page(() => import('./features/master/OrgPages.tsx'), 'SitesPage')
const TankGaugingPage = page(() => import('./features/master/TankGaugingPage.tsx'), 'TankGaugingPage')
const MasterMenuPage = page(() => import('./features/master/MasterMenuPage.tsx'), 'MasterMenuPage')
const CommoditiesCalibrationPage = page(() => import('./features/master/CommoditiesCalibrationPage.tsx'), 'CommoditiesCalibrationPage')
const TankCalibrationPage = page(() => import('./features/master/TankCalibrationPage.tsx'), 'TankCalibrationPage')
const OpsAnalyticsPage = page(() => import('./features/ops-analytics/OpsAnalyticsPage.tsx'), 'OpsAnalyticsPage')
const DailyProductionPage = page(() => import('./features/daily-production/DailyProductionPage.tsx'), 'DailyProductionPage')
const MovementPage = page(() => import('./features/qc/MovementPage.tsx'), 'MovementPage')
const RefineryQualityPage = page(() => import('./features/qc/RefineryQualityPage.tsx'), 'RefineryQualityPage')
const QcOverviewPage = page(() => import('./features/qc/QcOverviewPage.tsx'), 'QcOverviewPage')
const StoragePage = page(() => import('./features/qc/StoragePage.tsx'), 'StoragePage')
const TruckPage = page(() => import('./features/qc/TruckPage.tsx'), 'TruckPage')
const VesselPage = page(() => import('./features/qc/VesselPage.tsx'), 'VesselPage')
const BoilerPage = page(() => import('./features/utility/BoilerPage.tsx'), 'BoilerPage')
const CoalPage = page(() => import('./features/utility/CoalPage.tsx'), 'CoalPage')
const EffluentPage = page(() => import('./features/utility/EffluentPage.tsx'), 'EffluentPage')
const LoaderPage = page(() => import('./features/utility/LoaderPage.tsx'), 'LoaderPage')
const UtilityOverviewPage = page(() => import('./features/utility/UtilityOverviewPage.tsx'), 'UtilityOverviewPage')
const UtilityLayout = page(() => import('./features/utility/utilityShell.tsx'), 'UtilityLayout')
const WaterPage = page(() => import('./features/utility/WaterPage.tsx'), 'WaterPage')
const StockOverviewPage = page(() => import('./features/management/StockOverviewPage.tsx'), 'StockOverviewPage')
const Fractionation400Page = page(() => import('./features/daily-production/PlantSectionPage.tsx'), 'Fractionation400Page')
const Fractionation500Page = page(() => import('./features/daily-production/PlantSectionPage.tsx'), 'Fractionation500Page')
const Refinery150Page = page(() => import('./features/daily-production/PlantSectionPage.tsx'), 'Refinery150Page')
const Refinery500Page = page(() => import('./features/daily-production/PlantSectionPage.tsx'), 'Refinery500Page')
const SeparatorPage = page(() => import('./features/daily-production/PlantSectionPage.tsx'), 'SeparatorPage')
const SupportingMaterialsPage = page(() => import('./features/daily-production/PlantSectionPage.tsx'), 'SupportingMaterialsPage')

const repository = createRepository()

export default function App() {
  return (
    <LocaleProvider>
      <AuthProvider>
        <OperationsProvider repository={repository}>
         <ActiveSiteProvider>
          <CalibrationProvider>
            <MasterProvider>
              <BrowserRouter>
                <Suspense fallback={<p className="page-note">…</p>}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/sso-error" element={<SsoErrorPage />} />
                  <Route element={<RequireAuth />}>
                    <Route element={<AppShell />}>
                      <Route path="/" element={<SiteRequired />}>
                        <Route element={<PageGate page="management-stock" />}>
                          <Route path="management" element={<StockOverviewPage />} />
                        </Route>
                        <Route element={<PageGate page="live-ops" module="live-ops" landing />}>
                          <Route index element={<LiveOpsPage />} />
                        </Route>
                        <Route element={<PageGate page="ops-analytics" module="live-ops" />}>
                          <Route path="ops-analytics" element={<OpsAnalyticsPage />} />
                        </Route>
                        <Route element={<PageGate page="daily-production" module="daily-production" />}>
                          <Route element={<ProductionLayout />}>
                            <Route path="daily-production" element={<DailyProductionPage />} />
                            <Route path="daily-production/refinery-500" element={<Refinery500Page />} />
                            <Route path="daily-production/refinery-150" element={<Refinery150Page />} />
                            <Route path="daily-production/fractionation-400" element={<Fractionation400Page />} />
                            <Route path="daily-production/fractionation-500" element={<Fractionation500Page />} />
                            <Route path="daily-production/separator" element={<SeparatorPage />} />
                            <Route path="daily-production/supporting-materials" element={<SupportingMaterialsPage />} />
                          </Route>
                        </Route>
                        <Route element={<PageGate page="qc" module="qc" />}>
                          <Route path="qc/refinery" element={<RefineryQualityPage />} />
                          <Route path="qc" element={<QcLayout />}>
                            <Route index element={<QcOverviewPage />} />
                            <Route path="storage" element={<StoragePage />} />
                            <Route path="vessel" element={<VesselPage />} />
                            <Route path="truck" element={<TruckPage />} />
                            <Route path="movements" element={<MovementPage />} />
                          </Route>
                        </Route>
                        <Route element={<PageGate page="utility" module="utility" />}>
                          <Route path="utility" element={<UtilityLayout />}>
                            <Route index element={<UtilityOverviewPage />} />
                            <Route path="boiler" element={<BoilerPage />} />
                            <Route path="coal" element={<CoalPage />} />
                            <Route path="water" element={<WaterPage />} />
                            <Route path="effluent" element={<EffluentPage />} />
                            <Route path="loader" element={<LoaderPage />} />
                          </Route>
                        </Route>
                        <Route element={<PageGate page="master-companies" />}>
                          <Route path="master" element={<MasterMenuPage />} />
                          <Route path="master/companies" element={<CompaniesPage />} />
                        </Route>
                        <Route element={<PageGate page="master-sites" />}>
                          <Route path="master/sites" element={<SitesPage />} />
                        </Route>
                                        <Route element={<PageGate page="master-commodities" />}>
                          <Route path="master/commodities" element={<CommoditiesPage />} />
                        </Route>
                        <Route element={<PageGate page="master-calibration" />}>
                          <Route path="master/commodities-calibration" element={<CommoditiesCalibrationPage />} />
                        </Route>
                        <Route element={<PageGate page="master-tanks" />}>
                          <Route path="master/tank-farm" element={<TankFarmPage />} />
                          <Route path="master/tank-gauging" element={<TankGaugingPage />} />
                          <Route path="master/tank-farm/:tankId" element={<TankCalibrationPage />} />
                        </Route>
                      </Route>
                      <Route path="admin" element={<AdminMenuPage />} />
                      <Route element={<PageGate page="admin-users" />}>
                        <Route path="admin/users" element={<UsersPage />} />
                      </Route>
                      <Route element={<PageGate page="admin-datahub" />}>
                        <Route path="admin/datahub" element={<DataHubPage />} />
                      </Route>
                      <Route element={<PageGate page="master-sites" />}>
                        <Route path="admin/site-modules" element={<SiteModulesPage />} />
                      </Route>
                      <Route element={<PageGate page="admin-roles" />}>
                        <Route path="admin/roles" element={<RolesPage />} />
                      </Route>
                    </Route>
                  </Route>
                </Routes>
                </Suspense>
              </BrowserRouter>
            </MasterProvider>
          </CalibrationProvider>
         </ActiveSiteProvider>
        </OperationsProvider>
      </AuthProvider>
    </LocaleProvider>
  )
}
