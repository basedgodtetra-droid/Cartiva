import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { LinearGradient } from "expo-linear-gradient";
import { Platform, StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme";

type BrandMarkProps = {
  compact?: boolean;
  showWordmark?: boolean;
};

export function BrandMark({ compact = false, showWordmark = true }: BrandMarkProps) {
  const size = compact ? 38 : 44;
  return (
    <View style={styles.row} accessibilityRole="header">
      <LinearGradient
        colors={[colors.emeraldBright, colors.emerald, colors.emeraldDeep]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.mark, { width: size, height: size, borderRadius: compact ? 13 : 15 }]}
      >
        <MaterialCommunityIcons
          name="basket-outline"
          size={compact ? 19 : 22}
          color={colors.white}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </LinearGradient>
      {showWordmark ? <Text style={[styles.wordmark, compact && styles.wordmarkCompact]}>CARTIVA</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 11 },
  mark: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.34)",
    ...Platform.select({
      ios: {
        shadowColor: colors.emeraldDeep,
        shadowOffset: { width: 0, height: 7 },
        shadowOpacity: 0.24,
        shadowRadius: 14,
      },
      android: { elevation: 5 },
      default: { boxShadow: "0 7px 14px rgba(6, 62, 44, 0.24)" },
    }),
  },
  wordmark: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "900",
    letterSpacing: 1.7,
  },
  wordmarkCompact: { fontSize: 15, letterSpacing: 1.4 },
});
