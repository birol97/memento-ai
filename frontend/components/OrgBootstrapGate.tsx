"use client";

// Gates the org app behind first-run setup: until the company has an on-chain
// org AND at least one customer, the only thing you can see is the Onboarding
// wizard. Once set up, the normal app shell loads.
import { useCallback, useEffect, useState } from "react";

import { listOrgsAction } from "@/app/actions/orgDirectory";
import { searchClients } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { Onboarding } from "@/components/Onboarding";

export function OrgBootstrapGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ loading: boolean; hasOrg: boolean; hasCustomer: boolean }>({
    loading: true, hasOrg: false, hasCustomer: false,
  });

  const check = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    const [orgs, clients] = await Promise.all([
      listOrgsAction().catch(() => []),
      searchClients().catch(() => []),
    ]);
    setState({ loading: false, hasOrg: orgs.length > 0, hasCustomer: clients.length > 0 });
  }, []);

  useEffect(() => { void check(); }, [check]);

  if (state.loading) {
    return <main className="ob"><div className="ob-card"><p className="ob-loading">Loading your workspace…</p></div></main>;
  }
  if (!state.hasOrg || !state.hasCustomer) {
    return <Onboarding hasOrg={state.hasOrg} hasCustomer={state.hasCustomer} onComplete={check} />;
  }
  return <AppShell>{children}</AppShell>;
}
