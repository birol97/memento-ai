/**
 * Decodes an audio file (WAV/MP3/M4A/FLAC/OGG) to 16 kHz mono Float32 PCM
 * using the browser's AudioContext + OfflineAudioContext (which handles
 * resampling for us). Then yields fixed-size chunks at real-time pace so the
 * backend's rolling-window inference behaves the same as a live mic feed.
 */

const TARGET_SR = 16000;

export async function decodeTo16kMono(file: File): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();

  // Decode at the file's native sample rate. We need a regular AudioContext
  // (not Offline) here because Offline can't decode arbitrary container formats.
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await decodeCtx.close().catch(() => {});
  }

  // Resample → 16 kHz mono using an OfflineAudioContext.
  const targetLength = Math.max(1, Math.ceil(decoded.duration * TARGET_SR));
  const offline = new OfflineAudioContext(1, targetLength, TARGET_SR);
  const src = offline.createBufferSource();
  src.buffer = decoded;

  // Mix down to mono if needed by routing through a ChannelMergerNode is
  // overkill — OfflineAudioContext with numberOfChannels=1 and a stereo
  // source will downmix automatically.
  src.connect(offline.destination);
  src.start();

  const rendered = await offline.startRendering();
  // Copy out so the AudioBuffer can be GC'd
  return new Float32Array(rendered.getChannelData(0));
}

export interface StreamOptions {
  chunkSamples?: number;   // 4000 = 250 ms at 16 kHz
  speed?: number;          // 1 = real-time, 4 = 4x faster
  onChunk?: (chunk: Float32Array, indexInFile: number) => void;
  signal?: AbortSignal;
}

/**
 * Yields successive Float32 chunks, sleeping between each so the wall-clock
 * pace matches `speed * realtime`. Default is exact real-time, which gives
 * the same UX as live mic input.
 */
export async function streamPcmAtPace(
  samples: Float32Array,
  options: StreamOptions = {},
): Promise<void> {
  const chunkSamples = options.chunkSamples ?? 4000;
  const speed = Math.max(0.1, options.speed ?? 1);
  const chunkDurationMs = (chunkSamples / TARGET_SR) * 1000 / speed;
  const onChunk = options.onChunk ?? (() => {});

  for (let i = 0; i < samples.length; i += chunkSamples) {
    if (options.signal?.aborted) return;
    const slice = samples.subarray(i, Math.min(i + chunkSamples, samples.length));
    // Copy because subarray shares the buffer; the consumer is going to
    // transfer or send this and we don't want to invalidate the source.
    const chunk = new Float32Array(slice);
    onChunk(chunk, i);
    // Sleep to pace.
    await new Promise<void>((resolve) => setTimeout(resolve, chunkDurationMs));
  }
}
