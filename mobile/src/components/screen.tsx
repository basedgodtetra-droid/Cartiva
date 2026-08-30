import type { PropsWithChildren } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "@/theme";

type ScreenProps = PropsWithChildren<{
  style?: ViewStyle;
  safeEdges?: ("top" | "right" | "bottom" | "left")[];
}>;

export function Screen({ children, style, safeEdges = ["top", "left", "right"] }: ScreenProps) {
  return (
    <View style={styles.root}>
      <LinearGradient
        colors={["#FFFDF7", colors.cream, "#ECF4E9"]}
        locations={[0, 0.52, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.mintGlow, styles.noPointerEvents]} />
      <View style={[styles.limeGlow, styles.noPointerEvents]} />
      <SafeAreaView edges={safeEdges} style={[styles.safe, style]}>
        {children}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  safe: { flex: 1 },
  noPointerEvents: { pointerEvents: "none" },
  mintGlow: {
    position: "absolute",
    top: -80,
    left: -90,
    width: 270,
    height: 270,
    borderRadius: 150,
    backgroundColor: "rgba(75, 207, 137, 0.14)",
  },
  limeGlow: {
    position: "absolute",
    top: 120,
    right: -120,
    width: 250,
    height: 250,
    borderRadius: 150,
    backgroundColor: "rgba(204, 236, 114, 0.13)",
  },
});
