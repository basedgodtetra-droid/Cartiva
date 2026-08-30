import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { interpretGroceryInput } from "@cartiva/shared";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GlassCard } from "@/components/glass-card";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import { bestEffortHaptic } from "@/services/haptics";
import { useCartiva } from "@/state/cartiva-context";
import { colors, radius, typography } from "@/theme";

export default function ClarifyScreen() {
  const router = useRouter();
  const { rawInput, resolveClarification } = useCartiva();
  const interpretation = interpretGroceryInput(rawInput);
  const unresolved = interpretation.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.clarification);

  const choose = (itemIndex: number, clarificationId: string, value: string) => {
    bestEffortHaptic(() => Haptics.selectionAsync());
    resolveClarification(itemIndex, clarificationId, value);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to grocery list"
          hitSlop={8}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <MaterialCommunityIcons name="arrow-left" size={23} color={colors.emeraldDeep} />
        </Pressable>

        <Text style={[typography.eyebrow, styles.eyebrow]}>Quick details</Text>
        <Text style={typography.screenTitle}>
          {unresolved.length || "No"} {unresolved.length === 1 ? "item needs" : "items need"} a quick detail
        </Text>
        <Text style={[typography.body, styles.intro]}>Only choices that materially affect a fair match appear here.</Text>

        <View style={styles.cards}>
          {unresolved.map(({ item, index }) => (
            <GlassCard key={`${item.id}:${item.clarification?.id}`} strong style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.itemIcon}>
                  <MaterialCommunityIcons name="basket-outline" size={20} color={colors.emerald} />
                </View>
                <View style={styles.itemCopy}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.prompt}>{item.clarification?.prompt}</Text>
                </View>
              </View>
              <View style={styles.options} accessibilityRole="radiogroup">
                {item.clarification?.options.map((option) => (
                  <Pressable
                    key={option.id}
                    onPress={() => choose(index, item.clarification!.id, option.value)}
                    accessibilityRole="radio"
                    accessibilityLabel={`${item.name}: ${option.label}`}
                    accessibilityState={{ selected: false }}
                    style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  >
                    <Text style={styles.optionLabel}>{option.label}</Text>
                  </Pressable>
                ))}
              </View>
            </GlassCard>
          ))}
        </View>

        {unresolved.length === 0 ? (
          <PrimaryButton
            label="Compare my cart"
            onPress={() => router.replace("/comparing")}
          />
        ) : (
          <Text style={styles.footerNote} accessibilityLiveRegion="polite">
            Choose an answer above. Cartiva will ask the next material detail, if one remains.
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 42 },
  backButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    marginBottom: 30,
  },
  pressed: { opacity: 0.65 },
  eyebrow: { marginBottom: 9 },
  intro: { marginTop: 12, maxWidth: 330 },
  cards: { marginTop: 28, gap: 16, marginBottom: 28 },
  card: { padding: 18 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  itemIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    backgroundColor: "rgba(114,221,162,0.18)",
  },
  itemCopy: { flex: 1 },
  itemName: { color: colors.ink, fontSize: 18, fontWeight: "800", letterSpacing: -0.35 },
  prompt: { color: colors.inkSoft, fontSize: 14, marginTop: 3 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 18 },
  option: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(40, 129, 84, 0.26)",
    backgroundColor: "rgba(236, 249, 238, 0.78)",
    paddingHorizontal: 16,
  },
  optionPressed: { backgroundColor: "rgba(114,221,162,0.28)", transform: [{ scale: 0.98 }] },
  optionLabel: { color: colors.emeraldDeep, fontSize: 14, fontWeight: "800" },
  footerNote: { ...typography.caption, textAlign: "center", paddingHorizontal: 20 },
});
