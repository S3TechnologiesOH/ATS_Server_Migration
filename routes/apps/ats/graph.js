/**
 * Microsoft Graph Routes Module
 * Handles all /graph/* and /meetings/* and /emails/* endpoints
 * Includes authentication, calendar, email, user search, scheduling
 */

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();

// MSAL configuration - will be initialized if env vars are present
let graphMsal = null;
const GRAPH_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "Mail.ReadWrite",
  "Mail.Send",
  "People.Read",
];

// Graph redirect URI - configured via env
const GRAPH_REDIRECT_URI = process.env.GRAPH_REDIRECT_URI ||
  "https://ats.s3protection.com/api/ats/api/ats/graph/callback";

/**
 * Initialize the graph router with MSAL client
 * @param {Object} deps - Dependencies including graphMsal client
 */
function initGraph(deps) {
  if (deps.graphMsal) {
    graphMsal = deps.graphMsal;
  }
}

// Helper to get graph token from session
function getGraphToken(req) {
  const g = req.session?.graph;
  if (!g || !g.accessToken) return null;
  if (g.expiresAt && g.expiresAt <= Date.now()) return null;
  return g.accessToken;
}

// Middleware to attach graph token to request
function requireGraphAuth(req, res, next) {
  const token = getGraphToken(req);
  if (!token) {
    return res.status(401).json({ error: "graph_auth_required" });
  }
  req.graphToken = token;
  next();
}

// ==================== GRAPH AUTH ====================
// GET /graph/login - Start Graph auth
router.get("/graph/login", (req, res) => {
  if (!graphMsal) {
    return res.status(500).json({ error: "graph_not_configured" });
  }
  if (!GRAPH_REDIRECT_URI) {
    return res.status(500).json({ error: "graph_redirect_not_configured" });
  }

  const state = crypto.randomBytes(16).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");
  req.session.graphAuthState = state;
  req.session.graphAuthNonce = nonce;

  graphMsal
    .getAuthCodeUrl({
      scopes: GRAPH_SCOPES,
      redirectUri: GRAPH_REDIRECT_URI,
      responseMode: "query",
      state,
      nonce,
    })
    .then((url) => res.redirect(url))
    .catch((e) =>
      res.status(500).json({ error: "graph_auth_url_error", detail: e.message })
    );
});

// GET /graph/callback - Graph OAuth callback
router.get("/graph/callback", async (req, res) => {
  if (!graphMsal) {
    return res.status(500).json({ error: "graph_not_configured" });
  }

  const { code, state } = req.query;
  if (!code) return res.status(400).json({ error: "missing_code" });
  if (!state || state !== req.session.graphAuthState) {
    return res.status(400).json({ error: "invalid_state" });
  }

  try {
    const tokenResp = await graphMsal.acquireTokenByCode({
      code,
      scopes: GRAPH_SCOPES,
      redirectUri: GRAPH_REDIRECT_URI,
    });

    const { accessToken, refreshToken, expiresOn } = tokenResp;
    req.session.graph = {
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt: expiresOn ? expiresOn.getTime() : Date.now() + 55 * 60 * 1000,
    };

    delete req.session.graphAuthState;
    delete req.session.graphAuthNonce;
    res.redirect("/ats/graph/success");
  } catch (e) {
    res.status(500).json({ error: "graph_token_error", detail: e.message });
  }
});

// GET /graph/success - Success page for popup completion
router.get("/graph/success", (req, res) => {
  res.send(`
    <html>
      <head><title>Graph Authentication Successful</title></head>
      <body>
        <h2>Microsoft Graph Authentication Successful</h2>
        <p>You can now close this window.</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'graph-auth-success' }, '*');
          }
          setTimeout(() => window.close(), 1000);
        </script>
      </body>
    </html>
  `);
});

// GET /graph/status - Check auth status
router.get("/graph/status", (req, res) => {
  const g = req.session?.graph;
  if (!g) return res.json({ authenticated: false });
  const expiresInSec = Math.max(0, Math.floor((g.expiresAt - Date.now()) / 1000));
  res.json({ authenticated: true, expiresInSec });
});

// ==================== GRAPH USERS ====================
// GET /graph/users - Search users
router.get("/graph/users", requireGraphAuth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const top = Math.max(1, Math.min(50, parseInt(req.query.top || "10", 10)));

  if (!q || q.length < 2) return res.json({ users: [] });

  const commonHeaders = {
    Authorization: `Bearer ${req.graphToken}`,
    "Content-Type": "application/json",
  };

  try {
    let users = [];

    // Try People API first for relevance
    try {
      const u1 = new URL("https://graph.microsoft.com/v1.0/me/people");
      u1.searchParams.set("$search", q);
      u1.searchParams.set("$top", String(top));
      u1.searchParams.set("$select", "displayName,scoredEmailAddresses");

      const r1 = await axios.get(u1.toString(), {
        headers: { ...commonHeaders, ConsistencyLevel: "eventual" },
      });

      if (r1.data?.value) {
        users = (r1.data.value || [])
          .map((p) => ({
            name: p.displayName || p.scoredEmailAddresses?.[0]?.address || "",
            email: p.scoredEmailAddresses?.[0]?.address || "",
          }))
          .filter((u) => u.email);
      }
    } catch {}

    // Fallback to Users API if People API didn't return results
    if (!users.length) {
      try {
        const u2 = new URL("https://graph.microsoft.com/v1.0/users");
        u2.searchParams.set("$search", `"${q}"`);
        u2.searchParams.set("$top", String(top));
        u2.searchParams.set("$select", "displayName,mail,userPrincipalName");

        const r2 = await axios.get(u2.toString(), {
          headers: { ...commonHeaders, ConsistencyLevel: "eventual" },
        });

        if (r2.data?.value) {
          users = (r2.data.value || [])
            .map((u) => ({
              name: u.displayName || u.mail || u.userPrincipalName,
              email: u.mail || u.userPrincipalName,
            }))
            .filter((u) => u.email);
        }
      } catch {}
    }

    return res.json({ users });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    return res.status(status).json({ error: "graph_users_error", detail });
  }
});

// ==================== GRAPH SCHEDULING ====================
// POST /graph/getSchedule - Get free/busy schedules
router.post("/graph/getSchedule", requireGraphAuth, async (req, res) => {
  try {
    const { attendees = [], startISO, endISO, intervalMinutes = 30 } = req.body || {};

    if (!Array.isArray(attendees) || attendees.length === 0) {
      return res.json({ schedules: [] });
    }

    const body = {
      schedules: attendees,
      startTime: {
        dateTime: startISO || new Date().toISOString(),
        timeZone: "UTC",
      },
      endTime: {
        dateTime: endISO || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        timeZone: "UTC",
      },
      availabilityViewInterval: intervalMinutes,
    };

    const resp = await axios.post(
      "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
      body,
      {
        headers: {
          Authorization: `Bearer ${req.graphToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({ schedules: resp.data.value || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    return res.status(status).json({ error: "graph_schedule_error", detail });
  }
});

// POST /graph/createEvent - Create calendar event
router.post("/graph/createEvent", requireGraphAuth, async (req, res) => {
  try {
    const {
      subject,
      body = "",
      startISO,
      endISO,
      attendees = [],
      isOnline = true,
      location,
    } = req.body || {};

    if (!subject || !startISO || !endISO) {
      return res.status(400).json({ error: "missing_required_fields" });
    }

    const eventBody = {
      subject,
      body: { contentType: "HTML", content: body || "" },
      start: { dateTime: startISO, timeZone: "UTC" },
      end: { dateTime: endISO, timeZone: "UTC" },
      attendees: (Array.isArray(attendees) ? attendees : []).map((e) => ({
        emailAddress: { address: e },
        type: "required",
      })),
      location: location ? { displayName: location } : undefined,
      isOnlineMeeting: !!isOnline,
      onlineMeetingProvider: isOnline ? "teamsForBusiness" : "unknown",
    };

    const resp = await axios.post(
      "https://graph.microsoft.com/v1.0/me/events",
      eventBody,
      {
        headers: {
          Authorization: `Bearer ${req.graphToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = resp.data || {};
    return res.status(201).json({
      id: data.id,
      webLink: data.webLink,
      joinUrl: data.onlineMeeting?.joinUrl || null,
    });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    return res.status(status).json({ error: "graph_create_event_error", detail });
  }
});

// ==================== MEETINGS ====================
// GET /meetings - List calendar events
router.get("/meetings", async (req, res) => {
  const token = getGraphToken(req);
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  try {
    const startISO = req.query.startISO || new Date().toISOString();
    const endISO = req.query.endISO || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      startDateTime: startISO,
      endDateTime: endISO,
    });

    const url = `https://graph.microsoft.com/v1.0/me/calendar/calendarView?${params.toString()}&$top=50&$select=subject,organizer,start,end,webLink,attendees,onlineMeeting`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const items = (resp.data.value || []).map((ev) => ({
      id: ev.id,
      subject: ev.subject,
      start: ev.start?.dateTime,
      end: ev.end?.dateTime,
      organizer: {
        name: ev.organizer?.emailAddress?.name,
        address: ev.organizer?.emailAddress?.address,
      },
      attendees: (ev.attendees || []).map((a) => ({
        name: a.emailAddress?.name,
        address: a.emailAddress?.address,
        type: a.type,
        status: a.status?.response || "none",
      })),
      webLink: ev.webLink,
    }));

    res.json({ items });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    res.status(status).json({ error: "graph_calendar_error", detail });
  }
});

// ==================== EMAILS ====================
// GET /emails - List email threads for a specific address
router.get("/emails", async (req, res) => {
  const token = getGraphToken(req);
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const email = req.query.email;
  const top = parseInt(req.query.top, 10) || 50;

  if (!email) return res.json({ success: true, threads: [] });

  try {
    const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${sinceIso}&$orderby=receivedDateTime desc&$top=${top}&$select=subject,from,toRecipients,ccRecipients,replyTo,conversationId,receivedDateTime,bodyPreview,webLink`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let items = resp.data.value || [];

    // Filter messages involving the specified email
    const emailLc = email.trim().toLowerCase();
    const involves = (m) => {
      const from = m.from?.emailAddress?.address?.toLowerCase() || "";
      const to = (m.toRecipients || []).map((r) => r?.emailAddress?.address?.toLowerCase()).filter(Boolean);
      const cc = (m.ccRecipients || []).map((r) => r?.emailAddress?.address?.toLowerCase()).filter(Boolean);
      const rt = (m.replyTo || []).map((r) => r?.emailAddress?.address?.toLowerCase()).filter(Boolean);
      return from === emailLc || to.includes(emailLc) || cc.includes(emailLc) || rt.includes(emailLc);
    };
    items = items.filter(involves);

    // Group by conversationId
    const threadsMap = new Map();
    for (const m of items) {
      const cid = m.conversationId || m.id;
      if (!threadsMap.has(cid)) threadsMap.set(cid, []);
      threadsMap.get(cid).push(m);
    }

    // Sort each thread by receivedDateTime asc
    const threads = Array.from(threadsMap.entries()).map(([id, msgs]) => ({
      id,
      messages: msgs.sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime)),
    }));

    // Sort threads by latest activity desc
    threads.sort(
      (a, b) =>
        new Date(b.messages[b.messages.length - 1].receivedDateTime) -
        new Date(a.messages[a.messages.length - 1].receivedDateTime)
    );

    res.json({ success: true, threads });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    res.status(status).json({ success: false, error: "graph_email_error", detail });
  }
});

// GET /emails/thread - Get full thread by conversationId
router.get("/emails/thread", async (req, res) => {
  const token = getGraphToken(req);
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const conversationId = req.query.conversationId;
  const top = parseInt(req.query.top, 10) || 100;

  if (!conversationId) return res.json({ success: true, messages: [] });

  try {
    const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const filter = `conversationId eq '${conversationId}' and receivedDateTime ge ${sinceIso}`;
    const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=${encodeURIComponent(filter)}&$top=${top}&$select=subject,from,toRecipients,ccRecipients,replyTo,conversationId,receivedDateTime,bodyPreview,body,webLink`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const since = new Date(sinceIso);
    const messages = (resp.data.value || [])
      .filter((m) => new Date(m.receivedDateTime) >= since)
      .sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime));

    res.json({ success: true, messages });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    res.status(status).json({ success: false, error: "graph_email_error", detail });
  }
});

// POST /emails/send - Send a new email
router.post("/emails/send", async (req, res) => {
  const token = getGraphToken(req);
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const { to, subject, html, cc = [] } = req.body;
  if (!to || !subject) {
    return res.status(400).json({ success: false, error: "Missing to/subject" });
  }

  try {
    const body = {
      message: {
        subject,
        body: { contentType: "HTML", content: html || "" },
        toRecipients: [].concat(to).filter(Boolean).map((a) => ({ emailAddress: { address: a } })),
        ccRecipients: [].concat(cc).filter(Boolean).map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: true,
    };

    await axios.post("https://graph.microsoft.com/v1.0/me/sendMail", body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    res.json({ success: true });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    res.status(status).json({ success: false, error: "graph_send_error", detail });
  }
});

// POST /emails/reply - Reply to an email
router.post("/emails/reply", async (req, res) => {
  const token = getGraphToken(req);
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const { messageId, html } = req.body;
  if (!messageId) {
    return res.status(400).json({ success: false, error: "Missing messageId" });
  }

  try {
    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`;

    await axios.post(
      url,
      {
        comment: "",
        message: { body: { contentType: "HTML", content: html || "" } },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ success: true });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 800) : e.message;
    res.status(status).json({ success: false, error: "graph_reply_error", detail });
  }
});

module.exports = router;
module.exports.initGraph = initGraph;
module.exports.getGraphToken = getGraphToken;
module.exports.requireGraphAuth = requireGraphAuth;
