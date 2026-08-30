import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import {
  BasketCompleteness,
  comparisonCartMutationReadiness,
} from "@cartiva/shared";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BackHandler, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "@/components/brand-mark";
import { GlassCard } from "@/components/glass-card";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import { analytics } from "@/services/analytics";
import {
  clearKrogerCartSubmissionMarker,
  clearKrogerCartSubmissionMarkerAfterOwnerNone,
  loadKrogerCartSubmissionMarker,
  markInterruptedKrogerCartSubmissionUnknown,
  markKrogerCartSubmitting,
  recordKrogerCartSubmissionOutcome,
} from "@/services/cart-submission-journal";
import {
  finishKrogerRecoveryReview,
  journalAfterAuthoritativeOwnerNone,
  visibleLocalKrogerSubmission,
  type KrogerSubmissionJournalView,
} from "@/services/kroger-cart-recovery-state";
import { isTrustedKrogerRetailerUrl } from "@/services/cart-submission-marker";
import {
  cartHandoffBelongsToComparison,
  cartTransferBlocksNavigation,
  runGuardedKrogerCartTransfer,
  type CartWriteSafetyState,
} from "@/services/cart-transfer-run";
import { bestEffortHaptic } from "@/services/haptics";
import {
  addComparisonToKrogerCart,
  authorizeKroger,
  disconnectKroger,
  getKrogerAuthorizationStatus,
} from "@/services/kroger-handoff-api";
import {
  krogerConnectionControl,
  krogerConnectionAfterCartTransferPhase,
  type KrogerConnectionUiState,
} from "@/services/kroger-connection-ui";
import {
  acknowledgeKrogerCartRecovery,
  getKrogerCartRecovery,
  type KrogerCartRecovery,
} from "@/services/kroger-cart-recovery-api";
import { validateKrogerOAuthReturn } from "@/services/kroger-oauth-return";
import {
  authorizationFailureState,
  cartAddFailureState,
  handoffPresentation,
  retailerBanner,
  type CartHandoffState,
} from "@/services/mobile-ux";
import { resetMobileSession } from "@/services/mobile-session";
import { useCartiva } from "@/state/cartiva-context";
import { colors, radius, typography } from "@/theme";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const CART_RECOVERY_TIMEOUT_MS = 12_000;

type OwnerCartRecoveryState =
  | { kind: "checking" }
  | { kind: "none"; localCleanupPending?: boolean }
  | { kind: "recovered"; operation: Exclude<KrogerCartRecovery, { status: "NONE" }> }
  | {
      kind: "unavailable";
      message: string;
      operation?: Exclude<KrogerCartRecovery, { status: "NONE" }>;
    };

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Checked just now";
  return `Checked ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export default function ResultsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const oauthReturn = useLocalSearchParams<{ oauthStatus?: string; comparisonId?: string }>();
  const { comparison, clearComparison, persistComparisonForHandoff } = useCartiva();
  const hasOauthReturn = Boolean(oauthReturn.oauthStatus);
  const validatedOauthReturn = hasOauthReturn
    ? validateKrogerOAuthReturn({
        status: oauthReturn.oauthStatus,
        comparisonId: oauthReturn.comparisonId,
      }, comparison?.comparisonId)
    : undefined;
  const oauthComparisonMatches = !hasOauthReturn
    || validatedOauthReturn?.comparisonId === comparison?.comparisonId;
  const [cartState, setCartState] = useState<CartHandoffState>(() => {
    if (!oauthComparisonMatches) return "idle";
    if (validatedOauthReturn?.status === "connected") return "authorizing";
    if (validatedOauthReturn?.status === "cancelled") return "cancelled";
    if (validatedOauthReturn?.status === "failed") return "failed";
    return "idle";
  });
  const [handoffComparisonId, setHandoffComparisonId] = useState<string | undefined>(
    comparison?.comparisonId,
  );
  const [handoffMessage, setHandoffMessage] = useState(() => {
    if (!oauthComparisonMatches) {
      return "The retailer returned to a different or expired comparison. Recompare before adding anything to a cart.";
    }
    if (validatedOauthReturn?.status === "connected") {
      return "Confirming retailer authorization before any cart action…";
    }
    if (validatedOauthReturn?.status === "cancelled") {
      return "Retailer sign-in was cancelled. Nothing was transferred and your basket is still here.";
    }
    if (validatedOauthReturn?.status === "failed") {
      return "Retailer sign-in could not be confirmed. Nothing was transferred and your basket is still here.";
    }
    return "";
  });
  const [confirmedCartUrl, setConfirmedCartUrl] = useState<string>();
  const [cartReviewUrl, setCartReviewUrl] = useState<string>();
  const [locationBoundByCartApi, setLocationBoundByCartApi] = useState(false);
  const [cartNeedsRecompare, setCartNeedsRecompare] = useState(!oauthComparisonMatches);
  const [storeConfirmationPending, setStoreConfirmationPending] = useState(false);
  const [cartWriteSafetyState, setCartWriteSafetyState] = useState<CartWriteSafetyState>("IDLE");
  const [submissionJournalResult, setSubmissionJournalResult] = useState<
    KrogerSubmissionJournalView | null
  >(null);
  const cartTransferAvailable = comparison?.capabilities.retailers.some(
    (retailer) => retailer.id === "kroger" && retailer.handoff.mode === "CART_TRANSFER_SUPPORTED",
  ) ?? false;
  const [ownerCartRecovery, setOwnerCartRecovery] = useState<OwnerCartRecoveryState>({
    kind: cartTransferAvailable ? "checking" : "none",
  });
  const [recoveryActionMessage, setRecoveryActionMessage] = useState("");
  const [recoveryAcknowledging, setRecoveryAcknowledging] = useState(false);
  const [krogerConnection, setKrogerConnection] = useState<KrogerConnectionUiState>(
    cartTransferAvailable ? "checking" : "not_connected",
  );
  const [checkingKrogerConnection, setCheckingKrogerConnection] = useState(false);
  const [sessionResetConfirmationPending, setSessionResetConfirmationPending] = useState(false);
  const [resettingMobileSession, setResettingMobileSession] = useState(false);
  const [disconnectingKroger, setDisconnectingKroger] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("");
  const cartActionInFlightRef = useRef(false);
  const cartWriteInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const comparisonIdRef = useRef<string | null>(comparison?.comparisonId ?? null);
  const preparationAbortRef = useRef<AbortController | undefined>(undefined);
  const recoveryAbortRef = useRef<AbortController | undefined>(undefined);
  const recoveryActionAbortRef = useRef<AbortController | undefined>(undefined);
  const connectionAbortRef = useRef<AbortController | undefined>(undefined);
  const navigationBlocked = cartTransferBlocksNavigation(cartWriteSafetyState);
  const handoffBelongsToComparison = cartHandoffBelongsToComparison(
    handoffComparisonId,
    comparison?.comparisonId,
  );

  const refreshOwnerCartRecovery = useCallback((showChecking = true) => {
    recoveryAbortRef.current?.abort();
    if (!cartTransferAvailable) {
      setOwnerCartRecovery({ kind: "none" });
      return;
    }
    const controller = new AbortController();
    recoveryAbortRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CART_RECOVERY_TIMEOUT_MS);
    if (showChecking) setOwnerCartRecovery({ kind: "checking" });
    void getKrogerCartRecovery(controller.signal).then((recovery) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      if (recovery.status === "NONE") {
        // Owner-level server state is authoritative. Never let a stale local
        // marker resurrect an acknowledged or absent cart operation.
        setOwnerCartRecovery({ kind: "none" });
        void clearKrogerCartSubmissionMarkerAfterOwnerNone().then((cleared) => {
          if (!mountedRef.current || controller.signal.aborted) return;
          setSubmissionJournalResult((current) => journalAfterAuthoritativeOwnerNone(
            comparisonIdRef.current,
            cleared,
            current,
          ));
          if (!cleared) {
            setOwnerCartRecovery({ kind: "none", localCleanupPending: true });
          }
        });
      } else {
        setOwnerCartRecovery({ kind: "recovered", operation: recovery });
      }
    }).catch((error) => {
      if (!mountedRef.current || (controller.signal.aborted && !timedOut)) return;
      setOwnerCartRecovery({
        kind: "unavailable",
        message: error instanceof Error
          ? error.message
          : "Cartiva could not verify the latest Kroger cart operation.",
      });
    }).finally(() => {
      clearTimeout(timeout);
      if (recoveryAbortRef.current === controller) recoveryAbortRef.current = undefined;
    });
  }, [cartTransferAvailable]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!cartWriteInFlightRef.current) preparationAbortRef.current?.abort();
      recoveryAbortRef.current?.abort();
      recoveryActionAbortRef.current?.abort();
      connectionAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => refreshOwnerCartRecovery(false), 0);
    return () => clearTimeout(timer);
  }, [refreshOwnerCartRecovery]);

  const refreshKrogerConnection = useCallback((announce = false) => {
    connectionAbortRef.current?.abort();
    if (!cartTransferAvailable) {
      setCheckingKrogerConnection(false);
      setKrogerConnection("not_connected");
      if (announce) setConnectionMessage("");
      return;
    }
    const controller = new AbortController();
    connectionAbortRef.current = controller;
    setCheckingKrogerConnection(true);
    if (announce) setConnectionMessage("");
    void getKrogerAuthorizationStatus(controller.signal).then((status) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      const connection = status.authorization === "CONNECTED"
        ? "connected"
        : status.authorization === "NOT_CONNECTED" ? "not_connected" : "unavailable";
      setKrogerConnection(connection);
      if (announce) {
        setConnectionMessage(connection === "connected"
          ? "Kroger connection verified."
          : connection === "not_connected"
            ? "No saved Kroger connection was found. The next cart add will ask you to sign in."
            : "Kroger still could not be verified. You can retry or reset the saved Cartiva-side connection.");
      }
    }).catch((error) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      setKrogerConnection("unavailable");
      setConnectionMessage(
        error instanceof Error
          ? `${error.message} You can retry or reset the saved Cartiva-side connection.`
          : "Cartiva could not verify the Kroger connection. You can retry or reset the saved Cartiva-side connection.",
      );
    }).finally(() => {
      if (connectionAbortRef.current === controller) {
        connectionAbortRef.current = undefined;
        if (mountedRef.current) setCheckingKrogerConnection(false);
      }
    });
  }, [cartTransferAvailable]);

  useEffect(() => {
    const timer = setTimeout(() => refreshKrogerConnection(), 0);
    return () => {
      clearTimeout(timer);
      connectionAbortRef.current?.abort();
    };
  }, [refreshKrogerConnection]);

  useLayoutEffect(() => {
    comparisonIdRef.current = comparison?.comparisonId ?? null;
    return () => {
      if (!cartWriteInFlightRef.current) preparationAbortRef.current?.abort();
    };
  }, [comparison?.comparisonId]);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !navigationBlocked });
  }, [navigation, navigationBlocked]);

  useEffect(() => navigation.addListener("beforeRemove", (event) => {
    if (cartWriteInFlightRef.current) event.preventDefault();
  }), [navigation]);

  useEffect(() => {
    if (!navigationBlocked) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [navigationBlocked]);

  useEffect(() => {
    const comparisonId = comparison?.comparisonId;
    if (!comparisonId) return;
    let cancelled = false;
    void loadKrogerCartSubmissionMarker(comparisonId).then(async (stored) => {
      const marker = stored?.phase === "SUBMITTING"
        ? await markInterruptedKrogerCartSubmissionUnknown(stored)
        : stored;
      if (
        cancelled
        || comparisonIdRef.current !== comparisonId
      ) return;
      if (marker) setHandoffComparisonId(comparisonId);
      setSubmissionJournalResult({ comparisonId, marker });
    }).catch((error) => {
      if (cancelled || comparisonIdRef.current !== comparisonId) return;
      setHandoffComparisonId(comparisonId);
      setHandoffMessage(
        error instanceof Error
          ? error.message
          : "Cartiva could not verify an earlier cart attempt. Automatic cart add is disabled.",
      );
      setSubmissionJournalResult({
        comparisonId,
        marker: null,
        error: "submission_journal_unavailable",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [comparison?.comparisonId]);

  useEffect(() => {
    if (
      !oauthComparisonMatches
      || validatedOauthReturn?.status !== "connected"
      || !oauthReturn.comparisonId
    ) return;
    let cancelled = false;
    const controller = new AbortController();
    void getKrogerAuthorizationStatus(controller.signal).then((authorization) => {
      if (cancelled) return;
      setHandoffComparisonId(oauthReturn.comparisonId);
      if (authorization.authorization === "CONNECTED") {
        setKrogerConnection("connected");
        setCartState("connected");
        setHandoffMessage("Retailer authorization was confirmed. Review the basket, then add it with the button below.");
      } else {
        setKrogerConnection(authorization.authorization === "NOT_CONNECTED"
          ? "not_connected"
          : "unavailable");
        setCartState("failed");
        setHandoffMessage("Kroger did not confirm this connection. Nothing was transferred.");
      }
    }).catch(() => {
      if (cancelled) return;
      setCartState("failed");
      setHandoffMessage("Cartiva could not verify the retailer connection. Nothing was transferred.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [oauthComparisonMatches, oauthReturn.comparisonId, validatedOauthReturn?.status]);

  const ownerRecoveryOperation = ownerCartRecovery.kind === "recovered"
    ? ownerCartRecovery.operation
    : ownerCartRecovery.kind === "unavailable"
      ? ownerCartRecovery.operation
      : undefined;
  const ownerRecoveryHandoff = ownerRecoveryOperation?.status === "CONFIRMED"
    ? ownerRecoveryOperation.handoff
    : ownerRecoveryOperation?.reviewHandoff;

  const openRecoveredKrogerCart = async () => {
    if (!ownerRecoveryHandoff || cartWriteInFlightRef.current) return;
    setRecoveryActionMessage("");
    try {
      if (!await Linking.canOpenURL(ownerRecoveryHandoff.url)) {
        throw new Error("Unsupported Kroger cart URL");
      }
      analytics.track("retailer_handoff_started", {
        retailer: "kroger",
        mode: ownerRecoveryOperation?.status === "CONFIRMED"
          ? "confirmed_cart"
          : "shopping_page",
      });
      await Linking.openURL(ownerRecoveryHandoff.url);
    } catch {
      setRecoveryActionMessage(
        `The ${ownerRecoveryHandoff.retailerBanner} cart could not be opened. Open the retailer app or website yourself before acknowledging review.`,
      );
    }
  };

  const acknowledgeRecoveredKrogerCart = async () => {
    if (!ownerRecoveryOperation || recoveryAcknowledging || cartWriteInFlightRef.current) return;
    recoveryActionAbortRef.current?.abort();
    const controller = new AbortController();
    recoveryActionAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), CART_RECOVERY_TIMEOUT_MS);
    setRecoveryAcknowledging(true);
    setRecoveryActionMessage("");
    try {
      const review = await finishKrogerRecoveryReview({
        acknowledge: async () => {
          await acknowledgeKrogerCartRecovery(ownerRecoveryOperation.operationId, controller.signal);
        },
        clearLocal: clearKrogerCartSubmissionMarkerAfterOwnerNone,
        afterAcknowledgeFailure: () => refreshOwnerCartRecovery(),
      });
      setOwnerCartRecovery({
        kind: "none",
        localCleanupPending: !review.localCleanupSucceeded,
      });
      setRecoveryActionMessage(review.localCleanupSucceeded
        ? "Kroger cart review recorded. A new comparison can be submitted safely."
        : "Kroger cart review recorded. Device cleanup will retry automatically.");
      if (comparison?.comparisonId === ownerRecoveryOperation.comparisonId) {
        setSubmissionJournalResult({
          comparisonId: comparison.comparisonId,
          marker: null,
        });
        setHandoffComparisonId(comparison.comparisonId);
        setCartState("failed");
        setConfirmedCartUrl(undefined);
        setCartReviewUrl(undefined);
        setLocationBoundByCartApi(false);
        setCartNeedsRecompare(true);
        setCartWriteSafetyState("IDLE");
        setHandoffMessage(
          review.localCleanupSucceeded
            ? "Review recorded. Recompare this basket before starting a new Kroger cart update."
            : "Review recorded. Recompare this basket before starting a new Kroger cart update. Device cleanup will retry automatically.",
        );
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setRecoveryActionMessage(
        error instanceof Error
          ? error.message
          : "Cartiva could not record that you reviewed the Kroger cart.",
      );
    } finally {
      clearTimeout(timeout);
      if (recoveryActionAbortRef.current === controller) {
        recoveryActionAbortRef.current = undefined;
      }
      if (mountedRef.current) setRecoveryAcknowledging(false);
    }
  };

  const disconnectKrogerAccount = async () => {
    if (
      disconnectingKroger
      || resettingMobileSession
      || cartWriteInFlightRef.current
      || cartActionInFlightRef.current
      || recoveryAcknowledging
    ) return;
    setDisconnectingKroger(true);
    setConnectionMessage("");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const disconnected = await Promise.race([
        disconnectKroger(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(
            "Kroger disconnect took too long to confirm.",
          )), 12_000);
        }),
      ]);
      if (disconnected.authorization !== "NOT_CONNECTED") {
        throw new Error("Kroger did not confirm the disconnect.");
      }
      if (!mountedRef.current) return;
      setKrogerConnection("not_connected");
      setConnectionMessage(
        "Kroger is disconnected. The next cart add will ask you to sign in again.",
      );
    } catch (error) {
      if (!mountedRef.current) return;
      setConnectionMessage(
        error instanceof Error
          ? `${error.message} No account change is being assumed; check again before adding a cart.`
          : "Cartiva could not confirm the Kroger disconnect. No account change is being assumed.",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (mountedRef.current) setDisconnectingKroger(false);
    }
  };

  const resetCartivaSession = async () => {
    if (
      resettingMobileSession
      || cartWriteInFlightRef.current
      || cartActionInFlightRef.current
      || recoveryAcknowledging
    ) return;
    setResettingMobileSession(true);
    setConnectionMessage("");
    try {
      const reset = await resetMobileSession();
      if (!mountedRef.current) return;
      setSessionResetConfirmationPending(false);
      if (!reset.serverRevoked) {
        setKrogerConnection("not_connected");
        setConnectionMessage(
          "The damaged session was cleared from this device, but no valid server recovery credential remained to revoke. Any older one-hour access token will expire naturally. Return to your list to start a fresh comparison.",
        );
        return;
      }
      clearComparison();
      router.replace("/");
    } catch (error) {
      if (!mountedRef.current) return;
      setConnectionMessage(
        error instanceof Error
          ? `${error.message} The existing Cartiva session was not reported as cleared.`
          : "Cartiva could not clear the saved session. The existing owner was kept.",
      );
    } finally {
      if (mountedRef.current) setResettingMobileSession(false);
    }
  };

  const ownerRecoveryPanel = !cartTransferAvailable ? null : ownerCartRecovery.kind === "checking" ? (
    <View style={styles.recoveryNotice} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <MaterialCommunityIcons name="shield-check-outline" size={21} color={colors.emerald} />
      <View style={styles.recoveryCopy}>
        <Text style={styles.recoveryTitle}>Checking for an earlier Kroger cart</Text>
        <Text style={styles.recoveryText}>Cartiva will not submit another cart until this safety check finishes.</Text>
      </View>
    </View>
  ) : ownerRecoveryOperation && ownerRecoveryHandoff ? (
    <View style={styles.recoveryCard} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <View style={styles.recoveryHeadingRow}>
        <MaterialCommunityIcons
          name={ownerRecoveryOperation.status === "CONFIRMED" ? "cart-outline" : "alert-circle-outline"}
          size={23}
          color={ownerRecoveryOperation.status === "CONFIRMED" ? colors.emerald : colors.warning}
        />
        <Text style={styles.recoveryTitle}>
          {ownerRecoveryOperation.status === "CONFIRMED"
            ? `${ownerRecoveryHandoff.retailerBanner} cart added`
            : "Previous cart update needs review"}
        </Text>
      </View>
      <Text style={styles.recoveryText}>
        {ownerRecoveryOperation.message} This belongs to {ownerRecoveryOperation.comparisonId === comparison?.comparisonId
          ? "the comparison shown here"
          : "an earlier Cartiva comparison"}.
      </Text>
      <Text style={styles.recoveryStore}>
        Verify {ownerRecoveryHandoff.locationName}, every item, and every quantity before checkout.
      </Text>
      {ownerCartRecovery.kind === "unavailable" ? (
        <Text style={styles.recoveryError}>{ownerCartRecovery.message}</Text>
      ) : null}
      {recoveryActionMessage ? (
        <Text style={styles.recoveryError}>{recoveryActionMessage}</Text>
      ) : null}
      <View style={styles.recoveryActions}>
        <Pressable
          onPress={() => void openRecoveredKrogerCart()}
          disabled={navigationBlocked || recoveryAcknowledging}
          accessibilityRole="button"
          accessibilityState={{ disabled: navigationBlocked || recoveryAcknowledging }}
          style={({ pressed }) => [
            styles.recoveryOpen,
            (navigationBlocked || recoveryAcknowledging) && styles.disabledAction,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.recoveryOpenText}>
            {ownerRecoveryOperation.status === "CONFIRMED" ? "Open Kroger cart" : "Check Kroger cart"}
          </Text>
          <MaterialCommunityIcons name="open-in-new" size={16} color={colors.emeraldDeep} />
        </Pressable>
        {ownerCartRecovery.kind === "recovered" ? (
          <Pressable
            onPress={() => void acknowledgeRecoveredKrogerCart()}
            disabled={navigationBlocked || recoveryAcknowledging}
            accessibilityRole="button"
            accessibilityState={{
              disabled: navigationBlocked || recoveryAcknowledging,
              busy: recoveryAcknowledging,
            }}
            style={({ pressed }) => [
              styles.recoveryAcknowledge,
              (navigationBlocked || recoveryAcknowledging) && styles.disabledAction,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.recoveryAcknowledgeText}>
              {recoveryAcknowledging ? "Recording review…" : "I reviewed my Kroger cart"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  ) : ownerCartRecovery.kind === "unavailable" ? (
    <View style={styles.recoveryNotice} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <MaterialCommunityIcons name="shield-alert-outline" size={21} color={colors.warning} />
      <View style={styles.recoveryCopy}>
        <Text style={styles.recoveryTitle}>Automatic cart add is paused</Text>
        <Text style={styles.recoveryText}>{ownerCartRecovery.message}</Text>
        <Pressable
          onPress={() => refreshOwnerCartRecovery()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.recoveryRetry, pressed && styles.pressed]}
        >
          <Text style={styles.recoveryRetryText}>Retry safety check</Text>
        </Pressable>
      </View>
    </View>
  ) : ownerCartRecovery.kind === "none" && ownerCartRecovery.localCleanupPending ? (
    <View style={styles.recoveryNotice} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <MaterialCommunityIcons name="cloud-sync-outline" size={21} color={colors.emerald} />
      <View style={styles.recoveryCopy}>
        <Text style={styles.recoveryTitle}>Kroger review recorded</Text>
        <Text style={styles.recoveryText}>Device cleanup will retry automatically. The server safety check is complete.</Text>
        <Pressable
          onPress={() => refreshOwnerCartRecovery()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.recoveryRetry, pressed && styles.pressed]}
        >
          <Text style={styles.recoveryRetryText}>Retry device cleanup</Text>
        </Pressable>
      </View>
    </View>
  ) : null;

  if (!comparison) {
    return (
      <Screen>
        <View style={styles.empty}>
          <BrandMark />
          {ownerRecoveryPanel}
          <Text style={typography.heading}>No comparison yet</Text>
          <Text style={[typography.body, styles.emptyText]}>Write a grocery list to build a basket at a nearby Kroger-family store.</Text>
          <PrimaryButton
            label={navigationBlocked ? "Recording Kroger result…" : "Start my list"}
            onPress={() => router.replace("/")}
            disabled={navigationBlocked}
            loading={navigationBlocked}
          />
        </View>
      </Screen>
    );
  }

  const { summary, location } = comparison;
  const complete = summary.status === BasketCompleteness.COMPLETE;
  const retailerCapability = comparison.capabilities.retailers.find((retailer) => retailer.id === "kroger");
  const banner = retailerBanner(comparison.retailerBanner);
  const cartMutationReadiness = comparisonCartMutationReadiness(comparison);
  const cartInventoryVerified = cartMutationReadiness.ready
    || cartMutationReadiness.reason !== "INVENTORY_UNVERIFIED";
  const cartEvidenceFresh = cartMutationReadiness.ready
    || cartMutationReadiness.reason !== "RECEIPT_STALE";
  const ownerRecoveryAllowsCartWrite = ownerCartRecovery.kind === "none";
  const authoritativeCurrentRecovery = ownerRecoveryOperation?.comparisonId === comparison.comparisonId
    ? ownerRecoveryOperation
    : undefined;
  const submissionJournalReady = submissionJournalResult?.comparisonId === comparison.comparisonId
    && !submissionJournalResult.error;
  const restoredSubmission = submissionJournalReady
    ? visibleLocalKrogerSubmission(
        ownerCartRecovery.kind,
        submissionJournalResult?.marker ?? null,
      )
    : null;
  const restoredCartState: CartHandoffState | undefined = authoritativeCurrentRecovery
    ? authoritativeCurrentRecovery.status === "CONFIRMED" ? "confirmed" : "outcome_unknown"
    : restoredSubmission?.phase === "CONFIRMED"
      ? "confirmed"
      : restoredSubmission?.phase === "OUTCOME_UNKNOWN" || restoredSubmission?.phase === "SUBMITTING"
        ? "outcome_unknown"
        : undefined;
  const currentCartState: CartHandoffState = restoredCartState ?? (
    handoffBelongsToComparison ? cartState : "idle"
  );
  const currentConfirmedCartUrl = (
    authoritativeCurrentRecovery?.status === "CONFIRMED"
      ? authoritativeCurrentRecovery.handoff.url
      : undefined
  ) ?? restoredSubmission?.handoffUrl ?? (
    handoffBelongsToComparison ? confirmedCartUrl : undefined
  );
  const currentCartReviewUrl = (
    authoritativeCurrentRecovery?.status === "OUTCOME_UNKNOWN"
      ? authoritativeCurrentRecovery.reviewHandoff.url
      : undefined
  ) ?? restoredSubmission?.reviewUrl ?? (
    handoffBelongsToComparison ? cartReviewUrl : undefined
  );
  const currentHandoffMessage = authoritativeCurrentRecovery?.message
    ?? restoredSubmission?.message ?? (
    handoffBelongsToComparison ? handoffMessage : ""
  );
  const currentLocationBoundByCartApi = authoritativeCurrentRecovery || restoredSubmission
    ? false
    : handoffBelongsToComparison && locationBoundByCartApi;
  const currentCartNeedsRecompare = handoffBelongsToComparison && cartNeedsRecompare;
  const submittedOutcome = currentCartState === "confirmed" || currentCartState === "outcome_unknown";
  const retailerDestination = currentConfirmedCartUrl ?? currentCartReviewUrl ?? (
    location.handoff.mode === "SHOPPING_PAGE_ONLY" ? location.handoff.url : undefined
  );
  const handoffState = handoffPresentation({
    complete,
    mode: retailerCapability?.handoff.mode,
    chain: comparison.retailerBanner,
    locationName: comparison.locationName,
    hasDestination: Boolean(retailerDestination),
    cartState: currentCartState,
    cartWriteReady: comparison.serverReceiptPersisted && !currentCartNeedsRecompare && cartEvidenceFresh,
    cartInventoryVerified,
    locationBoundByCartApi: currentLocationBoundByCartApi,
    hasCartReviewDestination: Boolean(currentCartReviewUrl),
  });
  const requiresRecompare = retailerCapability?.handoff.mode === "CART_TRANSFER_SUPPORTED"
    && !submittedOutcome
    && (!comparison.serverReceiptPersisted || currentCartNeedsRecompare || !cartEvidenceFresh);
  const cartTransferMode = retailerCapability?.handoff.mode === "CART_TRANSFER_SUPPORTED";
  const cartBusy = currentCartState === "checking"
    || currentCartState === "authorizing"
    || currentCartState === "adding"
    || disconnectingKroger;
  const selectedUnitCount = comparison.basketLines
    .filter((line) => line.status === "ACCEPTED")
    .reduce((total, line) => total + line.quantity, 0);
  const connectionControl = krogerConnectionControl(krogerConnection);

  const openHandoff = async () => {
    if (cartWriteInFlightRef.current) return;
    if (!retailerDestination) {
      setHandoffMessage(`${banner} could not be opened. Your Cartiva basket is safe; run the comparison again before continuing.`);
      return;
    }
    try {
      if (!isTrustedKrogerRetailerUrl(retailerDestination)) {
        throw new Error("Untrusted retailer URL");
      }
      if (!await Linking.canOpenURL(retailerDestination)) throw new Error("Unsupported retailer URL");
      analytics.track("retailer_handoff_started", {
        retailer: "kroger",
        mode: currentCartState === "confirmed" ? "confirmed_cart" : "shopping_page",
      });
      bestEffortHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
      await Linking.openURL(retailerDestination);
    } catch {
      setHandoffMessage(`${banner} couldn’t open. Open the retailer app or website yourself and confirm ${comparison.locationName} is selected. Your matched basket remains in Cartiva.`);
    }
  };

  const openRetailer = (forceStoreConfirmation = false) => {
    if (cartWriteInFlightRef.current) return;
    if (!forceStoreConfirmation && !handoffState.requiresStoreConfirmation) {
      void openHandoff();
      return;
    }
    setStoreConfirmationPending(true);
  };
  const storeConfirmationText = currentCartState === "confirmed"
    ? `${banner} accepted the selected products, but its cart API did not bind them to ${comparison.locationName}. Verify the active store, items, and quantities before checkout.`
    : currentCartState === "outcome_unknown"
      ? `The cart update could not be confirmed. Open ${banner}, check for the items, and verify ${comparison.locationName} before taking another action.`
      : `${banner} may open with a previously saved location. Before shopping, confirm ${comparison.locationName} is selected. No cart has been transferred.`;

  const addCart = async () => {
    if (cartBusy || disconnectingKroger || cartActionInFlightRef.current) return;
    if (!ownerRecoveryAllowsCartWrite) {
      setHandoffMessage(
        ownerRecoveryOperation
          ? "Review and acknowledge the earlier Kroger cart before submitting another."
          : "Cartiva could not verify whether an earlier Kroger cart needs review. Automatic cart add remains paused.",
      );
      return;
    }
    if (!submissionJournalReady) {
      setHandoffMessage("Cartiva is checking for an earlier cart attempt before anything can be sent.");
      return;
    }
    if (requiresRecompare) {
      router.replace("/comparing");
      return;
    }
    const identity = {
      comparisonId: comparison.comparisonId,
      locationId: comparison.locationId,
      retailerBanner: comparison.retailerBanner,
    };
    try {
      await persistComparisonForHandoff(identity.comparisonId);
    } catch (error) {
      setCartState("failed");
      setHandoffMessage(
        error instanceof Error
          ? error.message
          : "Cartiva could not save this basket safely. Nothing was sent to Kroger.",
      );
      return;
    }
    if (!mountedRef.current || comparisonIdRef.current !== identity.comparisonId) return;
    const controller = new AbortController();
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = controller;
    cartActionInFlightRef.current = true;
    setHandoffComparisonId(identity.comparisonId);
    setCartState("idle");
    setCartWriteSafetyState("PREPARING");
    setHandoffMessage("");
    setConfirmedCartUrl(undefined);
    setCartReviewUrl(undefined);
    setLocationBoundByCartApi(false);
    setCartNeedsRecompare(false);
    setStoreConfirmationPending(false);
    try {
      const result = await runGuardedKrogerCartTransfer({
        identity,
        signal: controller.signal,
        isCurrent: (comparisonId) => (
          mountedRef.current && comparisonIdRef.current === comparisonId
        ),
        getAuthorizationStatus: getKrogerAuthorizationStatus,
        authorize: authorizeKroger,
        prepareCartWrite: markKrogerCartSubmitting,
        cancelPreparedCartWrite: ({ comparisonId }) => (
          clearKrogerCartSubmissionMarker(comparisonId)
        ),
        addToCart: addComparisonToKrogerCart,
        recordCartOutcome: recordKrogerCartSubmissionOutcome,
        onPhase: (phase) => {
          if (phase === "CHECKING_AUTHORIZATION") {
            setCartState("checking");
            return;
          }
          if (phase === "AUTHORIZING") {
            setCartState("authorizing");
            return;
          }
          if (phase === "AUTHORIZATION_CONNECTED") {
            setKrogerConnection((current) => (
              krogerConnectionAfterCartTransferPhase(current, phase)
            ));
            setCartState("connected");
            return;
          }
          if (phase === "CART_WRITE_STARTED") {
            // This ref flips synchronously before the POST. Navigation cannot
            // slip through while React is scheduling the visual loading state.
            cartWriteInFlightRef.current = true;
            navigation.setOptions({ gestureEnabled: false });
            setCartWriteSafetyState("CART_WRITE_STARTED");
            setCartState("adding");
          }
        },
      });

      if (result.kind === "STALE_BEFORE_WRITE") {
        if (mountedRef.current) {
          setCartState("idle");
          setCartWriteSafetyState("IDLE");
          setHandoffMessage("The basket changed before any retailer cart action. Review the current comparison and try again.");
        }
        return;
      }

      if (result.kind === "AUTHORIZATION_STATUS") {
        setCartWriteSafetyState("IDLE");
        setCartState("unavailable");
        setHandoffMessage(
          result.authorization.capability.reason
          || "This retailer connection cannot transfer a cart right now.",
        );
        return;
      }

      if (result.kind === "AUTHORIZATION_OUTCOME") {
        setCartWriteSafetyState("IDLE");
        const authorization = result.authorization;
        if (authorization.status === "CANCELLED") {
          setCartState("cancelled");
        } else if (authorization.status === "UNAVAILABLE") {
          setCartState("unavailable");
        } else {
          const failure = authorizationFailureState(authorization.code);
          setCartState(failure.cartState);
          if (failure.requiresRecompare) setCartNeedsRecompare(true);
        }
        setHandoffMessage(authorization.message);
        return;
      }

      const outcome = result.outcome;
      try {
        if (outcome.status === "CONFIRMED") {
          setCartState("confirmed");
          setConfirmedCartUrl(outcome.handoff.url);
          setLocationBoundByCartApi(outcome.handoff.locationBoundByCartApi);
          setHandoffMessage(outcome.message);
          analytics.track("retailer_cart_added", {
            retailer: "kroger",
            item_count: outcome.itemCount,
            unit_count: outcome.addedCount,
          });
          bestEffortHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
        } else {
          setHandoffMessage(outcome.error);
          if (outcome.reviewHandoff) {
            setCartReviewUrl(outcome.reviewHandoff.url);
            setLocationBoundByCartApi(outcome.reviewHandoff.locationBoundByCartApi);
          }
          const failure = cartAddFailureState(outcome);
          setCartState(failure.cartState);
          if (failure.requiresRecompare) setCartNeedsRecompare(true);
        }
      } finally {
        // Record the terminal UI state before releasing navigation. React
        // batches these updates into one render, so no retry surface appears
        // between a retailer response and its confirmed/unknown/failed state.
        cartWriteInFlightRef.current = false;
        navigation.setOptions({ gestureEnabled: true });
        setCartWriteSafetyState("OUTCOME_RECORDED");
      }
      refreshOwnerCartRecovery();
    } catch (error) {
      if (cartWriteInFlightRef.current) {
        setCartState("outcome_unknown");
        setHandoffMessage("Cartiva could not record Kroger's response. Check your retailer cart before trying again.");
        cartWriteInFlightRef.current = false;
        navigation.setOptions({ gestureEnabled: true });
        setCartWriteSafetyState("OUTCOME_RECORDED");
        refreshOwnerCartRecovery();
        return;
      }
      if (!mountedRef.current || comparisonIdRef.current !== identity.comparisonId) return;
      setCartWriteSafetyState("IDLE");
      setCartState("failed");
      setHandoffMessage(
        error instanceof Error ? error.message : "The retailer connection could not be checked.",
      );
    } finally {
      if (preparationAbortRef.current === controller) preparationAbortRef.current = undefined;
      cartActionInFlightRef.current = false;
    }
  };

  const handoff = () => {
    if (cartWriteInFlightRef.current) return;
    if (!ownerRecoveryAllowsCartWrite && cartTransferMode) {
      setHandoffMessage(
        ownerRecoveryOperation
          ? "Review and acknowledge the earlier Kroger cart before submitting another."
          : "Cartiva could not verify whether an earlier Kroger cart needs review. Automatic cart add remains paused.",
      );
      return;
    }
    if (!submissionJournalReady && cartTransferMode) {
      setHandoffMessage("Cartiva is checking for an earlier cart attempt before anything can be sent.");
      return;
    }
    if (requiresRecompare) {
      router.replace("/comparing");
      return;
    }
    if (
      cartTransferMode
      && cartInventoryVerified
      && !["confirmed", "outcome_unknown", "unavailable"].includes(currentCartState)
    ) {
      void addCart();
      return;
    }
    openRetailer();
  };

  const showShoppingFallback = cartTransferMode
    && cartInventoryVerified
    && Boolean(retailerDestination)
    && !cartBusy
    && !["confirmed", "outcome_unknown", "unavailable"].includes(currentCartState);
  const handoffNeedsAttention = handoffState.kind === "incomplete"
    || ["cancelled", "failed", "outcome_unknown", "unavailable"].includes(currentCartState)
    || requiresRecompare;

  const editList = () => {
    if (cartWriteInFlightRef.current) return;
    clearComparison();
    router.replace("/");
  };

  const viewMatchedItems = () => {
    if (cartWriteInFlightRef.current) return;
    router.push("/basket/kroger");
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
        <View style={styles.header}>
          <BrandMark compact />
          <Pressable
            onPress={editList}
            disabled={navigationBlocked}
            accessibilityRole="button"
            accessibilityLabel="Edit grocery list"
            accessibilityState={{ disabled: navigationBlocked }}
            hitSlop={8}
            style={({ pressed }) => [
              styles.headerButton,
              navigationBlocked && styles.disabledAction,
              pressed && !navigationBlocked && styles.pressed,
            ]}
          >
            <MaterialCommunityIcons name="pencil-outline" size={21} color={colors.emeraldDeep} />
          </Pressable>
        </View>

        <Text style={[typography.eyebrow, styles.eyebrow]}>Your result</Text>
        <Text style={typography.screenTitle}>{complete ? "Your complete basket" : "Your basket needs review"}</Text>
        <Text style={[typography.body, styles.intro]}>
          {complete
            ? "Every requested line has an accepted product match at one store. Review item-level availability evidence before continuing."
            : "At least one requested line has no accepted match. This basket is incomplete and does not receive a complete total."}
        </Text>

        <GlassCard strong style={styles.resultCard}>
          <View style={styles.retailerRow}>
            <View style={styles.retailerMark}>
              <Text style={styles.retailerLetter}>{banner.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.retailerCopy}>
              <Text style={styles.chain}>{banner}</Text>
              <Text style={styles.official}>Official retailer data</Text>
            </View>
            <View style={[styles.statusPill, !complete && styles.statusPillWarning]}>
              <MaterialCommunityIcons
                name={complete ? "check-circle" : "alert-circle"}
                size={14}
                color={complete ? colors.emerald : colors.warning}
              />
              <Text style={[styles.statusPillText, !complete && styles.statusPillTextWarning]}>
                {complete ? "Complete" : "Incomplete"}
              </Text>
            </View>
          </View>

          <View style={styles.totalArea}>
            <Text style={styles.matchCount}>{summary.matchedCount} / {summary.requestedCount} matched</Text>
            {selectedUnitCount > 0 ? (
              <Text style={styles.unitCount}>
                {selectedUnitCount} retailer {selectedUnitCount === 1 ? "unit" : "units"} selected
              </Text>
            ) : null}
            {complete && summary.totalCents !== undefined ? (
              <Text style={styles.total}>{money.format(summary.totalCents / 100)}</Text>
            ) : (
              <>
                <Text style={styles.incompleteLabel}>No complete-basket total</Text>
                {summary.matchedSubtotalCents > 0 ? (
                  <Text style={styles.subtotal}>{money.format(summary.matchedSubtotalCents / 100)} matched-item subtotal</Text>
                ) : null}
              </>
            )}
            <Text style={styles.checked}>{timeLabel(comparison.checkedAt)}</Text>
          </View>

          <View style={styles.storeArea}>
            <MaterialCommunityIcons name="store-marker-outline" size={22} color={colors.emerald} />
            <View style={styles.storeCopy}>
              <Text style={styles.storeName}>{comparison.locationName}</Text>
              <Text style={styles.storeAddress}>{comparison.locationAddress}</Text>
              <Text style={styles.storeBasis}>This store was used for product matching, prices, and availability evidence.</Text>
            </View>
          </View>
        </GlassCard>

        {ownerRecoveryPanel}

        {cartTransferMode && (connectionControl || connectionMessage) ? (
          <View style={styles.connectionCard} accessibilityLiveRegion="polite">
            <View style={styles.connectionHeadingRow}>
              <MaterialCommunityIcons
                name={krogerConnection === "connected" ? "account-check-outline" : "account-alert-outline"}
                size={21}
                color={krogerConnection === "connected" ? colors.emerald : colors.warning}
              />
              <Text style={styles.connectionTitle}>
                {connectionControl?.title ?? "Kroger account disconnected"}
              </Text>
            </View>
            <Text style={styles.connectionText}>
              {connectionControl?.detail ?? connectionMessage}
            </Text>
            {connectionControl ? (
              <View style={styles.connectionActions}>
                {connectionControl.canRetry ? (
                  <Pressable
                    onPress={() => refreshKrogerConnection(true)}
                    disabled={navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging}
                    accessibilityRole="button"
                    accessibilityLabel="Retry Kroger connection check"
                    accessibilityState={{
                      disabled: navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging,
                      busy: checkingKrogerConnection,
                    }}
                    style={({ pressed }) => [
                      styles.disconnectButton,
                      (navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging) && styles.disabledAction,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.disconnectButtonText}>
                      {checkingKrogerConnection ? "Checking…" : "Retry connection check"}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => void disconnectKrogerAccount()}
                  disabled={navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging}
                  accessibilityRole="button"
                  accessibilityLabel={connectionControl.resetAccessibilityLabel}
                  accessibilityHint="The next Kroger cart add will ask you to sign in again."
                  accessibilityState={{
                    disabled: navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging,
                    busy: disconnectingKroger,
                  }}
                  style={({ pressed }) => [
                    styles.disconnectButton,
                    (navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging) && styles.disabledAction,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.disconnectButtonText}>
                    {disconnectingKroger
                      ? krogerConnection === "unavailable" ? "Resetting…" : "Disconnecting…"
                      : connectionControl.resetLabel}
                  </Text>
                </Pressable>
                {connectionControl.canResetSession ? (
                  <Pressable
                    onPress={() => setSessionResetConfirmationPending(true)}
                    disabled={navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging}
                    accessibilityRole="button"
                    accessibilityLabel="Reset Cartiva anonymous session"
                    accessibilityHint="Shows a warning before clearing this device’s anonymous Cartiva history."
                    accessibilityState={{
                      disabled: navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging,
                    }}
                    style={({ pressed }) => [
                      styles.sessionResetButton,
                      (navigationBlocked || checkingKrogerConnection || disconnectingKroger || resettingMobileSession || recoveryAcknowledging) && styles.disabledAction,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.sessionResetButtonText}>Reset Cartiva session…</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {connectionMessage && connectionControl ? (
              <Text style={styles.connectionError}>{connectionMessage}</Text>
            ) : null}
            {sessionResetConfirmationPending && connectionControl?.canResetSession ? (
              <View style={styles.sessionResetWarning} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                <Text style={styles.sessionResetWarningTitle}>Check Kroger before resetting</Text>
                <Text style={styles.sessionResetWarningText}>
                  First open Kroger yourself and inspect the cart for any earlier Cartiva add. Resetting permanently disconnects this iPhone from its anonymous Cartiva comparison and cart-recovery history. It does not remove retailer items or affect payment information.
                </Text>
                <View style={styles.storeConfirmationActions}>
                  <Pressable
                    onPress={() => setSessionResetConfirmationPending(false)}
                    disabled={resettingMobileSession}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: resettingMobileSession }}
                    style={({ pressed }) => [styles.confirmationCancel, pressed && styles.pressed]}
                  >
                    <Text style={styles.confirmationCancelText}>Keep this session</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void resetCartivaSession()}
                    disabled={resettingMobileSession}
                    accessibilityRole="button"
                    accessibilityLabel="I checked Kroger, reset Cartiva session"
                    accessibilityState={{ disabled: resettingMobileSession, busy: resettingMobileSession }}
                    style={({ pressed }) => [
                      styles.sessionResetConfirm,
                      resettingMobileSession && styles.disabledAction,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.sessionResetConfirmText}>
                      {resettingMobileSession ? "Resetting…" : "I checked — reset"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        <Pressable
          onPress={viewMatchedItems}
          disabled={navigationBlocked}
          accessibilityRole="button"
          accessibilityState={{ disabled: navigationBlocked }}
          style={({ pressed }) => [
            styles.detailsButton,
            navigationBlocked && styles.disabledAction,
            pressed && !navigationBlocked && styles.pressed,
          ]}
        >
          <View>
            <Text style={styles.detailsTitle}>View matched items</Text>
            <Text style={styles.detailsNote}>Inspect evidence, alternatives, and exclusions</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={24} color={colors.emeraldDeep} />
        </Pressable>

        {handoffState.primaryLabel ? (
          <PrimaryButton
            label={handoffState.primaryLabel}
            onPress={handoff}
            disabled={
              !handoffState.primaryEnabled
              || navigationBlocked
              || (cartTransferMode && !submissionJournalReady)
              || (cartTransferMode && !ownerRecoveryAllowsCartWrite)
            }
            loading={cartBusy}
            icon={requiresRecompare
              ? "refresh"
              : cartTransferMode && cartInventoryVerified && !["confirmed", "outcome_unknown", "unavailable"].includes(currentCartState)
                ? "cart-plus"
                : "open-in-new"}
          />
        ) : null}

        {showShoppingFallback ? (
          <Pressable
            onPress={() => openRetailer(true)}
            disabled={navigationBlocked}
            accessibilityRole="button"
            accessibilityLabel={`Continue at ${banner} without transferring the cart`}
            accessibilityState={{ disabled: navigationBlocked }}
            style={({ pressed }) => [
              styles.fallbackButton,
              navigationBlocked && styles.disabledAction,
              pressed && !navigationBlocked && styles.pressed,
            ]}
          >
            <Text style={styles.fallbackButtonText}>Continue at {banner} without transfer</Text>
          </Pressable>
        ) : null}

        {storeConfirmationPending ? (
          <View style={styles.storeConfirmation} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <View style={styles.storeConfirmationTitleRow}>
              <MaterialCommunityIcons name="store-marker-outline" size={21} color={colors.warning} />
              <Text style={styles.storeConfirmationTitle}>Confirm your pickup store</Text>
            </View>
            <Text style={styles.storeConfirmationText}>{storeConfirmationText}</Text>
            <View style={styles.storeConfirmationActions}>
              <Pressable
                onPress={() => setStoreConfirmationPending(false)}
                disabled={navigationBlocked}
                accessibilityRole="button"
                accessibilityState={{ disabled: navigationBlocked }}
                style={({ pressed }) => [
                  styles.confirmationCancel,
                  navigationBlocked && styles.disabledAction,
                  pressed && !navigationBlocked && styles.pressed,
                ]}
              >
                <Text style={styles.confirmationCancelText}>Stay in Cartiva</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (cartWriteInFlightRef.current) return;
                  setStoreConfirmationPending(false);
                  void openHandoff();
                }}
                disabled={navigationBlocked}
                accessibilityRole="button"
                accessibilityState={{ disabled: navigationBlocked }}
                style={({ pressed }) => [
                  styles.confirmationOpen,
                  navigationBlocked && styles.disabledAction,
                  pressed && !navigationBlocked && styles.pressed,
                ]}
              >
                <Text style={styles.confirmationOpenText}>Open {banner}</Text>
                <MaterialCommunityIcons name="open-in-new" size={16} color={colors.white} />
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={[styles.handoffNote, handoffNeedsAttention && styles.handoffNoteWarning]} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <MaterialCommunityIcons
            name={currentCartState === "confirmed"
              ? "check-circle-outline"
              : handoffNeedsAttention ? "alert-circle-outline" : "shield-check-outline"}
            size={20}
            color={handoffNeedsAttention ? colors.warning : colors.emerald}
          />
          <View style={styles.handoffCopy}>
            <Text style={styles.handoffTitle}>{handoffState.statusTitle}</Text>
            <Text style={styles.handoffText}>{handoffState.statusDetail} Cartiva never receives payment information.</Text>
            {currentHandoffMessage ? <Text style={styles.handoffMessage}>{currentHandoffMessage}</Text> : null}
          </View>
        </View>

        <Pressable
          onPress={editList}
          disabled={navigationBlocked}
          accessibilityRole="button"
          accessibilityState={{ disabled: navigationBlocked }}
          style={({ pressed }) => [
            styles.editList,
            navigationBlocked && styles.disabledAction,
            pressed && !navigationBlocked && styles.pressed,
          ]}
        >
          <MaterialCommunityIcons name="arrow-left" size={18} color={colors.emeraldDeep} />
          <Text style={styles.editListText}>Return to list</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 42 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  eyebrow: { marginTop: 32, marginBottom: 9 },
  intro: { marginTop: 12 },
  resultCard: { marginTop: 26 },
  retailerRow: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18 },
  retailerMark: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: colors.emeraldDeep },
  retailerLetter: { color: colors.white, fontSize: 20, fontWeight: "900" },
  retailerCopy: { flex: 1 },
  chain: { color: colors.ink, fontSize: 16, fontWeight: "900", textTransform: "uppercase", letterSpacing: 0.4 },
  official: { color: colors.inkMuted, fontSize: 11, fontWeight: "700", marginTop: 3 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.pill, backgroundColor: "rgba(114,221,162,0.2)", paddingHorizontal: 9, paddingVertical: 6 },
  statusPillWarning: { backgroundColor: colors.warningSurface },
  statusPillText: { color: colors.emerald, fontSize: 11, fontWeight: "800" },
  statusPillTextWarning: { color: colors.warning },
  totalArea: { alignItems: "center", borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, paddingHorizontal: 18, paddingVertical: 24 },
  matchCount: { color: colors.emerald, fontSize: 13, fontWeight: "800" },
  unitCount: { color: colors.inkMuted, fontSize: 11, fontWeight: "700", marginTop: 5 },
  total: { color: colors.ink, fontSize: 48, fontWeight: "900", letterSpacing: -2, marginTop: 8 },
  incompleteLabel: { color: colors.ink, fontSize: 23, fontWeight: "900", letterSpacing: -0.7, marginTop: 9 },
  subtotal: { color: colors.inkSoft, fontSize: 13, fontWeight: "700", marginTop: 7 },
  checked: { color: colors.inkMuted, fontSize: 11, marginTop: 8 },
  storeArea: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 18 },
  storeCopy: { flex: 1 },
  storeName: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  storeAddress: { color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 4 },
  storeBasis: { color: colors.inkMuted, fontSize: 11, lineHeight: 16, marginTop: 7 },
  recoveryNotice: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 16, borderRadius: radius.medium, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceMint, padding: 14 },
  recoveryCard: { marginTop: 16, borderRadius: radius.medium, borderWidth: 1, borderColor: "rgba(139,100,43,0.28)", backgroundColor: colors.warningSurface, padding: 16 },
  recoveryHeadingRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  recoveryCopy: { flex: 1 },
  recoveryTitle: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: "900", lineHeight: 20 },
  recoveryText: { color: colors.inkSoft, fontSize: 12, lineHeight: 18, marginTop: 6 },
  recoveryStore: { color: colors.warning, fontSize: 12, fontWeight: "700", lineHeight: 18, marginTop: 8 },
  recoveryError: { color: colors.warning, fontSize: 12, fontWeight: "700", lineHeight: 18, marginTop: 8 },
  recoveryActions: { gap: 8, marginTop: 14 },
  recoveryOpen: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceStrong, paddingHorizontal: 14 },
  recoveryOpenText: { color: colors.emeraldDeep, fontSize: 13, fontWeight: "800" },
  recoveryAcknowledge: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.emeraldDeep, paddingHorizontal: 14 },
  recoveryAcknowledgeText: { color: colors.white, fontSize: 13, fontWeight: "800", textAlign: "center" },
  recoveryRetry: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center", marginTop: 8 },
  recoveryRetryText: { color: colors.emeraldDeep, fontSize: 13, fontWeight: "800" },
  connectionCard: { marginTop: 14, borderRadius: radius.medium, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 15 },
  connectionHeadingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  connectionTitle: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: "900" },
  connectionText: { marginTop: 8, color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  connectionActions: { marginTop: 8, gap: 8 },
  disconnectButton: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center", marginTop: 8, paddingHorizontal: 2 },
  disconnectButtonText: { color: colors.emeraldDeep, fontSize: 13, fontWeight: "800" },
  connectionError: { marginTop: 6, color: colors.warning, fontSize: 12, lineHeight: 18 },
  sessionResetButton: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center", paddingHorizontal: 2 },
  sessionResetButtonText: { color: colors.warning, fontSize: 13, fontWeight: "800" },
  sessionResetWarning: { marginTop: 12, borderRadius: radius.medium, borderWidth: 1, borderColor: "rgba(139,100,43,0.28)", backgroundColor: colors.warningSurface, padding: 15 },
  sessionResetWarningTitle: { color: colors.ink, fontSize: 14, fontWeight: "900" },
  sessionResetWarningText: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: 8 },
  sessionResetConfirm: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.warning, paddingHorizontal: 14 },
  sessionResetConfirmText: { color: colors.white, fontSize: 12, fontWeight: "800", textAlign: "center" },
  detailsButton: { minHeight: 72, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 16, borderRadius: radius.medium, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: 16 },
  detailsTitle: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  detailsNote: { color: colors.inkMuted, fontSize: 11, marginTop: 4 },
  fallbackButton: { minHeight: 50, alignItems: "center", justifyContent: "center", marginTop: 7, borderRadius: radius.pill },
  fallbackButtonText: { color: colors.emeraldDeep, fontSize: 13, fontWeight: "800", textAlign: "center" },
  storeConfirmation: { marginTop: 12, borderRadius: radius.medium, borderWidth: 1, borderColor: "rgba(139,100,43,0.28)", backgroundColor: colors.warningSurface, padding: 15 },
  storeConfirmationTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  storeConfirmationTitle: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: "900" },
  storeConfirmationText: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: 8 },
  storeConfirmationActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 13 },
  confirmationCancel: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  confirmationCancelText: { color: colors.emeraldDeep, fontSize: 12, fontWeight: "800" },
  confirmationOpen: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: radius.pill, backgroundColor: colors.emeraldDeep, paddingHorizontal: 15 },
  confirmationOpenText: { color: colors.white, fontSize: 12, fontWeight: "800" },
  handoffNote: { flexDirection: "row", alignItems: "flex-start", gap: 9, marginTop: 17, borderRadius: radius.medium, backgroundColor: colors.surfaceMint, padding: 14 },
  handoffNoteWarning: { backgroundColor: colors.warningSurface },
  handoffCopy: { flex: 1 },
  handoffTitle: { color: colors.ink, fontSize: 13, fontWeight: "800", lineHeight: 18 },
  handoffText: { flex: 1, color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  handoffMessage: { color: colors.warning, fontSize: 12, fontWeight: "700", lineHeight: 18, marginTop: 7 },
  editList: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 13 },
  editListText: { color: colors.emeraldDeep, fontSize: 14, fontWeight: "800" },
  disabledAction: { opacity: 0.45 },
  pressed: { opacity: 0.62 },
  empty: { flex: 1, justifyContent: "center", paddingHorizontal: 24, gap: 18 },
  emptyText: { marginTop: -8 },
});
