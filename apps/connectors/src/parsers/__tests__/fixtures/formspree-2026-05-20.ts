/**
 * KAN-954 — verbatim Formspree specimen fetched from Resend Receiving API
 * 2026-05-20. Pinned as the ground-truth fixture for the parser per the
 * schema-claims-verified rule (don't build against assumed external format;
 * fetch + freeze a real specimen first).
 *
 * Provenance:
 *   resend_email_id = a35ff56c-d5df-4190-8e69-272c35dfb9bb
 *   created_at      = 2026-05-20T19:47:47.906Z (15:47:47 ET)
 *   lead_inbox_events.id = 230f6fd1-e79b-464b-8aba-a7bbd530e216
 *   tenant inbox    = c03065f6@leads.axisone.ca
 *   form            = growth landing-page (Formspree form mkoynpbr)
 *   submitter       = cowork-pipeline-test@e2etest.co (synthetic test submitter)
 *
 * Fields below are byte-for-byte from the Receiving API response. Do NOT
 * edit them — if the format changes, re-fetch a fresh specimen via:
 *   GET https://api.resend.com/emails/receiving/{email_id}
 *     with Authorization: Bearer $RESEND_API_KEY_RW
 */

export const FORMSPREE_SPECIMEN_2026_05_20 = {
  emailId: "a35ff56c-d5df-4190-8e69-272c35dfb9bb",
  from: 'noreply@formspree.io',
  // Formspree's display-name shape — handler's extractFromAddress strips it.
  fromHeader: '"Formspree" <noreply@formspree.io>',
  to: ["c03065f6@leads.axisone.ca"],
  subject: "Growth landing — new early-access lead",
  messageId: "<4vzJC7QWSuOSGeF727eIIg@geopod-ismtpd-60>",
  replyTo: ["cowork-pipeline-test@e2etest.co"],
  // Verbatim plain-text body — vertical Label:\nValue\n\n format.
  text: `Hey there,

Someone just submitted your form on formspree.io/. Here's what they had to say:


formSource:
growth-landing-v1


leadType:
early_access_request


name:
Cowork Pipeline Test


email:
cowork-pipeline-test@e2etest.co


company:
E2E Test Co


role:
Founder / CEO


monthlyLeadVolume:
100-500


biggestPain:
COWORK E2E PIPELINE TEST — submitted 2026-05-20T19:47:46.033Z to verify the lead chain (Formspree -&gt; leads.axisone.ca -&gt; Lead API -&gt; Opportunities) lands end to end.



Submitted 07:47 PM - 20 May 2026
---

You are receiving this because you confirmed this email address on <a href="https://formspree.io">Formspree</a>. If you don't remember doing that, or no longer wish to receive these emails, please remove the form on formspree.io/ or visit //formspree.io/unsubscribe/bef721c32b537881d3407c377f0bfff0c5b8127da75f6b9613b7c0ebdefefc20/NTI2OTczMw.3_drl1D_ESzWDD0RDNq70DcS6UA?email=c03065f6@leads.axisone.ca to unsubscribe from this endpoint.`,
  headers: {
    "from": '"Formspree" <noreply@formspree.io>',
    "to": "c03065f6@leads.axisone.ca",
    "reply-to": "cowork-pipeline-test@e2etest.co",
    "subject": "Growth landing — new early-access lead",
    "message-id": "<4vzJC7QWSuOSGeF727eIIg@geopod-ismtpd-60>",
    "mime-version": "1.0",
    "content-type": "multipart/alternative",
    "authentication-results":
      "amazonses.com; spf=pass (spfCheck: domain of email.formspree.io designates 149.72.68.181 as permitted sender) client-ip=149.72.68.181; envelope-from=bounces+5120942-4f35-c03065f6=leads.axisone.ca@email.formspree.io; helo=o2.ptr1523.formspree.io; dkim=pass header.i=@formspree.io; dmarc=pass header.from=formspree.io;",
    "return-path":
      "bounces+5120942-4f35-c03065f6=leads.axisone.ca@email.formspree.io",
  },
} as const;
