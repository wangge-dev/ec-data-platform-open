// 预警定时调度器（V0.20+）
// API 启动时调用 startScheduler()：扫描所有模块的 schedule 字段，按 cron 表达式注册定时任务
// 到点自动调 runAlerts(moduleCode)；可被 stopScheduler() 停掉用于热重载
import cron from "node-cron";
import { loadModules, type LoadedModule } from "./loader.js";
import { runAlerts, type RunResult } from "./alerts-engine.js";

// node-cron 没有导出 ScheduledTask 命名空间，用 ReturnType 推导避免 TS2503
type ScheduledTask = ReturnType<typeof cron.schedule>;

type Job = {
  moduleCode: string;
  moduleName: string;
  cronExpr: string;
  task: ScheduledTask;
  registeredAt: string;
  lastRunAt?: string;
  lastResult?: {
    triggered: number;
    skippedCount: number;
    durationMs: number;
    error?: string;
  };
};

const jobs = new Map<string, Job>();
let started = false;

/**
 * 启动调度器：扫描所有模块，按 schedule 注册任务
 */
export async function startScheduler(): Promise<void> {
  if (started) {
    console.log("[scheduler] already started, skipping");
    return;
  }
  started = true;

  const mods = await loadModules();
  for (const mod of mods) {
    if (!mod.schedule) continue;
    registerOne(mod);
  }
  if (jobs.size === 0) {
    console.log("[scheduler] no modules have 'schedule' field; nothing scheduled");
  } else {
    console.log(
      `[scheduler] started ${jobs.size} job(s): ${[...jobs.keys()].join(", ")}`,
    );
  }
}

/**
 * 停掉所有调度（用于热重载）
 */
export function stopScheduler(): void {
  for (const [, job] of jobs) job.task.stop();
  jobs.clear();
  started = false;
}

function registerOne(mod: LoadedModule): void {
  if (!mod.schedule) return;
  if (!cron.validate(mod.schedule)) {
    console.error(
      `[scheduler] ${mod.code} 的 schedule "${mod.schedule}" 非法 cron 表达式，跳过`,
    );
    return;
  }

  const task = cron.schedule(
    mod.schedule,
    async () => {
      const t0 = Date.now();
      const job = jobs.get(mod.code);
      try {
        const r: RunResult = await runAlerts(mod.code);
        const triggered = r.reports.reduce((s, x) => s + x.triggered, 0);
        const skippedCount = r.reports.filter((x) => x.skipped).length;
        if (job) {
          job.lastRunAt = new Date().toISOString();
          job.lastResult = {
            triggered,
            skippedCount,
            durationMs: Date.now() - t0,
          };
        }
        console.log(
          `[scheduler] ✓ ${mod.code} 跑完 triggered=${triggered} skipped=${skippedCount} (${
            Date.now() - t0
          }ms)`,
        );
      } catch (e: any) {
        if (job) {
          job.lastRunAt = new Date().toISOString();
          job.lastResult = {
            triggered: 0,
            skippedCount: 0,
            durationMs: Date.now() - t0,
            error: e.message,
          };
        }
        console.error(`[scheduler] ✗ ${mod.code} 失败：${e.message}`);
      }
    },
    { timezone: "Asia/Shanghai" },
  );

  jobs.set(mod.code, {
    moduleCode: mod.code,
    moduleName: mod.name,
    cronExpr: mod.schedule,
    task,
    registeredAt: new Date().toISOString(),
  });
  console.log(`[scheduler] + ${mod.code} schedule="${mod.schedule}"`);
}

/**
 * 给路由层用的当前调度状态（含每个 job 上次跑结果）
 */
export function getScheduleStatus() {
  return {
    started,
    count: jobs.size,
    jobs: [...jobs.values()].map((j) => ({
      moduleCode: j.moduleCode,
      moduleName: j.moduleName,
      cronExpr: j.cronExpr,
      registeredAt: j.registeredAt,
      lastRunAt: j.lastRunAt ?? null,
      lastResult: j.lastResult ?? null,
      // node-cron 不直接暴露下次时间，前端按表达式自算
    })),
  };
}
