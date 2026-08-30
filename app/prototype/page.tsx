import { AssistantApp } from "@/components/assistant-app";
import { hasLiveWalmartProvider } from "@/lib/walmart-provider";

export default function PrototypePage() {
  const initialStore = {
    id: process.env.WALMART_STORE_ID?.trim() ?? "",
    name: process.env.WALMART_STORE_NAME?.trim() || "El Paso Walmart",
    location: process.env.WALMART_STORE_LOCATION?.trim() || "El Paso, TX",
  };

  return (
    <AssistantApp
      initialStore={initialStore}
      initialDemoMode={!hasLiveWalmartProvider()}
    />
  );
}
