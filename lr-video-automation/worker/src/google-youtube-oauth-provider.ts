import {
  YOUTUBE_READONLY_SCOPE,
  YoutubeOAuthError,
  type YoutubeOAuthProvider,
  type YoutubeOAuthTokenSet,
} from "./e5-youtube-oauth";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
const TIMEOUT_MS = 10_000;

export class GoogleYoutubeOAuthProvider implements YoutubeOAuthProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  authorizationUrl(input: Parameters<YoutubeOAuthProvider["authorizationUrl"]>[0]): string {
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", input.scope);
    url.searchParams.set("access_type", input.accessType);
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "false");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(input: Parameters<YoutubeOAuthProvider["exchangeCode"]>[0]): Promise<YoutubeOAuthTokenSet> {
    return this.token(new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }), true);
  }

  async refresh(refreshToken: string): Promise<YoutubeOAuthTokenSet> {
    return this.token(new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }), false);
  }

  async revoke(token: string): Promise<void> {
    await this.request(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }, "OAUTH_REVOKE_FAILED", false);
  }

  async listMineChannels(accessToken: string): Promise<readonly string[]> {
    const url = new URL(CHANNELS_ENDPOINT);
    url.searchParams.set("part", "id");
    url.searchParams.set("mine", "true");
    const response = await this.request(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    }, "CHANNEL_LOOKUP_FAILED");
    let payload: { items?: unknown };
    try { payload = await response.json() as { items?: unknown }; }
    catch { throw new YoutubeOAuthError("CHANNEL_RESPONSE_INVALID", true); }
    if (!Array.isArray(payload.items)) throw new YoutubeOAuthError("CHANNEL_RESPONSE_INVALID", true);
    return payload.items.map((item) => {
      if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") {
        throw new YoutubeOAuthError("CHANNEL_RESPONSE_INVALID", true);
      }
      return (item as { id: string }).id;
    });
  }

  private async token(body: URLSearchParams, requireRefreshToken: boolean): Promise<YoutubeOAuthTokenSet> {
    const response = await this.request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    }, "OAUTH_TOKEN_REQUEST_FAILED");
    let payload: Record<string, unknown>;
    try { payload = await response.json() as Record<string, unknown>; }
    catch { throw new YoutubeOAuthError("OAUTH_TOKEN_RESPONSE_INVALID", true); }
    if (typeof payload.access_token !== "string" || typeof payload.expires_in !== "number"
      || typeof payload.scope !== "string"
      || (requireRefreshToken && typeof payload.refresh_token !== "string")) {
      throw new YoutubeOAuthError("OAUTH_TOKEN_RESPONSE_INVALID", true);
    }
    return {
      accessToken: payload.access_token,
      ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
      expiresInSeconds: payload.expires_in,
      scopes: payload.scope.split(/\s+/u).filter(Boolean),
    };
  }

  private async request(
    url: string,
    init: RequestInit,
    code: string,
    expectBody = true,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new YoutubeOAuthError(code, true);
    }
    if (!response.ok) {
      let remoteCode: unknown;
      try { remoteCode = ((await response.clone().json()) as { error?: unknown }).error; } catch { /* ignore body */ }
      if (remoteCode === "invalid_grant") throw new YoutubeOAuthError("OAUTH_GRANT_INVALID");
      if (code === "OAUTH_REVOKE_FAILED" && remoteCode === "invalid_token") return response;
      throw new YoutubeOAuthError(code, response.status >= 500 || response.status === 429);
    }
    if (expectBody && response.status === 204) throw new YoutubeOAuthError(code, true);
    return response;
  }
}

export const GOOGLE_YOUTUBE_READONLY_SCOPE = YOUTUBE_READONLY_SCOPE;
