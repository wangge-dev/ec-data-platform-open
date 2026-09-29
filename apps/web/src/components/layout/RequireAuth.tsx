import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/lib/auth-store";

export function RequireAuth() {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <Outlet />;
}
