export interface LyricLine {
  time: number; // seconds from start
  text: string;
}

export interface TrackPalette {
  primary: string;   // Main fluid highlight
  secondary: string; // Secondary wave hue
  accent: string;    // Specular rim & active lyric glow
  ambient: string;   // Deep atmospheric background tint
}

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // seconds
  bpm: number;
  mood: 'Ethereal' | 'Euphoric' | 'Melancholic' | 'Kinetic';
  platform: 'Spotify' | 'Apple Music' | 'MuseVis Studio';
  palette: TrackPalette;
  chordProgression: number[][]; // Frequencies in Hz for real-time Web Audio synth
  lyrics?: LyricLine[];
  externalUrl?: string;
  previewUrl?: string;
  spotifyUri?: string;
  coverUrl?: string;
}

export interface PlaylistItem {
  id: string;
  name: string;
  source: 'Spotify' | 'Apple Music';
  trackCount: number;
  synced: boolean;
  tracks: MusicTrack[];
  coverUrl?: string;
  description?: string;
  spotifyUri?: string;
}

export const ABSTRACT_COVER_PLACEHOLDERS: Record<MusicTrack['mood'], string> = {
  Ethereal: '/assets/albums/cover_ethereal_fluid.svg',
  Kinetic: '/assets/albums/cover_kinetic_aurora.svg',
  Melancholic: '/assets/albums/cover_melancholic_indigo.svg',
  Euphoric: '/assets/albums/cover_euphoric_amber.svg',
};

export function getAbstractPlaceholderCover(mood: MusicTrack['mood'] = 'Ethereal'): string {
  return ABSTRACT_COVER_PLACEHOLDERS[mood] || ABSTRACT_COVER_PLACEHOLDERS.Ethereal;
}

export function getTrackAlbumCover(track?: MusicTrack | null): string {
  if (!track) return ABSTRACT_COVER_PLACEHOLDERS.Ethereal;
  if (track.coverUrl && track.coverUrl.trim()) {
    return track.coverUrl;
  }
  return getAbstractPlaceholderCover(track.mood);
}

export const CHORD_PROGRESSIONS: number[][][] = [
  [
    [130.81, 196.0, 246.94, 329.63], // Cmaj7
    [110.0, 164.81, 220.0, 261.63],  // Am7
    [146.83, 220.0, 261.63, 349.23], // Dm7
    [98.0, 146.83, 196.0, 246.94],   // G6
  ],
  [
    [146.83, 220.0, 293.66, 349.23], // Dm
    [116.54, 174.61, 233.08, 293.66], // Bbmaj7
    [130.81, 196.0, 261.63, 329.63], // C
    [110.0, 164.81, 207.65, 261.63], // A7
  ],
  [
    [123.47, 185.0, 246.94, 293.66], // Bm7
    [98.0, 146.83, 196.0, 246.94],   // Gmaj7
    [146.83, 220.0, 277.18, 329.63], // Dadd9
    [110.0, 164.81, 220.0, 277.18],  // A
  ],
  [
    [164.81, 246.94, 329.63, 392.0], // Em7
    [130.81, 196.0, 246.94, 329.63], // Cmaj7
    [146.83, 220.0, 293.66, 369.99], // D
    [123.47, 185.0, 246.94, 293.66], // Bm7
  ],
];

export const PALETTE_PRESETS: TrackPalette[] = [
  { primary: '#1DB954', secondary: '#0EA5E9', accent: '#6EE7B7', ambient: '#051B14' },
  { primary: '#F59E0B', secondary: '#EC4899', accent: '#FDE68A', ambient: '#1F0D18' },
  { primary: '#38BDF8', secondary: '#6366F1', accent: '#BAE6FD', ambient: '#081226' },
  { primary: '#14B8A6', secondary: '#F43F5E', accent: '#99F6E4', ambient: '#071C1F' },
  { primary: '#A855F7', secondary: '#06B6D4', accent: '#F0ABFC', ambient: '#120824' },
  { primary: '#FB7185', secondary: '#F97316', accent: '#FECDD3', ambient: '#1F0910' },
];

export const DEFAULT_IDLE_TRACK: MusicTrack = {
  id: 'spotify-awaiting-selection',
  title: 'Select or Search a Song',
  artist: 'Spotify Library',
  album: 'Connect Spotify or search any song to begin',
  duration: 30,
  bpm: 100,
  mood: 'Ethereal',
  platform: 'Spotify',
  coverUrl: '/assets/albums/cover_ethereal_fluid.svg',
  palette: PALETTE_PRESETS[0],
  chordProgression: CHORD_PROGRESSIONS[0],
  lyrics: [
    { time: 0, text: 'Connect Spotify or choose a playlist to start streaming' },
    { time: 8, text: 'Real-time 3D fluid resonance awaits your music' },
  ],
};

export function hashTrackToPalette(seed: string): TrackPalette {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE_PRESETS[Math.abs(hash) % PALETTE_PRESETS.length];
}

function parseHexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return [r || 0, g || 0, b || 0];
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [
    Number.isNaN(r) ? 0 : r,
    Number.isNaN(g) ? 0 : g,
    Number.isNaN(b) ? 0 : b,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function lerpHexColor(hexA: string, hexB: string, t: number): string {
  const clampedT = Math.max(0, Math.min(1, t));
  const [r1, g1, b1] = parseHexToRgb(hexA);
  const [r2, g2, b2] = parseHexToRgb(hexB);
  return rgbToHex(
    r1 + (r2 - r1) * clampedT,
    g1 + (g2 - g1) * clampedT,
    b1 + (b2 - b1) * clampedT
  );
}

export function interpolatePalette(
  from: TrackPalette,
  to: TrackPalette,
  t: number
): TrackPalette {
  return {
    primary: lerpHexColor(from.primary, to.primary, t),
    secondary: lerpHexColor(from.secondary, to.secondary, t),
    accent: lerpHexColor(from.accent, to.accent, t),
    ambient: lerpHexColor(from.ambient, to.ambient, t),
  };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}

function hslToHex(hDeg: number, s: number, l: number): string {
  const h = ((hDeg % 360) + 360) % 360;
  const sc = Math.max(0, Math.min(1, s));
  const lc = Math.max(0, Math.min(1, l));

  const c = (1 - Math.abs(2 * lc - 1)) * sc;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lc - c / 2;
  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (h < 60) {
    rPrime = c;
    gPrime = x;
  } else if (h < 120) {
    rPrime = x;
    gPrime = c;
  } else if (h < 180) {
    gPrime = c;
    bPrime = x;
  } else if (h < 240) {
    gPrime = x;
    bPrime = c;
  } else if (h < 300) {
    rPrime = x;
    bPrime = c;
  } else {
    rPrime = c;
    bPrime = x;
  }

  return rgbToHex((rPrime + m) * 255, (gPrime + m) * 255, (bPrime + m) * 255);
}

const albumPaletteCache = new Map<string, TrackPalette>();

/**
 * Extracts a cohesive 4-color theme & lyric palette (primary, secondary, accent, ambient)
 * directly from the playing track's album cover image via offscreen canvas pixel analysis.
 */
export async function extractPaletteFromAlbumArt(
  coverUrl: string | undefined,
  fallback: TrackPalette
): Promise<TrackPalette> {
  if (!coverUrl || !coverUrl.trim()) {
    return fallback;
  }
  const cached = albumPaletteCache.get(coverUrl);
  if (cached) {
    return cached;
  }

  return new Promise<TrackPalette>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const finishWithFallback = () => {
      resolve(fallback);
    };

    img.onload = () => {
      try {
        const size = 56;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          finishWithFallback();
          return;
        }

        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        const bucketCount = 24; // 15-degree hue buckets
        const buckets = Array.from({ length: bucketCount }, () => ({
          weight: 0,
          hueSin: 0,
          hueCos: 0,
          satSum: 0,
          lightSum: 0,
        }));

        let totalChromaticWeight = 0;
        let avgHueSin = 0;
        let avgHueCos = 0;
        let avgLightness = 0;
        let validPixels = 0;

        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 128) continue;

          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const [h, s, l] = rgbToHsl(r, g, b);

          validPixels++;
          avgLightness += l;
          const rad = (h * Math.PI) / 180;
          avgHueSin += Math.sin(rad) * (s + 0.05);
          avgHueCos += Math.cos(rad) * (s + 0.05);

          // Ignore near-black and near-white pixels for chromatic buckets
          if (l < 0.09 || l > 0.93 || s < 0.1) continue;

          // Favor vibrant mid-to-bright tones found in focal album art elements
          const lightBell = 1 - Math.min(1, Math.abs(l - 0.54) * 1.45);
          const vibranceWeight = Math.pow(s, 1.3) * Math.max(0.15, lightBell);

          const bIdx = Math.floor(h / (360 / bucketCount)) % bucketCount;
          const bucket = buckets[bIdx];
          bucket.weight += vibranceWeight;
          bucket.hueSin += Math.sin(rad) * vibranceWeight;
          bucket.hueCos += Math.cos(rad) * vibranceWeight;
          bucket.satSum += s * vibranceWeight;
          bucket.lightSum += l * vibranceWeight;
          totalChromaticWeight += vibranceWeight;
        }

        if (validPixels === 0) {
          finishWithFallback();
          return;
        }

        // Handle monochromatic / noir / B&W album covers gracefully using subtle cast
        if (totalChromaticWeight < 1.5) {
          const baseHue =
            ((Math.atan2(avgHueSin, avgHueCos) * 180) / Math.PI + 360) % 360 || 215;
          const meanL = avgLightness / validPixels;
          const monoPalette: TrackPalette = {
            primary: hslToHex(baseHue, 0.52, Math.max(0.56, Math.min(0.68, meanL + 0.18))),
            secondary: hslToHex((baseHue + 38) % 360, 0.45, 0.5),
            accent: hslToHex((baseHue + 18) % 360, 0.72, 0.8),
            ambient: hslToHex(baseHue, 0.42, 0.1),
          };
          albumPaletteCache.set(coverUrl, monoPalette);
          resolve(monoPalette);
          return;
        }

        const ranked = buckets
          .map((b, idx) => {
            if (b.weight <= 0) {
              return { idx, weight: 0, hue: idx * 15, sat: 0, light: 0.5 };
            }
            const meanHue =
              ((Math.atan2(b.hueSin, b.hueCos) * 180) / Math.PI + 360) % 360;
            return {
              idx,
              weight: b.weight,
              hue: meanHue,
              sat: b.satSum / b.weight,
              light: b.lightSum / b.weight,
            };
          })
          .filter((b) => b.weight > 0)
          .sort((a, b) => b.weight - a.weight);

        const dominant = ranked[0];
        const hueDistance = (h1: number, h2: number) => {
          const diff = Math.abs(h1 - h2) % 360;
          return diff > 180 ? 360 - diff : diff;
        };

        // Find a distinct secondary hue from the artwork (at least 28 degrees apart)
        const secondaryCandidate = ranked.find(
          (b) => hueDistance(b.hue, dominant.hue) >= 28 && b.weight >= dominant.weight * 0.12
        );

        // Find a vibrant highlight / accent hue from the artwork
        const accentCandidate = ranked.find(
          (b) =>
            hueDistance(b.hue, dominant.hue) >= 18 &&
            b.light >= 0.45 &&
            b.weight >= dominant.weight * 0.08
        );

        const primaryHue = dominant.hue;
        const primarySat = Math.max(0.74, Math.min(0.92, dominant.sat * 1.18));
        const primaryLight = Math.max(0.55, Math.min(0.66, dominant.light * 0.95 + 0.12));

        const secondaryHue = secondaryCandidate
          ? secondaryCandidate.hue
          : (primaryHue + 42) % 360;
        const secondarySat = secondaryCandidate
          ? Math.max(0.68, Math.min(0.88, secondaryCandidate.sat * 1.15))
          : Math.max(0.68, primarySat - 0.06);
        const secondaryLight = secondaryCandidate
          ? Math.max(0.48, Math.min(0.6, secondaryCandidate.light))
          : 0.52;

        const accentHue = accentCandidate
          ? accentCandidate.hue
          : secondaryCandidate
          ? (secondaryHue + 22) % 360
          : (primaryHue + 28) % 360;
        const accentSat = Math.max(0.84, Math.min(0.96, primarySat + 0.08));
        const accentLight = Math.max(0.74, Math.min(0.84, (accentCandidate?.light || 0.65) + 0.16));

        const extracted: TrackPalette = {
          primary: hslToHex(primaryHue, primarySat, primaryLight),
          secondary: hslToHex(secondaryHue, secondarySat, secondaryLight),
          accent: hslToHex(accentHue, accentSat, accentLight),
          ambient: hslToHex(primaryHue, Math.max(0.55, primarySat * 0.78), 0.1),
        };

        albumPaletteCache.set(coverUrl, extracted);
        resolve(extracted);
      } catch {
        finishWithFallback();
      }
    };

    img.onerror = finishWithFallback;
    img.src = coverUrl;
  });
}

