/**
 * Meta Graph API Client
 * Handles token exchange, page subscription, and lead data fetching.
 */

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

export interface MetaTokens {
  shortLivedToken: string;
  longLivedToken: string;
  pageAccessToken: string;
  pageId: string;
  pageName: string;
}

export interface MetaLeadField {
  name: string;
  values: string[];
}

export interface MetaLeadData {
  id: string;
  created_time: string;
  field_data: MetaLeadField[];
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  form_id?: string;
}

/**
 * Exchange an authorization code for a short-lived user access token.
 */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string
): Promise<string> {
  const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta token exchange failed: ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Exchange a short-lived token for a long-lived user access token (~60 days).
 */
export async function getLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string
): Promise<string> {
  const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta long-lived token exchange failed: ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Get all pages the user manages, returning page access tokens.
 * Page access tokens obtained from long-lived user tokens are non-expiring.
 */
export async function getUserPages(
  longLivedToken: string
): Promise<Array<{ id: string; name: string; access_token: string }>> {
  const url = `${GRAPH_API_BASE}/me/accounts?access_token=${longLivedToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta get pages failed: ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return data.data || [];
}

/**
 * Subscribe a page to the leadgen webhook.
 */
export async function subscribePageToLeadgen(
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  const url = `${GRAPH_API_BASE}/${pageId}/subscribed_apps`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscribed_fields: "leadgen",
      access_token: pageAccessToken,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta page subscription failed: ${JSON.stringify(err)}`);
  }
}

/**
 * Unsubscribe a page from all webhook subscriptions.
 */
export async function unsubscribePageFromLeadgen(
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  const url = `${GRAPH_API_BASE}/${pageId}/subscribed_apps?access_token=${pageAccessToken}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn(`Meta page unsubscribe warning: ${JSON.stringify(err)}`);
    // Don't throw — best-effort on disconnect
  }
}

/**
 * Fetch full lead data from the Graph API using a leadgen_id.
 */
export async function fetchLeadData(
  leadgenId: string,
  pageAccessToken: string
): Promise<MetaLeadData> {
  const url = `${GRAPH_API_BASE}/${leadgenId}?access_token=${pageAccessToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta lead fetch failed: ${JSON.stringify(err)}`);
  }
  return res.json();
}

/**
 * Build the Facebook Login authorization URL.
 */
export function buildAuthorizationUrl(
  appId: string,
  redirectUri: string,
  state: string
): string {
  const url = new URL("https://www.facebook.com/v19.0/dialog/oauth");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "pages_show_list,pages_read_engagement");
  url.searchParams.set("response_type", "code");
  return url.toString();
}
