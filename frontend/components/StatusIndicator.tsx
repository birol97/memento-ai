"use client";

import type { ConnectionStatus } from "@/lib/types";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  ready: "Connected",
  recording: "Listening",
  stopped: "Stopped",
  error: "Error",
};

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  idle: "#94a3b8",
  connecting: "#f59e0b",
  ready: "#22c55e",
  recording: "#22c55e",
  stopped: "#94a3b8",
  error: "#ef4444",
};

export function StatusIndicator({
  status,
  speaking = false,
}: {
  status: ConnectionStatus;
  speaking?: boolean;
}) {
  const isRecording = status === "recording";
  const showSpeaking = isRecording && speaking;
  const dotColor = showSpeaking ? "#ef4444" : STATUS_COLOR[status];
  const label = showSpeaking ? "Speaking" : STATUS_LABEL[status];

  return (
    <div className="status">
      <span
        className={showSpeaking ? "dot pulse" : "dot"}
        style={{ background: dotColor }}
      />
      <span>{label}</span>
    </div>
  );
}
