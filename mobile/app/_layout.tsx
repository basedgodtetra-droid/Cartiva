import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { CartivaProvider } from "@/state/cartiva-context";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { colors } from "@/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const reducedMotion = useReducedMotion();
  const [fontsLoaded, fontError] = useFonts(MaterialCommunityIcons.font);

  useEffect(() => {
    if (fontsLoaded || fontError) void SplashScreen.hideAsync();
  }, [fontError, fontsLoaded]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <CartivaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.cream },
          animation: reducedMotion ? "none" : "fade_from_bottom",
          animationDuration: 220,
          gestureEnabled: true,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="clarify" />
        <Stack.Screen name="comparing" options={{ gestureEnabled: false }} />
        <Stack.Screen name="results" />
        <Stack.Screen name="basket/[retailer]" />
        <Stack.Screen name="oauth/kroger" options={{ gestureEnabled: false }} />
        <Stack.Screen name="about" options={{ presentation: "modal" }} />
      </Stack>
    </CartivaProvider>
  );
}
