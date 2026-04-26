/**
 * Facebook Messenger Graph API Client
 * Handles page messaging, webhook subscription, and message sending.
 * Reuses token exchange from the meta integration — Messenger uses the same
 * Facebook Login flow but with different permissions (pages_messaging).
 */

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

// ── Re-export shared token helpers from meta integration ────────────────────
// The token exchange flow is identical — only permissions differ.
export {
  exchangeCodeForToken,
  getLongLivedToken,
  getUserPages,
} from "../meta/graph-api.js";

// ── Messenger-specific functions ────────────────────────────────────────────

export type ValidatePageTokenResult =
  | { ok: true; pageId: string; pageName: string }
  | { ok: false; reason: "token_expired" | "page_unbound" | "unknown"; detail?: string };

/**
 * Cheap liveness check: GET /me with a Page Access Token returns the Page
 * identity (id + name) — proves the token is alive AND still bound to its
 * Page. Used by Settings → Channels "Test connection" (KAN-474 subtask 1).
 *
 * Classification mirrors apps/connectors/src/adapters/meta/errors.ts so the
 * UI can branch on token_expired (offer Reconnect CTA) vs page_unbound
 * (operator must re-grant from Facebook side).
 */
export async function validatePageToken(
  pageAccessToken: string,
): Promise<ValidatePageTokenResult> {
  const url = `${GRAPH_API_BASE}/me?fields=id,name&access_token=${encodeURIComponent(
    pageAccessToken,
  )}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, reason: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { id?: string; name?: string };
    if (typeof data.id === "string" && typeof data.name === "string") {
      return { ok: true, pageId: data.id, pageName: data.name };
    }
    return { ok: false, reason: "unknown", detail: "Graph /me missing id or name" };
  }
  const errBody = (await res.json().catch(() => ({}))) as {
    error?: { code?: number; subcode?: number; message?: string; type?: string };
  };
  const code = errBody.error?.code;
  const subcode = errBody.error?.subcode;
  // Meta error code 190 = OAuth invalid/expired token. Subcodes 458 (user
  // not authorized), 460 (password change), 463 (expired) all indicate
  // token-side failure → the user must re-OAuth.
  if (code === 190) {
    return {
      ok: false,
      reason: "token_expired",
      detail: errBody.error?.message ?? `Meta OAuth error ${subcode ?? code}`,
    };
  }
  // Code 100 / 803 commonly mean Page no longer accessible to this app.
  if (code === 100 || code === 803) {
    return {
      ok: false,
      reason: "page_unbound",
      detail: errBody.error?.message ?? `Page lookup failed (code ${code})`,
    };
  }
  return {
    ok: false,
    reason: "unknown",
    detail: errBody.error?.message ?? `Graph /me ${res.status}`,
  };
}

/**
 * Subscribe a page to the Messenger webhook (messages field).
 */
export async function subscribePageToMessages(
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  const url = `${GRAPH_API_BASE}/${pageId}/subscribed_apps`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscribed_fields: "messages,messaging_postbacks,messaging_optins",
      access_token: pageAccessToken,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Messenger page subscription failed: ${JSON.stringify(err)}`);
  }
}

/**
 * Unsubscribe a page from Messenger webhook subscriptions.
 */
export async function unsubscribePageFromMessages(
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  const url = `${GRAPH_API_BASE}/${pageId}/subscribed_apps?access_token=${pageAccessToken}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn(`Messenger page unsubscribe warning: ${JSON.stringify(err)}`);
  }
}

/**
 * Send a text message via Messenger.
 */
export async function sendTextMessage(
  recipientId: string,
  text: string,
  pageAccessToken: string
): Promise<{ recipientId: string; messageId: string }> {
  const url = `${GRAPH_API_BASE}/me/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text },
      access_token: pageAccessToken,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Messenger send failed: ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return {
    recipientId: data.recipient_id,
    messageId: data.message_id,
  };
}

/**
 * Send a message with quick reply buttons via Messenger.
 */
export async function sendQuickReplyMessage(
  recipientId: string,
  text: string,
  quickReplies: Array<{ title: string; payload: string }>,
  pageAccessToken: string
): Promise<{ recipientId: string; messageId: string }> {
  const url = `${GRAPH_API_BASE}/me/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: {
        text,
        quick_replies: quickReplies.map((qr) => ({
          content_type: "text",
          title: qr.title,
          payload: qr.payload,
        })),
      },
      access_token: pageAccessToken,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Messenger quick reply send failed: ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return {
    recipientId: data.recipient_id,
    messageId: data.message_id,
  };
}

/**
 * Get user profile from Messenger PSID.
 */
export async function getMessengerProfile(
  psid: string,
  pageAccessToken: string
): Promise<{ firstName?: string; lastName?: string; profilePic?: string }> {
  const url = `${GRAPH_API_BASE}/${psid}?fields=first_name,last_name,profile_pic&access_token=${pageAccessToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn(`Messenger profile fetch warning: ${JSON.stringify(err)}`);
    return {};
  }
  const data = await res.json();
  return {
    firstName: data.first_name,
    lastName: data.last_name,
    profilePic: data.profile_pic,
  };
}

/**
 * Build the Facebook Login authorization URL for Messenger permissions.
 */
export function buildMessengerAuthorizationUrl(
  appId: string,
  redirectUri: string,
  state: string
): string {
  const url = new URL("https://www.facebook.com/v19.0/dialog/oauth");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "scope",
    "pages_show_list,pages_manage_metadata,pages_messaging"
  );
  url.searchParams.set("response_type", "code");
  return url.toString();
}
