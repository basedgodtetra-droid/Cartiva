type AuthSessionResult =
  | { type: "success"; url: string }
  | { type: "cancel" | "dismiss" | "locked" };

export const webBrowserTestDouble: {
  openAuthSessionAsync: (
    authorizationUrl: string,
    returnUrl: string,
    options?: { preferEphemeralSession?: boolean; preferUniversalLinks?: boolean },
  ) => Promise<AuthSessionResult>;
  dismissAuthSession: () => void;
} = {
  openAuthSessionAsync: async () => ({ type: "cancel" }),
  dismissAuthSession: () => undefined,
};

export function openAuthSessionAsync(
  authorizationUrl: string,
  returnUrl: string,
  options?: { preferEphemeralSession?: boolean; preferUniversalLinks?: boolean },
) {
  return webBrowserTestDouble.openAuthSessionAsync(authorizationUrl, returnUrl, options);
}

export function dismissAuthSession() {
  return webBrowserTestDouble.dismissAuthSession();
}
