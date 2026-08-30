import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "@/components/brand-mark";
import { GlassCard } from "@/components/glass-card";
import { Screen } from "@/components/screen";
import { colors, radius, typography } from "@/theme";

const principles = [
  {
    icon: "magnify-scan" as const,
    title: "Search flexibly. Verify strictly.",
    body: "Cartiva can search broadly, but a cheaper wrong product never outranks the right one.",
  },
  {
    icon: "basket-check-outline" as const,
    title: "Complete means complete.",
    body: "A basket with a missing item is labeled incomplete and never presented as the best complete total.",
  },
  {
    icon: "shield-check-outline" as const,
    title: "Checkout stays with the retailer.",
    body: "Cartiva does not process payment, place orders, or receive card information.",
  },
];

export default function AboutScreen() {
  const router = useRouter();
  return (
    <Screen safeEdges={["top", "left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
        <View style={styles.header}>
          <BrandMark />
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={8}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <MaterialCommunityIcons name="close" size={23} color={colors.emeraldDeep} />
          </Pressable>
        </View>

        <Text style={[typography.eyebrow, styles.eyebrow]}>How Cartiva works</Text>
        <Text style={typography.screenTitle}>Grocery intelligence,{"\n"}without the grocery-app clutter.</Text>
        <Text style={[typography.body, styles.intro]}>Write one list. Cartiva interprets it, finds a real store, verifies comparable products, and shows exactly what it could prove.</Text>

        <View style={styles.principles}>
          {principles.map((principle) => (
            <GlassCard key={principle.title} strong style={styles.principleCard}>
              <View style={styles.iconBox}>
                <MaterialCommunityIcons name={principle.icon} size={22} color={colors.emerald} />
              </View>
              <View style={styles.principleCopy}>
                <Text style={styles.principleTitle}>{principle.title}</Text>
                <Text style={styles.principleBody}>{principle.body}</Text>
              </View>
            </GlassCard>
          ))}
        </View>

        <View style={styles.dataNote}>
          <Text style={styles.dataTitle}>Trust & data</Text>
          <Text style={styles.dataBody}>Kroger-family results come from official retailer APIs through the Cartiva backend. Private retailer credentials never enter this app. Cartiva only says items were added to a retailer cart after the retailer confirms the update.</Text>
        </View>

        <Text style={styles.legal}>Cartiva is independent and is not affiliated with or endorsed by Kroger. Retailer prices, availability, and cart contents can change. Review the retailer cart before checkout.</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 34 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  closeButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  pressed: { opacity: 0.62 },
  eyebrow: { marginTop: 34, marginBottom: 9 },
  intro: { marginTop: 14 },
  principles: { gap: 13, marginTop: 28 },
  principleCard: { flexDirection: "row", alignItems: "flex-start", gap: 13, padding: 16 },
  iconBox: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: colors.surfaceMint },
  principleCopy: { flex: 1 },
  principleTitle: { color: colors.ink, fontSize: 15, fontWeight: "900", lineHeight: 20 },
  principleBody: { color: colors.inkSoft, fontSize: 13, lineHeight: 20, marginTop: 5 },
  dataNote: { marginTop: 22, borderRadius: radius.large, backgroundColor: colors.emeraldDeep, padding: 20 },
  dataTitle: { color: colors.signal, fontSize: 12, fontWeight: "900", letterSpacing: 0.8, textTransform: "uppercase" },
  dataBody: { color: "#DDEBE1", fontSize: 13, lineHeight: 21, marginTop: 10 },
  legal: { color: colors.inkMuted, fontSize: 11, lineHeight: 17, marginTop: 20, paddingHorizontal: 4 },
});
