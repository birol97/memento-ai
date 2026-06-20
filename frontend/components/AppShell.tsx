"use client";

// The authenticated shell: top nav + org switcher + sign-out. Replaces the
// static nav that used to live in layout.tsx.
import { useTransition } from "react";
import Link from "next/link";
import { useDisconnectWallet } from "@mysten/dapp-kit";

import { Logo } from "@/components/Logo";
import { switchOrg } from "@/app/actions/session";
import { getSession, setSession } from "@/lib/session";
import { useSession } from "@/lib/useSession";

export function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const { mutate: disconnect } = useDisconnectWallet();
  const [pending, startTransition] = useTransition();

  const onSwitch = (orgId: number) => {
    const cur = getSession();
    if (!cur || orgId === cur.orgId) return;
    startTransition(async () => {
      const r = await switchOrg(cur.token, orgId);
      if (r.ok) setSession({ token: r.token, address: r.address, orgId: r.orgId, role: r.role, orgs: r.orgs });
    });
  };

  const signOut = () => {
    setSession(null);
    disconnect();
  };

  const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

  return (
    <>
      <nav className="topnav">
        <Link href="/customers" className="topnav-brand">
          <Logo size={28} />
          <span className="brand-wrap">
            <span className="brand-name">
              Memento<span className="brand-ai"> AI</span>
            </span>
            <span className="brand-tag">People leave. Knowledge stays.</span>
          </span>
        </Link>
        <span className="topnav-spacer" />
        <Link href="/customers" title="Your advanced inbox">Inbox</Link>
        <Link href="/tribe">Tribe</Link>
        <Link href="/assistant">Assistant</Link>
        <Link href="/monitor" title="Long-running commitments monitor (multi-agent)">Monitor</Link>
        <Link href="/org" title="On-chain organization directory (team + roles)">Org</Link>
        <Link href="/channels">Settings</Link>

        {session && (
          <span className="topnav-account">
            {session.orgs.length > 0 && (
              <select
                className="org-switcher"
                value={session.orgId}
                disabled={pending}
                onChange={(e) => onSwitch(Number(e.target.value))}
                title="Active organization"
              >
                {session.orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.role})
                  </option>
                ))}
              </select>
            )}
            <span className="topnav-addr" title={session.address}>
              {short(session.address)}
            </span>
            <button className="topnav-signout" onClick={signOut}>
              Sign out
            </button>
          </span>
        )}
      </nav>
      {children}
    </>
  );
}
