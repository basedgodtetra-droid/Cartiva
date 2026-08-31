import type { Metadata } from "next";
import { ListsPage } from "@/components/cartiva-library-pages";

export const metadata: Metadata = { title: "My lists", description: "Create, save, reopen, rename, duplicate, and edit Cartiva grocery lists." };

export default function Page() { return <ListsPage />; }
