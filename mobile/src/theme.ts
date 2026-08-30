import { Platform, StyleSheet } from "react-native";

export const colors = {
  background: "#F3F0E7",
  cream: "#FBF8EF",
  surface: "rgba(255, 255, 255, 0.76)",
  surfaceStrong: "rgba(255, 255, 255, 0.92)",
  surfaceMint: "rgba(228, 247, 232, 0.78)",
  ink: "#122019",
  inkSoft: "#405047",
  inkMuted: "#526158",
  line: "rgba(31, 91, 59, 0.18)",
  emerald: "#08754D",
  emeraldBright: "#11A36C",
  emeraldDeep: "#063E2C",
  mint: "#72DDA2",
  lime: "#CCEC72",
  signal: "#D8F38F",
  white: "#FFFFFF",
  warning: "#8B642B",
  warningSurface: "#FFF3DB",
  danger: "#8F493B",
  dangerSurface: "#FFF0EA",
  shadow: "#03432B",
} as const;

export const radius = {
  small: 12,
  medium: 18,
  large: 26,
  xlarge: 32,
  pill: 999,
} as const;

export const spacing = {
  xsmall: 6,
  small: 10,
  medium: 16,
  large: 24,
  xlarge: 32,
  xxlarge: 44,
} as const;

export const shadow = Platform.select({
  ios: {
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.12,
    shadowRadius: 28,
  },
  android: { elevation: 6 },
  default: {},
});

export const typography = StyleSheet.create({
  eyebrow: {
    color: colors.emerald,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  title: {
    color: colors.ink,
    fontSize: 38,
    fontWeight: "800",
    letterSpacing: -1.8,
    lineHeight: 40,
  },
  screenTitle: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -1.2,
    lineHeight: 34,
  },
  heading: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 25,
  },
  body: {
    color: colors.inkSoft,
    fontSize: 16,
    lineHeight: 24,
  },
  caption: {
    color: colors.inkMuted,
    fontSize: 13,
    lineHeight: 19,
  },
});
