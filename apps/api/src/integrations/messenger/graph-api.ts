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
