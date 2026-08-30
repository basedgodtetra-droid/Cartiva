import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { interpretGroceryInput } from "@cartiva/shared";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BrandMark } from "@/components/brand-mark";
import { GlassCard } from "@/components/glass-card";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import { analytics } from "@/services/analytics";
import { groceryParsingAnnouncement } from "@/services/accessibility-progress";
import { bestEffortHaptic } from "@/services/haptics";
import { createSingleFlightAction } from "@/services/single-flight-action";
import { useCartiva } from "@/state/cartiva-context";
import { colors, radius, spacing, typography } from "@/theme";

const PLACEHOLDER = "eggs 18 count\n2% milk gallon\nwhite bread\ncoke zero 24 pack\nchicken breast 2 lb";

export default function ListScreen() {
  const router = useRouter();
  const { rawInput, zipCode, setRawInput, setZipCode } = useCartiva();
  const [parsedInput, setParsedInput] = useState(rawInput);
  const [message, setMessage] = useState("");
  const listInputRef = useRef<TextInput>(null);
  const zipInputRef = useRef<TextInput>(null);
  const parsingAnnouncementRef = useRef({ initialized: false, key: "" });
  const compareNavigationRef = useRef<ReturnType<typeof createSingleFlightAction> | null>(null);
  compareNavigationRef.current ??= createSingleFlightAction();

  useFocusEffect(useCallback(() => {
    compareNavigationRef.current?.reset();
  }, []));

  useEffect(() => {
    const timeout = setTimeout(() => setParsedInput(rawInput), 120);
    return () => clearTimeout(timeout);
  }, [rawInput]);

  const interpretation = useMemo(() => interpretGroceryInput(parsedInput), [parsedInput]);
  const zipIsValid = /^\d{5}$/.test(zipCode);

  useEffect(() => {
    if (interpretation.items.length) {
      analytics.track("item_parsed", { item_count: interpretation.items.length });
    }
  }, [interpretation.items.length]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;

    const key = `${interpretation.items.length}:${interpretation.unresolvedCount}`;
    if (!parsingAnnouncementRef.current.initialized) {
      parsingAnnouncementRef.current = { initialized: true, key };
      return;
    }
    if (parsingAnnouncementRef.current.key === key) return;
    parsingAnnouncementRef.current.key = key;

    const timeout = setTimeout(() => {
      AccessibilityInfo.announceForAccessibility(groceryParsingAnnouncement(
        interpretation.items.length,
        interpretation.unresolvedCount,
      ));
    }, 300);
    return () => clearTimeout(timeout);
  }, [interpretation.items.length, interpretation.unresolvedCount]);

  const addItem = () => {
    setRawInput(rawInput.trimEnd() ? `${rawInput.trimEnd()}\n` : rawInput);
    requestAnimationFrame(() => listInputRef.current?.focus());
  };

  const compare = () => {
    const latest = interpretGroceryInput(rawInput);
    if (!latest.items.length) {
      setMessage("Add at least one grocery item to compare.");
      listInputRef.current?.focus();
      return;
    }
    if (latest.limitReached) {
      setMessage("Cartiva supports up to 24 items per comparison.");
      listInputRef.current?.focus();
      return;
    }
    if (!zipIsValid) {
      setMessage("Enter a valid 5-digit ZIP code.");
      zipInputRef.current?.focus();
      return;
    }
    // Press handlers can run twice before a navigation blur commits. Claim
    // the transition synchronously so only one destination is ever pushed.
    if (!compareNavigationRef.current?.tryStart()) return;
    Keyboard.dismiss();
    bestEffortHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    setMessage("");
    try {
      if (latest.unresolvedCount > 0) {
        analytics.track("clarification_requested", { item_count: latest.unresolvedCount });
        router.push("/clarify");
      } else {
        router.push("/comparing");
      }
    } catch {
      compareNavigationRef.current?.reset();
      setMessage("Cartiva could not open the comparison. Try again.");
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="never"
        >
          <View style={styles.header}>
            <BrandMark compact />
            <Pressable
              onPress={() => router.push("/about")}
              accessibilityRole="button"
              accessibilityLabel="About Cartiva"
              hitSlop={8}
              style={({ pressed }) => [styles.infoButton, pressed && styles.pressed]}
            >
              <MaterialCommunityIcons name="information-outline" size={22} color={colors.emeraldDeep} />
            </Pressable>
          </View>

          <View style={styles.hero}>
            <Text style={typography.title}>Your cart.{"\n"}<Text style={styles.titleAccent}>Your best price.</Text></Text>
            <Text style={styles.heroNote}>One list. Cartiva handles the matching.</Text>
          </View>

          <Text style={styles.question}>What do you need?</Text>
          <GlassCard strong style={styles.notepadCard}>
            <TextInput
              ref={listInputRef}
              value={rawInput}
              onChangeText={(value) => {
                setRawInput(value);
                if (message) setMessage("");
              }}
              placeholder={PLACEHOLDER}
              placeholderTextColor={colors.inkMuted}
              multiline
              textAlignVertical="top"
              scrollEnabled
              spellCheck
              autoCapitalize="sentences"
              autoCorrect
              accessibilityLabel="Grocery list"
              accessibilityHint="Type naturally using lines, commas, or spaces."
              style={styles.notepadInput}
            />
            <View style={styles.notepadFooter}>
              <Pressable
                onPress={addItem}
                accessibilityRole="button"
                accessibilityLabel="Add another grocery item"
                style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
              >
                <MaterialCommunityIcons name="plus" size={18} color={colors.emerald} />
                <Text style={styles.addLabel}>Add item</Text>
              </Pressable>
              <Text style={styles.localLabel}>Understood on device</Text>
            </View>
          </GlassCard>

          {interpretation.items.length > 0 ? (
            <View style={styles.interpretation} accessibilityLiveRegion="polite">
              <Text style={styles.interpretationTitle}>
                Cartiva understood {interpretation.items.length} {interpretation.items.length === 1 ? "item" : "items"}
              </Text>
              <View style={styles.itemList}>
                {interpretation.items.slice(0, 6).map((item) => (
                  <View key={item.id} style={styles.itemRow}>
                    <View style={[styles.statusDot, item.status === "needs-detail" && styles.statusDotWarning]}>
                      <MaterialCommunityIcons
                        name={item.status === "ready" ? "check" : "help"}
                        size={12}
                        color={item.status === "ready" ? colors.emerald : colors.warning}
                      />
                    </View>
                    <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                    <Text style={[styles.itemDetail, item.status === "needs-detail" && styles.itemDetailWarning]}>
                      {item.detail ?? item.clarification?.shortLabel ?? "Ready"}
                    </Text>
                  </View>
                ))}
                {interpretation.items.length > 6 ? (
                  <Text style={styles.moreItems}>+ {interpretation.items.length - 6} more</Text>
                ) : null}
              </View>
            </View>
          ) : null}

          <View style={styles.zipSection}>
            <Text style={styles.zipLabel}>ZIP code</Text>
            <View style={[styles.zipField, zipCode.length > 0 && !zipIsValid && styles.zipFieldInvalid]}>
              <MaterialCommunityIcons name="map-marker-outline" size={21} color={colors.emerald} />
              <TextInput
                ref={zipInputRef}
                value={zipCode}
                onChangeText={(value) => {
                  setZipCode(value);
                  if (message) setMessage("");
                }}
                placeholder="79912"
                placeholderTextColor={colors.inkMuted}
                keyboardType="number-pad"
                textContentType="postalCode"
                autoComplete="postal-code"
                returnKeyType="done"
                maxLength={5}
                accessibilityLabel="ZIP code"
                style={styles.zipInput}
              />
              {zipIsValid ? <MaterialCommunityIcons name="check-circle" size={20} color={colors.emerald} /> : null}
            </View>
          </View>

          {message ? (
            <View style={styles.errorRow} accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <MaterialCommunityIcons name="alert-circle-outline" size={19} color={colors.warning} />
              <Text style={styles.errorText}>{message}</Text>
            </View>
          ) : null}

          <PrimaryButton
            label="Compare my cart"
            onPress={compare}
            accessibilityHint="Finds a Kroger-family store and matches every item."
          />
          <Text style={styles.checkoutNote}>Comparison requires internet. Checkout always happens with the retailer.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 42 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  infoButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(255,255,255,0.65)",
  },
  pressed: { opacity: 0.66, transform: [{ scale: 0.97 }] },
  hero: { marginTop: 30 },
  titleAccent: { color: colors.emerald },
  heroNote: { ...typography.body, marginTop: 12, fontSize: 15 },
  question: { ...typography.heading, marginTop: 32, marginBottom: 12 },
  notepadCard: { minHeight: 270 },
  notepadInput: {
    minHeight: 220,
    paddingHorizontal: 20,
    paddingTop: 19,
    paddingBottom: 14,
    color: colors.ink,
    fontSize: 17,
    lineHeight: 30,
  },
  notepadFooter: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 14,
  },
  addButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6 },
  addLabel: { color: colors.emerald, fontSize: 14, fontWeight: "800" },
  localLabel: { color: colors.inkMuted, fontSize: 11, fontWeight: "700" },
  interpretation: {
    marginTop: 14,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceMint,
    padding: 14,
  },
  interpretationTitle: { color: colors.emeraldDeep, fontSize: 12, fontWeight: "800", letterSpacing: 0.25 },
  itemList: { marginTop: 8, gap: 2 },
  itemRow: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(114, 221, 162, 0.24)",
  },
  statusDotWarning: { backgroundColor: colors.warningSurface },
  itemName: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: "700" },
  itemDetail: { color: colors.inkMuted, fontSize: 12 },
  itemDetailWarning: { color: colors.warning, fontWeight: "700" },
  moreItems: { marginTop: 5, color: colors.inkMuted, fontSize: 12, fontWeight: "700" },
  zipSection: { marginTop: spacing.large, marginBottom: spacing.large },
  zipLabel: { color: colors.ink, fontSize: 15, fontWeight: "800", marginBottom: 9 },
  zipField: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceStrong,
    paddingHorizontal: 16,
  },
  zipFieldInvalid: { borderColor: "rgba(139, 100, 43, 0.48)" },
  zipInput: { flex: 1, minHeight: 56, color: colors.ink, fontSize: 18, fontWeight: "800", letterSpacing: 1.3 },
  errorRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 14, paddingHorizontal: 4 },
  errorText: { flex: 1, color: colors.warning, fontSize: 13, fontWeight: "700", lineHeight: 19 },
  checkoutNote: { ...typography.caption, marginTop: 14, textAlign: "center", paddingHorizontal: 14 },
});
