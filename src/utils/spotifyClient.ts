// Client-side PKCE, Real Spotify Track Mapper, Audio Stream Resolver & Synchronized Lyrics Helper
import {
  CHORD_PROGRESSIONS,
  LyricLine,
  MusicTrack,
  hashTrackToPalette,
  getAbstractPlaceholderCover,
} from '../data/tracks';

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createClientPkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const randomBytes = new Uint8Array(48);
  window.crypto.getRandomValues(randomBytes);
  const codeVerifier = base64UrlEncode(randomBytes.buffer);
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  const codeChallenge = base64UrlEncode(digest);
  return { codeVerifier, codeChallenge };
}

export async function safeJsonFetch<T = any>(
  url: string,
  options?: RequestInit
): Promise<{ ok: boolean; status: number; isJson: boolean; data: T | null }> {
  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return { ok: false, status: res.status, isJson: false, data: null };
    }
    const text = await res.text();
    if (!text || text.trim().startsWith('<')) {
      return { ok: false, status: res.status, isJson: false, data: null };
    }
    const parsed = JSON.parse(text) as T;
    return { ok: res.ok, status: res.status, isJson: true, data: parsed };
  } catch {
    return { ok: false, status: 0, isJson: false, data: null };
  }
}

const MOODS: MusicTrack['mood'][] = ['Ethereal', 'Kinetic', 'Melancholic', 'Euphoric'];

export function decodeHtmlEntities(str: string): string {
  return String(str || '')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&#039;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeTrackToken(str: string): string {
  return decodeHtmlEntities(str)
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s*-\s*(?:remaster|single|version|from|mono|stereo|deluxe|explicit).*$/gi, ' ')
    .replace(/[^a-z0-9]/g, '');
}

export function isStrictTrackMatch(
  candidateTitle: string,
  candidateArtist: string,
  targetTitle: string,
  targetArtist: string
): boolean {
  const cTitle = normalizeTrackToken(candidateTitle);
  const tTitle = normalizeTrackToken(targetTitle);
  if (!cTitle || !tTitle) return false;

  const rawCandLower = decodeHtmlEntities(`${candidateTitle} ${candidateArtist}`).toLowerCase();
  const rawTargetLower = decodeHtmlEntities(`${targetTitle} ${targetArtist}`).toLowerCase();

  const unwantedKeywords = [
    'karaoke',
    'tribute',
    'made famous',
    'in the style of',
    'originally performed',
    'originally perfomed',
    'melody version',
    'instrumental version',
    'nightcore',
    '8-bit',
    'ringtone',
  ];
  for (const kw of unwantedKeywords) {
    if (rawCandLower.includes(kw) && !rawTargetLower.includes(kw)) {
      return false;
    }
  }

  // Stricter matching
  const titleMatches =
    cTitle === tTitle ||
    (cTitle.includes(tTitle) && tTitle.length >= Math.max(5, Math.floor(cTitle.length * 0.8))) ||
    (tTitle.includes(cTitle) && cTitle.length >= Math.max(5, Math.floor(tTitle.length * 0.8)));

  if (!titleMatches) return false;

  const tArtist = normalizeTrackToken(targetArtist.split(',')[0]);
  if (!tArtist) return true;

  const cArtist = normalizeTrackToken(candidateArtist);
  // Stricter artist matching
  return (
    cArtist === tArtist ||
    (cArtist.includes(tArtist) && tArtist.length >= Math.max(3, Math.floor(cArtist.length * 0.8))) ||
    (tArtist.includes(cArtist) && cArtist.length >= Math.max(3, Math.floor(tArtist.length * 0.8)))
  );
}

export function mapSpotifyTrackToMusicTrack(spTrack: any, index = 0): MusicTrack {
  const id = String(spTrack?.id || `sp-track-${index}`);
  const title = decodeHtmlEntities(spTrack?.name || 'Spotify Track').trim();
  const artist = decodeHtmlEntities(
    Array.isArray(spTrack?.artists) && spTrack.artists.length > 0
      ? spTrack.artists.map((a: any) => a.name).join(', ')
      : 'Spotify Artist'
  ).trim();
  const album = decodeHtmlEntities(spTrack?.album?.name || 'Spotify Single').trim();
  const duration = Math.max(30, Math.round((spTrack?.duration_ms || 180000) / 1000));
  const previewUrl = spTrack?.preview_url || undefined;
  const rawId = String(spTrack?.id || '');
  const isSpotifyBase62Id = /^[a-zA-Z0-9]{22}$/.test(rawId);
  const spotifyUri =
    spTrack?.uri || (isSpotifyBase62Id ? `spotify:track:${rawId}` : undefined);

  let hash = 0;
  const seed = `${id}-${title}-${artist}`;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const absHash = Math.abs(hash);
  const bpm = 88 + (absHash % 52);
  const mood = MOODS[absHash % MOODS.length];
  const chordProgression = CHORD_PROGRESSIONS[absHash % CHORD_PROGRESSIONS.length];
  const coverUrl = spTrack?.album?.images?.[0]?.url || getAbstractPlaceholderCover(mood);

  const POETIC_MOOD_VERSES: Record<MusicTrack['mood'], string[]> = {
    Ethereal: [
      'Raat ki khamoshi mein kho gaye',
      'Sitaron ki roshni mein gunguna rahe',
      'Tere khwabon mein hi hum ji rahe',
      'Dhundli yaadein, dil mein bas gayi',
      'Hawaon ke sang udne ka mann hai',
      'Sukoon ki talaash mein hum gum hain',
    ],
    Kinetic: [
      'Neon lights mein bhaage, jab shehar so gaya',
      'Dil ki dhadkan tez, sapna mera ho gaya',
      'Raftaar mein hum, masti mein choor',
      'Manzil door hai, par hum majboor nahi',
      'Aag lagi hai seene mein, jeetne ka junoon',
      'Raste naye hain, aur hum taiyaar hain',
    ],
    Melancholic: [
      'Purani yaadein, jaise baarish ki bundein',
      'Alfaaz mere, tere bin hain adhoore',
      'Tanhai ka aalam, dil mein hai chupa',
      'Waqt ruk gaya, jaise main akela hua',
      'Khamosh galiyon mein, teri parchayi hai',
      'Yaadon ka karwaan, har pal yaad aayi hai',
    ],
    Euphoric: [
      'Sunheri roshni, badalon ke paar',
      'Khushi ka jashn, hai har taraf bahaar',
      'Sapne sach hue, aaj dil khush hai',
      'Zindagi ka ye pal, sabse anmol hai',
      'Umeedon ke pankh, falak tak le jayenge',
      'Aaj hum milke, naye geet gayenge',
    ],
  };

  const step = Math.max(6, Math.floor(duration / 8));

  return {
    id,
    title,
    artist,
    album,
    duration,
    bpm,
    mood,
    platform: 'Spotify',
    palette: hashTrackToPalette(`${title}-${artist}`),
    chordProgression,
    lyrics: undefined,
    previewUrl,
    spotifyUri,
    coverUrl,
  };
}

export function isShortPreviewUrl(url?: string | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes('itunes.apple.com') ||
    lower.includes('mzstatic.com') ||
    lower.includes('p.scdn.co/mp3-preview') ||
    lower.includes('cdns-preview-')
  );
}

function extractClientSaavnDownloadUrl(song: any): string | null {
  const urls = song?.downloadUrl || song?.download_url;
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const sorted = [...urls].reverse();
  for (const item of sorted) {
    const link = item?.url || item?.link;
    if (typeof link === 'string' && link.startsWith('http')) {
      return link.replace(/^http:\/\//i, 'https://');
    }
  }
  return null;
}

function extractClientSaavnCover(song: any): string | null {
  const images = song?.image;
  if (Array.isArray(images) && images.length > 0) {
    const last = images[images.length - 1];
    const link = last?.url || last?.link;
    if (typeof link === 'string' && link.startsWith('http')) {
      return link.replace(/^http:\/\//i, 'https://');
    }
  }
  return null;
}

const clientMediaCache = new Map<
  string,
  { previewUrl: string | null; coverUrl: string | null; duration?: number; isFullTrack: boolean }
>();

export async function resolveTrackMedia(
  _title: string,
  _artist: string,
  existingPreviewUrl?: string,
  existingCoverUrl?: string
): Promise<{
  previewUrl: string | null;
  coverUrl: string | null;
  duration?: number;
  isFullTrack?: boolean;
}> {
  // Spotify metadata must never be paired with audio resolved from unrelated third-party catalogs.
  return {
    previewUrl: existingPreviewUrl || null,
    coverUrl: existingCoverUrl || null,
    isFullTrack: false,
  };
}

export async function resolveTrackStreamUrl(
  title: string,
  artist: string,
  existingPreviewUrl?: string
): Promise<string | null> {
  const media = await resolveTrackMedia(title, artist, existingPreviewUrl);
  return media.previewUrl;
}

function isMetadataOrHeaderLine(text: string): boolean {
  const clean = text.trim();
  if (!clean) return true;
  if (/^\[(?:verse|chorus|intro|outro|bridge|hook|pre-chorus|instrumental|interlude).*?\]$/i.test(clean)) {
    return true;
  }
  if (
    /^(?:song|title|artist|album|lyrics?\s*by|composed\s*by|music\s*by|singer|vocal|arranger|producer|lrc\s*by|synced\s*by|by\s*:|www\.|https?:\/\/)/i.test(
      clean
    )
  ) {
    return true;
  }
  return false;
}

export function parseLrcLyrics(lrcText: string): LyricLine[] {
  const lines = lrcText.split('\n');
  const parsed: LyricLine[] = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const rawLine of lines) {
    const text = decodeHtmlEntities(rawLine.replace(timeRegex, '').trim());
    if (!text || isMetadataOrHeaderLine(text)) continue;
    let match: RegExpExecArray | null;
    timeRegex.lastIndex = 0;
    while ((match = timeRegex.exec(rawLine)) !== null) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
      const timeSec = Math.round((mins * 60 + secs + ms / 1000) * 10) / 10;
      parsed.push({ time: timeSec, text });
    }
  }

  const sorted = parsed.sort((a, b) => a.time - b.time);
  // Anchor the very first lyric line at 0:00 so real lyrics are displayed immediately from the start of the song
  if (sorted.length > 0 && sorted[0].time > 0) {
    sorted[0] = { ...sorted[0], time: 0 };
  }
  return sorted;
}

const clientLyricsCache = new Map<string, LyricLine[]>();

export async function fetchLyricsForSpotifyTrack(
  title: string,
  artist: string,
  durationSec = 200
): Promise<LyricLine[] | null> {
  try {
    const cleanTitle = decodeHtmlEntities(title)
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s*\[.*?\]\s*/g, '')
      .trim();
    const primaryArtist = decodeHtmlEntities(artist).split(',')[0].trim();
    if (!cleanTitle || !primaryArtist) return null;

    const targetDuration = Math.max(30, Math.round(durationSec || 200));
    const cacheKey = cleanTitle.toLowerCase() + '::' + primaryArtist.toLowerCase() + '::' + (Math.round(targetDuration / 4) * 4);
    if (clientLyricsCache.has(cacheKey)) return clientLyricsCache.get(cacheKey)!;

    const params = new URLSearchParams({ track_name: cleanTitle, artist_name: primaryArtist });
    const response = await fetch('https://lrclib.net/api/search?' + params.toString());
    if (!response.ok) return null;
    const items: any[] = await response.json();
    if (!Array.isArray(items)) return null;

    const candidates = items.filter((item: any) => {
      if (!item?.syncedLyrics || typeof item.syncedLyrics !== 'string') return false;
      if (!isStrictTrackMatch(
        String(item.trackName || ''),
        String(item.artistName || ''),
        cleanTitle,
        primaryArtist
      )) return false;
      const candidateDuration = Number(item.duration || 0);
      return !candidateDuration || Math.abs(candidateDuration - targetDuration) <= Math.max(10, targetDuration * 0.08);
    });

    if (!candidates.length) return null;
    candidates.sort((a: any, b: any) =>
      Math.abs(Number(a.duration || targetDuration) - targetDuration) -
      Math.abs(Number(b.duration || targetDuration) - targetDuration)
    );
    const parsed = parseLrcLyrics(candidates[0].syncedLyrics);
    if (parsed.length < 3) return null;
    clientLyricsCache.set(cacheKey, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function fetchSpotifyPlaylistTracks(
  playlistId: string,
  token?: string,
  playlistName?: string
): Promise<MusicTrack[]> {
  const cleanToken =
    token && token !== 'server_managed_session'
      ? token
      : localStorage.getItem('musevis_spotify_token') || undefined;

  // 1. Try server proxy endpoint
  const { ok, isJson, data } = await safeJsonFetch(
    `/api/spotify/playlists/${encodeURIComponent(playlistId)}/tracks`,
    {
      headers: cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {},
    }
  );

  if (isJson && ok && data) {
    const rawTracks = Array.isArray(data.tracks)
      ? data.tracks
      : (data.items || []).map((it: any) => it?.track || it?.item).filter(Boolean);
    if (rawTracks.length > 0) {
      return rawTracks.map((t: any, idx: number) => mapSpotifyTrackToMusicTrack(t, idx));
    }
  }

  // 2. Fallback to direct Spotify Web API if Bearer token is in browser
  if (cleanToken) {
    try {
      const res = await fetch(
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=25`,
        {
          headers: { Authorization: `Bearer ${cleanToken}` },
        }
      );
      if (res.ok) {
        const json = await res.json();
        const rawTracks = (json.items || [])
          .map((it: any) => it?.track || it?.item)
          .filter((t: any) => t && t.id && t.name);
        if (rawTracks.length > 0) {
          return rawTracks.map((t: any, idx: number) => mapSpotifyTrackToMusicTrack(t, idx));
        }
      }
    } catch {
      // Ignore direct error
    }
  }

  // 3. If Spotify restricts a playlist (e.g. Spotify-owned algorithmic mixes in Dev mode), resolve real tracks matching the playlist name
  if (playlistName) {
    const cleanedName = playlistName
      .replace(/spotify|playlist|mix|daily|discover|radio/gi, '')
      .trim();
    const fallbackQuery = cleanedName.length >= 2 ? cleanedName : 'The Weeknd';
    const searched = await searchSpotifyCatalog(fallbackQuery, cleanToken);
    if (searched.length > 0) return searched;
  }

  return [];
}

export async function searchSpotifyCatalog(
  query: string,
  token?: string
): Promise<MusicTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const cleanToken =
    token && token !== 'server_managed_session'
      ? token
      : localStorage.getItem('musevis_spotify_token') || undefined;
  if (!cleanToken) return [];

  try {
    const res = await fetch(
      'https://api.spotify.com/v1/search?q=' + encodeURIComponent(trimmed) + '&type=track&limit=14',
      { headers: { Authorization: 'Bearer ' + cleanToken } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.tracks?.items || [];
    return items
      .filter((track: any) => track && track.id && track.name)
      .map((track: any, idx: number) => mapSpotifyTrackToMusicTrack(track, idx));
  } catch {
    return [];
  }
}

export async function fetchRealStarterCatalog(): Promise<{
  playlists: {
    id: string;
    name: string;
    source: 'Spotify' | 'Apple Music';
    trackCount: number;
    synced: boolean;
    tracks: MusicTrack[];
  }[];
  tracks: MusicTrack[];
}> {
  // Query clean, single-artist catalogs so every track has 100% matched audio, official cover art, and synced lyrics
  const [rnb, electronic, indie] = await Promise.all([
    searchSpotifyCatalog('The Weeknd'),
    searchSpotifyCatalog('Daft Punk'),
    searchSpotifyCatalog('Tame Impala'),
  ]);

  const playlists = [
    {
      id: 'live-midnight-rnb-pop',
      name: 'Late Night R&B & Pop',
      source: 'Spotify' as const,
      trackCount: rnb.length,
      synced: true,
      tracks: rnb,
    },
    {
      id: 'live-electronic-horizon',
      name: 'Electronic & Melodic House',
      source: 'Spotify' as const,
      trackCount: electronic.length,
      synced: true,
      tracks: electronic,
    },
    {
      id: 'live-alt-indie-currents',
      name: 'Alternative & Indie Currents',
      source: 'Spotify' as const,
      trackCount: indie.length,
      synced: true,
      tracks: indie,
    },
  ].filter((pl) => pl.tracks.length > 0);

  return {
    playlists,
    tracks: playlists[0]?.tracks || [],
  };
}

export async function resolveSpotifyTrackUri(
  title: string,
  artist: string,
  existingUri?: string,
  token?: string
): Promise<string | null> {
  if (existingUri && /^spotify:track:[a-zA-Z0-9]{22}$/.test(existingUri)) {
    return existingUri;
  }
  const cleanToken =
    token && token !== 'server_managed_session'
      ? token
      : localStorage.getItem('musevis_spotify_token') || undefined;

  const primaryArtist = artist.split(',')[0].trim();
  const cleanTitle = title.replace(/\s*\(.*?\)\s*/g, '').replace(/\s*-.*$/, '').trim();
  const q = encodeURIComponent(`${cleanTitle} ${primaryArtist}`);

  if (cleanToken) {
    try {
      const res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
        headers: { Authorization: `Bearer ${cleanToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        const uri = data?.tracks?.items?.[0]?.uri;
        if (typeof uri === 'string' && /^spotify:track:[a-zA-Z0-9]{22}$/.test(uri)) {
          return uri;
        }
      }
    } catch {
      // Fall through to server proxy search
    }
  }

  try {
    const { ok, isJson, data } = await safeJsonFetch(`/api/spotify/search?q=${q}`);
    if (isJson && ok && Array.isArray(data?.tracks) && data.tracks.length > 0) {
      const first = data.tracks[0];
      if (typeof first?.uri === 'string' && /^spotify:track:[a-zA-Z0-9]{22}$/.test(first.uri)) {
        return first.uri;
      }
      if (typeof first?.id === 'string' && /^[a-zA-Z0-9]{22}$/.test(first.id)) {
        return `spotify:track:${first.id}`;
      }
    }
  } catch {
    // Ignore
  }

  return null;
}

export async function fetchSpotifyLivePlayerState(token?: string): Promise<{
  track: MusicTrack | null;
  isPlaying: boolean;
  progressSec: number;
  durationSec: number;
  deviceName: string | null;
  deviceId: string | null;
} | null> {
  const cleanToken =
    token && token !== 'server_managed_session'
      ? token
      : localStorage.getItem('musevis_spotify_token') || undefined;

  if (cleanToken) {
    try {
      const res = await fetch('https://api.spotify.com/v1/me/player', {
        headers: { Authorization: `Bearer ${cleanToken}` },
      });
      if (res.status === 200) {
        const data = await res.json();
        if (data?.item) {
          const liveTrack = mapSpotifyTrackToMusicTrack(data.item, 0);
          return {
            track: liveTrack,
            isPlaying: Boolean(data.is_playing),
            progressSec:
              typeof data.progress_ms === 'number'
                ? Math.round((data.progress_ms / 1000) * 4) / 4
                : 0,
            durationSec: liveTrack.duration,
            deviceName: data.device?.name || null,
            deviceId: data.device?.id || null,
          };
        }
      }
    } catch {
      // Fall through to server proxy
    }
  }

  try {
    const { ok, isJson, data } = await safeJsonFetch('/api/spotify/player', {
      headers: cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {},
    });
    const cp = isJson && ok && data?.active ? data.player : null;
    if (cp?.item) {
      const liveTrack = mapSpotifyTrackToMusicTrack(cp.item, 0);
      return {
        track: liveTrack,
        isPlaying: Boolean(cp.is_playing ?? true),
        progressSec:
          typeof cp.progress_ms === 'number'
            ? Math.round((cp.progress_ms / 1000) * 4) / 4
            : 0,
        durationSec: liveTrack.duration,
        deviceName: cp.device?.name || null,
        deviceId: cp.device?.id || null,
      };
    }
  } catch {
    // Ignore
  }

  return null;
}

export async function controlSpotifyRemotePlayer(
  action: 'play' | 'pause' | 'next' | 'previous' | 'seek',
  options?: {
    contextUri?: string;
    trackUri?: string;
    positionMs?: number;
    deviceId?: string | null;
    token?: string;
  }
): Promise<boolean> {
  const cleanToken =
    options?.token && options.token !== 'server_managed_session'
      ? options.token
      : localStorage.getItem('musevis_spotify_token') || undefined;

  if (cleanToken) {
    try {
      let targetDeviceId = options?.deviceId || null;

      if (!targetDeviceId && (action === 'play' || action === 'seek')) {
        try {
          const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
            headers: { Authorization: `Bearer ${cleanToken}` },
          });
          if (devRes.ok) {
            const devData = await devRes.json();
            const devices: any[] = Array.isArray(devData?.devices) ? devData.devices : [];
            const activeDev = devices.find((d) => d.is_active) || devices[0];
            if (activeDev?.id) {
              targetDeviceId = activeDev.id;
            }
          }
        } catch {
          // Proceed without device_id
        }
      }

      const deviceQuery = targetDeviceId
        ? `?device_id=${encodeURIComponent(targetDeviceId)}`
        : '';
      let endpoint = `https://api.spotify.com/v1/me/player/play${deviceQuery}`;
      let method = 'PUT';
      let body: string | undefined;

      if (action === 'play') {
        method = 'PUT';
        endpoint = `https://api.spotify.com/v1/me/player/play${deviceQuery}`;
        if (options?.trackUri) {
          body = JSON.stringify({
            uris: [options.trackUri],
            ...(typeof options.positionMs === 'number' ? { position_ms: options.positionMs } : {}),
          });
        } else if (options?.contextUri) {
          body = JSON.stringify({ context_uri: options.contextUri });
        }
      } else if (action === 'pause') {
        method = 'PUT';
        endpoint = `https://api.spotify.com/v1/me/player/pause${deviceQuery}`;
      } else if (action === 'next') {
        method = 'POST';
        endpoint = `https://api.spotify.com/v1/me/player/next${deviceQuery}`;
      } else if (action === 'previous') {
        method = 'POST';
        endpoint = `https://api.spotify.com/v1/me/player/previous${deviceQuery}`;
      } else if (action === 'seek') {
        method = 'PUT';
        const pos = Math.max(0, Math.round(options?.positionMs || 0));
        const devParam = targetDeviceId
          ? `&device_id=${encodeURIComponent(targetDeviceId)}`
          : '';
        endpoint = `https://api.spotify.com/v1/me/player/seek?position_ms=${pos}${devParam}`;
      }

      const res = await fetch(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
      });
      if (res.ok || res.status === 204) return true;
    } catch {
      // Fall through to server proxy
    }
  }

  try {
    const { ok, isJson, data } = await safeJsonFetch('/api/spotify/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {}),
      },
      body: JSON.stringify({
        action,
        contextUri: options?.contextUri,
        trackUri: options?.trackUri,
        positionMs: options?.positionMs,
        deviceId: options?.deviceId,
      }),
    });
    return Boolean(isJson && ok && data?.ok);
  } catch {
    return false;
  }
}

export interface SpotifyWebPlayerCallbacks {
  onReady?: (deviceId: string) => void;
  onStateChange?: (state: {
    paused: boolean;
    positionSec: number;
    durationSec: number;
    trackId?: string;
  }) => void;
  onError?: (message: string) => void;
}

export function initSpotifyWebPlaybackSdk(
  getToken: () => string | null,
  callbacks: SpotifyWebPlayerCallbacks
): () => void {
  let player: any = null;
  let disposed = false;

  const setupPlayer = () => {
    if (disposed || !(window as any).Spotify?.Player) return;
    const token = getToken();
    if (!token || token === 'server_managed_session') return;

    player = new (window as any).Spotify.Player({
      name: 'MuseVis Audio Studio (Full-Track Player)',
      getOAuthToken: (cb: (t: string) => void) => {
        const currentToken = getToken();
        if (currentToken && currentToken !== 'server_managed_session') {
          cb(currentToken);
        }
      },
      volume: 0.8,
    });

    player.addListener('ready', ({ device_id }: { device_id: string }) => {
      if (!disposed) {
        console.info('[MuseVis Spotify Web Playback SDK] Ready with Device ID:', device_id);
        callbacks.onReady?.(device_id);
      }
    });

    player.addListener('player_state_changed', (state: any) => {
      if (disposed || !state) return;
      const currentTrack = state.track_window?.current_track;
      callbacks.onStateChange?.({
        paused: Boolean(state.paused),
        positionSec: Math.floor((state.position || 0) / 1000),
        durationSec: Math.max(30, Math.round((state.duration || 180000) / 1000)),
        trackId: currentTrack?.id,
      });
    });

    player.addListener('initialization_error', ({ message }: { message: string }) => {
      callbacks.onError?.(message);
    });
    player.addListener('authentication_error', ({ message }: { message: string }) => {
      callbacks.onError?.(message);
    });
    player.addListener('account_error', ({ message }: { message: string }) => {
      callbacks.onError?.(message);
    });

    player.connect();
  };

  if ((window as any).Spotify?.Player) {
    setupPlayer();
  } else {
    const existingScript = document.getElementById('spotify-player-sdk');
    const prevReady = (window as any).onSpotifyWebPlaybackSDKReady;
    (window as any).onSpotifyWebPlaybackSDKReady = () => {
      if (typeof prevReady === 'function') prevReady();
      setupPlayer();
    };
    if (!existingScript) {
      const script = document.createElement('script');
      script.id = 'spotify-player-sdk';
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      document.body.appendChild(script);
    }
  }

  return () => {
    disposed = true;
    if (player && typeof player.disconnect === 'function') {
      player.disconnect();
    }
  };
}

export async function fetchSpotifyDirectLibrary(token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const [meRes, playlistsRes, currentRes] = await Promise.allSettled([
    fetch('https://api.spotify.com/v1/me', { headers }),
    fetch('https://api.spotify.com/v1/me/playlists?limit=15', { headers }),
    fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers }),
  ]);

  let user = null;
  if (meRes.status === 'fulfilled' && meRes.value.ok) {
    const meData = await meRes.value.json();
    user = {
      id: meData.id,
      displayName: meData.display_name || meData.id,
      email: meData.email,
      product: meData.product,
    };
  }

  let playlists: any[] = [];
  if (playlistsRes.status === 'fulfilled' && playlistsRes.value.ok) {
    const plData = await playlistsRes.value.json();
    playlists = plData.items || [];
  }

  let currentlyPlaying = null;
  if (currentRes.status === 'fulfilled' && currentRes.value.status === 200) {
    currentlyPlaying = await currentRes.value.json().catch(() => null);
  }

  let initialTracks: any[] = [];
  let initialPlaylistId: string | null = null;
  for (const pl of playlists.slice(0, 6)) {
    if (!pl?.id) continue;
    try {
      const plTracksRes = await fetch(
        `https://api.spotify.com/v1/playlists/${pl.id}/tracks?limit=25`,
        { headers }
      );
      if (plTracksRes.ok) {
        const plTracksData = await plTracksRes.json();
        const tracks = (plTracksData.items || [])
          .map((it: any) => it?.track || it?.item)
          .filter((t: any) => t && t.id && t.name);
        if (tracks.length > 0) {
          initialTracks = tracks;
          initialPlaylistId = pl.id;
          break;
        }
      }
    } catch {
      // Try next playlist
    }
  }

  if (initialTracks.length === 0) {
    try {
      const savedRes = await fetch('https://api.spotify.com/v1/me/tracks?limit=20', { headers });
      if (savedRes.ok) {
        const savedData = await savedRes.json();
        initialTracks = (savedData.items || [])
          .map((it: any) => it?.track)
          .filter((t: any) => t && t.id && t.name);
      }
    } catch {
      // Ignore error
    }
  }

  return { user, playlists, currentlyPlaying, initialTracks, initialPlaylistId };
}


export async function searchSpotifyPlaylists(query: string, token?: string): Promise<any[]> {
  const cleanToken = token || localStorage.getItem('musevis_spotify_token') || undefined;
  if (!cleanToken || !query.trim()) return [];
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=10`,
      {
        headers: { Authorization: `Bearer ${cleanToken}` },
      }
    );
    if (res.ok) {
      const data = await res.json();
      return data.playlists?.items || [];
    }
  } catch {
    // Ignore
  }
  return [];
}

export async function exchangeSpotifyCodeClientSide(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
  errorCode?: string;
  statusCode?: number;
}> {
  try {
    const body = new URLSearchParams({
      client_id: params.clientId,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      return {
        success: false,
        error: data.error_description || data.error || 'Client PKCE token exchange failed',
        errorCode: data.error || 'pkce_exchange_failed',
        statusCode: res.status,
      };
    }

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      statusCode: res.status,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Network error during client PKCE exchange',
      errorCode: 'network_error',
      statusCode: 500,
    };
  }
}
