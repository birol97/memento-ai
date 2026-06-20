import type {
  AutoIntervalSeconds,
  ServerMessage,
  SuggestionMode,
  SuggestionSkill,
} from "./types";

export interface TranscribeClientCallbacks {
  onOpen?: () => void;
  onMessage: (msg: ServerMessage) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (err: Event) => void;
}

export class TranscribeClient {
  private readonly url: string;
  private readonly cb: TranscribeClientCallbacks;
  private ws: WebSocket | null = null;

  constructor(url: string, callbacks: TranscribeClientCallbacks) {
    this.url = url;
    this.cb = callbacks;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      const onOpen = () => {
        this.cb.onOpen?.();
        resolve();
      };

      const onErr = (ev: Event) => {
        this.cb.onError?.(ev);
        reject(new Error("WebSocket failed to open"));
      };

      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onErr, { once: true });

      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data) as ServerMessage;
          this.cb.onMessage(msg);
        } catch (e) {
          console.warn("invalid server message", ev.data);
        }
      });

      ws.addEventListener("close", (ev) => {
        this.cb.onClose?.(ev);
      });
    });
  }

  sendStart(
    sampleRate: number,
    client?: { id: number } | null,
    suggestion?: {
      mode: SuggestionMode;
      autoIntervalSeconds: AutoIntervalSeconds;
      skill: SuggestionSkill;
    },
    memory?: string | null,
  ): void {
    const payload: Record<string, unknown> = { type: "start", sample_rate: sampleRate };
    if (client) payload.client = { id: client.id };
    if (suggestion) {
      payload.mode = suggestion.mode;
      payload.auto_interval_seconds = suggestion.autoIntervalSeconds;
      payload.skill = suggestion.skill;
    }
    // MemWal-recalled memory block, injected into the copilot prompt server-side.
    if (memory && memory.trim()) payload.memory = memory;
    this.ws?.send(JSON.stringify(payload));
  }

  sendMode(
    mode: SuggestionMode,
    autoIntervalSeconds: AutoIntervalSeconds,
    skill: SuggestionSkill,
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "set_mode",
        mode,
        auto_interval_seconds: autoIntervalSeconds,
        skill,
      }),
    );
  }

  sendStop(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }));
    }
  }

  sendAsk(prompt: string, askId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "ask", prompt, ask_id: askId }));
  }

  sendAudio(samples: Float32Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Pass the underlying ArrayBuffer (already Float32 LE on every supported
      // platform — JS engines we target are all little-endian).
      this.ws.send(samples.buffer);
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}
