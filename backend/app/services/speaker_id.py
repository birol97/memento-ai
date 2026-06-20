"""Voice-print enrollment + per-turn speaker classification — numpy only.

We extract a 29-dim raw fingerprint from a chunk of mono 16 kHz audio:

  [0:13]  MFCC means         (timbre — vocal tract shape)
  [13:26] MFCC stds          (timbre dynamics)
  [26]    F0 mean, semitones (pitch)
  [27]    F0 std, semitones  (intonation range)
  [28]    voiced fraction    (speaking style)

The classifier requires BOTH timbre AND pitch to match before labelling
a turn 'rep' — this is much harder to fool than a single cosine score,
where MFCC pooling averages out and most voices end up similar.

  decision rule:
      timbre_cos = cosine(mfcc_test[:26], mfcc_rep[:26])
      pitch_diff = |f0_mean_test - f0_mean_rep|   (semitones)
      label = 'rep' iff timbre_cos >= TIMBRE_THRESHOLD
                   and pitch_diff <= PITCH_THRESHOLD_ST
                   (or: too little voicing to score pitch — fall back
                    to timbre alone)

Only depends on numpy. No torch, no scipy, no librosa.

NOTE on backwards compatibility: a fingerprint stored before this rewrite
was L2-normalized and had different per-feature scaling. The byte layout
is the same shape (29 × float32), so old rows parse without crashing,
but their *values* are not comparable to fingerprints produced now —
re-enrollment is required after this change.
"""
from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

from app.core.config import get_settings
from app.core.logger import get_logger

log = get_logger(__name__)


EXPECTED_SR = 16000
FRAME_MS = 25
HOP_MS = 10
N_MELS = 40
N_MFCC = 13
PRE_EMPH = 0.97
FFT_SIZE = 512               # > frame_len at 16 kHz (400 samples)
FMIN_HZ = 80.0
FMAX_HZ = 7600.0

# Two-score classifier thresholds. Both must pass to tag 'rep'.
#
#   TIMBRE_THRESHOLD: cosine between MFCC-stat blocks. MFCC mean+std are
#   relatively flat across speakers (most speech has similar broad
#   spectral shape), so cosine alone can't discriminate — but it does
#   reliably reject genuinely different timbres (e.g. mic on the rep's
#   side vs phone audio on the prospect's side).
#
#   PITCH_THRESHOLD_ST: semitone distance between mean F0s. ~3-4 semis
#   is the natural variation within one speaker; 5+ usually means
#   different person. Tunable per voice via env.
DEFAULT_TIMBRE_THRESHOLD = 0.85
DEFAULT_PITCH_THRESHOLD_ST = 5.0

# F0 search range — covers from low-male to high-female speech.
F0_MIN_HZ = 60.0
F0_MAX_HZ = 400.0
# Voicing decision: a frame is "voiced" only if its peak normalized
# autocorrelation exceeds this. Below this we treat it as unvoiced and
# exclude it from F0 statistics.
VOICING_THRESHOLD = 0.35
# If a fingerprint has less than this fraction voiced, its F0 stats are
# unreliable and the pitch test is skipped (timbre alone decides).
MIN_VOICED_FRAC_FOR_PITCH = 0.1

# Fingerprint layout (29 × float32) — see module docstring.
_F0_MEAN_INDEX = 26
_F0_STD_INDEX = 27
_VOICED_FRAC_INDEX = 28
_MFCC_BLOCK = slice(0, 26)

# Below this much voiced audio the classifier is unreliable and we fall
# back to "client" (the conservative default for sales coaching — better
# to miss-tag a short rep utterance than miss a prospect turn that should
# trigger a suggestion).
MIN_SECONDS_FOR_EMBEDDING = 1.0


class SpeakerIdUnavailable(Exception):
    """Raised when the encoder fails for environmental reasons. Currently
    impossible (numpy-only path), but kept for API compatibility with the
    REST + websocket callers that catch it."""


# ─── Mel filterbank (precomputed once on import) ─────────────────────────

def _hz_to_mel(f: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(f) / 700.0)


def _mel_to_hz(m: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(m) / 2595.0) - 1.0)


def _build_mel_filterbank(
    sr: int = EXPECTED_SR,
    n_fft: int = FFT_SIZE,
    n_mels: int = N_MELS,
    fmin: float = FMIN_HZ,
    fmax: float = FMAX_HZ,
) -> np.ndarray:
    n_bins = n_fft // 2 + 1
    mel_min = _hz_to_mel(fmin)
    mel_max = _hz_to_mel(fmax)
    mel_pts = np.linspace(mel_min, mel_max, n_mels + 2)
    hz_pts = _mel_to_hz(mel_pts)
    fft_bin_hz = np.linspace(0, sr / 2, n_bins)
    fb = np.zeros((n_mels, n_bins), dtype=np.float32)
    for i in range(n_mels):
        left, center, right = hz_pts[i], hz_pts[i + 1], hz_pts[i + 2]
        # rising edge
        rising = (fft_bin_hz - left) / max(center - left, 1e-9)
        # falling edge
        falling = (right - fft_bin_hz) / max(right - center, 1e-9)
        fb[i] = np.clip(np.minimum(rising, falling), 0.0, None)
    return fb


_MEL_FB = _build_mel_filterbank()
# DCT-II basis, orthonormalized — matches scipy.fft.dct(type=2, norm='ortho').
_DCT = np.zeros((N_MFCC, N_MELS), dtype=np.float32)
for k in range(N_MFCC):
    for n in range(N_MELS):
        _DCT[k, n] = np.cos(np.pi * k * (2 * n + 1) / (2 * N_MELS))
_DCT[0] *= 1.0 / np.sqrt(N_MELS)
_DCT[1:] *= np.sqrt(2.0 / N_MELS)
_HAMMING = None  # built on first use, cached by frame length


# ─── feature extraction ───────────────────────────────────────────────────

def _coerce_mono_float32(samples: np.ndarray) -> np.ndarray:
    arr = np.asarray(samples)
    if arr.ndim > 1:
        arr = arr.mean(axis=tuple(range(1, arr.ndim)))
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32, copy=False)
    return arr


def _frame(signal: np.ndarray, frame_len: int, hop: int) -> np.ndarray:
    """Split ``signal`` into overlapping frames of ``frame_len`` samples
    with ``hop`` samples between starts. Trailing partial frame is dropped."""
    if signal.shape[0] < frame_len:
        return np.empty((0, frame_len), dtype=signal.dtype)
    n_frames = 1 + (signal.shape[0] - frame_len) // hop
    # stride trick — zero-copy view, much faster than np.stack in a loop
    stride = signal.strides[0]
    return np.lib.stride_tricks.as_strided(
        signal,
        shape=(n_frames, frame_len),
        strides=(stride * hop, stride),
        writeable=False,
    )


def _mfccs(samples: np.ndarray, sr: int = EXPECTED_SR) -> np.ndarray:
    """Compute (n_frames, N_MFCC) MFCCs from mono float32 audio."""
    global _HAMMING
    frame_len = int(round(sr * FRAME_MS / 1000))
    hop = int(round(sr * HOP_MS / 1000))

    # Pre-emphasis filter (cheap high-pass — boosts the speech band).
    emph = np.empty_like(samples)
    emph[0] = samples[0]
    emph[1:] = samples[1:] - PRE_EMPH * samples[:-1]

    frames = _frame(emph, frame_len, hop)
    if frames.shape[0] == 0:
        return np.empty((0, N_MFCC), dtype=np.float32)

    if _HAMMING is None or _HAMMING.shape[0] != frame_len:
        _HAMMING = np.hamming(frame_len).astype(np.float32)
    windowed = frames * _HAMMING

    # Power spectrum on FFT_SIZE bins (zero-padded if frame_len < FFT_SIZE).
    spec = np.fft.rfft(windowed, n=FFT_SIZE, axis=1)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32) / FFT_SIZE

    mel_energies = power @ _MEL_FB.T          # (n_frames, N_MELS)
    log_mel = np.log(mel_energies + 1e-10)
    mfcc = log_mel @ _DCT.T                   # (n_frames, N_MFCC)
    return mfcc.astype(np.float32, copy=False)


def _hz_to_semitones(f_hz: np.ndarray) -> np.ndarray:
    """Convert Hz → semitones above 8.176 Hz (MIDI 0). Log domain makes
    pitch differences perceptually linear, which is what we want for
    speaker comparison."""
    f = np.asarray(f_hz, dtype=np.float32)
    out = np.zeros_like(f)
    pos = f > 0
    out[pos] = 12.0 * np.log2(f[pos] / 8.1757989156)
    return out


def _f0_per_frame(samples: np.ndarray, sr: int = EXPECTED_SR) -> np.ndarray:
    """Estimate per-frame F0 in Hz via normalized autocorrelation.

    Returns one F0 per frame, with 0.0 for frames classified as unvoiced.
    Uses the same framing geometry as MFCC (25 ms / 10 ms) so feature
    aggregation lines up.
    """
    frame_len = int(round(sr * FRAME_MS / 1000))
    hop = int(round(sr * HOP_MS / 1000))
    frames = _frame(samples, frame_len, hop)
    if frames.shape[0] == 0:
        return np.empty(0, dtype=np.float32)

    min_lag = int(sr / F0_MAX_HZ)
    max_lag = int(sr / F0_MIN_HZ)
    if max_lag >= frame_len:
        max_lag = frame_len - 1

    out = np.zeros(frames.shape[0], dtype=np.float32)
    for i in range(frames.shape[0]):
        f = frames[i].astype(np.float32, copy=False)
        f = f - f.mean()
        norm0 = float(np.dot(f, f))
        if norm0 < 1e-7:
            continue  # silence
        # Only the positive-lag half of autocorrelation, normalized to [0,1].
        # We compute via FFT for speed: O(n log n) vs O(n^2) per frame.
        n = frame_len
        n_fft = 1 << (2 * n - 1).bit_length()
        F = np.fft.rfft(f, n=n_fft)
        ac_full = np.fft.irfft(F * np.conj(F), n=n_fft)
        ac = ac_full[: max_lag + 1] / norm0
        if max_lag <= min_lag:
            continue
        peak_lag = min_lag + int(np.argmax(ac[min_lag : max_lag + 1]))
        if ac[peak_lag] < VOICING_THRESHOLD:
            continue  # unvoiced (noise / fricatives / silence)
        out[i] = sr / float(peak_lag)
    return out


def extract_embedding(samples: np.ndarray, *, sample_rate: int = EXPECTED_SR) -> np.ndarray:
    """Compute a 29-dim raw voice fingerprint from a mono PCM array.

    Layout (see module docstring):
      [0:13]  MFCC means
      [13:26] MFCC stds
      [26]    F0 mean (semitones); 0.0 if no voiced frames
      [27]    F0 std (semitones)
      [28]    voiced fraction in [0, 1]

    Audio must be at 16 kHz. Raises ValueError if too short to score
    reliably (< ``MIN_SECONDS_FOR_EMBEDDING``).
    """
    if sample_rate != EXPECTED_SR:
        raise ValueError(f"speaker_id expects {EXPECTED_SR} Hz audio, got {sample_rate}")
    audio = _coerce_mono_float32(samples)
    duration_s = len(audio) / float(EXPECTED_SR)
    if duration_s < MIN_SECONDS_FOR_EMBEDDING:
        raise ValueError(
            f"audio too short for embedding: {duration_s:.2f}s "
            f"(need >= {MIN_SECONDS_FOR_EMBEDDING}s)"
        )

    coeffs = _mfccs(audio)
    if coeffs.shape[0] == 0:
        raise ValueError("audio yielded zero frames after framing")
    mfcc_means = coeffs.mean(axis=0)
    mfcc_stds = coeffs.std(axis=0)

    f0 = _f0_per_frame(audio)
    voiced_mask = f0 > 0
    voiced_frac = float(voiced_mask.mean()) if f0.size else 0.0
    if voiced_mask.any():
        f0_st = _hz_to_semitones(f0[voiced_mask])
        f0_mean_st = float(f0_st.mean())
        f0_std_st = float(f0_st.std())
    else:
        # No voiced frames — record 0 so the consumer can detect this
        # via the voiced_frac field and skip the pitch comparison.
        f0_mean_st = 0.0
        f0_std_st = 0.0

    return np.concatenate(
        [
            mfcc_means,
            mfcc_stds,
            np.array([f0_mean_st, f0_std_st, voiced_frac], dtype=np.float32),
        ]
    ).astype(np.float32, copy=False)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a32 = a.astype(np.float32, copy=False)
    b32 = b.astype(np.float32, copy=False)
    denom = float(np.linalg.norm(a32) * np.linalg.norm(b32))
    if denom == 0.0:
        return 0.0
    return float(np.dot(a32, b32) / denom)


def classify_turn(
    samples: np.ndarray,
    *,
    rep_embedding: np.ndarray,
    sample_rate: int = EXPECTED_SR,
    timbre_threshold: float = DEFAULT_TIMBRE_THRESHOLD,
    pitch_threshold_st: float = DEFAULT_PITCH_THRESHOLD_ST,
) -> Tuple[str, Optional[float]]:
    """Classify a turn as 'rep' or 'client' using both timbre AND pitch.

    Returns (label, timbre_cosine). The cosine value is for diagnostics —
    the actual decision uses both timbre and pitch.

    Decision rule:
      - Compute timbre cosine on the MFCC block (26 dims).
      - If both rep and turn have enough voicing, compute pitch distance
        in semitones.
      - 'rep' iff timbre_cos ≥ timbre_threshold AND pitch_diff ≤ threshold.
      - When voicing is too low to score pitch, fall back to timbre alone.

    Returns ('client', None) for turns too short to embed at all.
    """
    if rep_embedding.shape[0] != 29:
        # Defensive: stale enrollment from a different format.
        return "client", None
    try:
        emb = extract_embedding(samples, sample_rate=sample_rate)
    except ValueError:
        return "client", None

    timbre_cos = cosine_similarity(emb[_MFCC_BLOCK], rep_embedding[_MFCC_BLOCK])

    rep_voiced = float(rep_embedding[_VOICED_FRAC_INDEX])
    turn_voiced = float(emb[_VOICED_FRAC_INDEX])
    if rep_voiced >= MIN_VOICED_FRAC_FOR_PITCH and turn_voiced >= MIN_VOICED_FRAC_FOR_PITCH:
        rep_f0 = float(rep_embedding[_F0_MEAN_INDEX])
        turn_f0 = float(emb[_F0_MEAN_INDEX])
        pitch_diff = abs(turn_f0 - rep_f0)
        pitch_match = pitch_diff <= pitch_threshold_st
    else:
        # Not enough voicing on one side — defer to timbre alone.
        pitch_diff = None
        pitch_match = True

    is_rep = (timbre_cos >= timbre_threshold) and pitch_match
    return ("rep" if is_rep else "client", timbre_cos)


def thresholds_from_settings() -> Tuple[float, float]:
    """Allow tuning via env vars without touching code."""
    s = get_settings()
    return (
        float(getattr(s, "speaker_id_timbre_threshold", DEFAULT_TIMBRE_THRESHOLD)),
        float(getattr(s, "speaker_id_pitch_threshold_st", DEFAULT_PITCH_THRESHOLD_ST)),
    )


# Kept for backward-compat with any caller that still imports the old name.
def threshold_from_settings() -> float:
    return thresholds_from_settings()[0]
