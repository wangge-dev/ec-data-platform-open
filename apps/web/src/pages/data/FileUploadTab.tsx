import { useEffect, useState, useRef } from "react";
import { useDropzone } from "react-dropzone";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Upload,
  FileSpreadsheet,
  Trash2,
  Eye,
  AlertCircle,
  Loader2,
  FolderUp,
  CheckSquare,
  Square,
  Boxes,
  BookOpen,
  HelpCircle,
  Plus,
  Play,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { cn } from "@/lib/utils";
import { ModuleBuilderDialog } from "@/pages/module/module-builder/ModuleBuilderDialog";
import { SchemaChangeDialog } from "@/pages/module/module-builder/SchemaChangeDialog";
import { builderFailureMessage } from "@/pages/module/module-builder/model";
import { filterRetiredModules } from "@/pages/module/types";

// 与服务端 files.ts 阈值保持一致
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB
const MAX_LARGE_CSV_BYTES = 512 * 1024 * 1024;
const ACCEPT_RE = /\.(xlsx|xls|csv)$/i;

type UploadOptions = {
  sheetMode?: "first" | "all";
  shapeMode?: "table" | "date-columns-to-rows";
  headerRows?: 1 | 2 | 3;
  headerStartRow?: number;
  streamLargeCsv?: boolean;
  expectedRows?: number;
};

type Attribution =
  | {
      kind: "module";
      moduleCode: string;
      moduleName: string;
      platformCode: string;
      platformName: string;
      label: string;
    }
  | { kind: "dict"; role: string; label: string }
  | { kind: "unmatched"; label: string };

type FileRow = {
  id: number;
  name: string;
  config: {
    rowCount: number;
    columns: any[];
    originalFileName: string;
    parentOriginalFileName?: string;
    sheetName?: string;
    quality?: {
      blankRowsSkipped?: number;
      status?: "ok" | "warning";
    };
    transform?: {
      mode?: "date-columns-to-rows";
      sourceRows?: number;
      outputRows?: number;
    };
    headerProcessing?: {
      mode?: "merge-header-rows";
      headerRows?: 2 | 3;
    };
    group?: string | null;
    schemaReview?: {
      status: "pending" | "awaiting_retry";
      moduleCode: string;
    };
  };
  createdAt: string;
  attribution?: Attribution;
};

export function FileUploadTab() {
  const qc = useQueryClient();
  const [uploadName, setUploadName] = useState("");
  const [asBrandDict, setAsBrandDict] = useState(false);
  const [dictRole, setDictRole] = useState<string>("brand_dict"); // B7 (V0.24)：字典 role 下拉，不止 brand_dict
  const [selModuleCode, setSelModuleCode] = useState<string>(""); // V0.27：归属模块（空=自动识别）
  const [sheetMode, setSheetMode] = useState<"first" | "all">("first");
  const [shapeMode, setShapeMode] = useState<"table" | "date-columns-to-rows">("table");
  const [headerRows, setHeaderRows] = useState<1 | 2 | 3>(1);
  const [headerStartRow, setHeaderStartRow] = useState("");
  const [streamLargeCsv, setStreamLargeCsv] = useState(false);
  const [expectedRows, setExpectedRows] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [folderProgress, setFolderProgress] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [builderOpen, setBuilderOpen] = useState(false);
  const [existingModuleCode, setExistingModuleCode] = useState("");
  const [schemaReviewFile, setSchemaReviewFile] = useState<FileRow | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const token = useAuth((s) => s.token);
  const isAdmin = useAuth((s) => s.user?.isAdmin === true);

  const { data, isLoading } = useQuery({
    queryKey: ["files"],
    queryFn: async () => {
      const r: any = await api.get("/files");
      return r.data as FileRow[];
    },
  });

  // V0.27：拉模块列表给"归属模块"下拉用（只列非字典的业务模块）
  const { data: modules } = useQuery({
    queryKey: ["modules"],
    queryFn: async () => {
      const r: any = await api.get("/modules");
      return filterRetiredModules(r.data as any[]).filter(
        (m) => m.enabled && !m.isDict,
      );
    },
  });

  useEffect(() => {
    if (!data) return;
    const available = new Set(data.map((file) => file.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [data]);

  async function uploadOne(
    file: File,
    name: string,
    role: string,
    group: string | null,
    moduleCode?: string,
    options: UploadOptions = {},
  ) {
    let res: Response;
    if (options.streamLargeCsv) {
      const query = new URLSearchParams({
        filename: file.name,
        name,
        role,
        replaceExisting: isAdmin ? "true" : "false",
        expectedRows: String(options.expectedRows),
      });
      if (group) query.set("group", group);
      if (moduleCode) query.set("moduleCode", moduleCode);
      res = await fetch(`/api/files/upload-large-csv?${query.toString()}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/csv",
        },
        body: file,
      });
    } else {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", name);
      fd.append("role", role);
      fd.append("sheetMode", options.sheetMode ?? "first");
      fd.append("shapeMode", options.shapeMode ?? "table");
      fd.append("headerRows", String(options.headerRows ?? 1));
      if (options.headerStartRow !== undefined) {
        fd.append("headerStartRow", String(options.headerStartRow));
      }
      if (group) fd.append("group", group);
      if (moduleCode) fd.append("moduleCode", moduleCode);
      res = await fetch("/api/files/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
    }
    const json = await res.json();
    if (!json.ok) throw new Error(json.message || "上传失败");

    // B1 (V0.24)：上传完自动跑 ETL，让文件立刻出现在对应模块工作台
    // 字典（role != 'file'）跳过 ETL，字典直接生效不需要加工
    const importedSources = Array.isArray(json.data?.sources)
      ? json.data.sources
      : json.data?.sourceId
        ? [json.data]
        : [];
    if (role === "file" && importedSources.length > 0) {
      const etlReports: any[] = [];
      for (const source of importedSources) {
        try {
          const etlRes = await fetch(`/api/etl/run/${source.sourceId}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
          const etlJson = await etlRes.json();
          if (etlJson?.ok && etlJson?.data) {
            etlReports.push(etlJson.data);
          } else if (!etlJson?.ok && typeof etlJson?.message === "string" && etlJson.message.includes("不属于任何已启用的模块")) {
            json.data.unmatched = true;
          }
        } catch {
          // 文件已安全入库；ETL 可从文件列表或模块页重试。
        }
      }
      json.data.etlReports = etlReports;
      if (etlReports.length === 1) json.data.etlReport = etlReports[0];
    }

    return json.data;
  }

  // B2 (V0.24)：ETL 跑完后要刷新的所有 query
  // 上传完文件 → 入 uf 表 → 自动 ETL → unified_<code> 有新数据
  // 这些缓存都要清，否则模块工作台/分析中心/看板都看到旧数据
  function invalidateAfterEtl() {
    qc.invalidateQueries({ queryKey: ["files"] });
    qc.invalidateQueries({ queryKey: ["modules"] });
    qc.invalidateQueries({ queryKey: ["module-stats"] });
    qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    qc.invalidateQueries({ queryKey: ["analytics-top-shops"] });
    qc.invalidateQueries({ queryKey: ["alerts"] });
    qc.invalidateQueries({ queryKey: ["etl-summary"] });
    qc.invalidateQueries({ queryKey: ["metrics-compare"] });
    qc.invalidateQueries({ queryKey: ["metrics-dates"] });
    // 看板用 charts + chart-render
    qc.invalidateQueries({ queryKey: ["charts"] });
    qc.invalidateQueries({ queryKey: ["chart-render"] });
  }

  const uploadMut = useMutation({
    mutationFn: ({
      file,
      name,
      role,
      moduleCode,
      options,
    }: {
      file: File;
      name: string;
      role: string;
      moduleCode?: string;
      options?: UploadOptions;
    }) => uploadOne(file, name, role, null, moduleCode, options),
    onSuccess: (d) => {
      const etlReports = Array.isArray(d.etlReports) ? d.etlReports : d.etlReport ? [d.etlReport] : [];
      const etlMsg = d.etlReport
        ? d.etlReport.error
          ? ` · ${builderFailureMessage(d.etlReport.error)}`
          : ` · 已识别为 ${d.etlReport.platform}，写入 ${d.etlReport.inserted}/${d.etlReport.total} 行`
        : "";
      const qualityItems = Array.isArray(d.sources) ? d.sources : [d];
      const blankRowsSkipped = qualityItems.reduce(
        (sum: number, item: any) => sum + Number(item?.quality?.blankRowsSkipped ?? 0),
        0,
      );
      const uploadSummary = Array.isArray(d.sources)
        ? `已拆分 ${d.sheetCount} 个工作表 · 共 ${d.rowCount} 行`
        : `已上传 ${d.rowCount} 行 · ${d.columns?.length ?? 0} 列`;
      const qualityMsg = blankRowsSkipped > 0 ? ` · 已拦截 ${blankRowsSkipped} 个空行` : "";
      const multiEtlMsg = etlReports.length > 1 ? ` · 已处理 ${etlReports.length} 个数据源` : etlMsg;
      setSuccess(`${uploadSummary}${qualityMsg}${multiEtlMsg}`);
      if (d.unmatched) {
        setError(`「${d.originalFileName ?? d.name}」尚未归入模块。请在下方选中文件后新建模块，或归入已有模块。`);
      } else {
        setError(null);
      }
      setUploadName("");
      invalidateAfterEtl();
      setTimeout(() => setSuccess(null), 5000);
    },
    onError: (uploadError) => setError(uploadError instanceof Error ? uploadError.message : "上传失败，请稍后重试"),
  });

  // 文件夹上传：把文件夹下的 xlsx/xls/csv 逐个串行导入，以顶层文件夹名为分组
  async function handleFolderPick(e: React.ChangeEvent<HTMLInputElement>) {
    const all = Array.from(e.target.files || []);
    e.target.value = ""; // 允许再次选同一文件夹
    const files = all.filter((f) => ACCEPT_RE.test(f.name) && f.size <= MAX_UPLOAD_BYTES);
    if (!files.length) {
      setError("该文件夹下没有可导入的 .xlsx/.xls/.csv 文件");
      return;
    }
    const rel = (files[0] as any).webkitRelativePath as string | undefined;
    const group = rel?.split("/")[0] || "未命名文件夹";
    setError(null);
    setSuccess(null);
    let ok = 0;
    const fails: string[] = [];
    // 逐文件收集 ETL 结果，最后显式汇总（避免个别文件静默漏跑）
    const etlOk: string[] = [];
    const unmatched: string[] = [];
    const etlFail: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setFolderProgress(`上传中 ${i + 1}/${files.length}：${files[i].name}`);
      try {
        const d = await uploadOne(files[i], files[i].name.replace(/\.[^.]+$/, ""), "file", group);
        ok++;
        if (d?.etlReport?.error) {
          etlFail.push(files[i].name);
        } else if (d?.etlReport) {
          etlOk.push(`${d.etlReport.platform} ${d.etlReport.inserted}/${d.etlReport.total} 行`);
        } else if (d?.unmatched) {
          unmatched.push(files[i].name);
        }
      } catch (err: any) {
        fails.push(files[i].name);
      }
      // 每个文件跑完就刷新一次，看板/分析中心增量可见（不必等整批结束）
      invalidateAfterEtl();
    }
    setFolderProgress(null);
    invalidateAfterEtl();
    // 显式汇总：上传数 + 入库 + 未匹配 + 失败，别让漏跑无声无息
    const parts = [`文件夹「${group}」：上传 ${ok}/${files.length}`];
    if (etlOk.length) parts.push(`入库 ${etlOk.length} 个`);
    if (unmatched.length) parts.push(`未匹配 ${unmatched.length} 个`);
    if (etlFail.length) parts.push(`ETL 失败 ${etlFail.length} 个`);
    setSuccess(parts.join(" · "));
    const problems: string[] = [];
    if (fails.length) problems.push(`上传失败：${fails.slice(0, 3).join("；")}`);
    if (etlFail.length) problems.push(`处理失败：${etlFail.slice(0, 3).join("；")}，可稍后重试`);
    if (unmatched.length)
      problems.push(`尚未归入模块（请在下方选中后处理）：${unmatched.slice(0, 3).join(" / ")}`);
    if (problems.length) setError(problems.join("　|　"));
    setTimeout(() => setSuccess(null), 8000);
  }

  const batchDeleteMut = useMutation({
    mutationFn: (ids: number[]) => api.post("/files/batch-delete", { ids }),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });

  const assignMut = useMutation({
    mutationFn: async ({
      moduleCode,
      sourceIds,
    }: {
      moduleCode: string;
      sourceIds: number[];
    }) => {
      const response: any = await api.post(
        `/modules/${moduleCode}/assign-and-run`,
        { sourceIds },
      );
      return response.data;
    },
    onSuccess: (result: any) => {
      const succeeded = (result.files ?? []).filter(
        (file: any) => file.status === "success",
      ).length;
      const failed = (result.files ?? []).length - succeeded;
      setSuccess(
        failed > 0
          ? `已归入 ${succeeded} 个文件，${failed} 个处理失败`
          : `已归入并处理 ${succeeded} 个文件`,
      );
      setError(
        failed > 0
          ? "部分文件未处理完成，可查看模块工作台中的结果后重试。"
          : null,
      );
      setSelected(new Set());
      invalidateAfterEtl();
    },
    onError: () => setError("归入模块失败，请稍后重试"),
  });

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel": [".xls"],
      "text/csv": [".csv"],
    },
    multiple: false,
    maxSize: MAX_LARGE_CSV_BYTES,
    onDrop: (acceptedFiles) => {
      const file = acceptedFiles[0];
      if (!file) return;
      setError(null);
      const isCsv = /\.csv$/i.test(file.name);
      const shouldStream = streamLargeCsv || file.size > MAX_UPLOAD_BYTES;
      const parsedExpectedRows = Number(expectedRows.trim());
      const parsedHeaderStartRow = Number(headerStartRow.trim());
      if (
        headerStartRow.trim()
        && (!Number.isSafeInteger(parsedHeaderStartRow) || parsedHeaderStartRow < 1 || parsedHeaderStartRow > 999999)
      ) {
        setError("表头起始行必须是 1 到 999999 的整数");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES && !isCsv) {
        setError("Excel 超过 30MB，请先转为 CSV；大文件流式入口只接收 CSV");
        return;
      }
      if (shouldStream && !isAdmin) {
        setError("大文件流式导入仅允许管理员执行");
        return;
      }
      if (shouldStream && !isCsv) {
        setError("大文件流式导入只支持 CSV");
        return;
      }
      if (shouldStream && (!Number.isSafeInteger(parsedExpectedRows) || parsedExpectedRows < 1)) {
        setError("流式导入前请填写 CSV 的准确数据行数（不含表头）");
        return;
      }
      if (shouldStream && (
        sheetMode !== "first"
        || shapeMode !== "table"
        || headerRows !== 1
        || headerStartRow.trim()
      )) {
        setError("流式 CSV 采用原样导入，不能同时拆分工作表、合并表头或宽表转长表");
        return;
      }
      if (sheetMode === "all" && !/\.xlsx?$/i.test(file.name)) {
        setError("多工作表拆分仅适用于 .xlsx / .xls");
        return;
      }
      const name = uploadName.trim() || file.name.replace(/\.[^.]+$/, "");
      uploadMut.mutate({
        file,
        name,
        role: asBrandDict ? dictRole : "file",
        moduleCode: asBrandDict ? undefined : selModuleCode || undefined,
        options: {
          sheetMode,
          shapeMode,
          headerRows,
          ...(headerStartRow.trim() ? { headerStartRow: parsedHeaderStartRow } : {}),
          streamLargeCsv: shouldStream,
          ...(shouldStream ? { expectedRows: parsedExpectedRows } : {}),
        },
      });
    },
    onDropRejected: (rejections) => {
      const code = rejections[0]?.errors[0]?.code;
      if (code === "file-too-large") setError(`文件超过 ${MAX_LARGE_CSV_BYTES / 1024 / 1024}MB 上限`);
      else if (code === "file-invalid-type") setError("仅支持 .xlsx / .xls / .csv");
      else setError("文件无法上传");
      setSuccess(null);
    },
  });

  // 按分组聚合
  const groups = new Map<string, FileRow[]>();
  for (const f of data ?? []) {
    const g = f.config?.group || "（未分组）";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }

  function toggle(id: number) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }
  const allIds = (data ?? []).map((f) => f.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const selectedUnmatchedIds = (data ?? [])
    .filter(
      (file) =>
        selected.has(file.id) && file.attribution?.kind === "unmatched",
    )
    .map((file) => file.id);

  return (
    <div className="space-y-5">
      <ModuleBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        initialSourceIds={selectedUnmatchedIds}
        sourceOptions={data}
        onSuccess={() => setSelected(new Set())}
      />
      {schemaReviewFile?.config.schemaReview && (
        <SchemaChangeDialog
          open
          onOpenChange={(open) => {
            if (!open) setSchemaReviewFile(null);
          }}
          moduleCode={schemaReviewFile.config.schemaReview.moduleCode}
          sourceId={schemaReviewFile.id}
          fileName={schemaReviewFile.config.originalFileName || schemaReviewFile.name}
          moduleColumns={
            modules?.find(
              (module: any) =>
                module.code === schemaReviewFile.config.schemaReview?.moduleCode,
            )?.columns ?? []
          }
        />
      )}
      <div>
        <div className="text-sm text-text-secondary mb-3">
          上传 Excel/CSV，自动建表落 PG，第一行为列名。支持单文件拖拽，也支持选整个文件夹批量导入。
        </div>

        <div className="space-y-3">
          <div className="flex gap-2 items-center flex-wrap">
            <input
              className="flex-1 min-w-[200px] max-w-md px-3 py-2 border rounded-md text-sm focus:outline-none focus:border-morandi-slate"
              placeholder="数据集名称（单文件上传用，留空用文件名）"
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
            />
            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={!!folderProgress}
              className="flex items-center gap-2 px-3.5 py-2 border border-morandi-slate/40 text-morandi-slate text-sm rounded-md hover:bg-morandi-slate/5 disabled:opacity-50 transition shrink-0"
            >
              {folderProgress ? <Loader2 size={16} className="animate-spin" /> : <FolderUp size={16} />}
              上传文件夹
            </button>
            {/* webkitdirectory 不是标准属性，用 ref + 原生 input */}
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-expect-error 非标准但浏览器支持
              webkitdirectory=""
              directory=""
              className="hidden"
              onChange={handleFolderPick}
            />
          </div>

          {isAdmin && (
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={asBrandDict}
                onChange={(e) => {
                  setAsBrandDict(e.target.checked);
                  if (e.target.checked) {
                    setSheetMode("first");
                    setShapeMode("table");
                    setHeaderRows(1);
                    setHeaderStartRow("");
                    setStreamLargeCsv(false);
                  }
                }}
              />
              作为品牌维护表导入（品牌字典，用于订单匹配品牌，行数上限放宽到 10 万）
            </label>
          )}

          {!asBrandDict && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <span className="shrink-0">归属模块：</span>
              <select
                value={selModuleCode}
                onChange={(e) => setSelModuleCode(e.target.value)}
                className="px-2 py-1.5 border border-morandi-slate/40 rounded-md text-sm bg-bg focus:outline-none focus:border-morandi-slate max-w-[240px]"
                title="可指定归入已有模块；留空时按文件名自动识别"
              >
                <option value="">自动识别（按文件名匹配）</option>
                {(modules ?? []).map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.name}
                  </option>
                ))}
              </select>
              {selModuleCode && (
                <button
                  onClick={() => setSelModuleCode("")}
                  className="text-xs text-text-muted hover:text-morandi-rose"
                  title="清除，回到自动识别"
                >
                  ✕
                </button>
              )}
              <Link
                to="/module"
                className="text-xs text-morandi-3 hover:underline ml-1"
                title="现有模块都不合适？去模块管理新建"
              >
                ➕ 新建模块
              </Link>
            </div>
          )}

          {!asBrandDict && (
            <fieldset className="card space-y-3 p-3" aria-label="导入方式">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-text-primary">导入方式</span>
                <span className="text-xs text-text-muted">单文件生效；文件夹仍按原样逐个导入</span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1 text-sm text-text-secondary">
                  <span className="block text-xs font-medium text-text-primary">工作表</span>
                  <select
                    value={sheetMode}
                    onChange={(event) => setSheetMode(event.target.value as "first" | "all")}
                    disabled={streamLargeCsv}
                    className="min-h-9 w-full rounded-md border border-morandi-slate/40 bg-bg px-2 text-sm focus:outline-none focus:ring-2 focus:ring-morandi-slate/30 disabled:opacity-50"
                  >
                    <option value="first">只导入第一个</option>
                    <option value="all">全部拆成独立数据源</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm text-text-secondary">
                  <span className="block text-xs font-medium text-text-primary">表头层数</span>
                  <select
                    value={headerRows}
                    onChange={(event) => {
                      const next = Number(event.target.value) as 1 | 2 | 3;
                      setHeaderRows(next);
                      if (next > 1) setShapeMode("table");
                    }}
                    disabled={streamLargeCsv}
                    className="min-h-9 w-full rounded-md border border-morandi-slate/40 bg-bg px-2 text-sm focus:outline-none focus:ring-2 focus:ring-morandi-slate/30 disabled:opacity-50"
                  >
                    <option value={1}>普通单行表头</option>
                    <option value={2}>合并连续 2 行表头</option>
                    <option value={3}>合并连续 3 行表头</option>
                  </select>
                  <span className="block text-[11px] text-text-muted">合并单元格会向右补齐，再组成唯一列名</span>
                </label>
                <label className="space-y-1 text-sm text-text-secondary">
                  <span className="block text-xs font-medium text-text-primary">表头起始行（可选）</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={999999}
                    step={1}
                    value={headerStartRow}
                    onChange={(event) => setHeaderStartRow(event.target.value)}
                    placeholder="自动识别"
                    aria-label="表头起始行"
                    disabled={streamLargeCsv}
                    className="min-h-9 w-full rounded-md border border-morandi-slate/40 bg-bg px-2 text-sm focus:outline-none focus:ring-2 focus:ring-morandi-slate/30 disabled:opacity-50"
                  />
                  <span className="block text-[11px] text-text-muted">有标题或说明行时，从第几行开始读取表头</span>
                </label>
                <label className="flex min-h-14 items-start gap-2 rounded-md border border-morandi-slate/20 p-2.5 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={shapeMode === "date-columns-to-rows"}
                    disabled={streamLargeCsv || headerRows > 1}
                    onChange={(event) => {
                      setShapeMode(event.target.checked ? "date-columns-to-rows" : "table");
                      if (event.target.checked) setHeaderRows(1);
                    }}
                  />
                  <span>
                    <span className="block text-xs font-medium text-text-primary">日期宽表转长表</span>
                    <span className="mt-1 block text-xs text-text-muted">把日期列展开为“统计日期 + 指标值”</span>
                  </span>
                </label>
                {isAdmin ? (
                  <div className="space-y-2 rounded-md border border-morandi-slate/20 p-2.5">
                    <label className="flex items-start gap-2 text-sm text-text-secondary">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={streamLargeCsv}
                        onChange={(event) => {
                          setStreamLargeCsv(event.target.checked);
                          if (event.target.checked) {
                            setSheetMode("first");
                            setShapeMode("table");
                            setHeaderRows(1);
                            setHeaderStartRow("");
                          }
                        }}
                      />
                      <span>
                        <span className="block text-xs font-medium text-text-primary">大 CSV 流式导入</span>
                        <span className="mt-1 block text-xs text-text-muted">30MB～512MB，不在内存中展开整表</span>
                      </span>
                    </label>
                    {streamLargeCsv && (
                      <label className="block text-xs text-text-secondary">
                        数据行数（不含表头）
                        <input
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={expectedRows}
                          onChange={(event) => setExpectedRows(event.target.value.replace(/\D/g, ""))}
                          placeholder="例如 55268"
                          className="mt-1 min-h-9 w-full rounded-md border border-morandi-slate/40 bg-bg px-2 text-sm focus:outline-none focus:ring-2 focus:ring-morandi-slate/30"
                        />
                      </label>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border border-morandi-slate/20 p-2.5 text-xs text-text-muted">
                    大 CSV 流式导入由管理员执行，避免误传超大文件。
                  </div>
                )}
              </div>
            </fieldset>
          )}

          <div
            {...getRootProps()}
            className={cn(
              "card border-dashed cursor-pointer transition text-center py-12",
              isDragActive ? "border-morandi-rose bg-morandi-rose/10" : "hover:bg-bg-subtle",
              (uploadMut.isPending || !!folderProgress) && "opacity-60 pointer-events-none",
            )}
          >
            <input {...getInputProps()} />
            {uploadMut.isPending ? (
              <div className="flex flex-col items-center gap-2 text-text-secondary">
                <Loader2 size={32} className="animate-spin" />
                <div className="text-sm">解析并入库中…</div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-text-secondary">
                <Upload size={32} className="text-morandi-slate" />
                <div className="text-sm font-medium">
                  {isDragActive ? "松手即可上传" : "点击或拖拽 .xlsx / .xls / .csv 到此（单文件）"}
                </div>
                <div className="text-xs text-text-muted">
                  普通 Excel/CSV ≤ 30MB、每表最多 50000 行 · 管理员可流式导入 ≤ 512MB CSV
                </div>
              </div>
            )}
          </div>

          {folderProgress && (
            <div className="flex items-center gap-2 px-3 py-2 bg-bg-subtle text-text-secondary rounded-md text-sm">
              <Loader2 size={16} className="animate-spin" />
              <span>{folderProgress}</span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 text-red-700 rounded-md text-sm">
              <AlertCircle size={16} className="mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-start gap-2 px-3 py-2 bg-green-50 text-green-700 rounded-md text-sm">
              <FileSpreadsheet size={16} className="mt-0.5" />
              <span>{success}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="font-medium text-sm">已上传的文件 ({data?.length ?? 0})</div>
          {allIds.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <button
                type="button"
                disabled={selectedUnmatchedIds.length === 0}
                onClick={() => setBuilderOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-morandi-3 text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <Plus size={13} />
                创建新模块
              </button>
              <button
                onClick={() => setSelected(allSelected ? new Set() : new Set(allIds))}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded-md hover:bg-bg-subtle transition"
              >
                {allSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                {allSelected ? "取消全选" : "全选"}
              </button>
              {isAdmin && (
                <button
                  disabled={selected.size === 0 || batchDeleteMut.isPending}
                  onClick={() => {
                    if (confirm(`确定删除选中的 ${selected.size} 个文件？将一并删除底层数据表，不可恢复。`))
                      batchDeleteMut.mutate([...selected]);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-morandi-rose/40 text-morandi-rose rounded-md hover:bg-morandi-rose/5 disabled:opacity-40 transition"
                >
                  {batchDeleteMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  批量删除{selected.size > 0 ? `(${selected.size})` : ""}
                </button>
              )}
            </div>
          )}
        </div>

        {isLoading && <div className="text-text-muted text-sm">加载中…</div>}
        {!isLoading && data && data.length === 0 && <div className="text-sm text-text-muted">暂无文件</div>}

        {!isLoading && data && data.length > 0 && (() => {
          const unmatched = data.filter((f) => f.attribution?.kind === "unmatched");
          if (unmatched.length === 0) return null;
          return (
            <div className="card p-3 mb-3 border-l-4 border-l-morandi-rose bg-morandi-rose/5 flex items-start gap-2 text-xs">
              <AlertCircle size={14} className="text-morandi-rose shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium text-morandi-rose mb-1">
                  {unmatched.length} 个文件尚未归入模块
                </div>
                <div className="text-text-secondary">
                  先勾选同一类文件，再创建新模块或归入已有模块。系统会检查字段并立即处理。
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    disabled={selectedUnmatchedIds.length === 0}
                    onClick={() => setBuilderOpen(true)}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-morandi-3 px-3 py-1.5 text-xs text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={13} />
                    创建新模块
                  </button>
                  <select
                    aria-label="选择已有模块"
                    value={existingModuleCode}
                    onChange={(event) => setExistingModuleCode(event.target.value)}
                    className="min-h-9 max-w-52 rounded-md border bg-bg-card px-2 py-1.5 text-xs outline-none focus:border-morandi-slate focus:ring-2 focus:ring-morandi-slate/20"
                  >
                    <option value="">选择已有模块</option>
                    {(modules ?? []).map((module: any) => (
                      <option key={module.code} value={module.code}>
                        {module.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={
                      selectedUnmatchedIds.length === 0 ||
                      !existingModuleCode ||
                      assignMut.isPending
                    }
                    onClick={() =>
                      assignMut.mutate({
                        moduleCode: existingModuleCode,
                        sourceIds: selectedUnmatchedIds,
                      })
                    }
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {assignMut.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Play size={13} />
                    )}
                    归入已有模块
                  </button>
                  <span className="text-text-muted">
                    已选 {selectedUnmatchedIds.length} 个未归入文件
                  </span>
                </div>
              </div>
            </div>
          );
        })()}

        {!isLoading && data && data.length > 0 && (
          <div className="space-y-5">
            {[...groups.entries()].map(([group, files]) => {
              const groupIds = files.map((f) => f.id);
              const allInGroupSelected = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
              const someInGroupSelected = groupIds.some((id) => selected.has(id));
              function toggleGroup() {
                const next = new Set(selected);
                if (allInGroupSelected) {
                  groupIds.forEach((id) => next.delete(id));
                } else {
                  groupIds.forEach((id) => next.add(id));
                }
                setSelected(next);
              }
              function deleteGroup() {
                if (!confirm(`确认删除「${group}」分组下的 ${files.length} 个文件？\n\n会同时删除：原始 uf_<id> 表 + unified_<code> 表里关联的数据。\n（重新上传可恢复）`)) return;
                batchDeleteMut.mutate(groupIds);
              }
              return (
                <div key={group} className="space-y-2">
                  <div className="text-xs text-text-muted font-medium flex items-center gap-1.5 flex-wrap">
                    <FolderUp size={12} /> {group} · {files.length} 个
                    <button
                      onClick={toggleGroup}
                      className="text-[11px] text-morandi-3 hover:underline"
                    >
                      {allInGroupSelected
                        ? "取消全选本组"
                        : someInGroupSelected
                          ? "全选本组"
                          : "全选本组"}
                    </button>
                    {isAdmin && (
                      <button
                        onClick={deleteGroup}
                        disabled={batchDeleteMut.isPending}
                        className="text-[11px] text-morandi-rose hover:underline disabled:opacity-40 ml-auto"
                        title={`删除本组 ${files.length} 个文件`}
                      >
                        🗑 删除本组 ({files.length})
                      </button>
                    )}
                  </div>
                  {files.map((f) => (
                    <div
                      key={f.id}
                      className={cn(
                      "card flex items-center gap-3 py-3 group hover:shadow-md transition",
                      selected.has(f.id) && "ring-1 ring-morandi-2",
                    )}
                  >
                    <button onClick={() => toggle(f.id)} className="text-text-muted hover:text-morandi-2 shrink-0">
                      {selected.has(f.id) ? <CheckSquare size={18} className="text-morandi-2" /> : <Square size={18} />}
                    </button>
                    <div className="w-9 h-9 rounded-md bg-morandi-2 flex items-center justify-center text-white shrink-0">
                      <FileSpreadsheet size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate text-sm flex items-center gap-2">
                        <span className="truncate">{f.name}</span>
                        <AttributionBadge attr={f.attribution} />
                        {(f.config.schemaReview?.status === "pending" ||
                          f.config.schemaReview?.status === "awaiting_retry") && (
                          <button
                            type="button"
                            onClick={() => setSchemaReviewFile(f)}
                            className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded bg-morandi-rose/15 px-2 py-1 text-[11px] text-morandi-rose transition hover:bg-morandi-rose/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-morandi-3/40"
                          >
                            <AlertCircle size={11} />
                            字段待确认
                          </button>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-muted">
                        <span>{f.config.rowCount} 行 · {f.config.columns?.length ?? 0} 列</span>
                        {f.config.parentOriginalFileName && f.config.sheetName && (
                          <span className="rounded bg-morandi-1/15 px-1.5 py-0.5 text-morandi-3">
                            {f.config.parentOriginalFileName} / {f.config.sheetName}
                          </span>
                        )}
                        {f.config.transform?.mode === "date-columns-to-rows" && (
                          <span className="rounded bg-morandi-2/15 px-1.5 py-0.5 text-morandi-3">已转长表</span>
                        )}
                        {f.config.headerProcessing?.mode === "merge-header-rows" && (
                          <span className="rounded bg-morandi-1/15 px-1.5 py-0.5 text-morandi-3">
                            已合并 {f.config.headerProcessing.headerRows} 行表头
                          </span>
                        )}
                        {Number(f.config.quality?.blankRowsSkipped ?? 0) > 0 && (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
                            拦截 {f.config.quality?.blankRowsSkipped} 个空行
                          </span>
                        )}
                        {!f.config.parentOriginalFileName && <span className="truncate">{f.config.originalFileName}</span>}
                        <span>· {new Date(f.createdAt).toLocaleString("zh-CN")}</span>
                      </div>
                    </div>
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition shrink-0">
                      <button
                        onClick={() =>
                          window.dispatchEvent(new CustomEvent("ec:browse-file", { detail: { id: f.id } }))
                        }
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded-md hover:bg-bg-subtle transition"
                      >
                        <Eye size={12} /> 预览
                      </button>
                    </div>
                  </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// 文件归属徽章 + tooltip 解释
function AttributionBadge({ attr }: { attr?: Attribution }) {
  if (!attr) return null;
  if (attr.kind === "module") {
    return (
      <Link
        to={`/module/${attr.moduleCode}`}
        title={`此文件被模块"${attr.moduleName}"的"${attr.platformName}"平台识别（点击进入工作台）`}
        className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-morandi-1/20 text-morandi-3 hover:bg-morandi-1/30 transition shrink-0"
      >
        <Boxes size={10} />
        {attr.label}
      </Link>
    );
  }
  if (attr.kind === "dict") {
    return (
      <span
        title={`字典/维护表：角色 role=${attr.role}（其他模块的 joins[] 通过这个 role 借字段）`}
        className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-morandi-2/20 text-morandi-3 shrink-0"
      >
        <BookOpen size={10} />
        {attr.label}
      </span>
    );
  }
  // unmatched
  return (
    <span
      title="选中后可创建新模块，或归入已有模块"
      className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-morandi-rose/15 text-morandi-rose hover:bg-morandi-rose/25 hover:underline transition shrink-0"
    >
      <HelpCircle size={10} />
      尚未归入
    </span>
  );
}
