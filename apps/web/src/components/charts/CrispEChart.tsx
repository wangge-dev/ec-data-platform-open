import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts, {
  type EChartsInstance,
  type EChartsReactProps,
} from "echarts-for-react";
import {
  buildChartInitOptions,
  normalizeDevicePixelRatio,
  type ChartRenderer,
} from "./chart-visuals";

type CrispEChartProps = Omit<EChartsReactProps, "autoResize" | "opts"> & {
  renderer?: ChartRenderer;
};

function readDevicePixelRatio(): number {
  return normalizeDevicePixelRatio(
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
  );
}

/**
 * Shared ECharts host. SVG is the default because the dashboard prioritizes
 * crisp labels; the canvas path remains available and is initialized at the
 * current display DPR. ResizeObserver also covers grid/sidebar size changes.
 */
export function CrispEChart({
  renderer = "svg",
  className = "",
  style,
  onChartReady,
  ...props
}: CrispEChartProps) {
  const chartRef = useRef<ReactECharts>(null);
  const instanceRef = useRef<EChartsInstance | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [devicePixelRatio, setDevicePixelRatio] = useState(readDevicePixelRatio);

  const scheduleResize = useCallback(() => {
    if (typeof window === "undefined") return;

    const nextRatio = readDevicePixelRatio();
    setDevicePixelRatio((current) =>
      current === nextRatio ? current : nextRatio,
    );

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      instanceRef.current?.resize({
        width: "auto",
        height: "auto",
        animation: { duration: 0 },
      });
    });
  }, []);

  useEffect(() => {
    const element = chartRef.current?.ele;
    const observer =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleResize)
        : null;

    if (element) observer?.observe(element);
    window.addEventListener("resize", scheduleResize);

    let cancelled = false;
    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!cancelled) scheduleResize();
      });
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleResize);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [scheduleResize]);

  const initOptions = useMemo(
    () => buildChartInitOptions(renderer, devicePixelRatio),
    [devicePixelRatio, renderer],
  );

  return (
    <ReactECharts
      ref={chartRef}
      {...props}
      className={`echart-crisp ${className}`.trim()}
      style={{ width: "100%", minWidth: 0, ...style }}
      opts={initOptions}
      autoResize={false}
      onChartReady={(instance) => {
        instanceRef.current = instance;
        scheduleResize();
        onChartReady?.(instance);
      }}
    />
  );
}
