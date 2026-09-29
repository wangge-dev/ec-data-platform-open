import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X, Check, Database, Terminal, Loader2, Plug } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SqlConsole } from "./SqlConsole";

const DIALECTS = [
  { code: "pg", label: "PostgreSQL", defaultPort: 5432, color: "bg-blue-100 text-blue-700" },
  { code: "mysql", label: "MySQL", defaultPort: 3306, color: "bg-amber-100 text-amber-700" },
] as const;

type Dialect = (typeof DIALECTS)[number]["code"];

type SqlConfig = {
  dialect: Dialect;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
};

type ExternalSource = {
  id: number;
  name: string;
  type: "external_sql";
  platform: string | null;
  config: SqlConfig;
  status: string;
  createdAt: string;
};

export function ExternalSqlTab() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [console_, setConsole] = useState<ExternalSource | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["external-sql"],
    queryFn: async () => {
      const r: any = await api.get("/external-sql");
      return r.data as ExternalSource[];
    },
  });

  const createMut = useMutation({
    mutationFn: (body: { name: string; config: SqlConfig }) => api.post("/external-sql", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["external-sql"] });
      setShowForm(false);
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/external-sql/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["external-sql"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-secondary">
          连接外部 PostgreSQL / MySQL 库 · 只读 SELECT · 密码落库脱敏
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-3.5 py-2 bg-morandi-1 text-white text-sm rounded-md hover:opacity-90 transition"
        >
          <Plus size={16} />
          新增连接
        </button>
      </div>

      {isLoading && <div className="text-text-muted text-sm">加载中…</div>}

      {!isLoading && data && data.length === 0 && (
        <div className="card border-dashed text-center py-12">
          <Database size={28} className="mx-auto text-text-muted mb-2" />
          <div className="text-text-muted text-sm">还没有外部数据库连接</div>
          <button
            onClick={() => setShowForm(true)}
            className="mt-3 text-sm text-morandi-slate hover:underline"
          >
            点击新增第一个
          </button>
        </div>
      )}

      {!isLoading && data && data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.map((d) => {
            const dialect = DIALECTS.find((x) => x.code === d.config?.dialect);
            return (
              <div key={d.id} className="card group hover:shadow-md transition">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-medium text-text-primary">{d.name}</div>
                    <div className="text-xs text-text-muted mt-0.5">
                      创建于 {new Date(d.createdAt).toLocaleDateString("zh-CN")}
                    </div>
                  </div>
                  {dialect && (
                    <span
                      className={cn(
                        "px-2 py-0.5 text-xs rounded-md font-medium",
                        dialect.color,
                      )}
                    >
                      {dialect.label}
                    </span>
                  )}
                </div>
                <div className="bg-bg-subtle rounded-md p-3 text-xs space-y-1 mb-3 font-mono">
                  <div>
                    <span className="text-text-muted">host: </span>
                    <span className="text-text-secondary">
                      {d.config?.host}:{d.config?.port}
                    </span>
                  </div>
                  <div>
                    <span className="text-text-muted">db: </span>
                    <span className="text-text-secondary">{d.config?.database}</span>
                    <span className="text-text-muted"> · user: </span>
                    <span className="text-text-secondary">{d.config?.user}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConsole(d)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-morandi-slate/10 text-morandi-slate rounded-md hover:bg-morandi-slate/20 transition"
                  >
                    <Terminal size={12} /> SQL 控制台
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`删除连接「${d.name}」？`)) deleteMut.mutate(d.id);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded-md text-red-600 hover:bg-red-50 transition opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 size={12} /> 删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <ConnectionForm
          onCancel={() => setShowForm(false)}
          onSubmit={(body) => createMut.mutate(body)}
          loading={createMut.isPending}
        />
      )}

      {console_ && <SqlConsole source={console_} onClose={() => setConsole(null)} />}
    </div>
  );
}

function ConnectionForm({
  onCancel,
  onSubmit,
  loading,
}: {
  onCancel: () => void;
  onSubmit: (body: { name: string; config: SqlConfig }) => void;
  loading: boolean;
}) {
  const [name, setName] = useState("");
  const [dialect, setDialect] = useState<Dialect>("pg");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(5432);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [ssl, setSsl] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const config: SqlConfig = { dialect, host, port: Number(port), user, password, database, ssl };

  function pickDialect(code: Dialect) {
    setDialect(code);
    const d = DIALECTS.find((x) => x.code === code)!;
    setPort(d.defaultPort);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r: any = await api.post("/external-sql/test", config);
      setTestResult({ ok: true, msg: `连接成功 · ${r.version ?? ""}`.trim() });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message ?? "连接失败" });
    } finally {
      setTesting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({ name, config });
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-card rounded-lg w-[560px] max-w-full shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="font-medium">新增外部数据库连接</div>
          <button onClick={onCancel} className="text-text-muted hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <Field label="连接名称">
            <input
              required
              className="w-full px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：业务库（生产只读）"
            />
          </Field>
          <Field label="数据库类型">
            <div className="flex gap-2">
              {DIALECTS.map((d) => (
                <button
                  type="button"
                  key={d.code}
                  onClick={() => pickDialect(d.code)}
                  className={cn(
                    "px-3 py-1.5 text-sm rounded-md border transition",
                    dialect === d.code
                      ? "bg-morandi-1 text-white border-transparent"
                      : "bg-bg-card hover:bg-bg-subtle",
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="主机">
                <input
                  required
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate font-mono text-sm"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="127.0.0.1"
                />
              </Field>
            </div>
            <Field label="端口">
              <input
                required
                type="number"
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate font-mono text-sm"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="用户名">
              <input
                required
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate font-mono text-sm"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            </Field>
            <Field label="密码">
              <input
                type="password"
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate font-mono text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>
          <Field label="数据库名">
            <input
              required
              className="w-full px-3 py-2 border rounded-md focus:outline-none focus:border-morandi-slate font-mono text-sm"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
            使用 SSL 连接
          </label>

          {testResult && (
            <div
              className={cn(
                "text-xs rounded-md px-3 py-2",
                testResult.ok
                  ? "bg-green-50 text-green-700"
                  : "bg-red-50 text-red-600",
              )}
            >
              {testResult.msg}
            </div>
          )}

          <div className="flex justify-between items-center pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-1.5 px-3.5 py-2 text-sm border rounded-md hover:bg-bg-subtle disabled:opacity-50 transition"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              测试连接
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-sm border rounded-md hover:bg-bg-subtle transition"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-morandi-1 text-white rounded-md hover:opacity-90 disabled:opacity-50 transition"
              >
                <Check size={14} />
                {loading ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-text-secondary mb-1.5">{label}</label>
      {children}
    </div>
  );
}

export type { ExternalSource, SqlConfig };
