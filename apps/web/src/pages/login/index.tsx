import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

export function LoginPage() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setAuth = useAuth((s) => s.setAuth);
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const r: any = await api.post("/auth/login", { username, password });
      if (r.ok) {
        setAuth(r.data.token, r.data.user);
        nav("/data", { replace: true });
      } else {
        setErr(r.message || "登录失败");
      }
    } catch (e: any) {
      setErr(e?.message || "网络错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-bg-base">
      <div className="absolute inset-0 bg-morandi-2 opacity-20" />
      <div className="card w-[400px] relative z-10 shadow-xl border">
        <div className="mb-8 text-center">
          <div className="inline-block w-12 h-12 bg-morandi-1 rounded-xl mb-3" />
          <h1 className="text-2xl font-semibold tracking-wide">ec 数据平台</h1>
          <p className="text-sm text-text-muted mt-1">DeepSeek V4 · 莫兰迪</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1.5">用户名</label>
            <input
              className="w-full px-3 py-2.5 border rounded-md bg-bg-card focus:outline-none focus:border-morandi-slate transition"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1.5">密码</label>
            <input
              type="password"
              className="w-full px-3 py-2.5 border rounded-md bg-bg-card focus:outline-none focus:border-morandi-slate transition"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {err && (
            <div role="alert" className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{err}</div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-morandi-1 text-white rounded-md font-medium hover:opacity-90 disabled:opacity-50 transition"
          >
            {loading ? "登录中…" : "登录"}
          </button>
          <div className="text-xs text-text-muted text-center">
            管理员账号通常为 <code className="bg-bg-subtle px-1.5 py-0.5 rounded">admin</code>
            ，密码由部署者设置
          </div>
        </form>
      </div>
    </div>
  );
}
