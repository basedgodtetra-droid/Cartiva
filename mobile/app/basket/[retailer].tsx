import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GlassCard } from "@/components/glass-card";
import { Screen } from "@/components/screen";
import type { RankedKrogerProduct } from "@/services/cartiva-api";
import {
  availabilityPresentation,
  basketLineQuantityPresentation,
  matchCandidatePresentation,
  matchSectionLabel,
  retailerBanner,
} from "@/services/mobile-ux";
import { comparablePriceCents, useCartiva } from "@/state/cartiva-context";
import { colors, radius, typography } from "@/theme";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function isAvailabilityReason(reason: string) {
  return /\b(?:inventory|in stock|out of stock|selected fulfillment method)\b/i.test(reason);
}

function CandidateButton({
  product,
  onPress,
}: {
  product: RankedKrogerProduct;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Choose ${product.title}, ${money.format(comparablePriceCents(product) / 100)}`}
      style={({ pressed }) => [styles.candidate, pressed && styles.pressed]}
    >
      <View style={styles.candidateCopy}>
        <Text style={styles.candidateTitle} numberOfLines={2}>{product.title}</Text>
        <Text style={styles.candidateMeta}>{product.size?.label ?? "Retailer package"}</Text>
      </View>
      <Text style={styles.candidatePrice}>{money.format(comparablePriceCents(product) / 100)}</Text>
      <MaterialCommunityIcons name="chevron-right" size={20} color={colors.emerald} />
    </Pressable>
  );
}

export default function BasketScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ retailer?: string }>();
  const {
    comparison,
    chooseAlternative,
    rejectMatch,
    removeRequestedItem,
    clearComparison,
  } = useCartiva();

  if (!comparison || params.retailer !== "kroger") {
    return (
      <Screen>
        <View style={styles.empty}>
          <Text style={typography.heading}>Basket details aren’t available.</Text>
          <Pressable onPress={() => router.replace("/")} style={styles.simpleButton} accessibilityRole="button">
            <Text style={styles.simpleButtonText}>Return to list</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  const editList = () => {
    clearComparison();
    router.replace("/");
  };
  const banner = retailerBanner(comparison.retailerBanner);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back to results"
            hitSlop={8}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          >
            <MaterialCommunityIcons name="arrow-left" size={23} color={colors.emeraldDeep} />
          </Pressable>
          <Text style={styles.headerLabel}>BASKET DETAILS</Text>
          <View style={styles.headerSpacer} />
        </View>

        <Text style={typography.screenTitle}>Every match, explained.</Text>
        <Text style={[typography.body, styles.intro]}>Retailer package metadata stays separate from what you requested.</Text>

        <View style={styles.storeBanner} accessibilityLabel={`All matches use ${banner}, ${comparison.locationName}`}>
          <MaterialCommunityIcons name="store-marker-outline" size={21} color={colors.emerald} />
          <View style={styles.storeBannerCopy}>
            <Text style={styles.storeBannerChain}>{banner}</Text>
            <Text style={styles.storeBannerName}>{comparison.locationName}</Text>
            <Text style={styles.storeBannerAddress}>{comparison.locationAddress}</Text>
          </View>
        </View>

        <View style={styles.items}>
          {comparison.results.map((result, index) => {
            const request = comparison.requestedItems[index];
            const basketLine = comparison.basketLines[index];
            const product = result.recommended;
            const matchPresentation = product
              ? matchCandidatePresentation(result)
              : undefined;
            const availability = product
              ? availabilityPresentation(product.availabilityStatus, comparison.retailerBanner)
              : undefined;
            const quantity = product
              ? basketLineQuantityPresentation({
                  quantity: basketLine?.quantity ?? 1,
                  unitPriceCents: comparablePriceCents(product),
                  packageSizeText: basketLine?.packageSizeText,
                })
              : undefined;
            const reasons = product
              ? ["Product identity", ...product.reasons]
                  .filter((reason) => !isAvailabilityReason(reason))
                  .filter((reason, reasonIndex, list) => list.indexOf(reason) === reasonIndex)
                  .slice(0, 4)
              : [];
            return (
              <GlassCard key={`${request?.id ?? index}:${product?.id ?? "none"}`} strong style={styles.itemCard}>
                <View style={styles.requestBlock}>
                  <Text style={styles.kicker}>YOU REQUESTED</Text>
                  <Text style={styles.requestName}>{request?.name ?? result.requestedItem}</Text>
                  {request?.detail ? <Text style={styles.requestDetail}>{request.detail}</Text> : null}
                </View>

                <View style={styles.separator} />

                {product ? (
                  <View style={styles.matchBlock}>
                    <View style={styles.matchHeader}>
                      <Text style={styles.kicker}>{matchSectionLabel(comparison.retailerBanner)}</Text>
                      <View style={[
                        styles.matchPill,
                        matchPresentation?.reviewRequired ? styles.reviewPill : styles.strongPill,
                      ]}>
                        <MaterialCommunityIcons
                          name={matchPresentation?.reviewRequired ? "alert-circle-outline" : "check"}
                          size={13}
                          color={matchPresentation?.reviewRequired ? colors.warning : colors.emerald}
                        />
                        <Text style={matchPresentation?.reviewRequired ? styles.reviewPillText : styles.strongPillText}>
                          {matchPresentation?.badgeLabel}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.productTitle}>{product.title}</Text>
                    <Text style={styles.productMeta}>{product.size?.label ?? "Package details supplied by Kroger"}</Text>
                    <Text style={styles.price}>{money.format((quantity?.lineTotalCents ?? comparablePriceCents(product)) / 100)}</Text>
                    {quantity && !matchPresentation?.reviewRequired ? (
                      <View
                        accessible
                        accessibilityLabel={`Cart quantity ${quantity.quantityLabel}.${quantity.packageSizeLabel ? ` Requested unit size ${quantity.packageSizeLabel}.` : ""} Unit price ${money.format(quantity.unitPriceCents / 100)}. Line subtotal ${money.format(quantity.lineTotalCents / 100)}.`}
                        style={styles.quantityBlock}
                      >
                        <View style={styles.quantityRow}>
                          <MaterialCommunityIcons name="package-variant-closed" size={17} color={colors.emeraldDeep} />
                          <Text style={styles.quantityLabel}>Cart quantity: {quantity.quantityLabel}</Text>
                        </View>
                        {quantity.packageSizeLabel ? (
                          <Text style={styles.quantityMath}>Requested unit size: {quantity.packageSizeLabel}</Text>
                        ) : null}
                        {quantity.quantity > 1 ? (
                          <Text style={styles.quantityMath}>
                            {money.format(quantity.unitPriceCents / 100)} each × {quantity.quantity} = {money.format(quantity.lineTotalCents / 100)}
                          </Text>
                        ) : (
                          <Text style={styles.quantityMath}>One selected retailer unit at {money.format(quantity.unitPriceCents / 100)}</Text>
                        )}
                      </View>
                    ) : null}
                    {product.priceProvenance.regularPriceCents && product.priceProvenance.promoPriceCents ? (
                      <Text style={styles.priceNote}>Regular price used unless Kroger proves a promotion is unconditional.</Text>
                    ) : null}

                    {matchPresentation?.reviewRequired ? (
                      <View style={styles.reviewBlock} accessibilityRole="alert">
                        <View style={styles.reviewTitleRow}>
                          <MaterialCommunityIcons name="alert-circle-outline" size={18} color={colors.warning} />
                          <Text style={styles.reviewTitle}>Needs your choice</Text>
                        </View>
                        {matchPresentation.fulfillmentLabel ? (
                          <Text style={styles.reviewPackage}>{matchPresentation.fulfillmentLabel}</Text>
                        ) : null}
                        <Text style={styles.reviewExplanation}>{matchPresentation.explanation}</Text>
                        {availability ? (
                          <Text style={styles.reviewAvailability}>
                            {availability.statusLabel}: {availability.detail}
                          </Text>
                        ) : null}
                      </View>
                    ) : (
                      <View style={styles.whyBlock}>
                        <Text style={styles.whyTitle}>Why this matched</Text>
                        {reasons.map((reason) => (
                          <View key={reason} style={styles.reasonRow}>
                            <MaterialCommunityIcons name="check-circle-outline" size={17} color={colors.emerald} />
                            <Text style={styles.reasonText}>{reason}</Text>
                          </View>
                        ))}
                        {availability ? (
                          <View style={styles.reasonRow}>
                            <MaterialCommunityIcons
                              name={availability.tone === "positive" ? "map-marker-check-outline" : "information-outline"}
                              size={17}
                              color={availability.tone === "positive" ? colors.emerald : colors.warning}
                            />
                            <Text style={styles.reasonText}>
                              <Text style={styles.reasonEmphasis}>{availability.statusLabel}: </Text>
                              {availability.detail}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    )}

                    <View style={styles.itemActions}>
                      <Pressable
                        onPress={() => rejectMatch(index)}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.rejectAction, pressed && styles.pressed]}
                      >
                        <Text style={styles.rejectActionText}>Reject match</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={styles.noMatchBlock} accessibilityRole="alert">
                    <View style={styles.noMatchTitleRow}>
                      <MaterialCommunityIcons name="alert-circle-outline" size={20} color={colors.warning} />
                      <Text style={styles.noMatchTitle}>No accepted match</Text>
                    </View>
                    <Text style={styles.noMatchExplanation}>{result.explanation}</Text>
                  </View>
                )}

                {result.alternatives.length > 0 ? (
                  <View style={styles.alternatives}>
                    <Text style={styles.alternativesTitle}>
                      {matchPresentation?.reviewRequired ? "Other candidates to review" : "Other verified candidates"}
                    </Text>
                    {result.alternatives.slice(0, 3).map((candidate) => (
                      <CandidateButton
                        key={candidate.id}
                        product={candidate}
                        onPress={() => chooseAlternative(index, candidate)}
                      />
                    ))}
                  </View>
                ) : null}

                <View style={styles.requestActions}>
                  <Pressable
                    onPress={editList}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}
                  >
                    <MaterialCommunityIcons name="pencil-outline" size={17} color={colors.emeraldDeep} />
                    <Text style={styles.textActionLabel}>Edit grocery list</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      removeRequestedItem(index);
                      router.replace("/");
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}
                  >
                    <MaterialCommunityIcons name="trash-can-outline" size={17} color={colors.danger} />
                    <Text style={styles.removeLabel}>Remove</Text>
                  </Pressable>
                </View>
              </GlassCard>
            );
          })}
        </View>

        <View style={styles.disclaimer}>
          <MaterialCommunityIcons name="information-outline" size={20} color={colors.emerald} />
          <Text style={styles.disclaimerText}>Prices are product subtotals and can change at retailer checkout. Taxes, fees, deposits, tips, and substitutions are not included.</Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 42 },
  header: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  backButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  headerLabel: { color: colors.emeraldDeep, fontSize: 12, fontWeight: "900", letterSpacing: 1.3 },
  headerSpacer: { width: 46 },
  intro: { marginTop: 12 },
  storeBanner: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 11, marginTop: 20, borderRadius: radius.medium, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceMint, paddingHorizontal: 15 },
  storeBannerCopy: { flex: 1 },
  storeBannerChain: { color: colors.emeraldDeep, fontSize: 13, fontWeight: "900" },
  storeBannerName: { color: colors.inkSoft, fontSize: 12, marginTop: 2 },
  storeBannerAddress: { color: colors.inkMuted, fontSize: 10, lineHeight: 14, marginTop: 2 },
  items: { gap: 18, marginTop: 26 },
  itemCard: {},
  requestBlock: { padding: 18 },
  kicker: { color: colors.emerald, fontSize: 10, fontWeight: "900", letterSpacing: 1.2 },
  requestName: { color: colors.ink, fontSize: 20, fontWeight: "900", letterSpacing: -0.5, marginTop: 9 },
  requestDetail: { color: colors.inkSoft, fontSize: 14, fontWeight: "700", marginTop: 4 },
  separator: { height: 1, backgroundColor: colors.line },
  matchBlock: { padding: 18 },
  matchHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  matchPill: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 5 },
  strongPill: { backgroundColor: "rgba(114,221,162,0.18)" },
  strongPillText: { color: colors.emerald, fontSize: 10, fontWeight: "800" },
  reviewPill: { backgroundColor: colors.warningSurface },
  reviewPillText: { color: colors.warning, fontSize: 10, fontWeight: "800" },
  productTitle: { color: colors.ink, fontSize: 17, fontWeight: "800", lineHeight: 23, marginTop: 11 },
  productMeta: { color: colors.inkMuted, fontSize: 13, lineHeight: 19, marginTop: 5 },
  price: { color: colors.ink, fontSize: 28, fontWeight: "900", letterSpacing: -1, marginTop: 12 },
  quantityBlock: { marginTop: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(255,255,255,0.56)", paddingHorizontal: 12, paddingVertical: 10 },
  quantityRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  quantityLabel: { color: colors.emeraldDeep, fontSize: 12, fontWeight: "800" },
  quantityMath: { color: colors.inkMuted, fontSize: 11, lineHeight: 16, marginTop: 4, marginLeft: 24 },
  priceNote: { color: colors.inkMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  whyBlock: { marginTop: 18, borderRadius: radius.medium, backgroundColor: colors.surfaceMint, padding: 14, gap: 8 },
  whyTitle: { color: colors.ink, fontSize: 13, fontWeight: "900", marginBottom: 2 },
  reasonRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  reasonText: { flex: 1, color: colors.inkSoft, fontSize: 12, lineHeight: 18 },
  reasonEmphasis: { color: colors.ink, fontWeight: "800" },
  reviewBlock: { marginTop: 18, borderRadius: radius.medium, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSurface, padding: 14 },
  reviewTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  reviewTitle: { color: colors.ink, fontSize: 13, fontWeight: "900" },
  reviewPackage: { color: colors.ink, fontSize: 12, lineHeight: 18, fontWeight: "800", marginTop: 9 },
  reviewExplanation: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: 6 },
  reviewAvailability: { color: colors.inkMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  itemActions: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  rejectAction: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: 13 },
  rejectActionText: { color: colors.danger, fontSize: 12, fontWeight: "800" },
  noMatchBlock: { padding: 18, backgroundColor: colors.warningSurface },
  noMatchTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  noMatchTitle: { color: colors.ink, fontSize: 15, fontWeight: "900" },
  noMatchExplanation: { color: colors.warning, fontSize: 13, lineHeight: 20, marginTop: 9 },
  alternatives: { borderTopWidth: 1, borderTopColor: colors.line, padding: 14, gap: 8 },
  alternativesTitle: { color: colors.inkSoft, fontSize: 11, fontWeight: "900", letterSpacing: 0.7, textTransform: "uppercase", marginBottom: 2 },
  candidate: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(255,255,255,0.62)", paddingHorizontal: 12, paddingVertical: 8 },
  candidateCopy: { flex: 1 },
  candidateTitle: { color: colors.ink, fontSize: 12, fontWeight: "800", lineHeight: 17 },
  candidateMeta: { color: colors.inkMuted, fontSize: 10, marginTop: 3 },
  candidatePrice: { color: colors.ink, fontSize: 13, fontWeight: "900" },
  requestActions: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 14 },
  textAction: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 4 },
  textActionLabel: { color: colors.emeraldDeep, fontSize: 12, fontWeight: "800" },
  removeLabel: { color: colors.danger, fontSize: 12, fontWeight: "800" },
  disclaimer: { flexDirection: "row", alignItems: "flex-start", gap: 9, marginTop: 20, paddingHorizontal: 4 },
  disclaimerText: { flex: 1, color: colors.inkMuted, fontSize: 11, lineHeight: 17 },
  pressed: { opacity: 0.62 },
  empty: { flex: 1, justifyContent: "center", paddingHorizontal: 24, gap: 18 },
  simpleButton: { minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.emeraldDeep },
  simpleButtonText: { color: colors.white, fontWeight: "800" },
});
