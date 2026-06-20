// AudioWorklet processor: captures Float32 PCM frames from the mic input
// and posts ~250ms chunks to the main thread. The AudioContext is created
// at 16 kHz, so the browser handles resampling for us.

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // 4000 samples = 250 ms at 16 kHz
    this._chunkSize = opts.chunkSize || 4000;
    this._buf = new Float32Array(this._chunkSize);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0]; // Float32Array, length 128

    let i = 0;
    while (i < channel.length) {
      const remaining = this._chunkSize - this._pos;
      const take = Math.min(remaining, channel.length - i);
      this._buf.set(channel.subarray(i, i + take), this._pos);
      this._pos += take;
      i += take;
      if (this._pos >= this._chunkSize) {
        const out = this._buf.slice(); // copy
        this.port.postMessage(out, [out.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PCMCaptureProcessor);
