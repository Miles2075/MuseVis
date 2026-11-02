# Debugging Plan: Spotify OAuth Integration

To resolve the "Authentication failed" crash, I will implement a more robust debugging strategy to identify the exact cause of the OAuth flow failure.

## User Review & Critical Decisions

> [!NOTE]
> Since the user has confirmed credentials and redirect URI are correct, the issue is likely due to environment variable injection or subtle configuration mismatches.

- **Proposed Action**: Enhance logging to output environment variable status (sanitized) to confirm they are being loaded by `server.ts` correctly.
- **Verification**: Check server logs after triggering authentication to see if variables are present and valid.

## 1. Overview & Core Concept

- **Goal**: Identify why `spotifyApi.authorizationCodeGrant(code)` is failing despite user confirmation of credentials.
- **Strategy**: 
    1. Log sanitized `process.env` values in `server.ts` upon server startup.
    2. Add detailed error catching around the OAuth exchange.
    3. Verify environment variable access.

## 2. Debugging Steps

1.  **Environment Audit**: Modify `server.ts` to log whether `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are defined at runtime.
2.  **Request Inspection**: Log the `code` received in `/auth/callback` to ensure it is not truncated or malformed.
3.  **Detailed Spotify Error**: Log the full error object returned by `spotify-web-api-node` to catch specific OAuth response codes (e.g., `invalid_grant`, `invalid_client`).

## 3. Technical Implementation

- **Step 1**: Add console logging for env var presence in `server.ts`.
- **Step 2**: If env vars are missing, investigate how AI Studio secrets are mapped to `process.env`.
- **Step 3**: If env vars are present, refine error logging to capture specific Spotify error response payloads.
