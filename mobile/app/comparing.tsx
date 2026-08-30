import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GlassCard } from "@/components/glass-card";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import type { CartivaApiError } from "@/services/cartiva-api";
import { comparisonProgressAnnouncement } from "@/services/accessibility-progress";
import { comparisonHeading, comparisonRecovery } from "@/services/mobile-ux";
import { isComparisonRunSuperseded } from "@/state/comparison-run";
import { useCartiva, type ComparisonProgress } from "@/state/cartiva-context";
import { colors, radius, typography } from "@/theme";

type StageState = "waiting" | "active" | "complete" | "warning";

interface ItemProgress {
  index: number;
  name: string;
  state: StageState;
}

interface ComparisonFailure {
  message: string;
  code?: string;
  status?: number;
}

function StageIcon({ state }: { state: StageState }) {
  if (state === "active") return <ActivityIndicator size="small" color={colors.emerald} />;
  if (state === "complete") return <MaterialCommunityIcons name="check-circle" size={22} color={colors.emerald} />;
  if (state === "warning") return <MaterialCommunityIcons name="alert-circle" size={22} color={colors.warning} />;
  return <MaterialCommunityIcons name="circle-outline" size={21} color="rgba(82,97,88,0.35)" />;
}

export default function ComparingScreen() {
  const router = useRouter();
  const { cancelComparisonRun, startComparison } = useCartiva();
  const [locationState, setLocationState] = useState<StageState>("waiting");
  const [locationName, setLocationName] = useState("");
  const [locationChain, setLocationChain] = useState("");
  const [items, setItems] = useState<ItemProgress[]>([]);
  const [basketState, setBasketState] = useState<StageState>("waiting");
  const [basketLabel, setBasketLabel] = useState("Checking basket completeness");
  const [error, setError] = useState<ComparisonFailure | null>(null);
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  const lastAnnouncementRef = useRef("");
  const startComparisonRef = useRef(startComparison);

  useEffect(() => {
    startComparisonRef.current = startComparison;
  }, [startComparison]);

  const handleProgress = useCallback((progress: ComparisonProgress) => {
    if (!mountedRef.current) return;
    const announcement = comparisonProgressAnnouncement(progress);
    if (
      Platform.OS === "ios"
      && announcement
      && lastAnnouncementRef.current !== announcement
    ) {
      lastAnnouncementRef.current = announcement;
      AccessibilityInfo.announceForAccessibility(announcement);
    }
    if (progress.type === "understood") {
      setLocationState("active");
      return;
    }
    if (progress.type === "location-started") {
      setLocationState("active");
      return;
    }
    if (progress.type === "location-found") {
      setLocationState("complete");
      setLocationName(progress.location.name);
      setLocationChain(progress.location.chain);
      return;
    }
    if (progress.type === "item-search") {
      setItems((current) => {
        const without = current.filter((item) => item.index !== progress.index);
        const next: ItemProgress = {
          index: progress.index,
          name: progress.item,
          state: "active",
        };
        return [...without, next]
          .sort((a, b) => a.index - b.index);
      });
      return;
    }
    if (progress.type === "item-verified") {
      setItems((current) => {
        const without = current.filter((item) => item.index !== progress.index);
        const next: ItemProgress = {
          index: progress.index,
          name: progress.item,
          state: progress.matched ? "complete" : "warning",
        };
        return [...without, next].sort((a, b) => a.index - b.index);
      });
      setBasketState("active");
      return;
    }
    setBasketState(progress.matchedCount === progress.requestedCount ? "complete" : "warning");
    setBasketLabel(`${progress.matchedCount} of ${progress.requestedCount} items verified`);
  }, []);

  const run = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError(null);
    setLocationState("active");
    setLocationName("");
    setLocationChain("");
    setItems([]);
    setBasketState("waiting");
    setBasketLabel("Checking basket completeness");
    lastAnnouncementRef.current = "";
    try {
      await startComparisonRef.current(handleProgress);
      if (mountedRef.current) router.replace("/results");
    } catch (reason) {
      if (isComparisonRunSuperseded(reason)) return;
      if (!mountedRef.current) return;
      const known = reason as CartivaApiError;
      setError({
        message: known instanceof Error ? known.message : "Kroger couldn't be checked right now.",
        code: known?.code,
        status: known?.status,
      });
      setLocationState((state) => state === "active" ? "warning" : state);
    }
  }, [handleProgress, router]);

  useEffect(() => {
    mountedRef.current = true;
    void run();
    return () => {
      mountedRef.current = false;
      cancelComparisonRun();
    };
  }, [cancelComparisonRun, run]);

  const backToList = useCallback(() => {
    mountedRef.current = false;
    cancelComparisonRun();
    router.replace("/");
  }, [cancelComparisonRun, router]);

  const retry = () => {
    startedRef.current = false;
    void run();
  };

  const recovery = error ? comparisonRecovery(error) : null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
        <Text style={[typography.eyebrow, styles.eyebrow]}>Official Kroger-family data</Text>
        <Text style={typography.screenTitle}>{comparisonHeading(locationChain)}</Text>
        <Text style={[typography.body, styles.intro]}>Cartiva searches broadly, then verifies every request against one store.</Text>

        <GlassCard strong style={styles.progressCard}>
          <View style={styles.stageRow} accessibilityLiveRegion="polite">
            <StageIcon state="complete" />
            <View style={styles.stageCopy}>
              <Text style={styles.stageTitle}>Understanding your list</Text>
              <Text style={styles.stageDetail}>Kept your requested attributes intact</Text>
            </View>
          </View>
          <View style={styles.divider} />
          <View style={styles.stageRow} accessibilityLiveRegion="polite">
            <StageIcon state={locationState} />
            <View style={styles.stageCopy}>
              <Text style={styles.stageTitle}>Finding a Kroger-family store</Text>
              <Text style={styles.stageDetail}>
                {locationName ? `${locationChain || "Kroger-family store"} · ${locationName}` : "Using your ZIP code"}
              </Text>
            </View>
          </View>

          {items.map((item) => (
            <View key={item.index}>
              <View style={styles.divider} />
              <View style={styles.stageRow} accessibilityLiveRegion="polite">
                <StageIcon state={item.state} />
                <View style={styles.stageCopy}>
                  <Text style={styles.stageTitle}>Matching {item.name}</Text>
                  <Text style={styles.stageDetail}>
                    {item.state === "active"
                      ? "Searching candidates, then verifying constraints"
                      : item.state === "complete" ? "Verified match" : "Needs review"}
                  </Text>
                </View>
              </View>
            </View>
          ))}

          <View style={styles.divider} />
          <View style={styles.stageRow} accessibilityLiveRegion="polite">
            <StageIcon state={basketState} />
            <View style={styles.stageCopy}>
              <Text style={styles.stageTitle}>{basketLabel}</Text>
              <Text style={styles.stageDetail}>Only a complete basket receives a complete total</Text>
            </View>
          </View>
        </GlassCard>

        {error && recovery ? (
          <View style={styles.errorArea} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <View style={styles.errorTitleRow}>
              <MaterialCommunityIcons
                name={error.code === "network" ? "wifi-alert" : "alert-circle-outline"}
                size={22}
                color={colors.warning}
              />
              <Text style={styles.errorTitle}>{recovery.title}</Text>
            </View>
            <Text style={styles.errorText}>{recovery.detail}</Text>
            <PrimaryButton
              label={recovery.primaryLabel}
              onPress={recovery.action === "retry" ? retry : backToList}
              icon={recovery.action === "retry" ? "refresh" : "pencil-outline"}
            />
            <Pressable
              onPress={recovery.action === "retry" ? backToList : retry}
              accessibilityRole="button"
              style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}
            >
              <Text style={styles.editLabel}>
                {recovery.action === "retry" ? "Keep editing my list" : "Try this comparison again"}
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={backToList}
            accessibilityRole="button"
            accessibilityLabel="Return to grocery list"
            style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
          >
            <Text style={styles.cancelLabel}>Back to list</Text>
          </Pressable>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 34, paddingBottom: 42 },
  eyebrow: { marginBottom: 9 },
  intro: { marginTop: 12, maxWidth: 340 },
  progressCard: { marginTop: 30, paddingHorizontal: 18 },
  stageRow: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: 13 },
  stageCopy: { flex: 1 },
  stageTitle: { color: colors.ink, fontSize: 15, fontWeight: "800", lineHeight: 20 },
  stageDetail: { color: colors.inkMuted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  divider: { height: 1, marginLeft: 35, backgroundColor: colors.line },
  errorArea: {
    marginTop: 20,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: "rgba(139,100,43,0.28)",
    backgroundColor: colors.warningSurface,
    padding: 18,
    gap: 14,
  },
  errorTitleRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  errorTitle: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: "800" },
  errorText: { color: colors.warning, fontSize: 14, lineHeight: 21 },
  editButton: { minHeight: 48, alignItems: "center", justifyContent: "center" },
  editLabel: { color: colors.emeraldDeep, fontSize: 14, fontWeight: "800" },
  cancelButton: { minHeight: 52, alignItems: "center", justifyContent: "center", marginTop: 12 },
  cancelLabel: { color: colors.inkSoft, fontSize: 14, fontWeight: "700" },
  pressed: { opacity: 0.62 },
});
