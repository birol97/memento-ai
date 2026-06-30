"use client";

// Gates the app on a signed-in zkLogin session.
//  - no wallet account        → "Continue with Google" (connects the Enoki wallet)
//  - account but no session    → sign a proof message → establishSession → store JWT
//  - session                   → render the app shell + children
import { useEffect, useRef, useState } from "react";
import {
  useConnectWallet,
  useCurrentAccount,
  useSignPersonalMessage,
  useWallets,
} from "@mysten/dapp-kit";

import { establishSession } from "@/app/actions/session";
import { employeeSignIn } from "@/app/actions/employee";
import { getSession, setSession } from "@/lib/session";
import { useSession } from "@/lib/useSession";
import { OrgBootstrapGate } from "@/components/OrgBootstrapGate";
import { EmployeeWorkspace } from "@/components/EmployeeWorkspace";
import { Landing } from "@/components/Landing";

const ENOKI_CONFIGURED =
  !!process.env.NEXT_PUBLIC_ENOKI_API_KEY && !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

export function AuthGate({ children }: { children: React.ReactNode }) {
  const account = useCurrentAccount();
  const session = useSession();
  const wallets = useWallets();
  const { mutate: connect, isPending: connecting } = useConnectWallet();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef<string | null>(null);

  // employee ("customer") login — by key, scoped to granted customers. The form
  // lives in <Landing>; this owns the auth result + the signed-in identity.
  const [empBusy, setEmpBusy] = useState(false);
  const [empErr, setEmpErr] = useState<string | null>(null);
  const [empIdentity, setEmpIdentity] = useState<{ pubHex: string; address: string } | null>(null);

  async function signInEmployee(empPub: string, empPriv: string) {
    setEmpBusy(true); setEmpErr(null);
    try {
      if (empPriv.trim()) {
        const r = await employeeSignIn(empPriv.trim());
        if (!r.ok) { setEmpErr(r.error); setEmpBusy(false); return; }
        setEmpIdentity({ pubHex: r.pubHex, address: r.address });
      } else if (empPub.trim()) {
        setEmpIdentity({ pubHex: empPub.trim().replace(/^0x/, ""), address: "(public-key view)" });
      } else {
        setEmpErr("Enter your public and/or private key");
      }
    } finally {
      setEmpBusy(false);
    }
  }

  // Once a wallet account exists, establish (or refresh) the backend session.
  useEffect(() => {
    if (!account) return;
    const existing = getSession();
    if (existing && existing.address === account.address) return;
    if (attempted.current === account.address) return; // don't loop on failure
    attempted.current = account.address;

    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const message = `SalesCall login\naddress:${account.address}\nts:${Date.now()}`;
        const { signature, bytes } = await signPersonalMessage({
          message: new TextEncoder().encode(message),
        });
        const r = await establishSession(account.address, bytes, signature);
        if (cancelled) return;
        if (r.ok) {
          setSession({ token: r.token, address: r.address, orgId: r.orgId, role: r.role, orgs: r.orgs });
        } else {
          setError(r.error);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "sign-in failed");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, signPersonalMessage]);

  // Transition mode: until Enoki/Google are configured, keep the app usable
  // (anonymous → backend resolves the default org while auth_required=false).
  if (!ENOKI_CONFIGURED) {
    return <OrgBootstrapGate>{children}</OrgBootstrapGate>;
  }

  // Employee ("customer") signed in by key → their scoped workspace.
  if (empIdentity) {
    return <EmployeeWorkspace identity={empIdentity} onSignOut={() => { setEmpIdentity(null); setEmpErr(null); }} />;
  }

  // Org signed in → full app, but gated behind first-run setup (company + customer).
  if (account && session && session.address === account.address) {
    return <OrgBootstrapGate>{children}</OrgBootstrapGate>;
  }

  // Signed out → the public hero / landing page, with the launch CTAs embedded.
  const googleWallet = wallets.find((w) => /google/i.test(w.name));
  return (
    <Landing
      busy={busy}
      connecting={connecting}
      googleReady={!!googleWallet}
      onGoogle={() => googleWallet && connect({ wallet: googleWallet })}
      empBusy={empBusy}
      empErr={empErr}
      onEmployeeSignIn={(pub, priv) => void signInEmployee(pub, priv)}
      error={error}
    />
  );
}
