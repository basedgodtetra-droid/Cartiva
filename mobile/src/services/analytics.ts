export type AnalyticsEvent =
  | "app_open"
  | "list_started"
  | "item_parsed"
  | "clarification_requested"
  | "comparison_started"
  | "comparison_completed"
  | "comparison_failed"
  | "retailer_handoff_started"
  | "retailer_cart_added";

export type AnalyticsProperties = Record<string, string | number | boolean | undefined>;

export interface AnalyticsClient {
  track(event: AnalyticsEvent, properties?: AnalyticsProperties): void;
}

class PrivacyFirstAnalytics implements AnalyticsClient {
  track(event: AnalyticsEvent, properties: AnalyticsProperties = {}) {
    if (__DEV__) {
      // Deliberately excludes raw grocery text, ZIP codes, and retailer identifiers.
      console.debug("[Cartiva analytics]", event, properties);
    }
  }
}

export const analytics: AnalyticsClient = new PrivacyFirstAnalytics();
