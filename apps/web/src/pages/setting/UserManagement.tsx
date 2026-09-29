import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, UserPlus, Trash2, KeyRound, X } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

type UserRow = {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: string | null;
};

const errMsg = (e: any, fallback: string) => e?.message || fallback;

export function UserManagement() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const [adding, setAdding] = useState(false);
  const [resetId, setResetId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const flash = (type: "ok" | "err", text: string) => {
    setNotice({ type, text });
    setTimeout(() => setNotice(null), 3000);
  };

  const { data: list } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const r: any = await api.get("/users");
      return r.data as UserRow[];
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const delMut = useMutation({
    mutationFn: (id: number) => api.delete(`/users/${id}`),
    onSuccess: () => {
      flash("ok", "已删除");
      refresh();
    },
    onError: (e: any) => flash("err", errMsg(e, "删除失败")),
  });

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-medium flex items-center gap-2">
          <div className="w-1 h-4 bg-morandi-1 rounded" />
          <Users size={16} className="text-text-secondary" />
          用户管理
          <span className="text-xs text-text-muted font-normal">让同事各自登录使用（数据共享）</span>
        </h2>
        <button
          onClick={() => setAdding(true)}
          className="px-3 py-1.5 text-sm rounded-md text-white bg-morandi-slate hover:opacity-90 transition flex items-center gap-1.5"
        >
          <UserPlus size={14} />
          新建用户
        </button>
      </div>

      {notice && (
        <div
          className={`mb-3 text-sm px-3 py-2 rounded-md ${
            notice.type === "ok" ? "bg-morandi-sage/20 text-text-primary" : "bg-red-50 text-red-600"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="divide-y">
        {(list ?? []).map((u) => (
          <div key={u.id} className="flex items-center gap-3 py-2.5">
            <div className="w-9 h-9 rounded-full bg-morandi-mauve flex items-center justify-center text-white text-sm font-medium shrink-0">
              {(u.displayName || u.username)[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {u.displayName || u.username}
                {u.id === me?.id && <span className="ml-2 text-xs text-morandi-slate">（我）</span>}
              </div>
              <div className="text-xs text-text-muted truncate">@{u.username} · UID {u.id}</div>
            </div>
            <button
              onClick={() => setResetId(u.id)}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-subtle rounded transition"
              title="重置密码"
            >
              <KeyRound size={15} />
            </button>
            <button
              onClick={() => {
                if (u.id === me?.id) return flash("err", "不能删除自己");
                if (confirm(`确认删除用户「${u.displayName || u.username}」？`)) delMut.mutate(u.id);
              }}
              disabled={u.id === me?.id}
              className="p-1.5 text-text-muted hover:text-red-500 hover:bg-red-50 rounded transition disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              title={u.id === me?.id ? "不能删除自己" : "删除"}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {list && list.length === 0 && (
          <div className="py-6 text-center text-sm text-text-muted">暂无用户</div>
        )}
      </div>

      {adding && (
        <AddUserModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            flash("ok", "用户已创建");
            refresh();
          }}
          onError={(m) => flash("err", m)}
        />
      )}
      {resetId !== null && (
        <ResetPasswordModal
          userId={resetId}
          userName={(list ?? []).find((u) => u.id === resetId)?.username ?? ""}
          onClose={() => setResetId(null)}
          onDone={() => {
            setResetId(null);
            flash("ok", "密码已重置");
          }}
          onError={(m) => flash("err", m)}
        />
      )}
    </section>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-bg-card rounded-lg shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium">{title}</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const fieldCls =
  "w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-morandi-slate/40";

function AddUserModal({
  onClose,
  onDone,
  onError,
}: {
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const mut = useMutation({
    mutationFn: () => api.post("/users", { username: username.trim(), password, displayName: displayName.trim() || undefined }),
    onSuccess: onDone,
    onError: (e: any) => onError(errMsg(e, "创建失败")),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim().length < 2) return onError("用户名至少 2 位");
    if (password.length < 6) return onError("密码至少 6 位");
    mut.mutate();
  };

  return (
    <ModalShell title="新建用户" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs text-text-muted">用户名（登录用，字母/数字/_.-）</label>
          <input className={fieldCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="如 xuzhu" autoFocus />
        </div>
        <div>
          <label className="text-xs text-text-muted">昵称（可选）</label>
          <input className={fieldCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如 虚竹" />
        </div>
        <div>
          <label className="text-xs text-text-muted">初始密码（≥ 6 位）</label>
          <input className={fieldCls} type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="告知同事后让其登录修改" />
        </div>
        <button
          type="submit"
          disabled={mut.isPending}
          className="w-full py-2 rounded-md text-white bg-morandi-slate hover:opacity-90 transition text-sm disabled:opacity-50"
        >
          {mut.isPending ? "创建中…" : "创建"}
        </button>
      </form>
    </ModalShell>
  );
}

function ResetPasswordModal({
  userId,
  userName,
  onClose,
  onDone,
  onError,
}: {
  userId: number;
  userName: string;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [password, setPassword] = useState("");
  const mut = useMutation({
    mutationFn: () => api.patch(`/users/${userId}`, { password }),
    onSuccess: onDone,
    onError: (e: any) => onError(errMsg(e, "重置失败")),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) return onError("密码至少 6 位");
    mut.mutate();
  };
  return (
    <ModalShell title={`重置密码 · @${userName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs text-text-muted">新密码（≥ 6 位）</label>
          <input className={fieldCls} type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        <button
          type="submit"
          disabled={mut.isPending}
          className="w-full py-2 rounded-md text-white bg-morandi-slate hover:opacity-90 transition text-sm disabled:opacity-50"
        >
          {mut.isPending ? "提交中…" : "确认重置"}
        </button>
      </form>
    </ModalShell>
  );
}
