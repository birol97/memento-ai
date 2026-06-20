"use server";

// Server actions for the multi-agent commitments monitor.
//  • runMonitor      — Scanner → Drafter pipeline (writes findings/drafts/state to Walrus)
//  • actionDraft     — the Actioner: human-approved send of one draft via the real
//                      channel path, then records an `actions` artifact on Walrus.
import { runMonitorPipeline, type PipelineResult, type Draft } from "@/lib/agents/pipeline";
import { putBlob } from "@/lib/agents/store";
import { listChannels, sendMessage, addNote } from "@/lib/api";

export type RunResult = { ok: true; result: PipelineResult } | { ok: false; error: string };

export async function runMonitor(dueWithinDays = 7): Promise<RunResult> {
  try {
    return { ok: true, result: await runMonitorPipeline(dueWithinDays) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "pipeline failed" };
  }
}

export type ActionResult =
  | { ok: true; channel: string; actionsBlobId: string }
  | { ok: false; error: string };

/** Actioner: send one approved draft through the real channel path, log to Walrus. */
export async function actionDraft(draft: Draft): Promise<ActionResult> {
  try {
    let channelUsed = draft.channel;
    if (draft.channel === "email") {
      const channels = await listChannels();
      const email = channels.find((c) => c.kind === "email");
      if (email && draft.to) {
        const r = await sendMessage(email.id, { to: draft.to, subject: draft.subject ?? "Reminder", body: draft.body, client_id: draft.clientId });
        if (!r.ok) return { ok: false, error: r.error ?? "send failed" };
      } else {
        // no email channel / address → fall back to an internal note so nothing is lost
        await addNote(draft.clientId, `📅 Reminder (no email channel): ${draft.body}`);
        channelUsed = "note";
      }
    } else {
      await addNote(draft.clientId, `📅 Reminder: ${draft.body}`);
    }
    const actionsBlobId = await putBlob({
      kind: "agent-actions", agent: "actioner", key: draft.key, clientId: draft.clientId,
      channel: channelUsed, at: new Date().toISOString(),
    });
    return { ok: true, channel: channelUsed, actionsBlobId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "action failed" };
  }
}
