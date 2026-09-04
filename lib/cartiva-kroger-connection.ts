export type CartivaKrogerConnectionState =
  | "connected"
  | "required"
  | "expired"
  | "unavailable";

export interface CartivaKrogerAuthStatusBody {
  connected?: boolean;
  configured?: boolean;
  expired?: boolean;
  error?: string;
}

export interface CartivaKrogerPreflight {
  state: CartivaKrogerConnectionState;
  connected: boolean;
  configured: boolean;
  message?: string;
}

export function getCartivaKrogerPreflight(
  responseOk: boolean,
  value: unknown,
): CartivaKrogerPreflight {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as CartivaKrogerAuthStatusBody : {};
  if (responseOk && typeof body.connected !== "boolean" && body.configured !== false && body.expired !== true) {
    return { state: "unavailable", connected: false, configured: true, message: "Cartiva could not verify your Kroger connection. Please try again." };
  }
  if (body.configured === false) {
    return {
      state: "unavailable",
      connected: false,
      configured: false,
      message: "Kroger OAuth is not configured on this deployment.",
    };
  }
  if (!responseOk) {
    return {
      state: "unavailable",
      connected: false,
      configured: true,
      message: (typeof body.error === "string" && body.error.trim()) || "Cartiva could not verify the saved Kroger connection.",
    };
  }
  if (body.connected === true) {
    return { state: "connected", connected: true, configured: true };
  }
  if (body.expired === true) {
    return {
      state: "expired",
      connected: false,
      configured: true,
      message: "Your Kroger connection expired. Reconnect Kroger to continue.",
    };
  }
  return {
    state: "required",
    connected: false,
    configured: true,
    message: "Connect to Kroger to add your items.",
  };
}
