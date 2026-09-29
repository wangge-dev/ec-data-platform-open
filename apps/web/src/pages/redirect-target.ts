export const MODULE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

export type LegacyModulePage = "compare" | "alerts";

/**
 * Convert a legacy query-string route to a module route. Module codes share
 * the API schema's strict identifier contract; invalid input fails closed.
 */
export function buildLegacyModuleRedirect(
  page: LegacyModulePage,
  params: URLSearchParams,
): string {
  const moduleCode = params.get("module");
  if (!moduleCode || !MODULE_CODE_PATTERN.test(moduleCode)) {
    return "/analytics";
  }

  if (page === "alerts") {
    return `/module/${moduleCode}/alerts`;
  }

  const tail = new URLSearchParams(params);
  tail.delete("module");
  const query = tail.toString();
  return `/module/${moduleCode}/compare${query ? `?${query}` : ""}`;
}
