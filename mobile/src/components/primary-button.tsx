import type { ComponentProps } from "react";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { LinearGradient } from "expo-linear-gradient";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius } from "@/theme";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  accessibilityHint?: string;
};

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  icon = "arrow-right",
  accessibilityHint,
}: PrimaryButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [styles.pressable, pressed && !disabled && styles.pressed]}
    >
      <LinearGradient
        colors={disabled ? ["#97AEA0", "#82978A"] : ["#19B978", colors.emerald, colors.emeraldDeep]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradient}
      >
        {loading ? <ActivityIndicator color={colors.white} /> : (
          <View style={styles.content}>
            <Text style={styles.label}>{label}</Text>
            <MaterialCommunityIcons name={icon} size={20} color={colors.white} accessibilityElementsHidden />
          </View>
        )}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    minHeight: 58,
    borderRadius: radius.pill,
    ...Platform.select({
      ios: {
        shadowColor: colors.emeraldDeep,
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.25,
        shadowRadius: 20,
      },
      android: { elevation: 6 },
      default: { boxShadow: "0 12px 20px rgba(6, 62, 44, 0.25)" },
    }),
  },
  pressed: { opacity: 0.9, transform: [{ scale: 0.985 }] },
  gradient: {
    minHeight: 58,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    paddingHorizontal: 22,
  },
  content: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  label: { color: colors.white, fontSize: 16, fontWeight: "800", letterSpacing: -0.2 },
});
