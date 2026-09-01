import type { Metadata } from "next";
import { LibraryPage } from "@/components/cartiva-library-pages";

export const metadata: Metadata = {
  title: "Library",
  description: "Reopen saved Cartiva grocery lists and historical basket snapshots.",
};

export default function Page() {
  return <LibraryPage />;
}
