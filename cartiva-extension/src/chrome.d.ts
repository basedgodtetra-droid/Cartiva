interface ChromeTab {
  id?: number;
  url?: string;
  status?: "loading" | "complete";
  active?: boolean;
}

interface ChromeStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeMessageSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: ChromeTab;
}

type CartivaWalmartControlKind = "add" | "increment";

interface CartivaWalmartControlCandidate {
  label: string;
  disabled: boolean;
  ariaDisabled: boolean;
  inRecommendation: boolean;
  inPrimaryRoot: boolean;
  explicitControlSelector: boolean;
  associatedItemIds: string[];
}

interface CartivaWalmartControlPolicyApi {
  postalCodeFromUsAddress(address: string): string | undefined;
  chooseCandidate(input: {
    kind: CartivaWalmartControlKind;
    itemId: string;
    exactTitle: string;
    pageTitleMatches: boolean;
    candidates: CartivaWalmartControlCandidate[];
  }): number | undefined;
}

declare const CartivaWalmartControlPolicy: CartivaWalmartControlPolicyApi;

type CartivaTargetControlKind = "add" | "increment";
type CartivaTargetFulfillmentMode = "pickup" | "delivery" | "shipping";

interface CartivaTargetControlCandidate {
  label: string;
  disabled: boolean;
  ariaDisabled: boolean;
  inRecommendation: boolean;
  inPrimaryRoot: boolean;
  explicitControlSelector: boolean;
  fulfillmentModes: CartivaTargetFulfillmentMode[];
}

interface CartivaTargetControlPolicyApi {
  visiblePickupStoreMatches(expectedStoreId?: string, elementId?: string | null): boolean;
  fulfillmentCellIsSelected(input: {
    ariaLabel?: string | null;
    ariaSelected?: string | null;
    ariaPressed?: string | null;
    dataSelected?: string | null;
  }): boolean;
  chooseCandidate(input: {
    kind: CartivaTargetControlKind;
    tcin: string;
    exactTitle: string;
    pageTitleMatches: boolean;
    fulfillmentMode: CartivaTargetFulfillmentMode;
    candidates: CartivaTargetControlCandidate[];
  }): number | undefined;
}

declare const CartivaTargetControlPolicy: CartivaTargetControlPolicyApi;

interface ChromeEvent<T extends (...args: never[]) => unknown> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

declare const chrome: {
  runtime: {
    id: string;
    lastError?: { message?: string };
    getManifest(): { name: string; version: string };
    sendMessage<T = unknown>(message: unknown): Promise<T>;
    onMessage: ChromeEvent<(
      message: unknown,
      sender: ChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void>;
    onInstalled: ChromeEvent<() => void>;
  };
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  storage: {
    local: ChromeStorageArea;
    session?: ChromeStorageArea;
  };
  tabs: {
    get(tabId: number): Promise<ChromeTab>;
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    create(createProperties: { url: string; active?: boolean }): Promise<ChromeTab>;
    update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<ChromeTab>;
    sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    onUpdated: ChromeEvent<(
      tabId: number,
      changeInfo: { status?: string; url?: string },
      tab: ChromeTab,
    ) => void>;
    onRemoved: ChromeEvent<(tabId: number) => void>;
  };
  permissions: {
    contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  };
};

interface SpeechRecognitionEvent extends Event {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface Window {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}
