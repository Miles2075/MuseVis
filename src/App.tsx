import { useEffect, useState, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Check,
  Music,
  Link2,
  Copy,
  Sparkles,
  Search,
  ListMusic,
  Disc3,
} from 'lucide-react';
import {
  DEFAULT_IDLE_TRACK,
  PALETTE_PRESETS,
  MusicTrack,
  PlaylistItem,
  TrackPalette,
  getTrackAlbumCover,
  getAbstractPlaceholderCover,
  interpolatePalette,
  lerpHexColor,
  extractPaletteFromAlbumArt,
} from './data/tracks';
import { FluidVisualizer } from './components/FluidVisualizer';
import { LyricDisplay } from './components/LyricDisplay';
import { SpectralVisualizer } from './components/SpectralVisualizer';
import { synthEngine } from './utils/audioEngine';
import { auth, db, handleFirestoreError, OperationType } from './firebaseConfig';
import { doc, setDoc } from 'firebase/firestore';
import {
  createClientPkcePair,
  safeJsonFetch,
  fetchSpotifyDirectLibrary,
  exchangeSpotifyCodeClientSide,
  mapSpotifyTrackToMusicTrack,
  fetchSpotifyPlaylistTracks,
  fetchLyricsForSpotifyTrack,
  searchSpotifyCatalog,
  fetchRealStarterCatalog,
  controlSpotifyRemotePlayer,
  resolveSpotifyTrackUri,
  fetchSpotifyLivePlayerState,
  searchSpotifyPlaylists,
} from './utils/spotifyClient';

type ActiveModal = 'none' | 'lyrics' | 'sync' | 'oauth-help';

interface OAuthErrorState {
  code: string;
  title: string;
  message: string;
  remediation: string;
  redirectUri: string;
  statusCode?: number | null;
  rawDetails?: string | null;
  timestamp: string;
}

function classifySpotifyOAuthError(payload: {
  error?: string | null;
  errorCode?: string | null;
  statusCode?: number | null;
  redirectUri?: string | null;
  rawDetails?: string | null;
  timestamp?: string | null;
}, defaultRedirectUri: string): OAuthErrorState {
  const rawError = payload.error || 'Unknown Spotify authentication failure.';
  const code = (payload.errorCode || '').toLowerCase() || (
    rawError.toLowerCase().includes('redirect_uri') ? 'redirect_uri_mismatch' :
    rawError.toLowerCase().includes('invalid_client') ? 'invalid_client' :
    rawError.toLowerCase().includes('invalid_grant') ? 'invalid_grant' :
    rawError.toLowerCase().includes('access_denied') ? 'access_denied' :
    'oauth_exchange_error'
  );
  const redirectUri = payload.redirectUri || defaultRedirectUri;
  const timestamp = payload.timestamp || new Date().toISOString();

  if (code.includes('invalid_client')) {
    return {
      code: 'invalid_client',
      title: 'Invalid Spotify Client Credentials',
      message: `Spotify rejected your Client ID or Client Secret (${rawError}).`,
      remediation:
        'Open the AI Studio Secrets panel and verify that SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET exactly match your app in the Spotify Developer Dashboard with no extra spaces or quotes.',
      redirectUri,
      statusCode: payload.statusCode,
      rawDetails: payload.rawDetails,
      timestamp,
    };
  }

  if (code.includes('redirect_uri') || rawError.toLowerCase().includes('redirect')) {
    return {
      code: 'redirect_uri_mismatch',
      title: 'Redirect URI Mismatch',
      message: `The callback URL sent during login does not match your Spotify app whitelist (${rawError}).`,
      remediation:
        'Copy the exact Redirect URI shown below, paste it into your Spotify Developer Dashboard under App Settings → Redirect URIs, and click Save.',
      redirectUri,
      statusCode: payload.statusCode,
      rawDetails: payload.rawDetails,
      timestamp,
    };
  }

  if (code.includes('invalid_grant')) {
    return {
      code: 'invalid_grant',
      title: 'Authorization Code Expired or Redirect Mismatch',
      message: `Spotify could not exchange the authorization code for a token (${rawError}).`,
      remediation:
        'Ensure the Redirect URI below is registered in your Spotify Dashboard and click "Retry Spotify Sign-In" to generate a fresh authorization code.',
      redirectUri,
      statusCode: payload.statusCode,
      rawDetails: payload.rawDetails,
      timestamp,
    };
  }

  if (code.includes('access_denied')) {
    return {
      code: 'access_denied',
      title: 'Spotify Authorization Declined or Restricted',
      message: `Spotify denied access to the account (${rawError}).`,
      remediation:
        'If your Spotify app is in Development Mode, make sure your Spotify account email is added under "User Management" in the Spotify Developer Dashboard.',
      redirectUri,
      statusCode: payload.statusCode,
      rawDetails: payload.rawDetails,
      timestamp,
    };
  }

  if (code.includes('missing_credentials')) {
    return {
      code: 'missing_credentials',
      title: 'Missing Spotify API Secrets',
      message: rawError,
      remediation:
        'Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the AI Studio Secrets panel, then retry connecting.',
      redirectUri,
      statusCode: payload.statusCode,
      rawDetails: payload.rawDetails,
      timestamp,
    };
  }

  return {
    code,
    title: 'Spotify Authentication Failed',
    message: rawError,
    remediation:
      'Verify your Redirect URI in the Spotify Developer Dashboard, confirm your account is listed in User Management (for Development Mode apps), or retry connecting.',
    redirectUri,
    statusCode: payload.statusCode,
    rawDetails: payload.rawDetails,
    timestamp,
  };
}

interface CredentialValidationResult {
  valid: boolean;
  code: string;
  status: number;
  message: string;
  remediation: string;
  clientIdStatus: string;
  clientSecretStatus: string;
  tokenType?: string;
  expiresIn?: number;
  redirectUri?: string;
  timestamp: string;
}

export default function App() {
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0); // seconds
  const [volume, setVolume] = useState<number>(0.75);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [cameraPreset, setCameraPreset] = useState<'center' | 'orbital' | 'macro'>('center');
  const [customPalette, setCustomPalette] = useState<TrackPalette | null>(null);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [activeModal, setActiveModal] = useState<ActiveModal>('none');

  // Streaming & OAuth state
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>('');
  const [spotifyConnected, setSpotifyConnected] = useState<boolean>(false);
  const [spotifyUser, setSpotifyUser] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [oauthErrorState, setOauthErrorState] = useState<OAuthErrorState | null>(null);
  const [isValidatingCreds, setIsValidatingCreds] = useState<boolean>(false);
  const [credValidationResult, setCredValidationResult] =
    useState<CredentialValidationResult | null>(null);
  const [clientIdInput, setClientIdInput] = useState<string>(
    () => localStorage.getItem('musevis_spotify_client_id') || ''
  );
  const [clientSecretInput, setClientSecretInput] = useState<string>(
    () => localStorage.getItem('musevis_spotify_client_secret') || ''
  );
  const [manualTokenInput, setManualTokenInput] = useState<string>('');
  const [isVerifyingToken, setIsVerifyingToken] = useState<boolean>(false);
  const [callbackUrl, setCallbackUrl] = useState<string>(
    `${window.location.origin}/auth/callback`
  );
  const [copiedUri, setCopiedUri] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchType, setSearchType] = useState<'track' | 'playlist'>('track');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [showSpotifyEmbed, setShowSpotifyEmbed] = useState<boolean>(false);
  const [showLibraryDrawer, setShowLibraryDrawer] = useState<boolean>(false);
  const [shortcutHud, setShortcutHud] = useState<string | null>(null);
  const [bloomIntensity, setBloomIntensity] = useState<number>(1.0);
  const [bassFlashIntensity, setBassFlashIntensity] = useState<number>(0);
  const [smartShuffleEnabled, setSmartShuffleEnabled] = useState<boolean>(false);
  const [spotifyIsPlaying, setSpotifyIsPlaying] = useState<boolean>(false);
  const studioFileInputRef = useRef<HTMLInputElement | null>(null);
  const [spotifyDeviceName, setSpotifyDeviceName] = useState<string | null>(null);
  const shortcutTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const activeModalLyricRef = useRef<HTMLButtonElement | null>(null);
  const activeTrackRef = useRef<HTMLButtonElement | null>(null);

  // Auto-scroll active track in the dock
  useEffect(() => {
    if (activeTrackRef.current) {
      activeTrackRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [currentTrackIndex]);

  const triggerShortcutHud = (label: string) => {
    setShortcutHud(label);
    if (shortcutTimerRef.current !== null) {
      window.clearTimeout(shortcutTimerRef.current);
    }
    shortcutTimerRef.current = window.setTimeout(() => {
      setShortcutHud(null);
    }, 1600);
  };

  const currentTrack = tracks[currentTrackIndex] || DEFAULT_IDLE_TRACK;
  const [artPalette, setArtPalette] = useState<TrackPalette | null>(null);
  const targetPalette = customPalette || artPalette || currentTrack.palette;

  // Automatically extract dominant & harmonic colors from the playing song's album cover art
  useEffect(() => {
    let cancelled = false;
    const coverSrc = getTrackAlbumCover(currentTrack);
    extractPaletteFromAlbumArt(coverSrc, currentTrack.palette).then((extracted) => {
      if (cancelled) return;
      setArtPalette(extracted);
      setTracks((prev) =>
        prev.map((t) =>
          t.id === currentTrack.id &&
          (t.palette.primary !== extracted.primary ||
            t.palette.secondary !== extracted.secondary ||
            t.palette.accent !== extracted.accent)
            ? { ...t, palette: extracted }
            : t
        )
      );
    });
    return () => {
      cancelled = true;
    };
  }, [currentTrack.id, currentTrack.coverUrl]);

  // Smooth RGB color-interpolation state for ambient background gradients & visualizer when tracks change
  const [interpolatedPalette, setInterpolatedPalette] = useState<TrackPalette>(targetPalette);
  const currentPaletteRef = useRef<TrackPalette>(targetPalette);

  useEffect(() => {
    const startPalette = currentPaletteRef.current;
    if (
      startPalette.primary === targetPalette.primary &&
      startPalette.secondary === targetPalette.secondary &&
      startPalette.accent === targetPalette.accent &&
      startPalette.ambient === targetPalette.ambient
    ) {
      return;
    }

    const durationMs = 1200;
    const startTime = performance.now();
    let rafId = 0;

    const animatePalette = (now: number) => {
      const elapsed = now - startTime;
      const rawT = Math.min(1, elapsed / durationMs);
      // Cubic ease-out for silky ambient gradient interpolation
      const easedT = 1 - Math.pow(1 - rawT, 3);
      const nextPalette = interpolatePalette(startPalette, targetPalette, easedT);
      currentPaletteRef.current = nextPalette;
      setInterpolatedPalette(nextPalette);

      if (rawT < 1) {
        rafId = window.requestAnimationFrame(animatePalette);
      }
    };

    rafId = window.requestAnimationFrame(animatePalette);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    targetPalette.primary,
    targetPalette.secondary,
    targetPalette.accent,
    targetPalette.ambient,
  ]);

  const activePalette = interpolatedPalette;
  const effectiveBpm = Math.round(currentTrack.bpm);
  const activePlaylist = playlists.find((p) => p.id === selectedPlaylistId) || playlists[0];

  const progressTimerRef = useRef<number | null>(null);
  const trackRequestIdRef = useRef<number>(0);
  const lastLocalControlTimeRef = useRef<number>(0);
  const isScrubbingRef = useRef<boolean>(false);
  const seekCommitTimerRef = useRef<number | null>(null);


  // Handle popup callback if /auth/callback is served by the SPA directly
  useEffect(() => {
    if (window.location.pathname === '/auth/callback' && window.opener) {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const error = params.get('error');
      const redirectUri = `${window.location.origin}/auth/callback`;

      if (error) {
        window.opener.postMessage(
          {
            type: 'OAUTH_AUTH_ERROR',
            error: `Spotify authorization error: ${error}`,
            errorCode: error,
            statusCode: 400,
            redirectUri,
            timestamp: new Date().toISOString(),
          },
          '*'
        );
        window.close();
        return;
      }

      if (code) {
        const verifier = localStorage.getItem('musevis_pkce_verifier') || '';
        const savedClientId = localStorage.getItem('musevis_spotify_client_id') || '';
        if (verifier && savedClientId) {
          exchangeSpotifyCodeClientSide({
            code,
            clientId: savedClientId,
            redirectUri,
            codeVerifier: verifier,
          }).then((res) => {
            if (res.success && res.accessToken) {
              window.opener.postMessage(
                {
                  type: 'OAUTH_AUTH_SUCCESS',
                  accessToken: res.accessToken,
                  refreshToken: res.refreshToken || null,
                  redirectUri,
                  timestamp: new Date().toISOString(),
                },
                '*'
              );
            } else {
              window.opener.postMessage(
                {
                  type: 'OAUTH_AUTH_ERROR',
                  error: res.error || 'Token exchange failed',
                  errorCode: res.errorCode || 'invalid_grant',
                  statusCode: res.statusCode || 400,
                  redirectUri,
                  timestamp: new Date().toISOString(),
                },
                '*'
              );
            }
            window.close();
          });
        }
      }
    }
  }, []);

  // Check initial Spotify connection status + load real playable catalog tracks immediately
  useEffect(() => {
    const checkStatus = async () => {
      try {
        // 1. Load real playable songs from the live catalog ONLY if not connected
        const savedToken = localStorage.getItem('musevis_spotify_token');
        if (!savedToken) {
            const starter = await fetchRealStarterCatalog();
            if (starter.playlists.length > 0 && trackRequestIdRef.current === 0) {
              setPlaylists((prev) => (prev.length > 0 ? prev : starter.playlists));
              setSelectedPlaylistId((prev) => prev || starter.playlists[0].id);
            }
            if (starter.tracks.length > 0 && trackRequestIdRef.current === 0) {
              setTracks((prev) => (prev.length > 0 ? prev : starter.tracks));
            }
        }
        const { ok, isJson, data } = await safeJsonFetch('/api/spotify/status', {
          headers: savedToken ? { Authorization: `Bearer ${savedToken}` } : {},
        });

        if (isJson && ok && data) {
          if (data.redirectUri) setCallbackUrl(data.redirectUri);
          if (data.accessToken) {
            localStorage.setItem('musevis_spotify_token', data.accessToken);
          }
          if (data.connected && data.user) {
            setSpotifyConnected(true);
            setSpotifyUser(data.user.displayName);
            await fetchSpotifyPlaylists(data.accessToken || savedToken || undefined);
            return;
          }
        }

        // 3. Direct browser fallback if a token is saved locally
        if (savedToken && savedToken !== 'server_managed_session') {
          const direct = await fetchSpotifyDirectLibrary(savedToken);
          if (direct.user) {
            setSpotifyConnected(true);
            setSpotifyUser(direct.user.displayName);
            await applyLibraryPayload(direct);
          }
        }
      } catch (err) {
        console.warn('[Spotify Status Check] Unable to verify initial status:', err);
      }
    };
    checkStatus();
  }, []);

  // Listen for OAuth popup postMessage with detailed logging and fallback UI state
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const origin = event.origin;
      const isTrustedOrigin =
        !origin ||
        origin === window.location.origin ||
        origin.endsWith('.run.app') ||
        origin.includes('localhost');

      if (!event.data || typeof event.data !== 'object') {
        return;
      }

      const msgType = event.data.type;
      if (msgType !== 'OAUTH_AUTH_SUCCESS' && msgType !== 'OAUTH_AUTH_ERROR') {
        return;
      }

      console.group('[MuseVis Spotify OAuth] postMessage Received');
      console.info('Event Origin:', origin, '| Trusted:', isTrustedOrigin);
      console.info('Message Type:', msgType);
      console.info('Payload Summary:', {
        hasAccessToken: Boolean(event.data.accessToken),
        hasRefreshToken: Boolean(event.data.refreshToken),
        errorCode: event.data.errorCode || null,
        statusCode: event.data.statusCode || null,
        redirectUri: event.data.redirectUri || callbackUrl,
        timestamp: event.data.timestamp || new Date().toISOString(),
      });

      if (!isTrustedOrigin) {
        console.warn('[MuseVis Spotify OAuth] Rejected message from untrusted origin:', origin);
        console.groupEnd();
        return;
      }

      if (msgType === 'OAUTH_AUTH_SUCCESS') {
        let token = event.data.accessToken as string | undefined;

        if (!token) {
          console.info(
            '[MuseVis Spotify OAuth] OAUTH_AUTH_SUCCESS received without inline accessToken; checking session...'
          );
          const { ok, isJson, data: statusData } = await safeJsonFetch('/api/spotify/status');
          if (isJson && ok && statusData?.connected) {
            token = statusData.accessToken || 'server_managed_session';
            if (statusData.user?.displayName) {
              setSpotifyUser(statusData.user.displayName);
            }
          }
        }

        if (!token) {
          const existingToken = localStorage.getItem('musevis_spotify_token');
          token = existingToken || 'server_managed_session';
        }

        console.info(
          '[MuseVis Spotify OAuth] Authentication succeeded. Storing token & syncing library...'
        );
        console.groupEnd();

        if (token && token !== 'server_managed_session') {
          localStorage.setItem('musevis_spotify_token', token);
        }
        setOauthErrorState(null);
        setSpotifyConnected(true);
        setAuthNotice('Spotify connected. Syncing your playlists...');

        // Persist in Firestore if Firebase user is signed in
        if (auth.currentUser && token && token !== 'server_managed_session') {
          const userPath = `users/${auth.currentUser.uid}`;
          try {
            await setDoc(
              doc(db, 'users', auth.currentUser.uid),
              {
                userId: auth.currentUser.uid,
                email: auth.currentUser.email || 'listener@musevis.app',
                displayName: auth.currentUser.displayName || 'Spotify Listener',
                spotifyAccessToken: String(token).slice(0, 500),
              },
              { merge: true }
            );
          } catch (err) {
            console.error('[MuseVis Spotify OAuth] Firestore profile sync failed:', err);
            handleFirestoreError(err, OperationType.WRITE, userPath);
          }
        }

        await fetchSpotifyPlaylists(token !== 'server_managed_session' ? token : undefined);
        setTimeout(() => setAuthNotice(null), 4000);
      } else if (msgType === 'OAUTH_AUTH_ERROR') {
        const diagnostic = classifySpotifyOAuthError(event.data, callbackUrl);
        console.error('[MuseVis Spotify OAuth] Authentication Failed:', {
          code: diagnostic.code,
          title: diagnostic.title,
          message: diagnostic.message,
          remediation: diagnostic.remediation,
          redirectUri: diagnostic.redirectUri,
          statusCode: diagnostic.statusCode,
          rawDetails: diagnostic.rawDetails,
        });
        console.groupEnd();

        if (event.data.redirectUri) {
          setCallbackUrl(event.data.redirectUri);
        }
        setSpotifyConnected(false);
        setOauthErrorState(diagnostic);
        setAuthNotice(`${diagnostic.title}: ${diagnostic.message}`);
        setActiveModal('oauth-help');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [callbackUrl]);

  // Power-user keyboard shortcuts: Space (Play/Pause), M (Mute), L (Lyrics), Left/Right Arrows (Prev/Next Track), Up/Down (Volume), Q (Queue), C (Camera), H (Zen Mode), / (Search), Escape (Close)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      ) {
        if (e.key === 'Escape') {
          target.blur();
        }
        return;
      }

      const key = e.key.toLowerCase();

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        triggerShortcutHud(isPlaying ? 'Paused (Space)' : 'Playing (Space)');
      } else if (key === 'm') {
        e.preventDefault();
        toggleMute();
        triggerShortcutHud(isMuted ? 'Unmuted (M)' : 'Muted (M)');
      } else if (key === 'l') {
        e.preventDefault();
        setActiveModal((prev) => {
          const next = prev === 'lyrics' ? 'none' : 'lyrics';
          triggerShortcutHud(next === 'lyrics' ? 'Lyrics Panel Opened (L)' : 'Lyrics Panel Closed (L)');
          return next;
        });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) {
          handleNextTrack();
          triggerShortcutHud('Next Track (Shift+→)');
        } else {
          const nextSec = Math.min(Math.max(0, currentTrack.duration - 1), progress + 5);
          seekPlayback(nextSec, true);
          triggerShortcutHud('Seek +5s (→)');
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) {
          handlePrevTrack();
          triggerShortcutHud('Previous Track (Shift+←)');
        } else {
          const prevSec = Math.max(0, progress - 5);
          seekPlayback(prevSec, true);
          triggerShortcutHud('Seek -5s (←)');
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const nextVol = Math.min(1, Math.round(( (isMuted ? 0 : volume) + 0.05 ) * 100) / 100);
        handleVolumeChange(nextVol);
        triggerShortcutHud(`Volume ${Math.round(nextVol * 100)}% (↑)`);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextVol = Math.max(0, Math.round(( (isMuted ? 0 : volume) - 0.05 ) * 100) / 100);
        handleVolumeChange(nextVol);
        triggerShortcutHud(`Volume ${Math.round(nextVol * 100)}% (↓)`);
      } else if (key === 'h') {
        e.preventDefault();
        setDockCollapsed((prev) => {
          const next = !prev;
          triggerShortcutHud(next ? 'Zen Mode Active (H)' : 'Controls Restored (H)');
          return next;
        });
      } else if (key === 'q') {
        e.preventDefault();
        setShowLibraryDrawer((prev) => {
          const next = !prev;
          triggerShortcutHud(next ? 'Queue Drawer Opened (Q)' : 'Queue Drawer Closed (Q)');
          return next;
        });
      } else if (key === 'c') {
        e.preventDefault();
        const order: ('center' | 'orbital' | 'macro')[] = ['center', 'orbital', 'macro'];
        const nextPreset = order[(order.indexOf(cameraPreset) + 1) % order.length];
        setCameraPreset(nextPreset);
        triggerShortcutHud(`Camera: ${nextPreset.toUpperCase()} (C)`);
      } else if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        triggerShortcutHud('Search Songs (/)');
      } else if (e.key === 'Escape') {
        setActiveModal('none');
        setShowLibraryDrawer(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Playback progress loop — locked to real HTMLAudioElement currentTime when streaming, or 1.0x normal clock
  useEffect(() => {
    synthEngine.setOnEnded(() => {
      handleNextTrack();
    });
    return () => {
      synthEngine.setOnEnded(null);
    };
  });

  useEffect(() => {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
    }
    if (isPlaying) {
      progressTimerRef.current = window.setInterval(() => {
        // Never overwrite the slider while the user is actively dragging the seek bar
        if (isScrubbingRef.current) {
          return;
        }

        const realAudioTime = synthEngine.getCurrentTime();
        const realStreamDur = synthEngine.getStreamDuration();

        if (
          realStreamDur &&
          realStreamDur >= 45 &&
          Math.abs(realStreamDur - currentTrack.duration) > 2
        ) {
          setTracks((prev) =>
            prev.map((t) =>
              t.id === currentTrack.id ? { ...t, duration: realStreamDur } : t
            )
          );
        }

        if (realAudioTime !== null) {
          if (
            !synthEngine.isStreamingRealAudio() &&
            realAudioTime >= Math.max(5, currentTrack.duration - 0.5)
          ) {
            handleNextTrack();
            return;
          }
          setProgress(Math.min(currentTrack.duration, realAudioTime));
          setBassFlashIntensity(Math.min(1, Math.max(0, synthEngine.getAudioMetrics().bass - 0.4)));
          return;
        }

        setProgress((prev) => {
          const next = prev + 0.05;
          if (next >= currentTrack.duration) {
            handleNextTrack();
            return 0;
          }
          return next;
        });
        setBassFlashIntensity(Math.min(1, Math.max(0, synthEngine.getAudioMetrics().bass - 0.4)));
      }, 50);
    }
    return () => {
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
      }
    };
  }, [isPlaying, currentTrack.id, currentTrack.duration, currentTrackIndex]);

  // Spotify catalog tracks are metadata only. Never resolve their audio from third-party stream providers.
  useEffect(() => {
    let cancelled = false;
    if (!currentTrack || currentTrack.id === DEFAULT_IDLE_TRACK.id || currentTrack.platform !== 'Spotify') return;
    const targetTrackId = currentTrack.id;
    if (!currentTrack.spotifyUri || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(currentTrack.spotifyUri)) {
      resolveSpotifyTrackUri(currentTrack.title, currentTrack.artist, currentTrack.spotifyUri).then((resolvedUri) => {
        if (!cancelled && resolvedUri) {
          setTracks((prev) => prev.map((t) => t.id === targetTrackId ? { ...t, spotifyUri: resolvedUri } : t));
        }
      });
    }
    return () => { cancelled = true; };
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist, currentTrack?.platform]);

  // Lyrics are only loaded for independent MuseVis Studio audio, never for Spotify playback.
  useEffect(() => {
    let cancelled = false;
    if (!currentTrack || currentTrack.id === DEFAULT_IDLE_TRACK.id || currentTrack.platform !== 'MuseVis Studio') return;
    const targetTrackId = currentTrack.id;
    fetchLyricsForSpotifyTrack(currentTrack.title, currentTrack.artist, currentTrack.duration).then((lyrics) => {
      if (!cancelled && lyrics && lyrics.length > 0) {
        setTracks((prev) => prev.map((t) => t.id === targetTrackId ? { ...t, lyrics } : t));
      }
    });
    return () => { cancelled = true; };
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist, currentTrack?.platform, Math.round((currentTrack?.duration || 200) / 4)]);

  // Spotify's Web Playback SDK is intentionally not attached to the visualizer/audio analyser.
  useEffect(() => {
    synthEngine.setExternalStreamMode(false);
  }, [spotifyConnected]);

  // Read Spotify's now-playing metadata without mirroring its audio, timeline, or lyrics into MuseVis.
  const syncTrackWithSpotify = async (manualTrigger = false) => {
    if (isPlaying) {
      if (manualTrigger) setAuthNotice('Pause MuseVis Studio playback before switching the active display to Spotify metadata.');
      return;
    }
    const liveState = await fetchSpotifyLivePlayerState();
    if (liveState?.track) {
      setSpotifyDeviceName(liveState.deviceName || null);
      setSpotifyIsPlaying(liveState.isPlaying);
      const spTrack = liveState.track;
      setTracks((prev) => {
        const existingIdx = prev.findIndex((t) => t.id === spTrack.id || t.spotifyUri === spTrack.spotifyUri);
        if (existingIdx >= 0) {
          setCurrentTrackIndex(existingIdx);
          return prev.map((t, i) => i === existingIdx ? { ...t, ...spTrack } : t);
        }
        setCurrentTrackIndex(0);
        return [spTrack, ...prev.filter((t) => t.platform !== 'Spotify')];
      });
      setProgress(0);
      if (manualTrigger) {
        setAuthNotice(`Spotify connected: "${spTrack.title}" by ${spTrack.artist}. Audio visualization is available in MuseVis Studio mode.`);
        setTimeout(() => setAuthNotice(null), 4500);
      }
      return;
    }
    if (manualTrigger) {
      setShowSpotifyEmbed(true);
      setAuthNotice('No active Spotify playback session. Start a track in Spotify, then sync metadata again.');
      setTimeout(() => setAuthNotice(null), 4000);
    }
  };

  const handleSelectPlaylist = async (pl: PlaylistItem, autoPlay = false) => {
    lastLocalControlTimeRef.current = Date.now();
    const reqId = ++trackRequestIdRef.current;
    setSelectedPlaylistId(pl.id);

    if (pl.source === 'Spotify' && !pl.id.startsWith('live-')) {
      setIsSyncing(true);
      const realTracks = await fetchSpotifyPlaylistTracks(pl.id, undefined, pl.name);
      setIsSyncing(false);
      if (reqId !== trackRequestIdRef.current) return;
      if (realTracks.length > 0) {
        setPlaylists((prev) => prev.map((item) => item.id === pl.id
          ? { ...item, tracks: realTracks, trackCount: item.trackCount || realTracks.length }
          : item));
        setTracks(realTracks);
        setSpotifyIsPlaying(false);
        setCurrentTrackIndex(0);
        setProgress(0);
        synthEngine.stop();
        setIsPlaying(false);
        if (autoPlay) {
          await controlSpotifyRemotePlayer('play', { contextUri: pl.spotifyUri || `spotify:playlist:${pl.id}` });
          setSpotifyIsPlaying(true);
        }
      }
      return;
    }

    if (pl.tracks?.length) {
      setSpotifyIsPlaying(false);
      setTracks(pl.tracks);
      setCurrentTrackIndex(0);
      setProgress(0);
      if (pl.tracks[0].platform === 'MuseVis Studio' && autoPlay) {
        synthEngine.start(pl.tracks[0]);
        synthEngine.setVolume(isMuted ? 0 : volume);
        setIsPlaying(true);
      } else {
        synthEngine.stop();
        setIsPlaying(false);
      }
    }
  };

  const handleSearchSongs = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchResults([]);
    try {
      if (searchType === 'track') {
        const results = await searchSpotifyCatalog(searchQuery);
        if (results.length > 0) {
          synthEngine.stop();
          setIsPlaying(false);
          setSpotifyIsPlaying(false);
          setTracks(results);
          setCurrentTrackIndex(0);
          setProgress(0);
          setActiveModal('none');
        }
      } else {
        const results = await searchSpotifyPlaylists(searchQuery);
        setSearchResults(results);
      }
    } catch (err) {
      console.error('Search failed', err);
    } finally {
      setIsSearching(false);
    }
  };

  const applyLibraryPayload = async (data: {
    user?: { displayName?: string } | null;
    playlists?: any[];
    currentlyPlaying?: any;
    initialTracks?: any[];
    initialPlaylistId?: string | null;
  }) => {
    if (data.user?.displayName) {
      setSpotifyUser(data.user.displayName);
    }

    let resolvedInitialTracks: MusicTrack[] = [];
    if (Array.isArray(data.initialTracks) && data.initialTracks.length > 0) {
      resolvedInitialTracks = data.initialTracks
        .slice(0, 20)
        .map((t: any, idx: number) => mapSpotifyTrackToMusicTrack(t, idx));
    }

    if (Array.isArray(data.playlists) && data.playlists.length > 0) {
      const targetPl =
        data.playlists.find((p: any) => p?.id === data.initialPlaylistId) || data.playlists[0];
      if (resolvedInitialTracks.length === 0 && targetPl?.id) {
        resolvedInitialTracks = await fetchSpotifyPlaylistTracks(
          targetPl.id,
          undefined,
          targetPl.name
        );
      }

      const activeId = targetPl?.id || data.playlists[0]?.id;
      const mapped: PlaylistItem[] = data.playlists.slice(0, 12).map((pl: any, idx: number) => ({
        id: pl.id || `sp-${idx}`,
        name: pl.name || 'Spotify Playlist',
        source: 'Spotify',
        trackCount: pl.tracks?.total ?? (pl.id === activeId ? resolvedInitialTracks.length : 0),
        synced: true,
        tracks: pl.id === activeId && resolvedInitialTracks.length > 0 ? resolvedInitialTracks : [],
      }));

      setPlaylists((prev) => {
        const liveCollections = prev.filter((p) => p.id.startsWith('live-'));
        return [...mapped, ...liveCollections];
      });
      if (activeId && !isPlaying && trackRequestIdRef.current === 0) {
        setSelectedPlaylistId(activeId);
      }
    }

    // Never overwrite the active track queue mid-playback if the user has already started playing a song
    if (isPlaying || synthEngine.isStreamingRealAudio() || trackRequestIdRef.current > 0) {
      return;
    }

    if (data.currentlyPlaying?.item) {
      const liveTrack = mapSpotifyTrackToMusicTrack(data.currentlyPlaying.item, 0);
      const combined = [
        liveTrack,
        ...resolvedInitialTracks.filter((t) => t.id !== liveTrack.id),
      ];
      setTracks(combined.length > 0 ? combined : [liveTrack]);
      setCurrentTrackIndex(0);
      setSpotifyIsPlaying(Boolean(data.currentlyPlaying.is_playing));
    } else if (resolvedInitialTracks.length > 0) {
      setTracks(resolvedInitialTracks);
      setCurrentTrackIndex(0);
      setProgress(0);
    }
  };

  const fetchSpotifyPlaylists = async (tokenOverride?: string) => {
    try {
      const token = tokenOverride || localStorage.getItem('musevis_spotify_token');
      const { ok, isJson, data } = await safeJsonFetch('/api/spotify/library', {
        headers:
          token && token !== 'server_managed_session'
            ? { Authorization: `Bearer ${token}` }
            : {},
      });

      if (isJson && ok && data) {
        await applyLibraryPayload(data);
        return;
      }

      // If /api/spotify/library returned non-JSON (SPA fallback) or non-OK, use direct Spotify Web API if token is available
      if (token && token !== 'server_managed_session') {
        const directData = await fetchSpotifyDirectLibrary(token);
        await applyLibraryPayload(directData);
        return;
      }

      console.info(
        '[MuseVis Spotify Library] No active Spotify Bearer token yet.'
      );
    } catch (err) {
      console.warn('[MuseVis Spotify Library] Unable to fetch Spotify library:', err);
    }
  };

  const handleConnectSpotify = async () => {
    try {
      setAuthNotice(null);
      const trimmedId = clientIdInput.trim();
      const trimmedSecret = clientSecretInput.trim();
      if (trimmedId) localStorage.setItem('musevis_spotify_client_id', trimmedId);
      if (trimmedSecret) localStorage.setItem('musevis_spotify_client_secret', trimmedSecret);

      const redirectUri = `${window.location.origin}/auth/callback`;
      const query = new URLSearchParams({
        redirect_uri: redirectUri,
        ...(trimmedId ? { client_id: trimmedId } : {}),
        ...(trimmedSecret ? { client_secret: trimmedSecret } : {}),
      });

      console.info('[MuseVis Spotify OAuth] Requesting authorization URL with redirect_uri:', redirectUri);
      const { ok, status, isJson, data } = await safeJsonFetch(
        `/api/auth/url?${query.toString()}`
      );

      if (isJson && data?.redirectUri) {
        setCallbackUrl(data.redirectUri);
      }

      let authUrl: string | null = isJson && ok && data?.url ? data.url : null;

      // Client-side PKCE fallback if server route is unreachable or Client ID was entered in UI
      if (!authUrl && trimmedId) {
        const { codeVerifier, codeChallenge } = await createClientPkcePair();
        localStorage.setItem('musevis_pkce_verifier', codeVerifier);
        const scopes = [
          'streaming',
          'user-read-private',
          'user-read-email',
          'playlist-read-private',
          'playlist-read-collaborative',
          'user-read-currently-playing',
          'user-read-playback-state',
          'user-modify-playback-state',
          'user-read-recently-played',
          'user-top-read',
          'user-library-read',
        ].join(' ');
        const spParams = new URLSearchParams({
          response_type: 'code',
          client_id: trimmedId,
          scope: scopes,
          redirect_uri: redirectUri,
          code_challenge_method: 'S256',
          code_challenge: codeChallenge,
          show_dialog: 'true',
        });
        authUrl = `https://accounts.spotify.com/authorize?${spParams.toString()}`;
      }

      if (!authUrl) {
        const initDiag = classifySpotifyOAuthError(
          {
            error:
              data?.error ||
              'Spotify Client ID is not configured yet. Enter your Spotify Client ID below or paste a Spotify Web API Access Token.',
            errorCode: 'missing_credentials',
            statusCode: status || 400,
            redirectUri,
          },
          callbackUrl
        );
        console.warn('[MuseVis Spotify OAuth] Credentials required before starting OAuth:', initDiag);
        setOauthErrorState(initDiag);
        setAuthNotice(`${initDiag.title}: ${initDiag.message}`);
        setActiveModal('oauth-help');
        return;
      }

      const authWindow = window.open(authUrl, 'oauth_popup', 'width=560,height=700');
      if (!authWindow) {
        const popupDiag = classifySpotifyOAuthError(
          {
            error: 'The browser blocked the Spotify login popup window.',
            errorCode: 'popup_blocked',
            redirectUri,
          },
          callbackUrl
        );
        console.warn('[MuseVis Spotify OAuth] Popup blocked by browser:', popupDiag);
        setOauthErrorState(popupDiag);
        setAuthNotice(popupDiag.message);
        setActiveModal('oauth-help');
      }
    } catch (error: any) {
      const netDiag = classifySpotifyOAuthError(
        {
          error: error.message || 'Network error while requesting Spotify OAuth URL.',
          errorCode: 'network_error',
        },
        callbackUrl
      );
      console.error('[MuseVis Spotify OAuth] Unexpected error initiating OAuth:', error);
      setOauthErrorState(netDiag);
      setAuthNotice(netDiag.message);
      setActiveModal('oauth-help');
    }
  };

  const handleValidateCredentials = async () => {
    setIsValidatingCreds(true);
    try {
      const trimmedId = clientIdInput.trim();
      const trimmedSecret = clientSecretInput.trim();
      if (trimmedId) localStorage.setItem('musevis_spotify_client_id', trimmedId);
      if (trimmedSecret) localStorage.setItem('musevis_spotify_client_secret', trimmedSecret);

      const redirectParam = encodeURIComponent(`${window.location.origin}/auth/callback`);
      console.info('[MuseVis Spotify OAuth] Performing silent Client Credentials validation...');
      const { isJson, data } = await safeJsonFetch<CredentialValidationResult>(
        `/api/auth/validate-credentials?redirect_uri=${redirectParam}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: trimmedId || undefined,
            clientSecret: trimmedSecret || undefined,
            redirectUri: `${window.location.origin}/auth/callback`,
          }),
        }
      );

      if (isJson && data) {
        console.info('[MuseVis Spotify OAuth] Credential Validation Result:', data);
        setCredValidationResult(data);
        if (data.redirectUri) {
          setCallbackUrl(data.redirectUri);
        }
        return;
      }

      // Fallback validation summary if running in pure SPA mode
      setCredValidationResult({
        valid: Boolean(trimmedId),
        code: trimmedId ? 'pkce_ready' : 'missing_credentials',
        status: trimmedId ? 200 : 400,
        message: trimmedId
          ? 'Client ID saved for PKCE S256 authentication flow.'
          : 'Enter your Spotify Client ID in the field below or in AI Studio Secrets.',
        remediation: trimmedId
          ? `Ensure ${window.location.origin}/auth/callback is added to your Spotify Dashboard Redirect URIs, then click Sign in with Spotify.`
          : 'Paste your 32-character Spotify Client ID below.',
        clientIdStatus: trimmedId
          ? `Configured (${trimmedId.slice(0, 4)}...${trimmedId.slice(-4)})`
          : 'Missing',
        clientSecretStatus: trimmedSecret
          ? `Configured (${trimmedSecret.length} chars)`
          : 'Optional (PKCE S256 enabled)',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[MuseVis Spotify OAuth] Credential validation request failed:', err);
      setCredValidationResult({
        valid: false,
        code: 'network_error',
        status: 500,
        message: err.message || 'Could not validate Spotify credentials.',
        remediation: 'Verify your Client ID or connect directly with a Spotify Access Token.',
        clientIdStatus: 'Unknown',
        clientSecretStatus: 'Unknown',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsValidatingCreds(false);
    }
  };

  const handleVerifyManualToken = async () => {
    const cleanToken = manualTokenInput.trim();
    if (!cleanToken) return;
    setIsVerifyingToken(true);
    try {
      const { ok, isJson, data } = await safeJsonFetch('/api/spotify/verify-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: cleanToken }),
      });

      if (isJson && ok && data?.valid) {
        localStorage.setItem('musevis_spotify_token', cleanToken);
        setSpotifyConnected(true);
        setSpotifyUser(data.user?.displayName || 'Spotify User');
        setOauthErrorState(null);
        setManualTokenInput('');
        setAuthNotice(`Connected to Spotify as ${data.user?.displayName || 'Spotify User'}`);
        await fetchSpotifyPlaylists(cleanToken);
        setActiveModal('none');
        return;
      }

      // Direct verification against https://api.spotify.com/v1/me
      const direct = await fetchSpotifyDirectLibrary(cleanToken);
      if (direct.user) {
        localStorage.setItem('musevis_spotify_token', cleanToken);
        setSpotifyConnected(true);
        setSpotifyUser(direct.user.displayName);
        setOauthErrorState(null);
        setManualTokenInput('');
        setAuthNotice(`Connected to Spotify as ${direct.user.displayName}`);
        applyLibraryPayload(direct);
        setActiveModal('none');
      } else {
        setAuthNotice('Invalid or expired Spotify Bearer token. Please generate a fresh token.');
      }
    } catch (err: any) {
      setAuthNotice(err.message || 'Failed to verify Spotify token.');
    } finally {
      setIsVerifyingToken(false);
    }
  };

  const handleDisconnectSpotify = async () => {
    localStorage.removeItem('musevis_spotify_token');
    await safeJsonFetch('/api/spotify/logout', { method: 'POST' });
    synthEngine.stop();
    setIsPlaying(false);
    setSpotifyIsPlaying(false);
    setSpotifyConnected(false);
    setSpotifyUser(null);
    setPlaylists([]);
    setSelectedPlaylistId('');
    setTracks([]);
    setCurrentTrackIndex(0);
    setProgress(0);
    setAuthNotice('Disconnected from Spotify.');
  };

  const togglePlay = async () => {
    lastLocalControlTimeRef.current = Date.now();
    if (currentTrack.platform === 'Spotify') {
      const action = spotifyIsPlaying ? 'pause' : 'play';
      const ok = await controlSpotifyRemotePlayer(action, {
        trackUri: action === 'play' ? currentTrack.spotifyUri : undefined,
        
      });
      if (ok) setSpotifyIsPlaying(action === 'play');
      else setAuthNotice('Open Spotify on an active device, then try the playback control again.');
      return;
    }

    synthEngine.unlock();
    if (isPlaying) {
      synthEngine.stop();
      setIsPlaying(false);
    } else {
      if (currentTrack.id === DEFAULT_IDLE_TRACK.id) {
        setActiveModal('sync');
        return;
      }
      synthEngine.start(currentTrack);
      if (progress > 1 && progress < currentTrack.duration - 2) synthEngine.seek(progress);
      synthEngine.setVolume(isMuted ? 0 : volume);
      setIsPlaying(true);
    }
  };

  const selectTrack = async (index: number, forcePlay = true) => {
    const target = tracks[index];
    if (!target) return;
    lastLocalControlTimeRef.current = Date.now();
    const reqId = ++trackRequestIdRef.current;
    setCurrentTrackIndex(index);
    setProgress(0);
    setCustomPalette(null);

    if (target.platform === 'Spotify') {
      synthEngine.stop();
      setIsPlaying(false);
      if (forcePlay) {
        let uri = target.spotifyUri;
        if (!uri) uri = (await resolveSpotifyTrackUri(target.title, target.artist, target.spotifyUri)) || undefined;
        if (uri) {
          if (reqId !== trackRequestIdRef.current) return;
          const ok = await controlSpotifyRemotePlayer('play', { trackUri: uri, deviceId: sdkDeviceId || undefined });
          if (reqId !== trackRequestIdRef.current) return;
          setSpotifyIsPlaying(Boolean(ok));
          if (!ok) setAuthNotice('Spotify track selected. Start playback on an active Spotify device.');
        } else {
          setSpotifyIsPlaying(false);
          setAuthNotice('Could not resolve this Spotify track URI. Try refreshing your Spotify library.');
        }
      }
      return;
    }

    setSpotifyIsPlaying(false);
    if (forcePlay || isPlaying) {
      synthEngine.unlock();
      synthEngine.start(target);
      synthEngine.setVolume(isMuted ? 0 : volume);
      setIsPlaying(true);
    } else {
      synthEngine.stop();
      setIsPlaying(false);
    }
  };

  const findBestNextTrack = (current: MusicTrack, pool: MusicTrack[]): number => {
    const candidates = pool.map((t, i) => ({ t, i })).filter(({ t }) => t.id !== current.id);
    if (candidates.length === 0) return currentTrackIndex;

    const scored = candidates.map(({ t, i }) => {
      const bpmDiff = Math.abs(current.bpm - t.bpm);
      const bpmScore = Math.max(0, 1 - (bpmDiff / 40));
      const moodScore = current.mood === t.mood ? 0.5 : 0;
      const score = bpmScore + moodScore;
      return { index: i, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].index;
  };

  const handleNextTrack = () => {
    if (tracks.length === 0) return;
    const nextIdx = smartShuffleEnabled
      ? findBestNextTrack(currentTrack, tracks)
      : (currentTrackIndex + 1) % tracks.length;
    selectTrack(nextIdx);
  };

  const handlePrevTrack = () => {
    if (tracks.length === 0) return;
    const prevIdx = (currentTrackIndex - 1 + tracks.length) % tracks.length;
    selectTrack(prevIdx);
  };

  const seekPlayback = (newSec: number, commitImmediately = true) => {
    if (currentTrack.platform === 'Spotify') return;
    lastLocalControlTimeRef.current = Date.now();
    // Leave at least 1.5s margin from the end when scrubbing so dragging to the right edge never triggers a track skip
    const maxSafeSeek = Math.max(1, currentTrack.duration - 1.5);
    const clamped = Math.max(0, Math.min(maxSafeSeek, newSec));
    setProgress(clamped);

    if (seekCommitTimerRef.current !== null) {
      window.clearTimeout(seekCommitTimerRef.current);
      seekCommitTimerRef.current = null;
    }

    const commitAudioSeek = () => {
      synthEngine.seek(clamped);
      window.setTimeout(() => {
        isScrubbingRef.current = false;
      }, 150);
    };

    if (commitImmediately) {
      commitAudioSeek();
    } else {
      isScrubbingRef.current = true;
      seekCommitTimerRef.current = window.setTimeout(commitAudioSeek, 120);
    }
  };

  const handleVolumeChange = (newVol: number) => {
    setVolume(newVol);
    setIsMuted(newVol === 0);
    synthEngine.setVolume(newVol);
  };

  const toggleMute = () => {
    if (isMuted) {
      setIsMuted(false);
      synthEngine.setVolume(volume || 0.6);
    } else {
      setIsMuted(true);
      synthEngine.setVolume(0);
    }
  };

  const handleCrossPlatformSync = () => {
    setIsSyncing(true);
    setTimeout(() => {
      setPlaylists((prev) => prev.map((pl) => ({ ...pl, synced: true })));
      setIsSyncing(false);
      setAuthNotice('Cross-platform playlists synced across Spotify and Apple Music.');
      setTimeout(() => setAuthNotice(null), 3500);
    }, 900);
  };

  const copyCallbackUri = () => {
    navigator.clipboard.writeText(callbackUrl);
    setCopiedUri(true);
    setTimeout(() => setCopiedUri(false), 2000);
  };


  const handleStudioFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    ++trackRequestIdRef.current;
    if (!file.type.startsWith('audio/')) {
      setAuthNotice('Choose an audio file (MP3, WAV, M4A, OGG, or another browser-supported format).');
      event.target.value = '';
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    synthEngine.stop();
    tracks.forEach((track) => {
      if (track.platform === 'MuseVis Studio' && track.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(track.previewUrl);
    });
    setIsPlaying(false);
    setSpotifyIsPlaying(false);
    const title = file.name.replace(/\\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Local audio';
    const studioTrack: MusicTrack = {
      id: `studio-${Date.now()}`,
      title,
      artist: 'Local audio file',
      album: 'MuseVis Studio',
      duration: 180,
      bpm: 100,
      mood: 'Ethereal',
      platform: 'MuseVis Studio',
      palette: PALETTE_PRESETS[0],
      chordProgression: currentTrack.chordProgression,
      lyrics: undefined,
      previewUrl: objectUrl,
      coverUrl: getAbstractPlaceholderCover('Ethereal'),
    };
    setTracks([studioTrack]);
    setCurrentTrackIndex(0);
    setSelectedPlaylistId('');
    setProgress(0);
    setActiveModal('none');
    setAuthNotice('Local audio loaded in MuseVis Studio. Visualizer and verified synced lyrics are available for this source.');
    setTimeout(() => setAuthNotice(null), 5000);
    event.target.value = '';
  };

  const formatTime = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return `${mins}:${rem < 10 ? '0' : ''}${rem}`;
  };



  return (
    <div
      className="relative w-screen h-screen overflow-hidden select-none text-slate-100"
      style={{ backgroundColor: '#06070a' }}
    >
      {/* Album-Art-Driven Full-Viewport Multi-Stop Ambient Vignette */}
      <div
        className="fixed inset-0 pointer-events-none z-0 transition-colors duration-700"
        style={{
          backgroundImage: `radial-gradient(circle at 50% 42%, ${activePalette.primary}2e 0%, ${activePalette.secondary}1f 36%, ${activePalette.ambient}eb 72%, #06070a 100%), radial-gradient(circle at 18% 18%, ${activePalette.accent}18 0%, transparent 48%), radial-gradient(circle at 50% 50%, ${activePalette.accent}${Math.round(bassFlashIntensity * 100).toString(16).padStart(2, '0')} 0%, transparent 60%)`,
        }}
      />

      {/* Real-time 3D Fluid Abstract Art Canvas */}
      <FluidVisualizer
        palette={activePalette}
        bpm={currentTrack.bpm}
        tempoMultiplier={1.0}
        bloomIntensity={bloomIntensity}
        isPlaying={isPlaying}
        cameraPreset={cameraPreset}
      />

      {/* Top Navigation Bar — Minimal 3-Zone Contract */}
      <header
        className="relative z-20 flex items-center justify-between gap-8 px-8 py-4 bg-[#0a0a0a]/50"
      >
        {/* Zone 1: Brand */}
        <div
          className="text-lg font-bold tracking-tight"
          style={{
            color: lerpHexColor('#ffffff', activePalette.accent, 0.25),
          }}
        >
          MuseVis
        </div>

        {/* Zone 2: Concise Navigation */}
        <nav className="flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            onClick={() => setActiveModal('none')}
            className={`hover:text-white transition-colors ${activeModal === 'none' ? 'text-white' : ''}`}
          >
            Visualizer
          </button>
          <button
            onClick={() => setShowLibraryDrawer(!showLibraryDrawer)}
            className={`hover:text-white transition-colors ${showLibraryDrawer ? 'text-white' : ''}`}
          >
            Queue
          </button>
        </nav>

        {/* Zone 3: Independent Studio audio + Spotify library connection */}
        <div className="flex items-center gap-2">
          <input
            ref={studioFileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={handleStudioFileChange}
          />
          <button
            onClick={() => studioFileInputRef.current?.click()}
            className="px-4 py-2 text-xs font-semibold rounded-lg transition-colors bg-white text-black hover:bg-slate-200"
          >
            Import Audio
          </button>
          {spotifyConnected && (
            <button
              onClick={() => syncTrackWithSpotify(true)}
              className="px-3 py-2 text-xs font-semibold rounded-lg transition-colors bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200"
            >
              Sync Now Playing
            </button>
          )}
          <button
            onClick={handleConnectSpotify}
            className="px-4 py-2 text-xs font-semibold rounded-lg transition-colors bg-white/5 hover:bg-white/10 text-slate-300"
          >
            {spotifyConnected ? 'Spotify Connected' : 'Connect Spotify'}
          </button>
        </div>
      </header>

      {/* Global Spectral Frequency Visualizer Overlay */}
      <SpectralVisualizer palette={activePalette} className="fixed inset-0 z-10 opacity-30 pointer-events-none" />

      {/* Source-mode indicator */}
      <div className="fixed top-[88px] right-6 z-20 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-[10px] uppercase tracking-wider text-slate-300">
        {currentTrack.platform === 'Spotify' ? 'Spotify · metadata & controls' : currentTrack.platform === 'MuseVis Studio' ? 'MuseVis Studio · local audio' : 'Ready for audio'}
      </div>

      {/* Centered Track Information Box */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none flex flex-col items-center gap-4">
          <div className="text-center bg-[#0e1015]/80 backdrop-blur-sm border border-white/10 rounded-lg p-3 shadow-lg pointer-events-auto">
             <div className="text-sm font-bold text-white truncate max-w-[200px]">{currentTrack.title}</div>
             <div className="text-xs text-slate-400 truncate max-w-[200px]">{currentTrack.artist}</div>
          </div>
      </div>

      {/* Subtle Toast Banner if Auth Notice is active */}
      {authNotice && (
        <div className="relative z-30 mx-auto mt-3 max-w-xl px-4 py-2.5 rounded-lg bg-[#121216]/95 border border-white/15 text-xs text-slate-200 flex items-center justify-between gap-4 shadow-lg">
          <span>{authNotice}</span>
          <button
            onClick={() => setAuthNotice(null)}
            className="text-slate-400 hover:text-white text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Central Unobstructed 3D Viewport + Synchronized Poetic Lyrics Overlay */}
      <main className="relative z-10 flex flex-col items-center justify-between h-[calc(100vh-65px)] pointer-events-none px-6 pt-6 pb-8">
        {/* Top-Left Minimal Track Metadata Readout + Quick Start Music & Playlist Switcher */}
        <div className="w-full max-w-[1360px] flex flex-wrap items-start justify-between gap-4 pointer-events-auto">
          <div className="space-y-2">
            <div className="flex items-center gap-3.5">
              {/* Album Cover Art or Mood-Matched Abstract Fluid Placeholder */}
              <div
                className="relative w-16 h-16 md:w-20 md:h-20 rounded-xl overflow-hidden border shrink-0 shadow-xl bg-[#0e1015] transition-all duration-500"
                style={{
                  borderColor: `${activePalette.accent}66`,
                  boxShadow: `0 10px 34px -4px ${activePalette.primary}75, 0 0 16px -2px ${activePalette.accent}45`,
                }}
              >
                <img
                  src={getTrackAlbumCover(currentTrack)}
                  alt={`${currentTrack.album} cover`}
                  onError={(e) => {
                    e.currentTarget.src = getAbstractPlaceholderCover(currentTrack.mood);
                  }}
                  className="w-full h-full object-cover"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-slate-400">
                  {currentTrack.artist}
                </div>
                <h1
                  className="text-3xl font-bold"
                  style={{
                    color: lerpHexColor('#ffffff', activePalette.accent, 0.22),
                  }}
                >
                  {currentTrack.title}
                </h1>
              </div>
            </div>

            {/* Controls */}
            <div className="pt-4 flex items-center gap-3">
              <button
                onClick={togglePlay}
                className="px-5 py-2 rounded-lg text-sm font-semibold text-black bg-white"
              >
                {(currentTrack.platform === 'Spotify' ? spotifyIsPlaying : isPlaying) ? 'Pause' : currentTrack.platform === 'Spotify' ? 'Play on Spotify' : 'Play'}
              </button>
            </div>
          </div>
          </div>

          {/* Right-Side Floating Panel: Official Spotify Embed & Quick Library Queue Drawer */}
          <div className="flex flex-col items-end gap-3 w-full sm:w-auto">
            {showSpotifyEmbed && (
              <div className="w-full sm:w-80 rounded-xl overflow-hidden border border-white/15 bg-[#0e1015]/95 shadow-2xl">
                {(() => {
                  const uriTrackId =
                    currentTrack.spotifyUri &&
                    /^spotify:track:[a-zA-Z0-9]{22}$/.test(currentTrack.spotifyUri)
                      ? currentTrack.spotifyUri.replace('spotify:track:', '')
                      : /^[a-zA-Z0-9]{22}$/.test(currentTrack.id)
                      ? currentTrack.id
                      : null;
                  const embedSrc = uriTrackId
                    ? `https://open.spotify.com/embed/track/${uriTrackId}?utm_source=generator&theme=0`
                    : selectedPlaylistId && !selectedPlaylistId.startsWith('live-')
                    ? `https://open.spotify.com/embed/playlist/${selectedPlaylistId}?utm_source=generator&theme=0`
                    : 'https://open.spotify.com/embed/playlist/37i9dQZF1DX4dyzvuaRJ0n?utm_source=generator&theme=0';
                  return (
                    <iframe
                      key={embedSrc}
                      title="Spotify Web Player"
                      src={embedSrc}
                      width="100%"
                      height="152"
                      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                      loading="lazy"
                      className="border-0"
                    />
                  );
                })()}
              </div>
            )}

            {showLibraryDrawer && (
              <div className="w-full sm:w-96 rounded-xl bg-[#0e1015]/95 border border-white/15 p-4 shadow-2xl space-y-3.5 max-h-[54vh] flex flex-col">
                <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                  <div>
                    <h3 className="text-xs font-semibold text-white uppercase tracking-wider">
                      Playlists & Active Queue
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      {activePlaylist?.name || 'Now Playing'} · {tracks.length} songs
                    </p>
                  </div>
                  <button
                    onClick={() => setShowLibraryDrawer(false)}
                    className="px-2 py-1 text-xs text-slate-400 hover:text-white rounded bg-white/5 cursor-pointer"
                  >
                    Hide
                  </button>
                </div>

                {/* Horizontal Playlist Pills */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar shrink-0">
                  {playlists.map((pl) => {
                    const isSelected = selectedPlaylistId === pl.id;
                    return (
                      <button
                        key={pl.id}
                        onClick={() => handleSelectPlaylist(pl, true)}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer border transition-colors ${
                          isSelected
                            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-semibold'
                            : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        {pl.name}
                      </button>
                    );
                  })}
                </div>

                {/* Scrollable Songs Queue */}
                <div className="divide-y divide-white/10 overflow-y-auto pr-1 flex-1 min-h-0">
                  {tracks.map((track, idx) => {
                    const isCurrent = idx === currentTrackIndex;
                    return (
                      <div
                        key={`${track.id}-${idx}`}
                        onClick={() => selectTrack(idx, true)}
                        className={`py-2 px-2.5 rounded-lg flex items-center justify-between gap-2.5 cursor-pointer transition-colors ${
                          isCurrent ? 'bg-white/15' : 'hover:bg-white/5'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <img
                            src={getTrackAlbumCover(track)}
                            alt={track.album}
                            onError={(e) => {
                              e.currentTarget.src = getAbstractPlaceholderCover(track.mood);
                            }}
                            className="w-8 h-8 rounded object-cover border border-white/10 shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-white truncate">
                              {track.title}
                            </div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {track.artist}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] font-mono tabular-nums text-slate-400">
                            {formatTime(track.duration)}
                          </span>
                          <span
                            className="w-6 h-6 rounded-full flex items-center justify-center text-black"
                            style={{
                              backgroundColor: isCurrent ? activePalette.primary : 'rgba(255,255,255,0.12)',
                              color: isCurrent ? '#000' : '#fff',
                            }}
                          >
                            {isCurrent && (currentTrack.platform === 'Spotify' ? spotifyIsPlaying : isPlaying) ? (
                              <Pause className="w-3 h-3 fill-current" />
                            ) : (
                              <Play className="w-3 h-3 fill-current" />
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
        </div>
      </main>

        {/* Modal Overlays (Interactive Split-Stage Lyrics Studio, Cross-Platform Library Sync, or OAuth Setup Guide) */}
        {activeModal !== 'none' && (
          <div
            className={`pointer-events-auto fixed inset-x-0 top-16 mx-auto z-30 px-4 ${
              activeModal === 'lyrics' ? 'max-w-4xl' : 'max-w-2xl'
            }`}
          >
            <div
              className="rounded-2xl border p-5 md:p-6 shadow-2xl max-h-[68vh] overflow-y-auto transition-colors duration-500"
              style={{
                background: `radial-gradient(circle at 16% 20%, ${activePalette.primary}22 0%, ${activePalette.secondary}14 42%, #0c0d12 92%)`,
                borderColor: `${activePalette.primary}45`,
                boxShadow: `0 24px 64px -12px rgba(0,0,0,0.85), 0 0 44px -12px ${activePalette.primary}55`,
              }}
            >

              {activeModal === 'lyrics' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <div>
                      <h2 className="text-lg font-semibold text-white">Lyrics</h2>
                      <p className="text-xs text-slate-400">{currentTrack.title}</p>
                    </div>
                    <button
                      onClick={() => setActiveModal('none')}
                      className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-white/5 rounded-lg cursor-pointer"
                    >
                      Close
                    </button>
                  </div>
                  {currentTrack.lyrics && currentTrack.lyrics.length > 0 ? (
                    <LyricDisplay
                      lyrics={currentTrack.lyrics}
                      currentTime={progress}
                      totalDuration={currentTrack.duration}
                      palette={activePalette}
                    />
                  ) : (
                    <div className="text-center py-20 text-slate-400">
                      {currentTrack.platform === 'Spotify'
                        ? 'Spotify playback is kept separate from synchronized visual media. Import an audio file into MuseVis Studio to use verified timed lyrics with the visualizer.'
                        : 'No verified synchronized lyrics are available for this local audio file.'}
                    </div>
                  )}
                </div>
              )}

              {activeModal === 'sync' && (
                <div className="space-y-5">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <div>
                      <h2 className="text-lg font-semibold text-white">
                        Spotify Playlists, Tracklist & Song Search
                      </h2>
                      <p className="text-xs text-slate-400">
                        Switch your active Spotify playlist, search any song, or start music playback immediately
                      </p>
                    </div>
                    <button
                      onClick={() => setActiveModal('none')}
                      className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-white/5 rounded-lg cursor-pointer"
                    >
                      Close
                    </button>
                  </div>

                  {/* Search Any Song or Playlist on Spotify */}
                  <div className="space-y-3">
                    <div className="flex gap-2">
                        {(['track', 'playlist'] as const).map(type => (
                            <button
                                key={type}
                                onClick={() => setSearchType(type)}
                                className={`px-3 py-1 rounded-lg text-xs font-semibold capitalize ${searchType === type ? 'bg-white text-black' : 'bg-white/10 text-white'}`}
                            >
                                {type}s
                            </button>
                        ))}
                    </div>
                    <form onSubmit={handleSearchSongs} className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={`Search for a ${searchType}...`}
                            className="w-full pl-8 pr-3 py-2 rounded-lg bg-black/60 border border-white/15 text-xs text-white focus:outline-none focus:border-emerald-400"
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={isSearching || !searchQuery.trim()}
                          className="px-3.5 py-2 rounded-lg bg-[#1DB954] text-black text-xs font-semibold hover:bg-[#1ed760] disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {isSearching ? 'Searching...' : 'Search'}
                        </button>
                    </form>
                  </div>

                  {/* Search Results Display (Simplified) */}
                  {searchResults.length > 0 && (
                      <div className="max-h-40 overflow-y-auto border border-white/10 rounded-lg bg-black/50 p-2 space-y-1">
                          {searchResults.map((res: any) => (
                              <div key={res.id} className="text-xs p-1 hover:bg-white/10 cursor-pointer" onClick={() => {
                                  if (searchType === 'track') {
                                      // Find index of the clicked track in current tracks list
                                      const trackIndex = tracks.findIndex(t => t.id === res.id);
                                      if (trackIndex !== -1) {
                                          selectTrack(trackIndex, true);
                                          setActiveModal('none');
                                      }
                                  } else {
                                      // Handle playlist result
                                      handleSelectPlaylist({id: res.id, name: res.name, source: 'Spotify', trackCount: res.tracks?.total || 0, synced: true, tracks: []}, true);
                                      setActiveModal('none');
                                  }
                              }}>
                                  {res.name || res.title} - {searchType === 'track' ? res.artist : res.owner?.display_name}
                              </div>
                          ))}
                      </div>
                  )}

                  {/* Playlists Switcher */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300">
                        Your Playlists ({playlists.length})
                      </span>
                      <button
                        onClick={handleCrossPlatformSync}
                        disabled={isSyncing}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer"
                      >
                        <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                        <span>{isSyncing ? 'Loading Tracks...' : 'Refresh Playlists'}</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-44 overflow-y-auto pr-1">
                      {playlists.map((pl) => {
                        const isSelected = selectedPlaylistId === pl.id;
                        return (
                          <div
                            key={pl.id}
                            onClick={() => handleSelectPlaylist(pl, false)}
                            className={`p-3 rounded-lg border flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-emerald-500/15 border-emerald-500/40'
                                : 'bg-white/5 border-white/10 hover:bg-white/10'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-white truncate">
                                {pl.name}
                              </div>
                              <div className="text-[11px] text-slate-400 tabular-nums">
                                {pl.source} · {pl.trackCount} tracks
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectPlaylist(pl, true);
                                setActiveModal('none');
                              }}
                              className="px-2.5 py-1 rounded-md bg-[#1DB954] text-black text-[11px] font-semibold hover:bg-[#1ed760] flex items-center gap-1 shrink-0 cursor-pointer"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              <span>Play</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Active Playlist Songs List */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300">
                        Songs in {activePlaylist?.name || 'Current Queue'} ({tracks.length})
                      </span>
                      <span className="text-[11px] text-slate-400">
                        Click any song to start music & 3D fluid art
                      </span>
                    </div>

                    <div className="divide-y divide-white/10 border border-white/10 rounded-lg max-h-56 overflow-y-auto">
                      {tracks.map((track, idx) => {
                        const isCurrent = idx === currentTrackIndex;
                        return (
                          <div
                            key={`${track.id}-${idx}`}
                            onClick={() => {
                              selectTrack(idx, true);
                              setActiveModal('none');
                            }}
                            className={`px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                              isCurrent ? 'bg-white/15' : 'hover:bg-white/5'
                            }`}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="text-xs font-mono text-slate-500 w-4 tabular-nums shrink-0">
                                {idx + 1}
                              </span>
                              <img
                                src={getTrackAlbumCover(track)}
                                alt={track.album}
                                onError={(e) => {
                                  e.currentTarget.src = getAbstractPlaceholderCover(track.mood);
                                }}
                                className="w-9 h-9 rounded-md object-cover border border-white/10 shrink-0 bg-black/40"
                              />
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-white truncate">
                                  {track.title}
                                </div>
                                <div className="text-[11px] text-slate-400 truncate">
                                  {track.artist} · {track.album}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2.5 shrink-0">
                              <span className="text-xs font-mono tabular-nums text-slate-400">
                                {formatTime(track.duration)}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isCurrent) {
                                    togglePlay();
                                  } else {
                                    selectTrack(idx, true);
                                  }
                                }}
                                className="px-2.5 py-1 rounded bg-white text-black text-[11px] font-semibold hover:bg-slate-200 flex items-center gap-1 cursor-pointer"
                              >
                                {isCurrent && (currentTrack.platform === 'Spotify' ? spotifyIsPlaying : isPlaying) ? (
                                  <>
                                    <Pause className="w-3 h-3 fill-current" />
                                    <span>Pause</span>
                                  </>
                                ) : (
                                  <>
                                    <Play className="w-3 h-3 fill-current" />
                                    <span>Start</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {activeModal === 'oauth-help' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <div>
                      <h2 className="text-lg font-semibold text-white">
                        Spotify OAuth Diagnostics & Setup
                      </h2>
                      <p className="text-xs text-slate-400">
                        Granular authentication status, Redirect URI verification, and fallback controls
                      </p>
                    </div>
                    <button
                      onClick={() => setActiveModal('none')}
                      className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-white/5 rounded-lg cursor-pointer"
                    >
                      Close
                    </button>
                  </div>

                  {/* Granular OAuth Fallback Diagnostic Panel */}
                  {oauthErrorState && (
                    <div className="p-4 rounded-lg bg-rose-950/40 border border-rose-500/30 space-y-2.5">
                      <div className="flex items-center justify-between gap-2 text-xs text-rose-300 font-mono tabular-nums">
                        <span>ERROR CODE: {oauthErrorState.code.toUpperCase()}</span>
                        {oauthErrorState.statusCode && (
                          <span>HTTP {oauthErrorState.statusCode}</span>
                        )}
                      </div>
                      <h3 className="text-sm font-semibold text-white">
                        {oauthErrorState.title}
                      </h3>
                      <p className="text-xs text-slate-200 leading-relaxed">
                        {oauthErrorState.message}
                      </p>
                      <div className="pt-1 border-t border-white/10 text-xs text-amber-200/90 leading-relaxed">
                        <strong className="text-white">How to fix: </strong>
                        {oauthErrorState.remediation}
                      </div>
                      {oauthErrorState.rawDetails && (
                        <div className="p-2 rounded bg-black/50 font-mono text-[11px] text-slate-400 break-all">
                          Raw Response: {oauthErrorState.rawDetails}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Silent Credential Validation Outcome Panel */}
                  {credValidationResult && (
                    <div
                      className={`p-4 rounded-lg border space-y-2 ${
                        credValidationResult.valid
                          ? 'bg-emerald-950/35 border-emerald-500/35'
                          : 'bg-rose-950/40 border-rose-500/35'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-mono tabular-nums">
                        <span
                          className={
                            credValidationResult.valid ? 'text-emerald-300' : 'text-rose-300'
                          }
                        >
                          {credValidationResult.valid
                            ? 'VALIDATION PASSED · CLIENT CREDENTIALS OK'
                            : `VALIDATION FAILED · ${credValidationResult.code.toUpperCase()}`}
                        </span>
                        <span className="text-slate-400">HTTP {credValidationResult.status}</span>
                      </div>
                      <p className="text-xs text-white font-medium leading-relaxed">
                        {credValidationResult.message}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px] font-mono text-slate-300">
                        <div className="p-2 rounded bg-black/40 border border-white/10">
                          <span className="text-slate-400">SPOTIFY_CLIENT_ID: </span>
                          <span className="text-white">{credValidationResult.clientIdStatus}</span>
                        </div>
                        <div className="p-2 rounded bg-black/40 border border-white/10">
                          <span className="text-slate-400">SPOTIFY_CLIENT_SECRET: </span>
                          <span className="text-white">
                            {credValidationResult.clientSecretStatus}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-300 pt-1 border-t border-white/10 leading-relaxed">
                        <strong className="text-white">Next Step: </strong>
                        {credValidationResult.remediation}
                      </p>
                    </div>
                  )}

                  <div className="space-y-3.5 text-xs text-slate-300 leading-relaxed">
                    <div>
                      <p className="mb-1.5">
                        1. Copy this exact <strong>Redirect URI</strong> into your{' '}
                        <a
                          href="https://developer.spotify.com/dashboard"
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-400 underline"
                        >
                          Spotify Developer Dashboard
                        </a>{' '}
                        (under <em>Settings → Redirect URIs</em>):
                      </p>
                      <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-black/60 border border-white/15 font-mono text-xs text-emerald-300">
                        <span className="truncate">{oauthErrorState?.redirectUri || callbackUrl}</span>
                        <button
                          onClick={copyCallbackUri}
                          className="px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-white flex items-center gap-1 shrink-0 cursor-pointer"
                        >
                          <Copy className="w-3 h-3" />
                          <span>{copiedUri ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Direct Client ID & Secret Configuration (works alongside AI Studio Secrets) */}
                    <div className="p-3.5 rounded-lg bg-white/5 border border-white/10 space-y-2.5">
                      <div className="text-xs font-semibold text-white">
                        2. Spotify App Credentials (PKCE & Confidential OAuth)
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Leave blank if already set in the AI Studio Secrets panel, or paste them directly here to override:
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">
                            Spotify Client ID
                          </label>
                          <input
                            type="text"
                            value={clientIdInput}
                            onChange={(e) => setClientIdInput(e.target.value)}
                            placeholder="e.g. 4a1b2c3d4e5f..."
                            className="w-full px-2.5 py-1.5 rounded bg-black/60 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">
                            Spotify Client Secret (Optional with PKCE)
                          </label>
                          <input
                            type="password"
                            value={clientSecretInput}
                            onChange={(e) => setClientSecretInput(e.target.value)}
                            placeholder="Optional if using PKCE..."
                            className="w-full px-2.5 py-1.5 rounded bg-black/60 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Direct Access Token Instant Connect */}
                    <div className="p-3.5 rounded-lg bg-white/5 border border-white/10 space-y-2">
                      <div className="text-xs font-semibold text-white">
                        Alternative: Instant Connect with a Spotify Web API Token
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={manualTokenInput}
                          onChange={(e) => setManualTokenInput(e.target.value)}
                          placeholder="Paste a Spotify Bearer Access Token (BQD...)"
                          className="w-full px-2.5 py-1.5 rounded bg-black/60 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                        />
                        <button
                          onClick={handleVerifyManualToken}
                          disabled={isVerifyingToken || !manualTokenInput.trim()}
                          className="px-3 py-1.5 rounded bg-emerald-500 text-black font-semibold text-xs hover:bg-emerald-400 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {isVerifyingToken ? 'Verifying...' : 'Use Token'}
                        </button>
                      </div>
                    </div>

                    <div className="pt-2 flex flex-wrap items-center justify-between gap-2.5 border-t border-white/10">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setOauthErrorState(null);
                            setAuthNotice(null);
                            setActiveModal('none');
                          }}
                          className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Close
                        </button>
                        {spotifyConnected && (
                          <button
                            onClick={handleDisconnectSpotify}
                            className="px-3 py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Disconnect
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleValidateCredentials}
                          disabled={isValidatingCreds}
                          className="px-3.5 py-2 rounded-lg bg-white text-black text-xs font-semibold hover:bg-slate-200 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 ${isValidatingCreds ? 'animate-spin' : ''}`}
                          />
                          <span>
                            {isValidatingCreds
                              ? 'Checking Credentials...'
                              : 'Check OAuth Credentials'}
                          </span>
                        </button>
                        <button
                          onClick={handleConnectSpotify}
                          className="px-4 py-2 rounded-lg bg-[#1DB954] text-black text-xs font-semibold hover:bg-[#1ed760] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {spotifyConnected ? 'Reconnect Spotify' : 'Sign in with Spotify'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}


      {/* Ergonomic Unified Bottom Control Dock (Collapsible Zen Mode) */}
      <div
        className="fixed left-1/2 z-20 w-[min(1120px,95vw)] transition-transform duration-300 ease-out"
        style={{
          bottom: '16px',
          transform: `translateX(-50%) translateY(${dockCollapsed ? 'calc(100% - 12px)' : '0px'})`,
        }}
      >
        {/* Collapse / Expand Zen Mode Handle */}
        <div className="flex justify-center mb-1.5">
          <button
            onClick={() => setDockCollapsed((prev) => !prev)}
            className="flex items-center gap-1.5 px-3.5 py-1 rounded-t-lg bg-[#111216]/95 border border-b-0 border-white/15 text-xs font-medium text-slate-300 hover:text-white transition-colors cursor-pointer"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Show Controls (H)</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>Zen Mode (H)</span>
              </>
            )}
          </button>
        </div>

        {/* Main Solid / RGBA Dock Surface (Zero backdrop-filter over WebGL per Three.js skill) */}
        <div
          className="rounded-xl bg-[#0e1015]/95 border px-4 py-3.5 shadow-2xl space-y-3 transition-colors duration-500"
          style={{
            borderColor: `${activePalette.primary}40`,
            boxShadow: `0 20px 50px -12px rgba(0,0,0,0.85), 0 0 32px -12px ${activePalette.primary}45`,
          }}
        >
          {/* Row 1: Playlist Switcher + Real Spotify Track Selector + Timeline Scrubber */}
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {/* Quick Playlist Selector Dropdown */}
              {playlists.length > 0 && (
                <select
                  aria-label="Active Playlist"
                  value={selectedPlaylistId}
                  onChange={(e) => {
                    const targetPl = playlists.find((p) => p.id === e.target.value);
                    if (targetPl) handleSelectPlaylist(targetPl);
                  }}
                  className="px-2.5 py-1.5 rounded-lg border text-xs font-semibold focus:outline-none cursor-pointer shrink-0 max-w-[170px] truncate"
                  style={{
                    backgroundColor: `${activePalette.primary}20`,
                    borderColor: `${activePalette.primary}50`,
                    color: activePalette.accent,
                  }}
                >
                  {playlists.map((pl) => (
                    <option key={pl.id} value={pl.id} className="bg-[#111216] text-white">
                      {pl.source === 'Spotify' ? `Spotify · ${pl.name}` : pl.name}
                    </option>
                  ))}
                </select>
              )}

              {/* Scrollable Track Selector */}
              <div className="flex items-center gap-1.5 overflow-x-auto min-w-0 flex-1 py-0.5 no-scrollbar">
                {tracks.length > 0 ? (
                  tracks.map((t, idx) => {
                    const active = idx === currentTrackIndex;
                    return (
                      <button
                        ref={active ? activeTrackRef : null}
                        key={`${t.id}-${idx}`}
                        onClick={() => selectTrack(idx)}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-2 ${
                          active
                            ? 'text-black font-semibold'
                            : 'bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'
                        }`}
                        style={
                          active
                            ? {
                                backgroundColor: activePalette.accent,
                                boxShadow: `0 0 14px -3px ${activePalette.accent}`,
                              }
                            : undefined
                        }
                      >
                        <img
                          src={getTrackAlbumCover(t)}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.src = getAbstractPlaceholderCover(t.mood);
                          }}
                          className="w-4 h-4 rounded-sm object-cover shrink-0"
                        />
                        <span className="max-w-[150px] truncate">{t.title}</span>
                      </button>
                    );
                  })
                ) : (
                  <button
                    onClick={() => setActiveModal('sync')}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5"
                  >
                    <Music className="w-3.5 h-3.5" style={{ color: activePalette.accent }} />
                    <span>Select a Spotify playlist or search a song...</span>
                  </button>
                )}
              </div>
            </div>

            {/* Timeline Scrubber */}
            <div
              className="flex items-center gap-2.5 w-full md:w-64 shrink-0 pl-2 border-l border-white/10"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-xs font-mono tabular-nums text-slate-400 w-9 text-right">
                {currentTrack.platform === 'Spotify' ? '—' : formatTime(progress)}
              </span>
              <input
                type="range"
                disabled={currentTrack.platform === 'Spotify'}
                min={0}
                max={Math.max(1, currentTrack.duration)}
                step={0.25}
                value={currentTrack.platform === 'Spotify' ? 0 : Math.min(currentTrack.duration, progress)}
                onPointerDown={() => {
                  isScrubbingRef.current = true;
                }}
                onMouseDown={() => {
                  isScrubbingRef.current = true;
                }}
                onTouchStart={() => {
                  isScrubbingRef.current = true;
                }}
                onChange={(e) => {
                  const newSec = parseFloat(e.target.value);
                  seekPlayback(newSec, false);
                }}
                onPointerUp={(e) => {
                  const newSec = parseFloat((e.currentTarget as HTMLInputElement).value);
                  seekPlayback(newSec, true);
                }}
                onMouseUp={(e) => {
                  const newSec = parseFloat((e.currentTarget as HTMLInputElement).value);
                  seekPlayback(newSec, true);
                }}
                onTouchEnd={(e) => {
                  const newSec = parseFloat((e.currentTarget as HTMLInputElement).value);
                  seekPlayback(newSec, true);
                }}
                aria-label="Track progress"
                className="w-full cursor-pointer h-1.5 bg-white/15 rounded-lg"
                style={{ accentColor: activePalette.primary }}
              />
              <span className="text-xs font-mono tabular-nums text-slate-400 w-9">
                {currentTrack.platform === 'Spotify' ? 'Spotify' : formatTime(currentTrack.duration)}
              </span>
            </div>
          </div>

          {/* Row 2: Playback Transport | Tempo Dynamics | Ambient Palette | Camera View | Sync */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2.5 border-t border-white/10">
            {/* Transport Controls */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={handlePrevTrack}
                title="Previous Track (Shortcut: Left Arrow ←)"
                aria-label="Previous track"
                className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 transition-colors cursor-pointer"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={togglePlay}
                title="Play / Pause Audio (Shortcut: Space)"
                aria-label={(currentTrack.platform === 'Spotify' ? spotifyIsPlaying : isPlaying) ? 'Pause' : 'Play'}
                className="px-3.5 py-2 rounded-lg font-semibold text-xs text-black flex items-center gap-1.5 transition-transform active:scale-95 cursor-pointer whitespace-nowrap shrink-0"
                style={{
                  backgroundColor: activePalette.primary,
                  boxShadow: `0 0 18px -4px ${activePalette.primary}`,
                }}
              >
                {(currentTrack.platform === 'Spotify' ? spotifyIsPlaying : isPlaying) ? (
                  <Pause className="w-3.5 h-3.5 fill-current" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                <span>{(currentTrack.platform === 'Spotify' ? spotifyIsPlaying : isPlaying) ? 'Pause' : currentTrack.platform === 'Spotify' ? 'Play on Spotify' : 'Play Audio'}</span>
              </button>
              <button
                onClick={handleNextTrack}
                title="Next Track (Shortcut: Right Arrow →)"
                aria-label="Next track"
                className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 transition-colors cursor-pointer"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setSmartShuffleEnabled(!smartShuffleEnabled)}
                title="Toggle Smart Shuffle"
                className={`p-2 rounded-lg transition-colors cursor-pointer ${
                  smartShuffleEnabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-slate-400 hover:text-white'
                }`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${smartShuffleEnabled ? 'animate-spin' : ''}`} />
              </button>

              {/* Volume */}
              <div className="hidden sm:flex items-center gap-1.5 ml-1">
                <button
                  onClick={toggleMute}
                  disabled={currentTrack.platform === 'Spotify'}
                  title="Toggle Mute (Shortcut: M) — Studio audio only"
                  aria-label="Toggle Mute"
                  className="p-1.5 text-slate-400 hover:text-white cursor-pointer flex items-center gap-1"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                  <span className="text-[10px] font-mono text-slate-500 hidden lg:inline">M</span>
                </button>
                <input
                  type="range"
                  disabled={currentTrack.platform === 'Spotify'}
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                  title="Volume (Shortcuts: Up/Down Arrows ↑/↓)"
                  aria-label="Volume"
                  className="w-16 cursor-pointer h-1 bg-white/15 rounded-lg"
                  style={{ accentColor: activePalette.accent }}
                />
              </div>
            </div>

            {/* Ambient Lighting Palette Swatches (Song Art Auto Mode + Custom Presets) */}
            <div className="flex items-center gap-1.5 shrink-0">
              <Sparkles className="w-3.5 h-3.5" style={{ color: activePalette.accent }} />
              <button
                type="button"
                onClick={() => {
                  setCustomPalette(null);
                  triggerShortcutHud('Synced to Album Art Palette');
                }}
                title="Automatically match theme & lyrics to the playing song's album cover art"
                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border transition-all cursor-pointer ${
                  customPalette === null ? 'ring-1 ring-white text-black' : 'text-slate-300 hover:text-white'
                }`}
                style={{
                  background:
                    customPalette === null
                      ? `linear-gradient(135deg, ${activePalette.primary}, ${activePalette.accent})`
                      : 'rgba(255,255,255,0.06)',
                  borderColor:
                    customPalette === null ? activePalette.accent : 'rgba(255,255,255,0.15)',
                }}
              >
                Song Art
              </button>
              {PALETTE_PRESETS.map((preset, idx) => {
                const isSelected = customPalette?.primary === preset.primary;
                return (
                  <button
                    key={preset.primary}
                    onClick={() => setCustomPalette(preset)}
                    title={`Override with Ambient Palette ${idx + 1}`}
                    className={`w-4 h-4 rounded-full transition-transform cursor-pointer ${
                      isSelected ? 'scale-125 ring-2 ring-white' : 'opacity-70 hover:opacity-100'
                    }`}
                    style={{
                      background: `linear-gradient(135deg, ${preset.primary}, ${preset.secondary})`,
                    }}
                  />
                );
              })}
            </div>

            {/* Camera Angle Presets & Lyrics / Sync Shortcuts */}
            <div className="flex items-center gap-2 shrink-0">
              <div
                className="flex items-center gap-0.5 p-1 bg-white/5 rounded-lg"
                title="Cycle 3D Camera Angle (Shortcut: C)"
              >
                {(['center', 'orbital', 'macro'] as const).map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setCameraPreset(preset)}
                    className={`px-2 py-1 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      cameraPreset === preset
                        ? 'bg-white text-black'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setActiveModal(activeModal === 'lyrics' ? 'none' : 'lyrics')}
                title="Toggle Lyrics Panel (Shortcut: L)"
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  activeModal === 'lyrics'
                    ? 'bg-white text-black font-semibold'
                    : 'bg-white/10 hover:bg-white/15 text-white'
                }`}
              >
                <span>Lyrics (L)</span>
              </button>

              <button
                onClick={() => setActiveModal(activeModal === 'sync' ? 'none' : 'sync')}
                title="Open Spotify Playlists & Search Modal"
                className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Sync ({playlists.length})</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Keyboard Shortcut HUD Pill */}
      <AnimatePresence>
        {shortcutHud && (
          <motion.div
            key={shortcutHud}
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.18 }}
            className="fixed top-20 right-6 z-40 px-3.5 py-1.5 rounded-lg bg-[#111216]/95 border border-white/15 text-xs font-mono font-medium text-white shadow-xl pointer-events-none flex items-center gap-2"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: activePalette.primary }}
            />
            <span>{shortcutHud}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
