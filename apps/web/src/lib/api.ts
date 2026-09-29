import axios from "axios";
import { useAuth } from "./auth-store";

// 默认 30s 给常规 CRUD 用；AI 类长请求（智能体运行/AI 出图/AI 分析）走 apiLong，3 分钟
export const api = axios.create({
  baseURL: "/api",
  timeout: 30000,
  withCredentials: true,
});

// 长请求专用 client：智能体跑大数据/复杂分析时 30s 不够
export const apiLong = axios.create({
  baseURL: "/api",
  timeout: 180000,
  withCredentials: true,
});

// 共用拦截器
function attachInterceptors(client: typeof api) {
  client.interceptors.request.use((cfg) => {
    const token = useAuth.getState().token;
    if (token) cfg.headers.Authorization = `Bearer ${token}`;
    return cfg;
  });
  client.interceptors.response.use(
    (r) => r.data,
    (e) => {
      if (e.response?.status === 401) {
        useAuth.getState().logout();
        if (window.location.pathname !== "/login") {
          window.location.href = "/login";
        }
      }
      return Promise.reject(e.response?.data ?? e);
    },
  );
}

attachInterceptors(api);
attachInterceptors(apiLong);
