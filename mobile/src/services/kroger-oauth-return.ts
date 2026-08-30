export type KrogerOAuthReturnStatus = "pending" | "connected" | "cancelled" | "failed";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function validateKrogerOAuthReturn(
  parameters: {
    status?: string | string[];
    comparisonId?: string | string[];
    completion?: string | string[];
  },
  expectedComparisonId: string | undefined,
): { status: KrogerOAuthReturnStatus; comparisonId?: string; completion?: string } {
  const status = single(parameters.status);
  const comparisonId = single(parameters.comparisonId);
  const completion = single(parameters.completion);
  if (
    !expectedComparisonId
    || comparisonId !== expectedComparisonId
    || !/^[A-Za-z0-9_-]{16,128}$/.test(comparisonId ?? "")
  ) {
    return { status: "failed" };
  }
  if (status === "pending") {
    if (!/^[A-Za-z0-9_-]{43}$/.test(completion ?? "")) {
      return { status: "failed", comparisonId };
    }
    return { status, comparisonId, completion };
  }
  if (status !== "connected" && status !== "cancelled" && status !== "failed") {
    return { status: "failed", comparisonId };
  }
  return { status, comparisonId };
}
