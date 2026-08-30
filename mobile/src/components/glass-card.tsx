import type { PropsWithChildren } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radius, shadow } from "@/theme";

type GlassCardProps = PropsWithChildren<{
  style?: ViewStyle | ViewStyle[];
  strong?: boolean;
}>;

export function GlassCard({ children, style, strong = false }: GlassCardProps) {
  return <View style={[styles.card, strong && styles.strong, shadow, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.large,
    backgroundColor: colors.surface,
  },
  strong: {
    backgroundColor: colors.surfaceStrong,
    borderColor: "rgba(86, 151, 107, 0.28)",
  },
});
