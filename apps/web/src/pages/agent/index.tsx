import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Play, Sparkles, Clock, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, apiLong } from "@/lib/api";
import { cn } from "@/lib/utils";
import { filterRetiredModules } from "@/pages/module/types";
import { buildSourceSampleSql } from "./source-sql";

type Agent = {
  id: number;
  code: string;
  name: string;
  description: string;
  model: string;
  config?: { inputMode?: "sql" | "text" | "analysis"; maxTokens?: number; temperature?: number } | null;
};

type AgentRun = {
  id: number;
  agentId: number;
  status: "running" | "succeeded" | "failed";
  inputs: any;
  outputs: any;
  costCny: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
};

type FileItem = { id: number; name: string; config: { group?: string | null } };

export function AgentPage() {
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const r: any = await api.get("/agents");
      return r.data as Agent[];
    },
  });

  const { data: runs } = useQuery({
    queryKey: ["agent-runs"],
    queryFn: async () => {
      const r: any = await api.get("/agents/runs");
      return r.data as AgentRun[];
    },
    refetchInterval: 2000, // 2s 轮询，让运行中的状态自动更新
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">智能体</h1>
        <p className="text-text-muted text-sm mt-1">
          基于数据的 AI 应用 · DeepSeek V4 驱动
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {agents?.map((a) => (
          <div
            key={a.id}
            className="card group cursor-pointer hover:shadow-lg transition relative overflow-hidden"
            onClick={() => setActiveAgent(a)}
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-morandi-3 opacity-10 rounded-full -translate-y-12 translate-x-12" />
            <div className="relative">
              <div className="w-12 h-12 rounded-lg bg-morandi-3 flex items-center justify-center text-white mb-4">
                <Bot size={20} />
              </div>
              <div className="font-semibold mb-1">{a.name}</div>
              <div className="text-xs text-text-muted mb-3">{a.description}</div>
              <div className="flex items-center justify-between">
                <span className="text-xs px-2 py-0.5 bg-bg-subtle rounded text-text-secondary">
                  {a.model}
                </span>
                <button className="flex items-center gap-1 text-xs text-morandi-slate font-medium">
                  <Play size={11} />
                  运行
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 历史运行记录 */}
      {runs && runs.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium">运行历史</h2>
          </div>
          <div className="space-y-2">
            {runs.map((r) => (
              <div
                key={r.id}
                onClick={() => setActiveRun(r)}
                className="card flex items-center gap-3 py-3 hover:shadow-md hover:border-morandi-slate/50 cursor-pointer transition"
              >
                <RunStatusIcon status={r.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    任务 #{r.id} · {r.inputs?.modelTier === "pro" ? "深度版" : "快速版"}
                  </div>
                  <div className="text-xs text-text-muted">
                    {new Date(r.createdAt).toLocaleString("zh-CN")}
                  </div>
                </div>
                <div className="text-xs text-text-muted text-right shrink-0">
                  {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s · ¥${r.costCny}` : "—"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeAgent && (
        <RunModal
          agent={activeAgent}
          onClose={() => setActiveAgent(null)}
          onCompleted={(run) => {
            setActiveAgent(null);
            setActiveRun(run);
          }}
        />
      )}

      {activeRun && <RunDetailModal run={activeRun} onClose={() => setActiveRun(null)} />}
    </div>
  );
}

function RunStatusIcon({ status }: { status: AgentRun["status"] }) {
  if (status === "running") return <Loader2 size={16} className="text-morandi-slate animate-spin" />;
  if (status === "succeeded") return <CheckCircle2 size={16} className="text-green-600" />;
  return <XCircle size={16} className="text-red-600" />;
}

// 不同 text 模式智能体的输入提示
const TEXT_PLACEHOLDERS: Record<string, string> = {
  detail_page_copy:
    "例：\n品名：沃朗森男士能量护理凝胶\n核心卖点：植物配方、温和不刺激、48 小时长效\n规格：50ml/支\n目标人群：25-45 岁男性\n价格带：99-159 元\n平台：天猫",
  cs_script:
    "例：\n场景：客户收到货后反馈使用没效果，要求退货并语气不满\n产品：某保健护理类目\n客户情绪：较激动，提到要投诉",
};

function RunModal({
  agent,
  onClose,
  onCompleted,
}: {
  agent: Agent;
  onClose: () => void;
  onCompleted: (run: AgentRun) => void;
}) {
  const qc = useQueryClient();
  const isCompetitorAgent = agent.code === "competitor_analysis";
  const inputMode = isCompetitorAgent ? "analysis" : (agent.config?.inputMode ?? "sql");
  const [sqlText, setSqlText] = useState("");
  const [selectedSqlSourceId, setSelectedSqlSourceId] = useState("");
  const [brief, setBrief] = useState("");
  const [tier, setTier] = useState<"flash" | "pro">("flash");
  // analysis 模式：scopeMode (group/multi-file/module) + 分析模式 + 维度
  const [scopeMode, setScopeMode] = useState<"group" | "multi-file" | "module">("multi-file");
  const [selectedGroup, setSelectedGroup] = useState("");
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(new Set());
  const [selectedModule, setSelectedModule] = useState("");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [analyzeMode, setAnalyzeMode] = useState<"auto" | "custom">(
    isCompetitorAgent ? "custom" : "auto",
  );
  const [dimensions, setDimensions] = useState("");

  const { data: files } = useQuery({
    queryKey: ["files"],
    queryFn: async () => {
      const r: any = await api.get("/files");
      return r.data as FileItem[];
    },
    enabled: inputMode === "analysis" || inputMode === "sql",
  });

  // V0.18：模块列表
  const { data: mods } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const r: any = await api.get("/modules");
      return filterRetiredModules(
        r.data as Array<{ code: string; name: string; outputTable: string }>,
      );
    },
    enabled: inputMode === "analysis" && !isCompetitorAgent,
  });

  const groupNames = [...new Set((files ?? []).map((f) => f.config?.group).filter(Boolean) as string[])].sort();
  const filesByGroup: Record<string, FileItem[]> = {};
  for (const f of files ?? []) {
    const g = f.config?.group ?? "（未分组）";
    if (!filesByGroup[g]) filesByGroup[g] = [];
    filesByGroup[g].push(f);
  }

  function toggleFile(id: number) {
    const next = new Set(selectedFileIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedFileIds(next);
  }
  function toggleGroupAllFiles(groupName: string) {
    const groupFiles = filesByGroup[groupName] ?? [];
    const allSelected = groupFiles.every((f) => selectedFileIds.has(f.id));
    const next = new Set(selectedFileIds);
    groupFiles.forEach((f) => (allSelected ? next.delete(f.id) : next.add(f.id)));
    setSelectedFileIds(next);
  }

  const runMut = useMutation({
    mutationFn: async () => {
      let body: any;
      if (inputMode === "sql") body = { datasetSql: sqlText, modelTier: tier };
      else if (inputMode === "analysis") {
        body = { modelTier: tier, mode: analyzeMode, question: dimensions };
        if (scopeMode === "multi-file" && selectedFileIds.size > 0) {
          body.sourceIds = [...selectedFileIds];
        } else if (scopeMode === "group" && selectedGroup) {
          body.group = selectedGroup;
        } else if (scopeMode === "module" && selectedModule) {
          body.moduleCode = selectedModule;
        }
      } else body = { inputText: brief, modelTier: tier };
      const r: any = await apiLong.post(`/agents/${agent.code}/run`, body);
      return r.data;
    },
    onSuccess: (run: AgentRun) => {
      qc.invalidateQueries({ queryKey: ["agent-runs"] });
      onCompleted(run);
    },
  });

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-card rounded-lg w-[640px] max-w-full shadow-2xl">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div>
            <div className="font-medium flex items-center gap-2">
              <Sparkles size={16} className="text-morandi-slate" />
              运行：{agent.name}
            </div>
            <div className="text-xs text-text-muted mt-0.5">{agent.description}</div>
          </div>
          <button onClick={onClose} className="text-text-muted">×</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {inputMode === "analysis" ? (
            isCompetitorAgent ? (
              <>
                <div>
                  <label className="mb-1.5 block text-sm text-text-secondary">选择竞品数据文件</label>
                  <select
                    value={[...selectedFileIds][0] ?? ""}
                    onChange={(event) => {
                      const sourceId = Number(event.target.value);
                      setSelectedFileIds(Number.isSafeInteger(sourceId) && sourceId > 0 ? new Set([sourceId]) : new Set());
                    }}
                    disabled={runMut.isPending}
                    className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm focus:border-morandi-slate focus:outline-none"
                  >
                    <option value="">请选择已上传的结构化竞品文件</option>
                    {(files ?? []).map((file) => (
                      <option key={file.id} value={file.id}>{file.name}</option>
                    ))}
                  </select>
                  {!files?.length && (
                    <div className="mt-1.5 text-xs text-amber-700">当前没有可分析文件，请先到“数据”页面上传竞品表格。</div>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-sm text-text-secondary">你想了解什么</label>
                  <textarea
                    rows={5}
                    className="w-full rounded-md border px-3 py-2 text-sm focus:border-morandi-slate focus:outline-none"
                    value={dimensions}
                    onChange={(event) => setDimensions(event.target.value)}
                    disabled={runMut.isPending}
                    placeholder="例如：比较各竞品的价格带、评论痛点和核心卖点，找出我们最值得切入的差异化机会。"
                  />
                </div>
              </>
            ) : (
              <>
              <div>
                <label className="block text-sm text-text-secondary mb-1.5">分析数据范围</label>
                <div
                  className="flex items-center justify-between px-3 py-2 border rounded-md cursor-pointer hover:bg-bg-subtle transition"
                  onClick={() => setScopeOpen(!scopeOpen)}
                >
                  <span className="text-sm">
                    {scopeMode === "module"
                      ? selectedModule
                        ? `模块：${mods?.find((m) => m.code === selectedModule)?.name ?? selectedModule}`
                        : "请选择模块"
                      : scopeMode === "group"
                      ? selectedGroup
                        ? `分组：${selectedGroup}`
                        : "请选择分组"
                      : selectedFileIds.size
                        ? `已选 ${selectedFileIds.size} 个文件`
                        : "请勾选文件"}
                  </span>
                  <span className="text-xs text-text-muted">{scopeOpen ? "▲" : "▼"}</span>
                </div>

                {scopeOpen && (
                  <div className="border border-t-0 rounded-b-md px-3 py-2 max-h-[300px] overflow-y-auto">
                    {/* 按模块（V0.18，最高优先级；模块级数据已 JOIN/计算字段完成）*/}
                    {mods && mods.length > 0 && (
                      <>
                        <label className="flex items-center gap-2 text-xs py-1 cursor-pointer hover:bg-bg-subtle px-1 rounded">
                          <input
                            type="radio"
                            checked={scopeMode === "module"}
                            onChange={() => setScopeMode("module")}
                            className="w-3 h-3"
                          />
                          <span>按模块（业务汇总表，含计算字段和关联字段）</span>
                        </label>
                        {scopeMode === "module" && (
                          <div className="ml-5 space-y-1 mt-1">
                            {mods.map((m) => (
                              <label
                                key={m.code}
                                className="flex items-center gap-2 text-xs py-0.5 pl-2 cursor-pointer hover:bg-bg-subtle rounded"
                              >
                                <input
                                  type="radio"
                                  name="module"
                                  checked={selectedModule === m.code}
                                  onChange={() => setSelectedModule(m.code)}
                                  className="w-3 h-3"
                                />
                                <span>
                                  {m.name} <code className="text-text-muted">({m.outputTable})</code>
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                        <div className="border-t my-2" />
                      </>
                    )}

                    {/* 按分组 */}
                    <label className="flex items-center gap-2 text-xs py-1 cursor-pointer hover:bg-bg-subtle px-1 rounded">
                      <input
                        type="radio"
                        checked={scopeMode === "group"}
                        onChange={() => setScopeMode("group")}
                        className="w-3 h-3"
                      />
                      <span>按分组（整批分析）</span>
                    </label>
                    {scopeMode === "group" && groupNames.length > 0 && (
                      <div className="ml-5 space-y-1 mt-1">
                        {groupNames.map((g) => (
                          <label
                            key={g}
                            className="flex items-center gap-2 text-xs py-0.5 pl-2 cursor-pointer hover:bg-bg-subtle rounded"
                          >
                            <input
                              type="radio"
                              name="group"
                              checked={selectedGroup === g}
                              onChange={() => setSelectedGroup(g)}
                              className="w-3 h-3"
                            />
                            <span>{g}</span>
                          </label>
                        ))}
                      </div>
                    )}

                    <div className="border-t my-2" />

                    {/* 多文件选择 */}
                    <label className="flex items-center gap-2 text-xs py-1 cursor-pointer hover:bg-bg-subtle px-1 rounded">
                      <input
                        type="radio"
                        checked={scopeMode === "multi-file"}
                        onChange={() => setScopeMode("multi-file")}
                        className="w-3 h-3"
                      />
                      <span>多文件选择</span>
                    </label>
                    {scopeMode === "multi-file" && (
                      <div className="ml-5 space-y-1 mt-1">
                        {Object.entries(filesByGroup).map(([g, items]) => (
                          <div key={g}>
                            <label className="flex items-center gap-2 text-xs py-0.5 cursor-pointer hover:bg-bg-subtle px-2 rounded">
                              <input
                                type="checkbox"
                                checked={items.every((f) => selectedFileIds.has(f.id))}
                                onChange={() => toggleGroupAllFiles(g)}
                                className="w-3 h-3"
                              />
                              <strong>{g}</strong>
                              <span className="text-text-muted">({items.length})</span>
                            </label>
                            <div className="ml-4 space-y-0.5">
                              {items.map((f) => (
                                <label
                                  key={f.id}
                                  className="flex items-center gap-2 text-xs py-0.5 cursor-pointer hover:bg-bg-subtle px-2 rounded"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedFileIds.has(f.id)}
                                    onChange={() => toggleFile(f.id)}
                                    className="w-3 h-3"
                                  />
                                  <span className="truncate" title={f.name}>{f.name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm text-text-secondary mb-1.5">分析方式</label>
                <div className="flex gap-2">
                  {[
                    { code: "auto", label: "AI 自动分析" },
                    { code: "custom", label: "自定义维度" },
                  ].map((m) => (
                    <button
                      key={m.code}
                      onClick={() => setAnalyzeMode(m.code as any)}
                      disabled={runMut.isPending}
                      className={cn(
                        "flex-1 px-3 py-2 text-sm rounded-md border transition",
                        analyzeMode === m.code ? "bg-morandi-3 text-white border-transparent" : "hover:bg-bg-subtle",
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              {analyzeMode === "custom" && (
                <div>
                  <label className="block text-sm text-text-secondary mb-1.5">分析维度（逗号分隔）</label>
                  <textarea
                    rows={3}
                    className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:border-morandi-slate"
                    value={dimensions}
                    onChange={(e) => setDimensions(e.target.value)}
                    disabled={runMut.isPending}
                    placeholder="例：价格分布、卖点对比、销量结构、滞销预警、改进建议"
                  />
                </div>
              )}
              </>
            )
          ) : inputMode === "sql" ? (
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-sm text-text-secondary">
                  选择要分析的数据文件
                </label>
                <select
                  value={selectedSqlSourceId}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSelectedSqlSourceId(value);
                    setSqlText(value ? buildSourceSampleSql(Number(value)) : "");
                  }}
                  disabled={runMut.isPending}
                  className="w-full rounded-md border bg-bg-card px-3 py-2 text-sm focus:border-morandi-slate focus:outline-none"
                >
                  <option value="">请选择已上传的文件</option>
                  {(files ?? []).map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.name}
                    </option>
                  ))}
                </select>
                <div className="mt-1.5 text-xs leading-5 text-text-muted">
                  这里读取所选文件的前 30 行作为分析样本。若找不到文件，请先到「数据」页面上传并确认内容。
                </div>
              </div>
              <details className="rounded-md border bg-bg-subtle/40 px-3 py-2">
                <summary className="cursor-pointer text-xs text-text-secondary">
                  高级设置：查看或修改数据 SQL
                </summary>
                <textarea
                  rows={5}
                  className="mt-2 w-full rounded-md border bg-bg-card px-3 py-2 font-mono text-xs focus:border-morandi-slate focus:outline-none"
                  value={sqlText}
                  onChange={(e) => setSqlText(e.target.value)}
                  disabled={runMut.isPending}
                />
                <div className="mt-1 text-xs text-text-muted">
                  仅支持平台允许的只读查询，提交给智能体的数据最多 30 行。
                </div>
              </details>
            </div>
          ) : (
            <div>
              <label className="block text-sm text-text-secondary mb-1.5">输入需求说明</label>
              <textarea
                rows={7}
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:border-morandi-slate whitespace-pre-wrap"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                disabled={runMut.isPending}
                placeholder={TEXT_PLACEHOLDERS[agent.code] ?? "描述你的需求…"}
              />
              <div className="text-xs text-text-muted mt-1">
                把产品信息 / 场景描述清楚，智能体会按固定框架产出
              </div>
            </div>
          )}
          <div>
            <label className="block text-sm text-text-secondary mb-1.5">模型档位</label>
            <div className="flex gap-2">
              {[
                { code: "flash", label: "快速版 · 日常分析", color: "bg-morandi-2" },
                { code: "pro", label: "深度版 · 复杂分析", color: "bg-morandi-1" },
              ].map((t) => (
                <button
                  key={t.code}
                  onClick={() => setTier(t.code as any)}
                  disabled={runMut.isPending}
                  className={cn(
                    "flex-1 px-3 py-2 text-sm rounded-md border transition",
                    tier === t.code ? `${t.color} text-white border-transparent` : "hover:bg-bg-subtle",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          {runMut.isError && (
            <div className="px-3 py-2 bg-red-50 text-red-700 text-sm rounded-md">
              {(runMut.error as any)?.message || "运行失败"}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={runMut.isPending}
            className="px-4 py-2 text-sm border rounded-md hover:bg-bg-subtle"
          >
            取消
          </button>
          <button
            onClick={() => runMut.mutate()}
            disabled={
              runMut.isPending ||
              (inputMode === "sql" && !sqlText.trim()) ||
              (inputMode === "text" && !brief.trim()) ||
              (inputMode === "analysis" &&
                ((scopeMode === "multi-file" && selectedFileIds.size === 0) ||
                  (scopeMode === "group" && !selectedGroup) ||
                  (scopeMode === "module" && !selectedModule) ||
                  (analyzeMode === "custom" && !dimensions.trim())))
            }
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-morandi-3 text-white rounded-md hover:opacity-90 disabled:opacity-50 transition"
          >
            {runMut.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> AI 思考中…（约 8-30 秒）
              </>
            ) : (
              <>
                <Play size={14} /> 开始运行
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunDetailModal({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const content = run.outputs?.content as string | undefined;
  const reasoning = run.outputs?.reasoning as string | undefined;
  const error = run.outputs?.error as string | undefined;
  const usage = run.outputs?.usage as any;
  const [showReasoning, setShowReasoning] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-card rounded-lg w-[860px] max-w-full shadow-2xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between shrink-0">
          <div>
            <div className="font-medium flex items-center gap-2">
              <RunStatusIcon status={run.status} />
              任务 #{run.id} ·{" "}
              <span className="text-text-muted text-sm">
                {run.inputs?.modelTier === "pro" ? "深度版" : "快速版"} · {run.outputs?.model}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-0.5 flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Clock size={11} />
                {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}
              </span>
              {run.costCny && <span>成本 ¥{run.costCny}</span>}
              {usage && (
                <span>
                  {usage.prompt_tokens}+{usage.completion_tokens} 个令牌
                  {usage.completion_tokens_details?.reasoning_tokens > 0 &&
                    ` (${usage.completion_tokens_details.reasoning_tokens} 思考)`}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5">
          {error && (
            <div className="px-3 py-2 bg-red-50 text-red-700 text-sm rounded-md mb-4">{error}</div>
          )}
          {reasoning && (
            <div className="mb-4">
              <button
                onClick={() => setShowReasoning((v) => !v)}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                {showReasoning ? "▼" : "▶"} 思考链 ({reasoning.length} 字)
              </button>
              {showReasoning && (
                <div className="mt-2 p-3 bg-bg-subtle rounded-md text-xs text-text-secondary whitespace-pre-wrap">
                  {reasoning}
                </div>
              )}
            </div>
          )}
          {content && (
            <article className="prose prose-sm max-w-none prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h2:border-b prose-h2:pb-1 prose-table:text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
