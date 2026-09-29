import { useState } from "react";
import { FileSpreadsheet, Database, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-store";
import { FileUploadTab } from "./FileUploadTab";
import { BrowseTab } from "./BrowseTab";
import { ExternalSqlTab } from "./ExternalSqlTab";

const TABS = [
  { key: "file", label: "Excel 上传", icon: FileSpreadsheet },
  { key: "browse", label: "表浏览", icon: Eye },
  { key: "sql", label: "外部 SQL", icon: Database, hint: "独立工具" },
];

export function DataPage() {
  const [active, setActive] = useState("file");
  const isAdmin = useAuth((state) => state.user?.isAdmin === true);
  const visibleTabs = isAdmin ? TABS : TABS.filter((tab) => tab.key !== "sql");

  // 处理"预览"按钮跨 tab 跳转
  if (typeof window !== "undefined") {
    window.addEventListener(
      "ec:browse-file",
      () => {
        setActive("browse");
      },
      { once: true },
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">数据</h1>
        <p className="text-text-muted text-sm mt-1">
          {isAdmin
            ? "上传 Excel/CSV → 模块按文件名正则识别归属 · 表浏览看原始数据 · 外部 SQL 直连其他库"
            : "上传 Excel/CSV → 模块按文件名正则识别归属 · 表浏览看原始数据"}
        </p>
      </header>

      <div className="border-b flex gap-1">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 -mb-px transition",
              active === t.key
                ? "border-morandi-rose text-text-primary font-medium"
                : "border-transparent text-text-secondary hover:text-text-primary",
            )}
          >
            <t.icon size={15} />
            {t.label}
            {t.hint && (
              <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-subtle">
                {t.hint}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="pt-2">
        {active === "file" && <FileUploadTab />}
        {active === "browse" && <BrowseTab />}
        {isAdmin && active === "sql" && <ExternalSqlTab />}
      </div>
    </div>
  );
}
