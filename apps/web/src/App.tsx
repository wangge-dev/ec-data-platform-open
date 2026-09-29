import { Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { RequireAuth } from "@/components/layout/RequireAuth";
import { DataPage } from "@/pages/data";
import { BoardPage } from "@/pages/board";
import { AgentPage } from "@/pages/agent";
import { SettingPage } from "@/pages/setting";
import { ModulePage } from "@/pages/module";
import { ModuleWorkbench } from "@/pages/module/workbench";
import { AnalyticsHubPage } from "@/pages/analytics";
import { FrontProfitPage } from "@/pages/front-profit";
import { SolutionPage } from "@/pages/solutions";
import { CompareRedirect, AlertRedirect } from "@/pages/redirects";
import { LoginPage } from "@/pages/login";

function Layout() {
  return (
    <div className="h-full flex">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto p-4 sm:p-8">
        <Routes>
          <Route path="/" element={<Navigate to="/module" replace />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/summary" element={<Navigate to="/analytics" replace />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/agent" element={<AgentPage />} />
          <Route path="/module" element={<ModulePage />} />
          <Route path="/module/:code" element={<ModuleWorkbench />} />
          <Route path="/module/:code/:tab" element={<ModuleWorkbench />} />
          <Route path="/front-profit" element={<FrontProfitPage />} />
          <Route path="/analytics" element={<AnalyticsHubPage />} />
          <Route path="/solutions" element={<SolutionPage />} />
          {/* 旧路由兼容重定向 */}
          <Route path="/compare" element={<CompareRedirect />} />
          <Route path="/alert" element={<AlertRedirect />} />
          {/* 平台模板 V0.21 删除，路由重定向到模块管理 */}
          <Route path="/template" element={<Navigate to="/module/orders/platforms" replace />} />
          <Route path="/setting" element={<SettingPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/*" element={<Layout />} />
      </Route>
    </Routes>
  );
}
