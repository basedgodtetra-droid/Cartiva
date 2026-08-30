/**
 * Runtime backstop for modules that read credentials or retailer OAuth tokens.
 * Keep the import as a side effect so an accidental browser bundle fails
 * before any secret-reading code can run.
 */
if (typeof window !== "undefined") {
  throw new Error("A Cartiva server-only module was imported into browser code.");
}

export {};
