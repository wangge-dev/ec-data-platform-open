// 旧路由兼容重定向：/compare?module=X → /module/X/compare ；无参数 → /analytics
import { Navigate, useSearchParams } from "react-router-dom";
import { buildLegacyModuleRedirect } from "./redirect-target";

export function CompareRedirect() {
  const [params] = useSearchParams();
  return <Navigate to={buildLegacyModuleRedirect("compare", params)} replace />;
}

export function AlertRedirect() {
  const [params] = useSearchParams();
  return <Navigate to={buildLegacyModuleRedirect("alerts", params)} replace />;
}
