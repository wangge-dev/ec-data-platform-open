import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  Boxes,
  Check,
  CheckCircle2,
  Download,
  FileJson,
  KeyRound,
  LockKeyhole,
  PackageCheck,
  PlugZap,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
} from "lucide-react";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { cn } from "@/lib/utils";
import type { ModuleData } from "@/pages/module/types";
import {
  MAX_SOLUTION_FILE_BYTES,
  SOLUTION_DELIVERY_SCOPE,
  SOLUTION_ID_PATTERN,
  parseSolutionManifestText,
  portableUserModules,
  solutionDownloadFileName,
  solutionErrorMessage,
  type ConnectorCatalogItem,
  type SolutionInstallResult,
  type SolutionRollbackResult,
  type SolutionValidationResult,
  type VerticalSolutionManifest,
} from "./model";

type Tab = "export" | "install";
type Notice = { kind: "success" | "error" | "info"; text: string };

const fieldClass = "mt-1 min-h-11 w-full rounded-md border bg-bg-card px-3 py-2 text-sm outline-none transition placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-morandi-slate/40";
const primaryButtonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-morandi-slate px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-slate/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45";
const secondaryButtonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-bg-card px-4 py-2 text-sm text-text-secondary transition hover:bg-bg-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-slate/30 disabled:cursor-not-allowed disabled:opacity-45";

export function SolutionPage() {
  const isAdmin = useAuth((state) => state.user?.isAdmin === true);
  const [activeTab, setActiveTab] = useState<Tab>("export");

  const modulesQuery = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const response: any = await api.get("/modules");
      return response.data as ModuleData[];
    },
    enabled: isAdmin,
  });
  const connectorsQuery = useQuery({
    queryKey: ["connector-catalog"],
    queryFn: async () => {
      const response: any = await api.get("/external-sql/connectors");
      return response.data.connectors as ConnectorCatalogItem[];
    },
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-2xl py-12">
        <section className="card text-center" aria-labelledby="solution-access-title">
          <LockKeyhole className="mx-auto mb-3 text-text-muted" size={32} />
          <h1 id="solution-access-title" className="text-xl font-semibold">需要管理员权限</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-text-muted">
            方案包会改变实例内的模块配置，只允许管理员导出、校验和应用。
          </p>
          <Link to="/module" className={cn(secondaryButtonClass, "mt-5")}>返回模块管理</Link>
        </section>
      </div>
    );
  }

  const portableModules = portableUserModules(modulesQuery.data);
  const connectors = connectorsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <PackageCheck size={22} className="text-morandi-slate" />
            方案交付
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            把已配置的普通模块复制到另一套实例，目标端再接入自己的数据
          </p>
        </div>
        <div className="flex items-center gap-3 border-l-2 border-morandi-sage px-3 py-1 text-xs leading-5 text-text-secondary">
          <ShieldCheck size={18} className="shrink-0 text-morandi-sage" />
          <span>只传配置，不包含业务数据、账号或连接密码</span>
        </div>
      </header>

      <section className="card grid gap-3 text-sm leading-6 text-text-secondary md:grid-cols-2" aria-label="方案包交付边界">
        <div>
          <p className="font-medium text-text-primary">包内有什么</p>
          <p>{SOLUTION_DELIVERY_SCOPE.includes}</p>
          <p>{SOLUTION_DELIVERY_SCOPE.excludes}</p>
        </div>
        <div>
          <p className="font-medium text-text-primary">选择与兼容</p>
          <p>{SOLUTION_DELIVERY_SCOPE.connector}</p>
          <p>{SOLUTION_DELIVERY_SCOPE.compatibility}</p>
        </div>
      </section>

      <div className="flex gap-1 border-b" role="tablist" aria-label="方案交付操作">
        <TabButton active={activeTab === "export"} onClick={() => setActiveTab("export")}>
          <Download size={15} />导出方案
        </TabButton>
        <TabButton active={activeTab === "install"} onClick={() => setActiveTab("install")}>
          <Upload size={15} />校验并应用
        </TabButton>
      </div>

      {activeTab === "export" ? (
        <ExportSolutionPanel
          modules={portableModules}
          connectors={connectors}
          loading={modulesQuery.isLoading || connectorsQuery.isLoading}
          loadError={modulesQuery.error ?? connectorsQuery.error}
        />
      ) : (
        <InstallSolutionPanel />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-slate/30",
        active
          ? "border-morandi-slate font-medium text-text-primary"
          : "border-transparent text-text-secondary hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

function ExportSolutionPanel({
  modules,
  connectors,
  loading,
  loadError,
}: {
  modules: ModuleData[];
  connectors: ConnectorCatalogItem[];
  loading: boolean;
  loadError: unknown;
}) {
  const [solutionId, setSolutionId] = useState("ecommerce.ops");
  const [label, setLabel] = useState("电商经营分析方案");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState(1);
  const [moduleCodes, setModuleCodes] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [exported, setExported] = useState<VerticalSolutionManifest | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const exportMutation = useMutation({
    mutationFn: async () => {
      const response: any = await api.post("/modules/solutions/export", {
        id: solutionId.trim(),
        version,
        label: label.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        moduleCodes,
        connectorIds,
      });
      return response.data as VerticalSolutionManifest;
    },
    onSuccess: (manifest) => {
      setExported(manifest);
      setNotice({ kind: "success", text: "方案包已生成，可以下载并交给目标实例管理员。" });
    },
    onError: (error) => {
      setExported(null);
      setNotice({ kind: "error", text: solutionErrorMessage(error, "方案包生成失败") });
    },
  });

  const toggleValue = (
    value: string,
    selected: string[],
    setSelected: (next: string[]) => void,
  ) => {
    setExported(null);
    setSelected(selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value]);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    if (!SOLUTION_ID_PATTERN.test(solutionId.trim())) {
      setNotice({ kind: "error", text: "方案 ID 必须是 namespace.name，例如 ecommerce.ops。" });
      return;
    }
    if (!label.trim()) {
      setNotice({ kind: "error", text: "请填写方案名称。" });
      return;
    }
    if (moduleCodes.length === 0) {
      setNotice({ kind: "error", text: "至少选择一个可移植模块。" });
      return;
    }
    exportMutation.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="导出垂直方案">
      {notice && <NoticeBanner notice={notice} />}
      {loadError != null && (
        <NoticeBanner notice={{ kind: "error", text: solutionErrorMessage(loadError, "模块或连接器目录加载失败") }} />
      )}

      <section className="card p-0 overflow-hidden">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.78fr)]">
          <div className="space-y-5 p-5 sm:p-6 lg:border-r">
            <SectionTitle icon={FileJson} title="方案身份" description="ID 和版本用于跨实例识别，不代表客户数据版本。" />
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
              <label className="text-sm font-medium">
                方案 ID
                <input
                  value={solutionId}
                  onChange={(event) => { setSolutionId(event.target.value); setExported(null); }}
                  className={fieldClass}
                  placeholder="ecommerce.ops"
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs font-normal text-text-muted">小写 namespace.name</span>
              </label>
              <label className="text-sm font-medium">
                版本
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={version}
                  onChange={(event) => { setVersion(Math.max(1, Number(event.target.value) || 1)); setExported(null); }}
                  className={fieldClass}
                />
              </label>
            </div>
            <label className="block text-sm font-medium">
              方案名称
              <input
                value={label}
                onChange={(event) => { setLabel(event.target.value); setExported(null); }}
                className={fieldClass}
                placeholder="例如：电商经营分析方案"
              />
            </label>
            <label className="block text-sm font-medium">
              交付说明 <span className="font-normal text-text-muted">（可选）</span>
              <textarea
                value={description}
                onChange={(event) => { setDescription(event.target.value); setExported(null); }}
                className={cn(fieldClass, "min-h-24 resize-y")}
                maxLength={500}
                placeholder="说明适用业务、需要客户准备的数据，以及已验证口径。"
              />
            </label>

            <div className="border-t pt-5">
              <SectionTitle icon={Boxes} title="选择普通模块" description="只列出无 transform 且已有语义合同的用户模块。" />
              {loading ? (
                <InlineState icon={RefreshCw} text="正在读取可移植模块…" spinning />
              ) : modules.length === 0 ? (
                <div className="rounded-md border border-dashed p-5 text-sm text-text-muted">
                  暂无可导出的用户模块。内置复杂模块不会进入配置包。
                  <Link to="/module" className="ml-1 text-morandi-slate underline underline-offset-2">先创建普通模块</Link>
                </div>
              ) : (
                <div className="mt-3 divide-y rounded-md border">
                  {modules.map((module) => {
                    const selected = moduleCodes.includes(module.code);
                    return (
                      <label key={module.code} className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-bg-subtle">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleValue(module.code, moduleCodes, setModuleCodes)}
                          className="h-4 w-4 accent-morandi-slate"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{module.name}</span>
                          <span className="block truncate text-xs text-text-muted">{module.code}</span>
                        </span>
                        <span className="shrink-0 text-right text-xs text-text-muted">
                          {module.semanticModel?.metrics.length ?? 0} 指标<br />
                          v{module.semanticModel?.version ?? 1}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-full flex-col p-5 sm:p-6">
            <SectionTitle icon={PlugZap} title="连接器要求" description="只记录连接器 ID 和精确版本，不导出连接密码。" />
            {loading ? (
              <InlineState icon={RefreshCw} text="正在读取连接器目录…" spinning />
            ) : connectors.length === 0 ? (
              <InlineState icon={AlertCircle} text="当前实例没有可用连接器档案。" />
            ) : (
              <div className="mt-3 divide-y rounded-md border">
                {connectors.map((connector) => (
                  <label key={connector.id} className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-bg-subtle">
                    <input
                      type="checkbox"
                      checked={connectorIds.includes(connector.id)}
                      onChange={() => toggleValue(connector.id, connectorIds, setConnectorIds)}
                      className="h-4 w-4 accent-morandi-slate"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{connector.label}</span>
                      <span className="block truncate text-xs text-text-muted">{connector.id}</span>
                    </span>
                    <span className="text-xs text-text-muted">{connector.adapter} · v{connector.version}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="mt-auto space-y-4 pt-6">
              <div className="grid grid-cols-2 gap-3 border-y py-4 text-sm">
                <SummaryNumber label="已选模块" value={moduleCodes.length} />
                <SummaryNumber label="连接器要求" value={connectorIds.length} />
              </div>
              <button type="submit" disabled={exportMutation.isPending || loading} className={cn(primaryButtonClass, "w-full")}>
                {exportMutation.isPending ? <RefreshCw size={16} className="animate-spin" /> : <PackageCheck size={16} />}
                {exportMutation.isPending ? "正在生成…" : "生成方案包"}
              </button>
              {exported && (
                <button type="button" onClick={() => downloadManifest(exported)} className={cn(secondaryButtonClass, "w-full")}>
                  <Download size={16} />
                  下载 {solutionDownloadFileName(exported)}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </form>
  );
}

function InstallSolutionPanel() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [manifest, setManifest] = useState<VerticalSolutionManifest | null>(null);
  const [validation, setValidation] = useState<SolutionValidationResult | null>(null);
  const [installed, setInstalled] = useState<SolutionInstallResult | null>(null);
  const [rolledBack, setRolledBack] = useState<SolutionRollbackResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const validateMutation = useMutation({
    mutationFn: async () => {
      const response: any = await api.post("/modules/solutions/validate", manifest);
      return response.data as SolutionValidationResult;
    },
    onSuccess: (result) => {
      setValidation(result);
      setNotice({
        kind: "success",
        text: result.readiness.operation === "upgrade"
          ? `兼容性检查通过，可从方案 v${result.readiness.currentSolutionVersion} 升级到 v${result.manifest.version}。`
          : "合同、连接器版本和目标模块冲突检查均已通过。",
      });
    },
    onError: (error) => {
      setValidation(null);
      setNotice({ kind: "error", text: solutionErrorMessage(error, "方案包校验失败") });
    },
  });

  const installMutation = useMutation({
    mutationFn: async () => {
      const response: any = await api.post("/modules/solutions/apply", {
        manifest,
        expectedModuleVersions: validation?.readiness.expectedModuleVersions ?? [],
      });
      return response.data as SolutionInstallResult;
    },
    onSuccess: (result) => {
      setInstalled(result);
      setRolledBack(null);
      setNotice({
        kind: "success",
        text: `${result.modules.length} 个模块已在一个事务中完成${result.operation === "upgrade" ? "升级" : "安装"}。`,
      });
      void queryClient.invalidateQueries({ queryKey: ["modules"] });
    },
    onError: (error) => {
      setInstalled(null);
      setNotice({ kind: "error", text: solutionErrorMessage(error, "方案包应用失败") });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async () => {
      if (!installed?.rollback) throw new Error("当前结果没有可用的回滚凭据");
      const response: any = await api.post("/modules/solutions/rollback", installed.rollback);
      return response.data as SolutionRollbackResult;
    },
    onSuccess: (result) => {
      setRolledBack(result);
      setNotice({
        kind: "success",
        text: `${result.modules.length} 个模块已原子回滚到方案 v${result.solutionVersion}。`,
      });
      void queryClient.invalidateQueries({ queryKey: ["modules"] });
    },
    onError: (error) => {
      setNotice({ kind: "error", text: solutionErrorMessage(error, "方案回滚失败") });
    },
  });

  const chooseFile = async (file: File | undefined) => {
    setManifest(null);
    setValidation(null);
    setInstalled(null);
    setRolledBack(null);
    setNotice(null);
    setFileName(file?.name ?? null);
    if (!file) return;
    if (file.size > MAX_SOLUTION_FILE_BYTES) {
      setNotice({ kind: "error", text: "方案包超过 2 MiB 前端读取限制。" });
      return;
    }
    try {
      const parsed = parseSolutionManifestText(await file.text());
      setManifest(parsed);
      setNotice({ kind: "info", text: "文件已读取；请继续执行目标实例校验。" });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "无法读取方案包",
      });
    }
  };

  const summary = useMemo(() => {
    if (!manifest) return null;
    return {
      moduleNames: manifest.modules.map((item) => item.module.name || item.module.code),
      connectorLabels: manifest.requiredConnectors.map((item) => `${item.id}@${item.version}`),
    };
  }, [manifest]);

  return (
    <div className="space-y-4">
      {notice && <NoticeBanner notice={notice} />}
      <section className="card p-0 overflow-hidden">
        <div className="grid lg:grid-cols-[minmax(19rem,0.72fr)_minmax(0,1fr)]">
          <div className="space-y-5 p-5 sm:p-6 lg:border-r">
            <SectionTitle icon={Upload} title="选择方案包" description="先在浏览器读取 JSON，再由目标实例执行完整校验。" />
            <label
              htmlFor="solution-package-file"
              className="flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-5 py-8 text-center transition hover:border-morandi-slate hover:bg-bg-subtle focus-within:ring-2 focus-within:ring-morandi-slate/30"
            >
              <FileJson size={32} className="mb-3 text-morandi-slate" />
              <span className="text-sm font-medium">{fileName ?? "选择 .solution.json 文件"}</span>
              <span className="mt-1 text-xs leading-5 text-text-muted">最大 2 MiB · 文件不会被保存为业务数据</span>
              <input
                ref={inputRef}
                id="solution-package-file"
                type="file"
                accept=".json,.solution.json,application/json"
                disabled={validateMutation.isPending || installMutation.isPending || rollbackMutation.isPending}
                className="sr-only"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </label>
            <button type="button" onClick={() => inputRef.current?.click()} className={cn(secondaryButtonClass, "w-full")}>
              <Upload size={16} />重新选择文件
            </button>

            <div className="space-y-2 border-t pt-4 text-xs leading-5 text-text-muted">
              <div className="flex gap-2"><KeyRound size={14} className="mt-0.5 shrink-0" />不导入账号、连接密码和 API Key</div>
              <div className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0" />不会覆盖不属于该方案的同名模块</div>
              <div className="flex gap-2"><Boxes size={14} className="mt-0.5 shrink-0" />首次安装后仍需分配本地文件并运行 ETL</div>
            </div>
          </div>

          <div className="flex min-h-[31rem] flex-col p-5 sm:p-6">
            <SectionTitle icon={PackageCheck} title="校验与应用" description="首次安装、兼容升级和回滚都在单个数据库事务中完成。" />
            {!manifest ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center text-sm text-text-muted">
                <FileJson size={30} className="mb-3 opacity-50" />
                选择方案包后，这里会显示模块和连接器要求
              </div>
            ) : (
              <div className="mt-4 space-y-5">
                <div className="border-b pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold">{manifest.label}</div>
                      <div className="mt-1 font-mono text-xs text-text-muted">{manifest.id}@{manifest.version}</div>
                    </div>
                    <div className="flex gap-2 text-xs">
                      <span className="rounded bg-morandi-sage/20 px-2 py-1 text-text-secondary">无业务数据</span>
                      <span className="rounded bg-morandi-sage/20 px-2 py-1 text-text-secondary">无密钥</span>
                    </div>
                  </div>
                  {manifest.description && <p className="mt-3 text-sm leading-6 text-text-secondary">{manifest.description}</p>}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <SummaryNumber label="方案模块" value={manifest.modules.length} />
                  <SummaryNumber label="连接器要求" value={manifest.requiredConnectors.length} />
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <SummaryList title="模块" items={summary?.moduleNames ?? []} empty="无模块" />
                  <SummaryList title="连接器" items={summary?.connectorLabels ?? []} empty="无连接器要求" />
                </div>

                {validation && !installed && (
                  <div className="flex gap-3 rounded-md border border-morandi-sage bg-morandi-sage/10 p-3 text-sm leading-5">
                    <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-morandi-sage" />
                    <div>
                      <div className="font-medium">
                        {validation.readiness.operation === "upgrade"
                          ? `可从方案 v${validation.readiness.currentSolutionVersion} 安全升级`
                          : "目标实例可安装"}
                      </div>
                      <div className="mt-0.5 text-xs text-text-muted">校验结果只对当前实例状态有效；执行时会再次检查模块版本。</div>
                    </div>
                  </div>
                )}

                {installed && (
                  <div className="rounded-md border border-morandi-sage bg-morandi-sage/10 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <CheckCircle2 size={17} />
                      {rolledBack
                        ? `已回滚至方案 v${rolledBack.solutionVersion}`
                        : installed.operation === "upgrade" ? "升级完成" : "安装完成"}
                    </div>
                    <div className="mt-3 divide-y border-y text-sm">
                      {(rolledBack?.modules ?? installed.modules).map((module) => (
                        <div key={module.code} className="flex items-center justify-between gap-3 py-2">
                          <span className="truncate">{module.code}</span>
                          <span className="shrink-0 text-xs text-text-muted">模块 v{module.version} · 语义 v{module.semanticModelVersion}</span>
                        </div>
                      ))}
                    </div>
                    {installed.rollback && !rolledBack && (
                      <button
                        type="button"
                        onClick={() => rollbackMutation.mutate()}
                        disabled={rollbackMutation.isPending}
                        className={cn(secondaryButtonClass, "mt-4 w-full")}
                      >
                        {rollbackMutation.isPending
                          ? <RefreshCw size={16} className="animate-spin" />
                          : <RotateCcw size={16} />}
                        {rollbackMutation.isPending
                          ? "回滚中…"
                          : `回滚到方案 v${installed.rollback.toSolutionVersion}`}
                      </button>
                    )}
                    <Link to="/module" className={cn(secondaryButtonClass, "mt-4 w-full")}>去模块管理分配数据</Link>
                  </div>
                )}
              </div>
            )}

            {manifest && !installed && (
              <div className="mt-auto flex flex-col gap-3 border-t pt-5 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => validateMutation.mutate()}
                  disabled={validateMutation.isPending || installMutation.isPending || rollbackMutation.isPending}
                  className={secondaryButtonClass}
                >
                  {validateMutation.isPending ? <RefreshCw size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                  {validateMutation.isPending ? "校验中…" : validation ? "重新校验" : "校验方案包"}
                </button>
                <button
                  type="button"
                  onClick={() => installMutation.mutate()}
                  disabled={!validation || installMutation.isPending || validateMutation.isPending || rollbackMutation.isPending}
                  className={primaryButtonClass}
                >
                  {installMutation.isPending ? <RefreshCw size={16} className="animate-spin" /> : <PackageCheck size={16} />}
                  {installMutation.isPending
                    ? validation?.readiness.operation === "upgrade" ? "升级中…" : "安装中…"
                    : validation?.readiness.operation === "upgrade"
                      ? `升级到方案 v${manifest.version}`
                      : `安装 ${manifest.modules.length} 个模块`}
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Boxes;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-morandi-slate">
        <Icon size={17} />
      </div>
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-0.5 text-xs leading-5 text-text-muted">{description}</p>
      </div>
    </div>
  );
}

function SummaryNumber({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SummaryList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-text-secondary">{title}</h3>
      <div className="mt-2 divide-y border-y">
        {items.length > 0 ? items.map((item, index) => (
          <div key={`${item}-${index}`} className="flex min-h-9 items-center gap-2 py-2 text-sm">
            <Check size={13} className="shrink-0 text-morandi-sage" />
            <span className="min-w-0 break-all">{item}</span>
          </div>
        )) : <div className="py-3 text-xs text-text-muted">{empty}</div>}
      </div>
    </div>
  );
}

function InlineState({
  icon: Icon,
  text,
  spinning = false,
}: {
  icon: typeof AlertCircle;
  text: string;
  spinning?: boolean;
}) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-dashed px-3 py-4 text-sm text-text-muted">
      <Icon size={16} className={cn("shrink-0", spinning && "animate-spin")} />
      {text}
    </div>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  const Icon = notice.kind === "success" ? CheckCircle2 : notice.kind === "error" ? AlertCircle : ShieldCheck;
  return (
    <div
      role={notice.kind === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm leading-5",
        notice.kind === "success" && "border-morandi-sage bg-morandi-sage/10",
        notice.kind === "error" && "border-red-200 bg-red-50 text-red-700",
        notice.kind === "info" && "border-morandi-sky bg-morandi-sky/10",
      )}
    >
      <Icon size={17} className="mt-0.5 shrink-0" />
      <span>{notice.text}</span>
    </div>
  );
}

function downloadManifest(manifest: VerticalSolutionManifest) {
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = solutionDownloadFileName(manifest);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
