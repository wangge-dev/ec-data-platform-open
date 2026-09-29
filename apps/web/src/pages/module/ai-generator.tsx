// AI 生成模块助手（V0.22）
// 多步 modal：1.基本信息 → 2.上传 Excel/贴表头 → 3.AI 生成 JSON 预览 → 复制/下载
import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation } from "@tanstack/react-query";
import {
  Sparkles,
  X,
  Upload,
  Copy,
  Download,
  Check,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
} from "lucide-react";
import { api, apiLong } from "@/lib/api";
import { cn } from "@/lib/utils";

type Inspected = {
  fileName: string;
  sheetName: string;
  rowCount: number;
  headers: string[];
  sample: Record<string, any>[];
};

type GenerateResult = {
  valid: boolean;
  validateError: string | null;
  json: any;
  jsonText: string;
  usage: any;
};

export function AiModuleGeneratorModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // step 1: 基本信息
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("shop_ops");
  const [categoryLabel, setCategoryLabel] = useState("店铺经营");

  // step 2: 表头来源
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [pastedHeaders, setPastedHeaders] = useState("");
  const [extraHint, setExtraHint] = useState("");

  // step 3: 结果
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [copied, setCopied] = useState(false);

  // 上传 Excel 提取表头
  const inspectMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const r: any = await api.post("/modules/inspect-excel", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return r.data as Inspected;
    },
    onSuccess: (d) => setInspected(d),
  });

  // 调 AI 生成 JSON
  const generateMut = useMutation({
    mutationFn: async () => {
      const headers = inspected
        ? inspected.headers
        : pastedHeaders
            .split(/[\n,\t]/)
            .map((s) => s.trim())
            .filter(Boolean);
      const r: any = await apiLong.post("/modules/generate", {
        code,
        name,
        description,
        category,
        categoryLabel,
        headers,
        sample: inspected?.sample ?? [],
        extraHint,
      });
      return r.data as GenerateResult;
    },
    onSuccess: (d) => {
      setResult(d);
      setStep(3);
    },
  });

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel": [".xls"],
      "text/csv": [".csv"],
    },
    maxSize: 20 * 1024 * 1024,
    multiple: false,
    onDrop: (accepted) => {
      if (accepted[0]) inspectMut.mutate(accepted[0]);
    },
  });

  async function copyJson() {
    if (!result?.jsonText) return;
    try {
      await navigator.clipboard.writeText(result.jsonText);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = result.jsonText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadJson() {
    if (!result?.jsonText) return;
    const blob = new Blob([result.jsonText], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${code}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const step1Ok = code.match(/^[a-z][a-z0-9_]*$/) && name.trim() && description.trim();
  const step2HeadersReady =
    !!inspected ||
    pastedHeaders.split(/[\n,\t]/).map((s) => s.trim()).filter(Boolean).length > 0;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="card max-w-3xl w-full max-h-[90vh] flex flex-col p-0 overflow-hidden">
        {/* 头 */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-morandi-3" />
            <span className="font-medium">AI 生成新模块</span>
            <span className="text-xs text-text-muted">·</span>
            <span className="text-xs text-text-muted">
              步骤 {step} / 3 ·{" "}
              {step === 1 ? "基本信息" : step === 2 ? "上传表头" : "JSON 预览"}
            </span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary p-1">
            <X size={18} />
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-auto p-5">
          {step === 1 && (
            <div className="space-y-4">
              <div className="text-xs text-text-muted">
                先告诉我新模块的基本信息。code 是英文小写下划线，比如 <code>flow_traffic</code>。
              </div>

              <Field label="模块代号 code" required>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="flow_traffic"
                  className="input"
                />
                <Hint
                  error={!!code && !code.match(/^[a-z][a-z0-9_]*$/)}
                  text="只能小写字母+数字+下划线，首字母字母"
                />
              </Field>

              <Field label="中文名 name" required>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="流量分析"
                  className="input"
                />
              </Field>

              <Field label="描述 description" required>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="生意参谋导出的流量数据 ETL：每天访客/PV/转化率，按平台日维度"
                  rows={3}
                  className="input"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="业务分类 category">
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="input"
                  >
                    <option value="shop_ops">shop_ops（店铺经营）</option>
                    <option value="warehouse">warehouse（仓储管理）</option>
                    <option value="customer">customer（客服管理）</option>
                    <option value="finance">finance（财务）</option>
                    <option value="">不分类</option>
                  </select>
                </Field>
                <Field label="分类显示名 categoryLabel">
                  <input
                    value={categoryLabel}
                    onChange={(e) => setCategoryLabel(e.target.value)}
                    placeholder="店铺经营"
                    className="input"
                  />
                </Field>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="text-xs text-text-muted">
                上传一份样本 Excel（推荐——AI 能看到真实数据样本生成更准），或者粘贴表头列表。
              </div>

              <div
                {...getRootProps()}
                className={cn(
                  "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition",
                  isDragActive
                    ? "border-morandi-3 bg-morandi-1/10"
                    : "border-bg-subtle hover:border-morandi-3/50",
                )}
              >
                <input {...getInputProps()} />
                {inspectMut.isPending ? (
                  <Loader2 className="mx-auto mb-2 text-morandi-3 animate-spin" size={24} />
                ) : (
                  <Upload className="mx-auto mb-2 text-text-muted" size={24} />
                )}
                <div className="text-sm">
                  {isDragActive
                    ? "松开上传"
                    : inspectMut.isPending
                      ? "解析中…"
                      : "拖入 Excel/CSV 或点击选择"}
                </div>
                <div className="text-xs text-text-muted mt-1">支持 .xlsx / .xls / .csv，最大 20MB</div>
              </div>

              {inspectMut.isError && (
                <div className="text-xs text-red-600 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {(inspectMut.error as any)?.message}
                </div>
              )}

              {inspected && (
                <div className="card p-3 bg-morandi-1/10 border-morandi-3/30">
                  <div className="text-sm font-medium mb-1 flex items-center gap-1.5">
                    <CheckCircle2 size={13} className="text-green-700" />
                    已解析：{inspected.fileName}
                  </div>
                  <div className="text-xs text-text-muted">
                    sheet={inspected.sheetName} · {inspected.rowCount} 行 ·{" "}
                    {inspected.headers.length} 列
                  </div>
                  <div className="text-xs text-text-secondary mt-2">
                    <div className="font-medium mb-1">表头：</div>
                    <div className="flex flex-wrap gap-1">
                      {inspected.headers.map((h, i) => (
                        <span
                          key={i}
                          className="px-1.5 py-0.5 rounded bg-bg-card border text-[11px]"
                        >
                          {h}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="relative">
                <div className="absolute inset-x-0 -top-2 flex items-center justify-center">
                  <span className="bg-bg-card px-2 text-xs text-text-muted">或</span>
                </div>
                <div className="border-t" />
              </div>

              <Field label="粘贴表头（用换行/逗号分隔）">
                <textarea
                  value={pastedHeaders}
                  onChange={(e) => setPastedHeaders(e.target.value)}
                  placeholder={`日期\n店铺\n访客数\n浏览量\n转化率\n...`}
                  rows={4}
                  className="input"
                  disabled={!!inspected}
                />
              </Field>

              <Field label="额外说明（可选）">
                <textarea
                  value={extraHint}
                  onChange={(e) => setExtraHint(e.target.value)}
                  placeholder="例：访客数和转化率都是必填；不同平台的'转化率'列名不一样，淘宝叫'支付转化率'，抖音叫'成交转化率'"
                  rows={2}
                  className="input"
                />
              </Field>
            </div>
          )}

          {step === 3 && result && (
            <div className="space-y-3">
              {result.valid ? (
                <div className="card p-3 bg-green-50 border-green-200 flex items-start gap-2 text-sm">
                  <CheckCircle2 size={14} className="text-green-700 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium text-green-700">JSON 校验通过 ✓</div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      复制内容保存到 <code>apps/api/src/modules/{code}.json</code>，然后{" "}
                      <code>docker compose restart api</code> 即可生效
                    </div>
                  </div>
                </div>
              ) : (
                <div className="card p-3 bg-morandi-rose/10 border-morandi-rose/30 flex items-start gap-2 text-sm">
                  <AlertCircle size={14} className="text-morandi-rose mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium text-morandi-rose">JSON 校验失败</div>
                    <div className="text-xs text-text-secondary mt-0.5 whitespace-pre-wrap">
                      {result.validateError}
                    </div>
                    <div className="text-xs text-text-muted mt-1">
                      下面是 AI 的草稿，你可以手改修正后再保存
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={copyJson}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border bg-bg-card hover:bg-bg-subtle transition"
                >
                  {copied ? (
                    <>
                      <Check size={13} className="text-green-700" />
                      <span className="text-green-700">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy size={13} />
                      复制 JSON
                    </>
                  )}
                </button>
                <button
                  onClick={downloadJson}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border bg-bg-card hover:bg-bg-subtle transition"
                >
                  <Download size={13} />
                  下载 {code}.json
                </button>
                <button
                  onClick={() => {
                    setResult(null);
                    setStep(2);
                  }}
                  className="text-xs px-3 py-1.5 rounded-md border hover:bg-bg-subtle transition text-text-secondary"
                >
                  重新生成
                </button>
              </div>

              <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto bg-bg-subtle/40 p-4 rounded-md max-h-[400px] overflow-y-auto">
                {result.jsonText}
              </pre>
            </div>
          )}
        </div>

        {/* 底部步骤按钮 */}
        <div className="px-5 py-3 border-t bg-bg-subtle/40 flex items-center justify-between">
          <div className="text-xs text-text-muted">
            {step === 3 ? "保存后重启 API 容器即可启用新模块" : "信息仅本次会话用，不入库"}
          </div>
          <div className="flex items-center gap-2">
            {step > 1 && step < 3 && (
              <button
                onClick={() => setStep((s) => (s - 1) as 1 | 2)}
                className="text-xs px-3 py-1.5 rounded-md border hover:bg-bg-subtle"
              >
                上一步
              </button>
            )}
            {step === 1 && (
              <button
                onClick={() => setStep(2)}
                disabled={!step1Ok}
                className="flex items-center gap-1 text-sm px-3.5 py-1.5 rounded-md bg-morandi-3 text-white disabled:opacity-40 hover:opacity-90 transition"
              >
                下一步：上传表头
                <ChevronRight size={13} />
              </button>
            )}
            {step === 2 && (
              <button
                onClick={() => generateMut.mutate()}
                disabled={!step2HeadersReady || generateMut.isPending}
                className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-md bg-morandi-3 text-white disabled:opacity-40 hover:opacity-90 transition"
              >
                {generateMut.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                生成 JSON
              </button>
            )}
            {step === 3 && (
              <button
                onClick={onClose}
                className="text-sm px-3.5 py-1.5 rounded-md bg-morandi-3 text-white hover:opacity-90 transition"
              >
                完成
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 公共样式 */}
      <style>{`
        .input { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--bg-subtle, #e5e5e0); border-radius: 0.375rem; background: var(--bg-card, #fff); font-size: 0.875rem; outline: none; }
        .input:focus { border-color: rgb(157 139 123); }
      `}</style>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs text-text-secondary mb-1 block">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function Hint({ error, text }: { error: boolean; text: string }) {
  if (!error) return null;
  return <div className="text-[11px] text-red-500 mt-1">{text}</div>;
}
