import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Screen } from "@/components/screen";
import {
  completeAndVerifyKrogerAuthorization,
  getKrogerAuthorizationStatus,
} from "@/services/kroger-handoff-api";
import { validateKrogerOAuthReturn } from "@/services/kroger-oauth-return";
import { useCartiva } from "@/state/cartiva-context";
import { colors, typography } from "@/theme";

/** Cold-start target for the claimed HTTPS link (custom scheme in development). */
export default function KrogerOAuthReturnScreen() {
  const router = useRouter();
  const parameters = useLocalSearchParams<{
    status?: string;
    comparisonId?: string;
    completion?: string;
  }>();
  const { hydrated, comparison } = useCartiva();
  const returnedStatus = parameters.status;
  const returnedComparisonId = parameters.comparisonId;
  const returnedCompletion = parameters.completion;

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    let activeController: AbortController | undefined;
    const deadlineAt = Date.now() + 25_000;
    const runBounded = async <T,>(
      operation: (signal: AbortSignal) => Promise<T>,
      maximumMs = 20_000,
    ) => {
      const remainingMs = Math.min(maximumMs, deadlineAt - Date.now());
      if (remainingMs <= 0) throw new Error("Kroger connection verification timed out.");
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      try {
        return await operation(controller.signal);
      } finally {
        clearTimeout(timeout);
        if (activeController === controller) activeController = undefined;
      }
    };
    const decision = validateKrogerOAuthReturn({
      status: returnedStatus,
      comparisonId: returnedComparisonId,
      completion: returnedCompletion,
    }, comparison?.comparisonId);
    void (async () => {
      let status = decision.status;
      if (status === "pending" && decision.comparisonId && decision.completion) {
        const controller = new AbortController();
        activeController = controller;
        try {
          const authorization = await completeAndVerifyKrogerAuthorization(
            decision.comparisonId,
            decision.completion,
            { signal: controller.signal, timeoutMs: 25_000 },
          );
          status = authorization.authorization === "CONNECTED" ? "connected" : "failed";
        } catch {
          status = "failed";
        } finally {
          if (activeController === controller) activeController = undefined;
        }
      } else if (status === "connected") {
        try {
          const authorization = await runBounded(
            (signal) => getKrogerAuthorizationStatus(signal),
            5_000,
          );
          if (authorization.authorization !== "CONNECTED") status = "failed";
        } catch {
          status = "failed";
        }
      }
      if (cancelled) return;
      router.replace({
        pathname: "/results",
        params: {
          oauthStatus: status,
          ...(decision.comparisonId ? { comparisonId: decision.comparisonId } : {}),
        },
      });
    })();
    return () => {
      cancelled = true;
      activeController?.abort();
    };
  }, [
    comparison?.comparisonId,
    hydrated,
    returnedComparisonId,
    returnedCompletion,
    returnedStatus,
    router,
  ]);

  return (
    <Screen>
      <View style={styles.content} accessibilityRole="alert" accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.emerald} />
        <Text style={typography.body}>Returning to your Cartiva basket…</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
});
