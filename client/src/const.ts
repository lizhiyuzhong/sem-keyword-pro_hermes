export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Generate login URL at runtime so redirect URI reflects the current origin.
// Only works when VITE_OAUTH_PORTAL_URL and VITE_APP_ID are configured (Manus platform).
export const getLoginUrl = () => {
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
  const appId = import.meta.env.VITE_APP_ID;

  if (!oauthPortalUrl || !appId) {
    throw new Error("OAuth not configured — VITE_OAUTH_PORTAL_URL and VITE_APP_ID are required.");
  }

  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const state = btoa(redirectUri);

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  return url.toString();
};

/** Safe wrapper for dev mode — returns null when OAuth is not configured. */
export const safeGetLoginUrl = (): string | null => {
  try {
    return getLoginUrl();
  } catch {
    return null;
  }
};
