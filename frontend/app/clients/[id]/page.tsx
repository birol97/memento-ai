"use client";

// Standalone deep-link to one customer's workspace (the master/detail lives at
// /customers). Renders the shared ClientWorkspace full-width.
import { ClientWorkspace } from "@/components/ClientWorkspace";

export default function ClientWorkspacePage({ params }: { params: { id: string } }) {
  return <ClientWorkspace clientId={Number(params.id)} />;
}
