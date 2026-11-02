import express from 'express';
import { createServer as createViteServer } from 'vite';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

// Runtime credentials store (supports environment secrets OR UI-configured credentials)
let runtimeSpotifyCreds: {
  clientId: string;
  clientSecret: string;
} = {
  clientId: (process.env.SPOTIFY_CLIENT_ID || process.env.CLIENT_ID || '').trim(),
  clientSecret: (process.env.SPOTIFY_CLIENT_SECRET || process.env.CLIENT_SECRET || '').trim(),
};

// Active Spotify session store with PKCE codeVerifiers by state
let spotifySession: {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
  lastRedirectUri: string | null;
  userProfile: {
    id: string;
    displayName: string;
    email?: string;
    product?: string;
    avatarUrl?: string;
  } | null;
} = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  lastRedirectUri: null,
  userProfile: null,
};

const pkceStore = new Map<string, { codeVerifier: string; redirectUri: string; clientId: string }>();

function getActiveCredentials(reqClientId?: string, reqClientSecret?: string) {
  const clientId = (
    reqClientId ||
    runtimeSpotifyCreds.clientId ||
    process.env.SPOTIFY_CLIENT_ID ||
    process.env.CLIENT_ID ||
    ''
  ).trim();
  const clientSecret = (
    reqClientSecret ||
    runtimeSpotifyCreds.clientSecret ||
    process.env.SPOTIFY_CLIENT_SECRET ||
    process.env.CLIENT_SECRET ||
    ''
  ).trim();
  return { clientId, clientSecret };
}

function getRedirectUri(req: express.Request): string {
  const customRedirect = req.query.redirect_uri as string | undefined;
  if (customRedirect) {
    return customRedirect.replace(/\/$/, '');
  }
  const appUrl = (
    process.env.APP_URL || `${req.protocol}://${req.get('host')}`
  ).replace(/\/$/, '');
  return `${appUrl}/auth/callback`;
}

function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// Save runtime Spotify Client ID & Secret from UI if not in env
app.post('/api/auth/credentials', (req, res) => {
  const { clientId, clientSecret } = req.body || {};
  if (typeof clientId === 'string') {
    runtimeSpotifyCreds.clientId = clientId.trim();
  }
  if (typeof clientSecret === 'string') {
    runtimeSpotifyCreds.clientSecret = clientSecret.trim();
  }
  const active = getActiveCredentials();
  res.json({
    saved: true,
    hasClientId: Boolean(active.clientId),
    hasClientSecret: Boolean(active.clientSecret),
  });
});

// 1. Construct Spotify OAuth URL (Supports Authorization Code + PKCE)
app.get('/api/auth/url', (req, res) => {
  const queryClientId = req.query.client_id as string | undefined;
  const queryClientSecret = req.query.client_secret as string | undefined;
  if (queryClientId) runtimeSpotifyCreds.clientId = queryClientId.trim();
  if (queryClientSecret) runtimeSpotifyCreds.clientSecret = queryClientSecret.trim();

  const { clientId } = getActiveCredentials();
  const redirectUri = getRedirectUri(req);
  spotifySession.lastRedirectUri = redirectUri;

  if (!clientId) {
    res.status(400).json({
      error:
        'Spotify Client ID is not configured. Enter your Spotify Client ID in the OAuth Setup modal or AI Studio Secrets panel.',
      redirectUri,
    });
    return;
  }

  const { codeVerifier, codeChallenge } = generatePkcePair();
  const stateId = crypto.randomBytes(16).toString('hex');
  pkceStore.set(stateId, { codeVerifier, redirectUri, clientId });

  const statePayload = Buffer.from(
    JSON.stringify({ stateId, redirectUri, clientId, codeVerifier })
  ).toString('base64url');

  const scopes = [
    'streaming',
    'user-read-private',
    'user-read-email',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'user-read-recently-played',
    'user-top-read',
    'user-library-read',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes,
    state: statePayload,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    show_dialog: 'true',
  });

  res.json({
    url: `https://accounts.spotify.com/authorize?${params.toString()}`,
    redirectUri,
  });
});

// 2. OAuth Callback Handler (Supports Confidential Client Secret AND PKCE Fallback)
const callbackHandler: express.RequestHandler = async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error('[Spotify OAuth Callback] Provider error:', error);
    res.status(400).send(
      renderCallbackHtml({
        success: false,
        error: `Spotify authorization error: ${String(error)}`,
        errorCode: String(error),
        statusCode: 400,
      })
    );
    return;
  }

  if (!code || typeof code !== 'string') {
    res.status(400).send(
      renderCallbackHtml({
        success: false,
        error: 'Missing authorization code from Spotify callback.',
        errorCode: 'missing_code',
        statusCode: 400,
      })
    );
    return;
  }

  let redirectUri = spotifySession.lastRedirectUri || getRedirectUri(req);
  let stateClientId = '';
  let codeVerifier = '';

  if (typeof state === 'string') {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
      if (decoded.redirectUri) redirectUri = decoded.redirectUri;
      if (decoded.clientId) stateClientId = decoded.clientId;
      if (decoded.codeVerifier) codeVerifier = decoded.codeVerifier;
      if (decoded.stateId && pkceStore.has(decoded.stateId)) {
        const stored = pkceStore.get(decoded.stateId)!;
        codeVerifier = stored.codeVerifier;
        redirectUri = stored.redirectUri;
        stateClientId = stored.clientId;
        pkceStore.delete(decoded.stateId);
      }
    } catch {
      // Ignore state decode error
    }
  }

  const { clientId, clientSecret } = getActiveCredentials(stateClientId);

  if (!clientId) {
    res.status(400).send(
      renderCallbackHtml({
        success: false,
        error: 'Missing Spotify Client ID during token exchange.',
        errorCode: 'missing_credentials',
        statusCode: 400,
        redirectUri,
      })
    );
    return;
  }

  try {
    let tokenRes;
    // Try Confidential Client exchange if Client Secret is provided, otherwise or on failure try PKCE
    if (clientSecret) {
      try {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenParams = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        });
        if (codeVerifier) {
          tokenParams.set('code_verifier', codeVerifier);
        }

        tokenRes = await axios.post(
          'https://accounts.spotify.com/api/token',
          tokenParams.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${basicAuth}`,
            },
          }
        );
      } catch (secretErr: any) {
        // If Basic Auth fails and we have a PKCE code_verifier, try PKCE client_id exchange
        if (codeVerifier) {
          const pkceParams = new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          });
          tokenRes = await axios.post(
            'https://accounts.spotify.com/api/token',
            pkceParams.toString(),
            {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            }
          );
        } else {
          throw secretErr;
        }
      }
    } else if (codeVerifier) {
      const pkceParams = new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      tokenRes = await axios.post(
        'https://accounts.spotify.com/api/token',
        pkceParams.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );
    } else {
      throw new Error('Missing both Client Secret and PKCE code_verifier.');
    }

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // Fetch user profile immediately so the app has the user's real Spotify identity
    let userProfile = null;
    try {
      const meRes = await axios.get('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      userProfile = {
        id: meRes.data.id,
        displayName: meRes.data.display_name || meRes.data.id,
        email: meRes.data.email,
        product: meRes.data.product,
        avatarUrl: meRes.data.images?.[0]?.url,
      };
    } catch {
      // Non-fatal if profile endpoint is restricted
    }

    spotifySession = {
      accessToken: access_token,
      refreshToken: refresh_token || spotifySession.refreshToken,
      expiresAt: Date.now() + (expires_in || 3600) * 1000,
      lastRedirectUri: redirectUri,
      userProfile,
    };

    res.send(
      renderCallbackHtml({
        success: true,
        accessToken: access_token,
        refreshToken: refresh_token,
        redirectUri,
      })
    );
  } catch (err: any) {
    const statusCode = err.response?.status || 500;
    const errorCode = err.response?.data?.error || 'token_exchange_failed';
    const spotifyErr =
      err.response?.data?.error_description ||
      err.response?.data?.error ||
      err.message ||
      'Token exchange failed';

    console.error('[Spotify OAuth Callback] Token Exchange Error:', {
      status: statusCode,
      errorCode,
      description: spotifyErr,
      responseData: err.response?.data,
      redirectUri,
    });

    res.status(200).send(
      renderCallbackHtml({
        success: false,
        error: spotifyErr,
        errorCode,
        statusCode,
        redirectUri,
        rawDetails: JSON.stringify(err.response?.data || { message: err.message }),
      })
    );
  }
};

app.get(['/auth/callback', '/auth/callback/'], callbackHandler);

function renderCallbackHtml(payload: {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
  errorCode?: string;
  statusCode?: number;
  redirectUri?: string;
  rawDetails?: string;
}): string {
  const safeJson = JSON.stringify({
    type: payload.success ? 'OAUTH_AUTH_SUCCESS' : 'OAUTH_AUTH_ERROR',
    accessToken: payload.accessToken || null,
    refreshToken: payload.refreshToken || null,
    error: payload.error || null,
    errorCode: payload.errorCode || null,
    statusCode: payload.statusCode || null,
    redirectUri: payload.redirectUri || null,
    rawDetails: payload.rawDetails || null,
    timestamp: new Date().toISOString(),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${payload.success ? 'Spotify Connected' : 'Spotify Connection Notice'}</title>
  <style>
    body {
      background: #0a0a0a;
      color: #f8fafc;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
      text-align: center;
    }
    .box {
      max-width: 460px;
      border: 1px solid rgba(255,255,255,0.12);
      background: #121214;
      padding: 28px;
      border-radius: 14px;
    }
    h2 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
    p { margin: 0 0 16px; font-size: 14px; color: #94a3b8; line-height: 1.5; word-break: break-word; }
    button {
      background: #1DB954;
      color: #050505;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="box">
    <h2>${payload.success ? 'Spotify Connected Successfully' : 'Spotify Authorization Issue'}</h2>
    <p>${payload.success ? 'Returning to MuseVis Audio...' : payload.error}</p>
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    (function() {
      var data = ${safeJson};
      if (window.opener) {
        window.opener.postMessage(data, '*');
        if (data.type === 'OAUTH_AUTH_SUCCESS') {
          setTimeout(function() { window.close(); }, 300);
        }
      }
    })();
  </script>
</body>
</html>`;
}

// 2b. Silent Validation of Spotify Client ID and Client Secret
app.post('/api/auth/validate-credentials', async (req, res) => {
  const { clientId: bodyClientId, clientSecret: bodyClientSecret } = req.body || {};
  if (typeof bodyClientId === 'string' && bodyClientId.trim()) {
    runtimeSpotifyCreds.clientId = bodyClientId.trim();
  }
  if (typeof bodyClientSecret === 'string' && bodyClientSecret.trim()) {
    runtimeSpotifyCreds.clientSecret = bodyClientSecret.trim();
  }

  const { clientId, clientSecret } = getActiveCredentials();
  const redirectUri = getRedirectUri(req);

  const clientIdStatus = clientId
    ? `Configured (${clientId.slice(0, 4)}...${clientId.slice(-4)}, ${clientId.length} chars)`
    : 'Missing';
  const clientSecretStatus = clientSecret
    ? `Configured (${clientSecret.length} chars)`
    : 'Missing (PKCE Mode Available)';

  if (!clientId) {
    res.status(400).json({
      valid: false,
      code: 'missing_client_id',
      status: 400,
      message: 'SPOTIFY_CLIENT_ID is missing.',
      remediation:
        'Paste your Spotify Client ID in the Credentials input below (or in the AI Studio Secrets panel) and click Check OAuth Credentials.',
      clientIdStatus,
      clientSecretStatus,
      redirectUri,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (!clientSecret) {
    res.json({
      valid: true,
      code: 'pkce_ready',
      status: 200,
      message:
        'Spotify Client ID is configured. You can sign in immediately using OAuth 2.0 PKCE (even without a Client Secret), or add your Client Secret for confidential server exchange.',
      remediation:
        'Ensure the Redirect URI above is saved in your Spotify Developer Dashboard, then click Connect Spotify.',
      clientIdStatus,
      clientSecretStatus,
      redirectUri,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams({ grant_type: 'client_credentials' });

    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`,
        },
        timeout: 6000,
      }
    );

    res.json({
      valid: true,
      code: 'credentials_verified',
      status: tokenRes.status,
      message:
        'Spotify API verified your Client ID and Client Secret via silent Client Credentials grant.',
      remediation:
        'Credentials are 100% valid. Make sure the Redirect URI above is added in your Spotify Dashboard, then click Retry Spotify Sign-In.',
      tokenType: tokenRes.data?.token_type || 'Bearer',
      expiresIn: tokenRes.data?.expires_in || 3600,
      clientIdStatus,
      clientSecretStatus,
      redirectUri,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    const status = err.response?.status || 500;
    const spotifyError = err.response?.data?.error || 'validation_failed';
    const spotifyDesc =
      err.response?.data?.error_description ||
      err.message ||
      'Spotify rejected the client credentials request.';

    res.status(200).json({
      valid: false,
      code: spotifyError,
      status,
      message: `Spotify API rejected credentials: ${spotifyDesc} (${spotifyError}).`,
      remediation:
        'Check your Client ID and Client Secret in the inputs below or AI Studio Secrets panel.',
      clientIdStatus,
      clientSecretStatus,
      redirectUri,
      timestamp: new Date().toISOString(),
    });
  }
});

// 2c. Validate and Save a Direct Spotify Access Token
app.post('/api/spotify/verify-token', async (req, res) => {
  const { accessToken } = req.body || {};
  const token = String(accessToken || '').trim();
  if (!token) {
    res.status(400).json({ error: 'Please provide a valid Spotify Access Token.' });
    return;
  }

  try {
    const profileRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const userProfile = {
      id: profileRes.data.id,
      displayName: profileRes.data.display_name || profileRes.data.id,
      email: profileRes.data.email,
      product: profileRes.data.product,
      avatarUrl: profileRes.data.images?.[0]?.url,
    };

    spotifySession = {
      accessToken: token,
      refreshToken: null,
      expiresAt: Date.now() + 3600 * 1000,
      lastRedirectUri: getRedirectUri(req),
      userProfile,
    };

    res.json({
      connected: true,
      accessToken: token,
      user: userProfile,
    });
  } catch (err: any) {
    res.status(401).json({
      connected: false,
      error:
        err.response?.data?.error?.message ||
        'Spotify rejected this access token. Ensure it has not expired.',
    });
  }
});

// 2d. Disconnect Spotify Session
app.post('/api/spotify/logout', (_req, res) => {
  spotifySession = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
    lastRedirectUri: null,
    userProfile: null,
  };
  res.json({ connected: false });
});

// 3. Spotify Status & Profile Proxy
app.get('/api/spotify/status', async (req, res) => {
  const headerToken = req.headers.authorization?.replace('Bearer ', '')?.trim();
  const token =
    headerToken && headerToken !== 'server_managed_session'
      ? headerToken
      : spotifySession.accessToken;
  const activeCreds = getActiveCredentials();
  const hasSecrets = Boolean(activeCreds.clientId);
  const redirectUri = getRedirectUri(req);

  if (!token) {
    res.json({
      connected: false,
      hasSecrets,
      hasClientId: Boolean(activeCreds.clientId),
      hasClientSecret: Boolean(activeCreds.clientSecret),
      redirectUri,
    });
    return;
  }

  try {
    const profileRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const user = {
      id: profileRes.data.id,
      displayName: profileRes.data.display_name || profileRes.data.id,
      email: profileRes.data.email,
      product: profileRes.data.product,
      avatarUrl: profileRes.data.images?.[0]?.url,
    };
    spotifySession.userProfile = user;

    res.json({
      connected: true,
      hasSecrets,
      hasClientId: Boolean(activeCreds.clientId),
      hasClientSecret: Boolean(activeCreds.clientSecret),
      redirectUri,
      accessToken: token,
      user,
    });
  } catch (err: any) {
    res.json({
      connected: false,
      hasSecrets,
      hasClientId: Boolean(activeCreds.clientId),
      hasClientSecret: Boolean(activeCreds.clientSecret),
      redirectUri,
      error: err.response?.data?.error?.message || 'Token expired or invalid',
    });
  }
});

// 4. Fetch User Playlists, Initial Playlist Tracks & Currently Playing from Spotify
app.get('/api/spotify/library', async (req, res) => {
  const headerToken = req.headers.authorization?.replace('Bearer ', '')?.trim();
  const token =
    headerToken && headerToken !== 'server_managed_session'
      ? headerToken
      : spotifySession.accessToken;

  if (!token) {
    res.status(401).json({ error: 'Not authenticated with Spotify' });
    return;
  }

  try {
    const [playlistsRes, currentRes] = await Promise.allSettled([
      axios.get('https://api.spotify.com/v1/me/playlists?limit=15', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    const playlists =
      playlistsRes.status === 'fulfilled' ? playlistsRes.value.data.items || [] : [];
    const currentlyPlaying =
      currentRes.status === 'fulfilled' && currentRes.value.status === 200
        ? currentRes.value.data
        : null;

    // Fetch real tracks from the user's first available non-empty playlist so the dock shows real Spotify songs immediately
    let initialTracks: any[] = [];
    let initialPlaylistId: string | null = null;
    for (const pl of playlists.slice(0, 6)) {
      if (!pl?.id) continue;
      try {
        const plTracksRes = await axios.get(
          `https://api.spotify.com/v1/playlists/${pl.id}/tracks?limit=25`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const rawItems = plTracksRes.data?.items || [];
        const tracks = rawItems
          .map((item: any) => item?.track || item?.item)
          .filter((t: any) => t && t.id && t.name);
        if (tracks.length > 0) {
          initialTracks = tracks;
          initialPlaylistId = pl.id;
          break;
        }
      } catch {
        // Try next playlist if this one is restricted (e.g., algorithmic mix in Dev mode)
      }
    }

    // Fallback to user's saved tracks or recently played if all playlists were restricted/empty
    if (initialTracks.length === 0) {
      try {
        const savedRes = await axios.get('https://api.spotify.com/v1/me/tracks?limit=20', {
          headers: { Authorization: `Bearer ${token}` },
        });
        initialTracks = (savedRes.data?.items || [])
          .map((item: any) => item?.track)
          .filter((t: any) => t && t.id && t.name);
      } catch {
        // Ignore if scope not granted on older token
      }
    }

    res.json({
      playlists,
      currentlyPlaying,
      initialTracks,
      initialPlaylistId,
      user: spotifySession.userProfile,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Fetch Tracks for a Specific Spotify Playlist
app.get('/api/spotify/playlists/:id/tracks', async (req, res) => {
  const headerToken = req.headers.authorization?.replace('Bearer ', '')?.trim();
  const token =
    headerToken && headerToken !== 'server_managed_session'
      ? headerToken
      : spotifySession.accessToken;

  if (!token) {
    res.status(401).json({ error: 'Not authenticated with Spotify' });
    return;
  }

  try {
    const tracksRes = await axios.get(
      `https://api.spotify.com/v1/playlists/${req.params.id}/tracks?limit=25`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const tracks = (tracksRes.data.items || [])
      .map((item: any) => item?.track)
      .filter((t: any) => t && t.id && t.name);
    res.json({ items: tracksRes.data.items || [], tracks });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Spotify Search Proxy (Uses active user token OR client_credentials token if configured)
app.get('/api/spotify/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.json({ tracks: [] });
    return;
  }

  const headerToken = req.headers.authorization?.replace('Bearer ', '')?.trim();
  let token =
    headerToken && headerToken !== 'server_managed_session'
      ? headerToken
      : spotifySession.accessToken;

  if (!token) {
    const { clientId, clientSecret } = getActiveCredentials();
    if (clientId && clientSecret) {
      try {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenRes = await axios.post(
          'https://accounts.spotify.com/api/token',
          'grant_type=client_credentials',
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${basicAuth}`,
            },
            timeout: 4500,
          }
        );
        token = tokenRes.data?.access_token || null;
      } catch {
        // Ignore if client credentials unavailable
      }
    }
  }

  if (token) {
    try {
      const searchRes = await axios.get(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=14`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        }
      );
      res.json({ tracks: searchRes.data?.tracks?.items || [] });
      return;
    } catch {
      // Fall through to empty list so client uses full-stream catalog fallback
    }
  }

  res.json({ tracks: [] });
});

// 7. Spotify Live Player State & Remote Control Proxy
app.get('/api/spotify/player', async (req, res) => {
  const headerToken = req.headers.authorization?.replace('Bearer ', '')?.trim();
  const token =
    headerToken && headerToken !== 'server_managed_session'
      ? headerToken
      : spotifySession.accessToken;

  if (!token) {
    res.status(401).json({ error: 'Not authenticated with Spotify' });
    return;
  }

  try {
    const playerRes = await axios.get('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
      timeout: 4500,
    });
    if (playerRes.status === 200 && playerRes.data) {
      res.json({ active: true, player: playerRes.data });
      return;
    }
    res.json({ active: false, player: null });
  } catch (err: any) {
    res.status(200).json({ active: false, player: null, error: err.message });
  }
});

app.post('/api/spotify/player', async (req, res) => {
  const headerToken = req.headers.authorization?.replace('Bearer ', '')?.trim();
  const token =
    headerToken && headerToken !== 'server_managed_session'
      ? headerToken
      : spotifySession.accessToken;

  if (!token) {
    res.status(401).json({ ok: false, error: 'Not authenticated with Spotify' });
    return;
  }

  const { action, contextUri, trackUri, positionMs, deviceId } = req.body || {};
  try {
    let targetDeviceId = deviceId || null;
    if (!targetDeviceId && (action === 'play' || action === 'seek')) {
      try {
        const devRes = await axios.get('https://api.spotify.com/v1/me/player/devices', {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 3500,
        });
        const devices: any[] = Array.isArray(devRes.data?.devices) ? devRes.data.devices : [];
        const activeDev = devices.find((d) => d.is_active) || devices[0];
        if (activeDev?.id) targetDeviceId = activeDev.id;
      } catch {
        // Proceed without device_id
      }
    }

    const deviceQuery = targetDeviceId ? `?device_id=${encodeURIComponent(targetDeviceId)}` : '';
    let endpoint = `https://api.spotify.com/v1/me/player/play${deviceQuery}`;
    let method: 'PUT' | 'POST' = 'PUT';
    let data: any = undefined;

    if (action === 'play') {
      method = 'PUT';
      endpoint = `https://api.spotify.com/v1/me/player/play${deviceQuery}`;
      if (trackUri) {
        data = {
          uris: [trackUri],
          ...(typeof positionMs === 'number' ? { position_ms: Math.max(0, Math.round(positionMs)) } : {}),
        };
      } else if (contextUri) {
        data = { context_uri: contextUri };
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
      const pos = Math.max(0, Math.round(positionMs || 0));
      const devParam = targetDeviceId ? `&device_id=${encodeURIComponent(targetDeviceId)}` : '';
      endpoint = `https://api.spotify.com/v1/me/player/seek?position_ms=${pos}${devParam}`;
    }

    const spRes = await axios({
      url: endpoint,
      method,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      validateStatus: () => true,
      timeout: 5000,
    });

    res.json({ ok: spRes.status >= 200 && spRes.status < 300, status: spRes.status });
  } catch (err: any) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// 8. Full-Length Audio Stream & Catalog Resolver (Direct 320kbps AAC streams with byte-range support)
const fullStreamCache = new Map<
  string,
  { streamUrl: string; coverUrl: string | null; duration: number; isFullTrack: boolean }
>();

const JIOSAAVN_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'X-Forwarded-For': '49.36.128.1',
};

function decodeHtmlEntitiesServer(str: string): string {
  return String(str || '')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&#039;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeTrackTokenServer(str: string): string {
  return decodeHtmlEntitiesServer(str)
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s*-\s*(?:remaster|single|version|from|mono|stereo|deluxe|explicit).*$/gi, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function isStrictTrackMatchServer(
  candidateTitle: string,
  candidateArtist: string,
  targetTitle: string,
  targetArtist: string
): boolean {
  const cTitle = normalizeTrackTokenServer(candidateTitle);
  const tTitle = normalizeTrackTokenServer(targetTitle);
  if (!cTitle || !tTitle) return false;

  const rawCandLower = decodeHtmlEntitiesServer(`${candidateTitle} ${candidateArtist}`).toLowerCase();
  const rawTargetLower = decodeHtmlEntitiesServer(`${targetTitle} ${targetArtist}`).toLowerCase();

  // Reject karaoke, tribute, instrumental, nightcore, slowed, 8-bit, or cover versions unless explicitly requested
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

  const titleMatches =
    cTitle === tTitle ||
    (cTitle.includes(tTitle) && tTitle.length >= Math.max(3, Math.floor(cTitle.length * 0.5))) ||
    (tTitle.includes(cTitle) && cTitle.length >= Math.max(3, Math.floor(tTitle.length * 0.5)));

  if (!titleMatches) return false;

  const tArtist = normalizeTrackTokenServer(targetArtist.split(',')[0]);
  if (!tArtist) return true;

  const cArtist = normalizeTrackTokenServer(candidateArtist);
  return cArtist.includes(tArtist) || tArtist.includes(cArtist);
}

async function resolveJioSaavnDirectStreamUrl(encryptedMediaUrl: string): Promise<string | null> {
  if (!encryptedMediaUrl) return null;
  try {
    const authRes = await axios.get(
      `https://www.jiosaavn.com/api.php?__call=song.generateAuthToken&url=${encodeURIComponent(
        encryptedMediaUrl
      )}&bitrate=320&api_version=4&_format=json&ctx=web6dot0&_marker=0`,
      {
        headers: JIOSAAVN_HEADERS,
        timeout: 4000,
      }
    );
    const rawAuthUrl = String(authRes.data?.auth_url || '').trim();
    if (!rawAuthUrl) return null;
    const directAacUrl = rawAuthUrl
      .split('?')[0]
      .replace(/^https?:\/\/web\.saavncdn\.com\//i, 'https://aac.saavncdn.com/')
      .replace(/^http:\/\//i, 'https://');
    if (directAacUrl.startsWith('https://')) {
      return directAacUrl;
    }
  } catch {
    // Ignore error
  }
  return null;
}

function extractJioSaavnArtists(item: any): string {
  const primary = item?.more_info?.artistMap?.primary_artists;
  if (Array.isArray(primary) && primary.length > 0) {
    return primary.map((a: any) => decodeHtmlEntitiesServer(a?.name || '')).filter(Boolean).join(', ');
  }
  const allArtists = item?.more_info?.artistMap?.artists;
  if (Array.isArray(allArtists) && allArtists.length > 0) {
    return allArtists
      .slice(0, 3)
      .map((a: any) => decodeHtmlEntitiesServer(a?.name || ''))
      .filter(Boolean)
      .join(', ');
  }
  return decodeHtmlEntitiesServer(String(item?.subtitle || '').split(' - ')[0] || 'Artist');
}

function extractJioSaavnCover(item: any): string | null {
  const rawImg = String(item?.image || '').trim();
  if (rawImg.startsWith('http')) {
    return rawImg
      .replace('150x150', '500x500')
      .replace('50x50', '500x500')
      .replace(/^http:\/\//i, 'https://');
  }
  return null;
}

// 8a. Full-Track Catalog Search Endpoint (/api/audio/search?q=...)
app.get('/api/audio/search', async (req, res) => {
  const query = decodeHtmlEntitiesServer(String(req.query.q || '').trim());
  if (!query) {
    res.json({ tracks: [] });
    return;
  }

  try {
    const searchRes = await axios.get(
      `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=18&p=1&q=${encodeURIComponent(
        query
      )}`,
      {
        headers: JIOSAAVN_HEADERS,
        timeout: 4500,
      }
    );

    const rawResults: any[] = Array.isArray(searchRes.data?.results) ? searchRes.data.results : [];
    const seenTitles = new Set<string>();
    const filteredCandidates: any[] = [];

    for (const item of rawResults) {
      const title = decodeHtmlEntitiesServer(String(item?.title || item?.song || '').trim());
      const artist = extractJioSaavnArtists(item);
      const dur = Number(item?.more_info?.duration || item?.duration || 0);
      const encUrl = String(item?.more_info?.encrypted_media_url || '');
      const lang = String(item?.language || '').toLowerCase();

      if (!title || !encUrl || dur < 60) continue;
      if (lang === 'instrumental') continue;

      const lowerCombined = `${title} ${artist}`.toLowerCase();
      if (
        lowerCombined.includes('karaoke') ||
        lowerCombined.includes('tribute') ||
        lowerCombined.includes('originally performed') ||
        lowerCombined.includes('originally perfomed') ||
        lowerCombined.includes('in the style of')
      ) {
        continue;
      }

      const dedupKey = `${normalizeTrackTokenServer(title)}::${normalizeTrackTokenServer(
        artist.split(',')[0]
      )}`;
      if (seenTitles.has(dedupKey)) continue;
      seenTitles.add(dedupKey);

      filteredCandidates.push(item);
      if (filteredCandidates.length >= 10) break;
    }

    const resolvedTracks = (
      await Promise.all(
        filteredCandidates.map(async (item) => {
          const encUrl = String(item?.more_info?.encrypted_media_url || '');
          const streamUrl = await resolveJioSaavnDirectStreamUrl(encUrl);
          if (!streamUrl) return null;

          const title = decodeHtmlEntitiesServer(String(item?.title || 'Track').trim());
          const artist = extractJioSaavnArtists(item);
          const album = decodeHtmlEntitiesServer(
            String(item?.more_info?.album || item?.album || title).trim()
          );
          const duration = Math.round(Number(item?.more_info?.duration || 200));
          const coverUrl = extractJioSaavnCover(item);

          // Pre-cache in fullStreamCache so playing any track is instantaneous
          const primaryArtist = artist.split(',')[0].trim();
          const cleanTitle = title
            .replace(/\s*\(.*?\)\s*/g, '')
            .replace(/\s*\[.*?\]\s*/g, '')
            .replace(/\s*-.*$/, '')
            .trim();
          const cacheKey = `${cleanTitle.toLowerCase()}::${primaryArtist.toLowerCase()}`;
          fullStreamCache.set(cacheKey, {
            streamUrl,
            coverUrl,
            duration,
            isFullTrack: true,
          });

          return {
            id: String(item?.id || `saavn-${Math.random().toString(36).slice(2, 8)}`),
            title,
            artist,
            album,
            duration,
            coverUrl,
            streamUrl,
            isFullTrack: true,
          };
        })
      )
    ).filter(Boolean);

    res.json({ tracks: resolvedTracks });
  } catch (err: any) {
    res.status(200).json({ tracks: [], error: err.message });
  }
});

// 8b. Single-Track Full-Length Stream Resolver (/api/audio/full-stream?title=...&artist=...)
app.get('/api/audio/full-stream', async (req, res) => {
  const rawTitle = decodeHtmlEntitiesServer(String(req.query.title || '').trim());
  const rawArtist = decodeHtmlEntitiesServer(String(req.query.artist || '').trim());
  if (!rawTitle) {
    res.status(400).json({ error: 'Missing title parameter' });
    return;
  }

  const primaryArtist = rawArtist.split(',')[0].trim();
  const cleanTitle = rawTitle
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/\s*\[.*?\]\s*/g, '')
    .replace(/\s*-.*$/, '')
    .trim();
  const cacheKey = `${cleanTitle.toLowerCase()}::${primaryArtist.toLowerCase()}`;

  if (fullStreamCache.has(cacheKey)) {
    res.json(fullStreamCache.get(cacheKey));
    return;
  }

  const searchQuery = `${cleanTitle} ${primaryArtist}`.trim();
  const encodedQuery = encodeURIComponent(searchQuery);

  // Provider 1: Primary JioSaavn Direct API (320kbps AAC with full byte-range support)
  try {
    const searchRes = await axios.get(
      `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=10&p=1&q=${encodedQuery}`,
      {
        headers: JIOSAAVN_HEADERS,
        timeout: 4200,
      }
    );
    const results: any[] = Array.isArray(searchRes.data?.results) ? searchRes.data.results : [];
    const strictMatch = results.find((item) => {
      const candTitle = decodeHtmlEntitiesServer(String(item?.title || item?.song || ''));
      const candArtist = extractJioSaavnArtists(item);
      const dur = Number(item?.more_info?.duration || 0);
      const lang = String(item?.language || '').toLowerCase();
      if (dur < 60 || lang === 'instrumental' || !item?.more_info?.encrypted_media_url) {
        return false;
      }
      return isStrictTrackMatchServer(candTitle, candArtist, cleanTitle, primaryArtist);
    });

    if (strictMatch) {
      const streamUrl = await resolveJioSaavnDirectStreamUrl(
        String(strictMatch.more_info.encrypted_media_url)
      );
      const duration = Math.round(Number(strictMatch.more_info.duration || 200));
      if (streamUrl && duration >= 60) {
        const payload = {
          streamUrl,
          coverUrl: extractJioSaavnCover(strictMatch),
          duration,
          isFullTrack: true,
        };
        fullStreamCache.set(cacheKey, payload);
        res.json(payload);
        return;
      }
    }
  } catch {
    // Fall through to secondary mirror
  }

  // Provider 2: Saavn Sumit API Mirror with strict title + artist verification
  try {
    const mirrorRes = await axios.get(
      `https://saavn.sumit.co/api/search/songs?query=${encodedQuery}&page=0&limit=10`,
      { timeout: 4000 }
    );
    const results: any[] = mirrorRes.data?.data?.results || [];
    const strictMirrorMatch = results.find((r) => {
      const rName = decodeHtmlEntitiesServer(String(r?.name || r?.title || ''));
      const rArtists = decodeHtmlEntitiesServer(
        String(
          r?.artists?.primary?.map((a: any) => a.name).join(', ') ||
            r?.primaryArtists ||
            r?.subtitle ||
            ''
        )
      );
      const dur = Number(r?.duration || 0);
      const lang = String(r?.language || '').toLowerCase();
      return (
        dur >= 60 &&
        lang !== 'instrumental' &&
        isStrictTrackMatchServer(rName, rArtists, cleanTitle, primaryArtist)
      );
    });

    if (strictMirrorMatch) {
      const urls = strictMirrorMatch?.downloadUrl || [];
      const bestUrlObj = Array.isArray(urls) && urls.length > 0 ? urls[urls.length - 1] : null;
      const streamUrl = String(bestUrlObj?.url || bestUrlObj?.link || '').replace(
        /^http:\/\//i,
        'https://'
      );
      const duration = Math.round(Number(strictMirrorMatch?.duration || 200));
      if (streamUrl.startsWith('https://') && duration >= 60) {
        const imgs = strictMirrorMatch?.image || [];
        const lastImg = Array.isArray(imgs) && imgs.length > 0 ? imgs[imgs.length - 1] : null;
        const coverUrl = String(lastImg?.url || lastImg?.link || '').replace(
          /^http:\/\//i,
          'https://'
        );
        const payload = {
          streamUrl,
          coverUrl: coverUrl || null,
          duration,
          isFullTrack: true,
        };
        fullStreamCache.set(cacheKey, payload);
        res.json(payload);
        return;
      }
    }
  } catch {
    // Fall through to iTunes fallback
  }

  // Provider 3: iTunes Search fallback with strict title + artist verification
  try {
    const itunesRes = await axios.get(
      `https://itunes.apple.com/search?term=${encodedQuery}&entity=song&limit=6`,
      { timeout: 4000 }
    );
    const items: any[] = itunesRes.data?.results || [];
    const matchedItunes = items.find((it) =>
      isStrictTrackMatchServer(
        String(it?.trackName || ''),
        String(it?.artistName || ''),
        cleanTitle,
        primaryArtist
      )
    );
    if (matchedItunes?.previewUrl) {
      const hiResCover = matchedItunes.artworkUrl100
        ? String(matchedItunes.artworkUrl100).replace('100x100bb', '600x600bb')
        : null;
      res.json({
        streamUrl: matchedItunes.previewUrl,
        coverUrl: hiResCover,
        duration: Math.round(Number(matchedItunes.trackTimeMillis || 180000) / 1000),
        isFullTrack: false,
      });
      return;
    }
  } catch {
    // Ignore
  }

  res.status(404).json({ error: 'No matching audio stream found' });
});

// 8c. Duration-Matched Synchronized LRC Lyrics Endpoint (/api/audio/lyrics?title=...&artist=...&duration=...)
app.get('/api/audio/lyrics', async (req, res) => {
  const rawTitle = decodeHtmlEntitiesServer(String(req.query.title || '').trim());
  const rawArtist = decodeHtmlEntitiesServer(String(req.query.artist || '').trim());
  const targetDuration = Number(req.query.duration || 200);

  if (!rawTitle) {
    res.status(400).json({ error: 'Missing title' });
    return;
  }

  const primaryArtist = rawArtist.split(',')[0].trim();
  const cleanTitle = rawTitle
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/\s*\[.*?\]\s*/g, '')
    .replace(/\s*-.*$/, '')
    .trim();

  const normTargetTitle = normalizeTrackTokenServer(cleanTitle);

  const isCleanTitleCandidate = (candTitle: string, candArtist: string): boolean => {
    const cTitle = normalizeTrackTokenServer(candTitle);
    if (!cTitle || !normTargetTitle) return false;
    const rawLower = `${candTitle} ${candArtist}`.toLowerCase();
    if (
      rawLower.includes('karaoke') ||
      rawLower.includes('instrumental') ||
      rawLower.includes('tribute') ||
      rawLower.includes('nightcore') ||
      rawLower.includes('ringtone')
    ) {
      return false;
    }
    return (
      cTitle === normTargetTitle ||
      (cTitle.includes(normTargetTitle) &&
        normTargetTitle.length >= Math.max(4, Math.floor(cTitle.length * 0.6))) ||
      (normTargetTitle.includes(cTitle) &&
        cTitle.length >= Math.max(4, Math.floor(normTargetTitle.length * 0.6)))
    );
  };

  try {
    // 1. Search LRCLIB with track_name + artist_name
    const searchParams = new URLSearchParams({
      track_name: cleanTitle,
      artist_name: primaryArtist,
    });
    let lrcRes = await axios.get(`https://lrclib.net/api/search?${searchParams.toString()}`, {
      timeout: 4500,
    });
    let items: any[] = Array.isArray(lrcRes.data) ? lrcRes.data : [];

    // 2. Fallback to combined query search
    if (items.length === 0) {
      const qParams = new URLSearchParams({
        q: `${cleanTitle} ${primaryArtist}`.trim(),
      });
      lrcRes = await axios.get(`https://lrclib.net/api/search?${qParams.toString()}`, {
        timeout: 4500,
      });
      items = Array.isArray(lrcRes.data) ? lrcRes.data : [];
    }

    let verified = items.filter((it) =>
      isStrictTrackMatchServer(
        String(it?.trackName || it?.name || ''),
        String(it?.artistName || ''),
        cleanTitle,
        primaryArtist
      )
    );

    // 3. If strict artist+title match found nothing (e.g. regional/film songs where composer vs singer credit differs), search by clean title
    if (verified.length === 0) {
      if (items.length === 0) {
        const titleOnlyParams = new URLSearchParams({ q: cleanTitle });
        const titleRes = await axios.get(
          `https://lrclib.net/api/search?${titleOnlyParams.toString()}`,
          { timeout: 4500 }
        );
        items = Array.isArray(titleRes.data) ? titleRes.data : [];
      } else {
        const titleOnlyParams = new URLSearchParams({ q: cleanTitle });
        try {
          const titleRes = await axios.get(
            `https://lrclib.net/api/search?${titleOnlyParams.toString()}`,
            { timeout: 4000 }
          );
          if (Array.isArray(titleRes.data)) {
            items = [...items, ...titleRes.data];
          }
        } catch {
          // Ignore secondary search failure
        }
      }

      verified = items.filter((it) =>
        isCleanTitleCandidate(
          String(it?.trackName || it?.name || ''),
          String(it?.artistName || '')
        )
      );
    }

    const syncedCandidates = verified.filter(
      (it) => typeof it?.syncedLyrics === 'string' && it.syncedLyrics.trim().length > 0
    );

    if (syncedCandidates.length > 0) {
      syncedCandidates.sort(
        (a, b) =>
          Math.abs(Number(a.duration || targetDuration) - targetDuration) -
          Math.abs(Number(b.duration || targetDuration) - targetDuration)
      );
      const best = syncedCandidates[0];
      res.json({
        syncedLyrics: best.syncedLyrics,
        plainLyrics: best.plainLyrics || null,
        duration: Number(best.duration || targetDuration),
      });
      return;
    }

    const plainCandidate = verified.find(
      (it) => typeof it?.plainLyrics === 'string' && it.plainLyrics.trim().length > 0
    );
    if (plainCandidate) {
      res.json({
        syncedLyrics: null,
        plainLyrics: plainCandidate.plainLyrics,
        duration: Number(plainCandidate.duration || targetDuration),
      });
      return;
    }
  } catch {
    // Fall through to JioSaavn / Lyrics.ovh fallback
  }

  // 4. Fallback to JioSaavn official song lyrics API if available
  try {
    const q = encodeURIComponent(`${cleanTitle} ${primaryArtist}`.trim());
    const searchRes = await axios.get(
      `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=5&p=1&q=${q}`,
      { headers: JIOSAAVN_HEADERS, timeout: 3500 }
    );
    const results: any[] = Array.isArray(searchRes.data?.results) ? searchRes.data.results : [];
    const match =
      results.find((r) =>
        isCleanTitleCandidate(
          decodeHtmlEntitiesServer(String(r?.title || r?.song || '')),
          extractJioSaavnArtists(r)
        )
      ) || results[0];

    if (match?.id) {
      const lyrRes = await axios.get(
        `https://www.jiosaavn.com/api.php?__call=lyrics.getLyrics&lyrics_id=${encodeURIComponent(
          String(match.id)
        )}&ctx=web6dot0&api_version=4&_format=json&_marker=0`,
        { headers: JIOSAAVN_HEADERS, timeout: 3500 }
      );
      const rawHtml = String(lyrRes.data?.lyrics || '').trim();
      if (rawHtml && rawHtml.length > 20) {
        const plainLyrics = decodeHtmlEntitiesServer(
          rawHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .trim()
        );
        if (plainLyrics.split('\n').filter(Boolean).length >= 3) {
          res.json({
            syncedLyrics: null,
            plainLyrics,
            duration: targetDuration,
          });
          return;
        }
      }
    }
  } catch {
    // Ignore JioSaavn lyrics error
  }

  // 5. Fallback to Lyrics.ovh
  if (primaryArtist && cleanTitle) {
    try {
      const ovhRes = await axios.get(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(primaryArtist)}/${encodeURIComponent(
          cleanTitle
        )}`,
        { timeout: 3500 }
      );
      const rawLyrics = String(ovhRes.data?.lyrics || '').trim();
      if (rawLyrics && rawLyrics.length > 20) {
        res.json({
          syncedLyrics: null,
          plainLyrics: rawLyrics.replace(/^Paroles de la chanson.*?\n/i, '').trim(),
          duration: targetDuration,
        });
        return;
      }
    } catch {
      // Ignore
    }
  }

  res.status(404).json({ error: 'No matching lyrics found' });
});

// 9. CORS Audio Stream Proxy (Allows Web Audio API AnalyserNode to process any remote stream cleanly)
app.get('/api/audio/proxy', async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    res.status(400).send('Invalid audio stream URL');
    return;
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ...(targetUrl.includes('saavncdn.com') ? { 'X-Forwarded-For': '49.36.128.1' } : {}),
    };
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await axios.get(targetUrl, {
      responseType: 'stream',
      headers,
      timeout: 12000,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', String(upstream.headers['content-type'] || 'audio/mp4'));
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', String(upstream.headers['content-length']));
    }
    if (upstream.headers['content-range']) {
      res.setHeader('Content-Range', upstream.headers['content-range']);
    }
    res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');

    req.on('close', () => {
      try {
        upstream.data.destroy();
      } catch {
        // Ignore cleanup error
      }
    });

    upstream.data.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.end();
      }
    });

    upstream.data.pipe(res);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(502).send(`Audio proxy error: ${err.message}`);
    }
  }
});

async function startServer() {
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: false,
    },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`MuseVis Audio server running on port ${port}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is already managed by the platform process.`);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer();
