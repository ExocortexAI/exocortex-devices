// EEG helpers any board can use: the region of a 10-20 (10-10, 10-5) electrode name, and band powers of a signal.
// Small and with no dependencies: the app summarises a board's EEG with them, whatever its montage.

export type Region = 'frontal' | 'central' | 'parietal' | 'occipital' | 'temporal';
export const REGIONS: Region[] = ['frontal', 'central', 'parietal', 'occipital', 'temporal'];

/**
 * The region of an electrode name ('Fp1', 'F3', 'C4', 'Pz', 'O2', 'T7', 'EEG Fp1-REF' …), or null when the name is not
 * a scalp position (a reference such as A1 or M2, a channel number, an ECG lead). Mixed positions go to the region
 * their first letters name (FC → frontal, CP → central, PO → parietal); FT and TP, which sit over the temporal lobe,
 * go to temporal, as do T3-T6 of the older naming.
 */
export function regionOf(name: string): Region | null {
  const s = name.trim().replace(/^EEG\s+/i, '').replace(/[-_ ](REF|LE|A[12]|M[12]|AVG|Cz)$/i, '');
  const m = /^(Fp|AF|FC|FT|F|CP|C|TP|T|PO|P|O|I)(\d{1,2}|z|Z|h\d{1,2})$/i.exec(s);
  if (!m) return null;
  const p = m[1].toUpperCase();
  if (p === 'FT' || p === 'TP' || p === 'T') return 'temporal';
  if (p === 'FP' || p === 'AF' || p === 'F' || p === 'FC') return 'frontal';
  if (p === 'C' || p === 'CP') return 'central';
  if (p === 'P' || p === 'PO') return 'parietal';
  return 'occipital';   // O, I
}

/** channel indexes grouped by region; names with no region are left out */
export function groupByRegion(names: string[]): Partial<Record<Region, number[]>> {
  const out: Partial<Record<Region, number[]>> = {};
  names.forEach((n, i) => {
    const r = regionOf(n);
    if (r) (out[r] ??= []).push(i);
  });
  return out;
}

export type Band = 'delta' | 'theta' | 'alpha' | 'beta' | 'gamma';
export const BANDS: Record<Band, [number, number]> = {
  delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 45],
};

/** in-place radix-2 FFT of (re, im); the length must be a power of two */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Power in each band of one signal (µV² when the samples are µV): the mean is removed, a Hann window applied, the
 * signal zero-padded to a power of two, and the one-sided power spectral density summed over each band's bins.
 * The sum over all bins is the signal's variance (Parseval, corrected for the window), so band powers compare across lengths and
 * rates. A band above half the sample rate is 0.
 */
export function bandPowers(samples: ArrayLike<number>, fs: number): Record<Band, number> & { total: number } {
  const n = samples.length;
  const out = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
  if (n < 4 || !(fs > 0)) return out;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  let size = 1;
  while (size < n) size <<= 1;
  const re = new Float64Array(size), im = new Float64Array(size);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (samples[i] - mean) * w;
    wsum += w * w;
  }
  fft(re, im);
  const df = fs / size;
  for (let k = 1; k <= size / 2; k++) {
    // one-sided: double every bin but the Nyquist one; normalise by the window's energy
    const p = ((re[k] ** 2 + im[k] ** 2) * (k === size / 2 ? 1 : 2)) / (size * wsum);
    const f = k * df;
    out.total += p;
    for (const b of Object.keys(BANDS) as Band[]) {
      const [lo, hi] = BANDS[b];
      if (f >= lo && f < hi) out[b] += p;
    }
  }
  return out;
}

/** band powers as fractions of the 1-45 Hz power */
export function relativeBandPowers(p: Record<Band, number>): Record<Band, number> {
  const sum = p.delta + p.theta + p.alpha + p.beta + p.gamma;
  const r = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  if (sum <= 0) return r;
  for (const b of Object.keys(r) as Band[]) r[b] = p[b] / sum;
  return r;
}
