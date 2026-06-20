/**
 * Captures microphone audio as raw 16 kHz mono Float32 PCM and emits ~250ms
 * chunks to a callback. Uses an AudioWorklet under the hood so the audio path
 * stays off the main thread.
 */

export interface AudioCaptureOptions {
  sampleRate?: number;
  chunkSize?: number;
  onChunk: (samples: Float32Array) => void;
  onError?: (err: Error) => void;
}

export class AudioCapture {
  private readonly opts: Required<Omit<AudioCaptureOptions, "onError">> & {
    onError?: (err: Error) => void;
  };
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;

  constructor(options: AudioCaptureOptions) {
    this.opts = {
      sampleRate: options.sampleRate ?? 16000,
      chunkSize: options.chunkSize ?? 4000, // 250 ms at 16 kHz
      onChunk: options.onChunk,
      onError: options.onError,
    };
  }

  async start(): Promise<void> {
    if (this.ctx) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.opts.onError?.(e);
      throw e;
    }

    // Create AudioContext at 16 kHz; browser will resample the mic input.
    // Safari ignores the hint, but we still post 16 kHz expectation to the
    // worklet — for an MVP this is acceptable.
    this.ctx = new AudioContext({ sampleRate: this.opts.sampleRate });

    await this.ctx.audioWorklet.addModule("/audio-processor.js");

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, "pcm-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { chunkSize: this.opts.chunkSize },
    });

    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.opts.onChunk(event.data);
    };

    // The worklet must be in the graph for `process()` to run, but we don't
    // actually want to hear ourselves — route to a muted gain node.
    const muted = this.ctx.createGain();
    muted.gain.value = 0;
    this.source.connect(this.worklet);
    this.worklet.connect(muted);
    muted.connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.worklet?.disconnect();
    this.worklet = null;
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== "closed") {
      await this.ctx.close();
    }
    this.ctx = null;
  }

  getActualSampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }
}
