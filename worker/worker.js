const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const MANAGED_MARKER = "shiatsu-reservation-web";

// Verejna konfigurace. Tohle muze byt primo ve Workeru.
const DEFAULT_CONFIG = {
  TIMEZONE: "Europe/Prague",
  SITE_URL: "https://shiatsudanica.github.io/",
  ALLOWED_ORIGINS: "https://shiatsudanica.github.io,http://127.0.0.1:8000",
  GOOGLE_CALENDAR_ID:
    "danicashiatsu@gmail.com",
  AVAILABLE_KEYWORDS: "volno,free,available",
  AVAILABLE_SUMMARY: "VOLNO",
  BOOKED_PREFIX: "Rezervace",
  // K zakaznikovi odejde Google Calendar pozvanka i samostatne HTML potvrzeni.
  GOOGLE_SEND_INVITES: "true",
  SLOT_DURATION_MINUTES: "90",
  SLOT_STEP_MINUTES: "90",
  MIN_BOOKING_NOTICE_HOURS: "24",
  CONTACT_NAME: "Danica Kuštera",
  CONTACT_PHONE: "+420 733 571 783",
  CONTACT_EMAIL: "danicashiatsu@gmail.com",
  CONTACT_ADDRESS: "V. Rabase 895, Kladno",
  RESEND_FROM: "",
};

let tokenCache = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/api/slots" && request.method === "GET") {
        return jsonResponse(await handleSlots(url, env), 200, request, env);
      }

      if (url.pathname === "/api/bookings" && request.method === "POST") {
        return jsonResponse(await handleBooking(request, env), 201, request, env);
      }

      if (url.pathname === "/cancel" && request.method === "GET") {
        return await handleCancel(url, env);
      }

      return jsonResponse({ error: "Nenalezeno." }, 404, request, env);
    } catch (error) {
      const status = error.status || 500;
      const message = status >= 500 ? `Serverová chyba: ${error.message}` : error.message;

      if (url.pathname === "/cancel") {
        return htmlResponse(
          status === 409 ? "Rezervaci nelze zrušit online" : "Zrušení se nepodařilo",
          message,
          status,
          env,
        );
      }

      return jsonResponse({ error: message }, status, request, env);
    }
  },
};

async function handleSlots(url, env) {
  const today = dateKey(new Date(), config(env, "TIMEZONE", "Europe/Prague"));
  const from = validDateKey(url.searchParams.get("from")) || today;
  const to = validDateKey(url.searchParams.get("to")) || addDaysKey(today, 45);
  const slots = await listGoogleSlots(env, from, to);

  return {
    mode: "google",
    timezone: config(env, "TIMEZONE", "Europe/Prague"),
    durationMinutes: numberConfig(env, "SLOT_DURATION_MINUTES", 90),
    warnings: [],
    slots,
  };
}

async function handleBooking(request, env) {
  const payload = await request.json().catch(() => ({}));
  const data = validateBookingPayload(payload);
  const decoded = decodeSlotId(data.slotId);
  const requestedStart = new Date(decoded.start);
  const requestedEnd = new Date(decoded.end);
  const payloadStart = new Date(data.start);
  const payloadEnd = new Date(data.end);

  if (Math.abs(requestedStart.getTime() - payloadStart.getTime()) > 1000) {
    throw userError("Začátek termínu neodpovídá vybranému času.", 400);
  }
  if (Math.abs(requestedEnd.getTime() - payloadEnd.getTime()) > 1000) {
    throw userError("Konec termínu neodpovídá vybranému času.", 400);
  }

  const sourceEvent = await googleEvent(env, decoded.source);
  if (!isAvailableEvent(sourceEvent, env)) {
    throw userError("Termín už není volný.", 409);
  }

  const bounds = eventBounds(sourceEvent);
  if (!bounds) {
    throw userError("Termín už není volný.", 409);
  }

  const [availableStart, availableEnd] = bounds;
  if (requestedStart < availableStart || requestedEnd > availableEnd) {
    throw userError("Vybraný čas už není dostupný.", 409);
  }
  if (requestedStart < new Date(Date.now() + bookingNoticeHours(env) * 60 * 60 * 1000)) {
    throw userError(`Rezervaci je potřeba udělat alespoň ${bookingNoticeLabel(env)} předem. Vyberte pozdější čas.`, 409);
  }

  const cancelToken = randomToken();
  const cancelUrl = `${publicBaseUrl(env, request.url)}/cancel?token=${encodeURIComponent(cancelToken)}`;
  const timezone = config(env, "TIMEZONE", "Europe/Prague");
  const body = {
    summary: bookingSummary(requestedStart, env),
    description: bookingDescription(data, requestedStart, requestedEnd, cancelUrl, env),
    start: { dateTime: googleDateTime(requestedStart, timezone), timeZone: timezone },
    end: { dateTime: googleDateTime(requestedEnd, timezone), timeZone: timezone },
    transparency: "opaque",
    extendedProperties: {
      private: {
        managedBy: MANAGED_MARKER,
        cancelToken,
        clientName: data.name,
        clientEmail: data.email,
        clientPhone: data.phone,
        service: data.service,
      },
    },
  };

  if (sourceEvent.location) {
    body.location = sourceEvent.location;
  } else if (config(env, "CONTACT_ADDRESS", "")) {
    body.location = config(env, "CONTACT_ADDRESS", "");
  }

  const googleInvites = googleInviteEnabled(env);
  if (googleInvites) {
    body.attendees = [{ email: data.email, displayName: data.name }];
    body.guestsCanInviteOthers = false;
    body.guestsCanModify = false;
    body.guestsCanSeeOtherGuests = false;
  }

  let bookedEvent;
  try {
    bookedEvent = await googleEventPatch(env, sourceEvent.id, body, {
      ifMatch: sourceEvent.etag,
      sendUpdates: googleInvites ? "all" : "none",
    });
  } catch (error) {
    if (error.status === 409 || error.status === 412) {
      throw userError("Termín byl právě obsazen někým jiným.", 409);
    }
    throw error;
  }

  await createLeftoverEvent(env, availableStart, requestedStart, sourceEvent);
  await createLeftoverEvent(env, requestedEnd, availableEnd, sourceEvent);

  // Calendar pozvanka a HTML potvrzeni jsou dva zamerne samostatne e-maily.
  // Pozvanka umi pridat udalost do kalendare, HTML zprava se spravne zobrazi i v Seznamu.
  const emailResult = await sendBookingEmail(env, data, requestedStart, requestedEnd, cancelUrl);
  const ownerCopySent = emailResult.ownerCopySent;

  return {
    ok: true,
    mode: "google",
    emailSent: emailResult.sent,
    emailConfigured: emailEnabled(env),
    emailError: emailResult.error || "",
    ownerCopySent,
    slot: slotToResponse(bookedEvent.id, requestedStart, requestedEnd, "booked", env),
  };
}

async function handleCancel(url, env) {
  const token = url.searchParams.get("token") || "";
  if (token.length < 20) {
    return htmlResponse("Neplatný odkaz", "Neplatný odkaz pro zrušení rezervace.", 400, env);
  }

  const now = new Date();
  const events = await googleEventsList(env, {
    timeMin: now.toISOString(),
    maxResults: "10",
    singleEvents: "true",
    orderBy: "startTime",
    privateExtendedProperty: `cancelToken=${token}`,
  });
  const event = events.find((item) => isBookedEvent(item, env));
  if (!event) {
    return htmlResponse(
      "Rezervace nenalezena",
      "Tento odkaz už není platný nebo rezervace byla zrušena dříve.",
      404,
      env,
    );
  }

  const bounds = eventBounds(event);
  if (!bounds) {
    return htmlResponse("Rezervace nenalezena", "Termín se nepodařilo najít.", 404, env);
  }

  const [start, end] = bounds;
  const cancelLimit = new Date(Date.now() + bookingNoticeHours(env) * 60 * 60 * 1000);
  if (start < cancelLimit) {
    return htmlResponse(
      "Rezervaci nelze zrušit online",
      `Rezervaci už nejde zrušit odkazem. Zavolejte prosím na ${config(env, "CONTACT_PHONE", "+420 733 571 783")}.`,
      409,
      env,
    );
  }

  const timezone = config(env, "TIMEZONE", "Europe/Prague");
  await googleEventPatch(
    env,
    event.id,
    {
      summary: config(env, "AVAILABLE_SUMMARY", "VOLNO"),
      description: "Termín byl zrušen klientem přes odkaz a je znovu dostupný.",
      start: { dateTime: googleDateTime(start, timezone), timeZone: timezone },
      end: { dateTime: googleDateTime(end, timezone), timeZone: timezone },
      transparency: "transparent",
      attendees: [],
      extendedProperties: {
        private: {
          managedBy: MANAGED_MARKER,
          cancelToken: `cancelled-${token}`,
          cancelledAt: new Date().toISOString(),
        },
      },
    },
    { ifMatch: event.etag, sendUpdates: googleInviteEnabled(env) ? "all" : "none" },
  );

  const privateProps = event.extendedProperties && event.extendedProperties.private
    ? event.extendedProperties.private
    : {};
  await Promise.all([
    sendCancellationEmail(env, privateProps, start, end),
    sendOwnerNotification(env, {
      name: privateProps.clientName,
      email: privateProps.clientEmail,
      phone: privateProps.clientPhone,
      service: privateProps.service,
    }, start, end),
  ]);

  return htmlResponse(
    "Rezervace zrušena",
    `Rezervace na ${humanRange(start, end, env)} byla zrušena. Termín je znovu dostupný.`,
    200,
    env,
  );
}

async function listGoogleSlots(env, from, to) {
  const events = await googleEventsList(env, {
    timeMin: `${from}T00:00:00Z`,
    timeMax: `${addDaysKey(to, 1)}T00:00:00Z`,
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    maxResults: "2500",
  });
  const now = new Date();
  const noticeAt = new Date(now.getTime() + bookingNoticeHours(env) * 60 * 60 * 1000);
  const slots = [];

  for (const event of events) {
    if (isAvailableEvent(event, env)) {
      slots.push(...splitAvailabilityEvent(event, now, env));
    } else if (isBookedEvent(event, env)) {
      const bounds = eventBounds(event);
      if (bounds && bounds[0] >= noticeAt) {
        slots.push(slotToResponse(event.id, bounds[0], bounds[1], "booked", env));
      }
    }
  }

  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

function splitAvailabilityEvent(event, now, env) {
  const bounds = eventBounds(event);
  if (!bounds) return [];

  const [start, end] = bounds;
  const durationMs = numberConfig(env, "SLOT_DURATION_MINUTES", 90) * 60 * 1000;
  const stepMs = numberConfig(env, "SLOT_STEP_MINUTES", numberConfig(env, "SLOT_DURATION_MINUTES", 90)) * 60 * 1000;
  const noticeAt = new Date(now.getTime() + bookingNoticeHours(env) * 60 * 60 * 1000);
  const slots = [];

  for (let cursor = start.getTime(); cursor + durationMs <= end.getTime(); cursor += stepMs) {
    const slotStart = new Date(cursor);
    const slotEnd = new Date(cursor + durationMs);
    if (slotStart >= noticeAt) {
      slots.push(slotToResponse(event.id, slotStart, slotEnd, "available", env));
    }
  }

  return slots;
}

async function createLeftoverEvent(env, start, end, baseEvent) {
  const durationMs = numberConfig(env, "SLOT_DURATION_MINUTES", 90) * 60 * 1000;
  if (end.getTime() - start.getTime() < durationMs) return;
  const timezone = config(env, "TIMEZONE", "Europe/Prague");

  const body = {
    summary: config(env, "AVAILABLE_SUMMARY", "VOLNO"),
    description: "Automaticky vytvořené zbývající volno po rezervaci z webu.",
    start: { dateTime: googleDateTime(start, timezone), timeZone: timezone },
    end: { dateTime: googleDateTime(end, timezone), timeZone: timezone },
    transparency: "transparent",
  };
  if (baseEvent.location) body.location = baseEvent.location;

  await googleEventInsert(env, body, { sendUpdates: "none" });
}

async function googleEventsList(env, params) {
  const query = new URLSearchParams(params);
  const path = `/calendars/${encodeURIComponent(config(env, "GOOGLE_CALENDAR_ID", ""))}/events?${query}`;
  const data = await googleRequest(env, path);
  return data.items || [];
}

async function googleEvent(env, eventId) {
  return googleRequest(env, `/calendars/${encodeURIComponent(config(env, "GOOGLE_CALENDAR_ID", ""))}/events/${encodeURIComponent(eventId)}`);
}

async function googleEventPatch(env, eventId, body, options = {}) {
  const query = new URLSearchParams({ sendUpdates: options.sendUpdates || "none" });
  const headers = { "Content-Type": "application/json" };
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;

  return googleRequest(
    env,
    `/calendars/${encodeURIComponent(config(env, "GOOGLE_CALENDAR_ID", ""))}/events/${encodeURIComponent(eventId)}?${query}`,
    { method: "PATCH", headers, body: JSON.stringify(body) },
  );
}

async function googleEventInsert(env, body, options = {}) {
  const query = new URLSearchParams({ sendUpdates: options.sendUpdates || "none" });
  return googleRequest(
    env,
    `/calendars/${encodeURIComponent(config(env, "GOOGLE_CALENDAR_ID", ""))}/events?${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

async function googleRequest(env, path, options = {}) {
  const token = await getAccessToken(env);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${GOOGLE_CALENDAR_API}${path}`, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : `Google API chyba ${response.status}`;
    throw userError(message, response.status);
  }
  return data;
}

async function getAccessToken(env) {
  if (googleOAuthEnabled(env)) return getOAuthAccessToken(env);
  return getServiceAccountAccessToken(env);
}

async function getOAuthAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.type === "oauth" && tokenCache.expiresAt > now + 60) {
    return tokenCache.accessToken;
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: secretConfig(env, "GOOGLE_CLIENT_ID"),
      client_secret: secretConfig(env, "GOOGLE_CLIENT_SECRET"),
      refresh_token: secretConfig(env, "GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = [data.error, data.error_description].filter(Boolean).join(": ");
    throw userError(
      detail ? `Google OAuth chyba: ${detail}` : "Nepodařilo se obnovit Google OAuth token.",
      500,
    );
  }

  tokenCache = {
    type: "oauth",
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600),
  };
  return tokenCache.accessToken;
}

async function getServiceAccountAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.type === "service-account" && tokenCache.expiresAt > now + 60) {
    return tokenCache.accessToken;
  }

  const account = serviceAccount(env);
  const jwtHeader = base64urlJson({ alg: "RS256", typ: "JWT" });
  const jwtClaim = base64urlJson({
    iss: account.client_email,
    scope: CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${jwtHeader}.${jwtClaim}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${base64urlBytes(new Uint8Array(signature))}`;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw userError(data.error_description || "Nepodařilo se získat Google access token.", 500);
  }

  tokenCache = {
    type: "service-account",
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600),
  };
  return tokenCache.accessToken;
}

function googleOAuthEnabled(env) {
  return Boolean(
    secretConfig(env, "GOOGLE_CLIENT_ID") &&
    secretConfig(env, "GOOGLE_CLIENT_SECRET") &&
    secretConfig(env, "GOOGLE_REFRESH_TOKEN"),
  );
}

function googleInviteEnabled(env) {
  const oauthEnabled = googleOAuthEnabled(env);
  const setting = config(env, "GOOGLE_SEND_INVITES", "auto").toLowerCase();
  if (setting === "false" || setting === "0" || setting === "none") return false;
  if (setting === "true" || setting === "1" || setting === "all") return oauthEnabled;
  return oauthEnabled;
}

function serviceAccount(env) {
  let raw = config(env, "GOOGLE_SERVICE_ACCOUNT_JSON", "");
  if (!raw) throw userError("Chybí GOOGLE_SERVICE_ACCOUNT_JSON.", 500);
  if (!raw.trim().startsWith("{")) raw = atob(raw);
  return JSON.parse(raw);
}

async function importPrivateKey(privateKeyPem) {
  const pem = privateKeyPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(pem);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function validateBookingPayload(payload) {
  if (payload.website) throw userError("Rezervaci se nepodařilo odeslat.", 400);

  const required = ["slotId", "start", "end", "name", "phone", "email", "service"];
  const data = {};
  for (const key of required) {
    data[key] = String(payload[key] || "").trim();
    if (!data[key]) throw userError("Vyplňte prosím všechna povinná pole.", 400);
  }
  data.message = String(payload.message || "").trim();

  if (data.name.length < 2 || data.name.length > 80) throw userError("Jméno musí mít 2 až 80 znaků.", 400);
  if (data.phone.length < 6 || data.phone.length > 30) throw userError("Zkontrolujte telefonní číslo.", 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email) || data.email.length > 120) {
    throw userError("Zkontrolujte e-mailovou adresu.", 400);
  }
  if (data.message.length > 600) throw userError("Zpráva je příliš dlouhá.", 400);

  return data;
}

function bookingDescription(data, start, end, cancelUrl, env) {
  const address = config(env, "CONTACT_ADDRESS", "V. Rabase 895, Kladno");
  const contactName = config(env, "CONTACT_NAME", "Danica Kuštera");
  const contactPhone = config(env, "CONTACT_PHONE", "+420 733 571 783");
  const contactEmail = config(env, "CONTACT_EMAIL", "danicashiatsu@gmail.com");
  const term = longRangeLabel(start, end, env);
  const message = data.message
    ? `<p><strong>Zpráva z formuláře</strong><br>${nl2br(escapeHtml(data.message))}</p>`
    : "";
  return [
    "<p><strong>Rezervace vytvořená z webového formuláře.</strong></p>",
    "<p>",
    `<strong>Jméno:</strong> ${escapeHtml(data.name)}<br>`,
    `<strong>Telefon:</strong> ${escapeHtml(data.phone)}<br>`,
    `<strong>E-mail:</strong> ${escapeHtml(data.email)}<br>`,
    `<strong>Služba:</strong> ${escapeHtml(data.service)}<br>`,
    `<strong>Datum a čas:</strong> ${escapeHtml(term)}<br>`,
    `<strong>Místo:</strong> ${escapeHtml(address)}`,
    "</p>",
    message,
    `<p><a href="${escapeHtml(cancelUrl)}"><strong>Zrušit rezervaci</strong></a></p>`,
    `<p>Rezervaci je možné zrušit tímto odkazem nejpozději ${bookingNoticeLabel(env)} před začátkem. Pozdější změnu termínu prosím řešte telefonicky.</p>`,
    "<p><strong>Kontakt na Danicu</strong><br>",
    `${escapeHtml(contactName)}<br>`,
    `${escapeHtml(contactPhone)}<br>`,
    `<a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a><br>`,
    `${escapeHtml(address)}</p>`,
  ].join("");
}

function bookingSummary(start, env) {
  const timezone = config(env, "TIMEZONE", "Europe/Prague");
  return `${config(env, "BOOKED_PREFIX", "Rezervace")} shiatsu - ${dateLabel(start, timezone)} v ${timeLabel(start, timezone)}`;
}

async function sendBookingEmail(env, data, start, end, cancelUrl) {
  const subject = `Potvrzení rezervace - ${data.service} ${dateLabel(start, config(env, "TIMEZONE", "Europe/Prague"))}`;
  const term = longRangeLabel(start, end, env);
  const body = [
    `Dobrý den, ${data.name},`,
    "",
    "vaše rezervace byla potvrzena.",
    "",
    `Služba: ${data.service}`,
    `Termín: ${term}`,
    `Místo: ${config(env, "CONTACT_ADDRESS", "V. Rabase 895, Kladno")}`,
    `Telefon: ${config(env, "CONTACT_PHONE", "+420 733 571 783")}`,
    `E-mail: ${config(env, "CONTACT_EMAIL", "danicashiatsu@gmail.com")}`,
    "",
    `Rezervaci můžete zrušit nejpozději ${bookingNoticeLabel(env)} před začátkem zde:`,
    cancelUrl,
    "",
    "Pokud potřebujete termín změnit později, zavolejte prosím na uvedené telefonní číslo.",
    "",
    "Shiatsu Danica",
  ].join("\n");

  const html = emailShell(
    "Rezervace je potvrzena",
    [
      `<p>Dobrý den, ${escapeHtml(data.name)},</p>`,
      "<p>Vaše rezervace byla potvrzena.</p>",
      emailDetailsTable([
        ["Služba", data.service],
        ["Termín", term],
        ["Místo", config(env, "CONTACT_ADDRESS", "V. Rabase 895, Kladno")],
        ["Telefon", config(env, "CONTACT_PHONE", "+420 733 571 783")],
        ["E-mail", config(env, "CONTACT_EMAIL", "danicashiatsu@gmail.com")],
      ]),
      `<p style="margin:24px 0 8px;"><a href="${escapeHtml(cancelUrl)}" style="display:inline-block;background:#365847;color:#ffffff;text-decoration:none;padding:13px 18px;border-radius:8px;font-weight:700;">Zrušit rezervaci</a></p>`,
      `<p style="color:#5f6b63;font-size:14px;line-height:1.6;margin:0;">Rezervaci můžete zrušit nejpozději ${bookingNoticeLabel(env)} před začátkem. Pokud potřebujete termín změnit později, zavolejte prosím na uvedené telefonní číslo.</p>`,
    ],
    env,
  );

  const [client, owner] = await Promise.all([
    sendReservationMessage(env, data.email, subject, body, html),
    sendOwnerNotification(env, data, start, end, cancelUrl),
  ]);
  return { ...client, ownerCopySent: owner.sent };
}

function sendOwnerNotification(env, data, start, end, cancelUrl) {
  const title = cancelUrl ? "Nová rezervace z webu" : "Rezervace byla zrušena";
  const rows = [
    ["Jméno", data.name || "Neuvedeno"],
    ["Telefon", data.phone || "Neuvedeno"],
    ["E-mail", data.email || "Neuvedeno"],
    ["Služba", data.service || "Shiatsu 90 minut"],
    [cancelUrl ? "Termín" : "Původní termín", longRangeLabel(start, end, env)],
    ["Místo", config(env, "CONTACT_ADDRESS", "V. Rabase 895, Kladno")],
  ];
  const blocks = [emailDetailsTable(rows)];
  const lines = [title, "", ...rows.map(([label, value]) => `${label}: ${value}`)];
  if (data.message) {
    blocks.push(`<p><strong>Zpráva z formuláře</strong><br>${nl2br(escapeHtml(data.message))}</p>`);
    lines.push("", "Zpráva z formuláře:", data.message);
  }
  const subject = `${title} – ${dateLabel(start, config(env, "TIMEZONE", "Europe/Prague"))}`;
  return sendReservationMessage(env, "danicashiatsu@gmail.com", subject, lines.join("\n"), emailShell(title, blocks, env), data.email);
}

async function sendReservationMessage(env, to, subject, text, html, replyTo) {
  if (!googleOAuthEnabled(env)) return sendEmail(env, to, subject, text, html);

  const fromEmail = config(env, "CONTACT_EMAIL", "danicashiatsu@gmail.com");
  try {
    await sendGmailMessage(env, {
      to,
      fromName: "Shiatsu Danica",
      fromEmail,
      replyTo: replyTo || fromEmail,
      subject,
      text,
      html,
    });
    return { sent: true, error: "" };
  } catch (error) {
    console.log(`Reservation email failed: ${error.message}`);
    return { sent: false, error: "E-mail se nepodařilo odeslat." };
  }
}

async function sendCancellationEmail(env, privateProps, start, end) {
  const email = privateProps.clientEmail;
  if (!email) return false;

  const subject = `Zrušení rezervace - ${dateLabel(start, config(env, "TIMEZONE", "Europe/Prague"))}`;
  const body = [
    `Dobrý den, ${privateProps.clientName || ""},`,
    "",
    "vaše rezervace byla zrušena.",
    "",
    `Služba: ${privateProps.service || "Shiatsu 90 minut"}`,
    `Původní termín: ${humanRange(start, end, env)}`,
    `Místo: ${config(env, "CONTACT_ADDRESS", "V. Rabase 895, Kladno")}`,
    "",
    `V případě dotazu volejte ${config(env, "CONTACT_PHONE", "+420 733 571 783")}.`,
    "",
    "Shiatsu Danica",
  ].join("\n");

  const html = emailShell(
    "Rezervace byla zrušena",
    [
      `<p>Dobrý den, ${escapeHtml(privateProps.clientName || "")},</p>`,
      "<p>Vaše rezervace byla zrušena.</p>",
      emailDetailsTable([
        ["Služba", privateProps.service || "Shiatsu 90 minut"],
        ["Původní termín", humanRange(start, end, env)],
        ["Místo", config(env, "CONTACT_ADDRESS", "V. Rabase 895, Kladno")],
      ]),
      `<p style="color:#5f6b63;font-size:14px;line-height:1.6;">V případě dotazu volejte ${escapeHtml(config(env, "CONTACT_PHONE", "+420 733 571 783"))}.</p>`,
    ],
    env,
  );

  return sendReservationMessage(env, email, subject, body, html);
}

async function sendEmail(env, to, subject, text, html = "") {
  if (!resendEnabled(env)) {
    return { sent: false, error: "E-mailové odesílání není nastavené." };
  }

  try {
    const payload = {
      from: config(env, "RESEND_FROM", ""),
      to,
      subject,
      text,
    };
    if (html) payload.html = html;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.log(`Resend email failed: ${response.status} ${detail}`);
      return { sent: false, error: resendErrorMessage(response.status, detail) };
    }

    return { sent: true, error: "" };
  } catch (error) {
    console.log(`Resend email failed: ${error.message}`);
    return { sent: false, error: error.message || "Neznama chyba Resend API." };
  }
}

async function sendGmailMessage(env, message) {
  const token = await getAccessToken(env);
  const raw = buildMimeMessage(message);
  const response = await fetch(`${GOOGLE_GMAIL_API}/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail API ${response.status}: ${detail}`);
  }

  return response.json();
}

function buildMimeMessage({ to, fromName, fromEmail, replyTo, subject, text, html }) {
  const boundary = `shiatsu-${randomToken()}`;
  const lines = [
    `From: ${mailAddress(fromName, fromEmail)}`,
    `To: ${mailAddress("", to)}`,
  ];
  if (replyTo) lines.push(`Reply-To: ${mailAddress("", replyTo)}`);
  lines.push(
    `Subject: ${mimeEncodedSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64String(text || "")),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64String(html || "")),
    `--${boundary}--`,
    "",
  );
  return base64urlString(lines.join("\r\n"));
}

function mailAddress(name, email) {
  const safeEmail = String(email || "").replace(/[\r\n<>]/g, "").trim();
  const safeName = String(name || "").replace(/[\r\n"]/g, "").trim();
  return safeName ? `"${safeName}" <${safeEmail}>` : safeEmail;
}

function uniqueEmailAddresses(addresses) {
  const seen = new Set();
  return addresses.filter((address) => {
    const normalized = String(address || "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function mimeEncodedSubject(value) {
  return `=?UTF-8?B?${base64String(value || "")}?=`;
}

function wrapBase64(value) {
  return String(value).replace(/.{1,76}/g, "$&\r\n").trim();
}

function resendErrorMessage(status, detail) {
  try {
    const parsed = JSON.parse(detail);
    if (parsed && parsed.message) return parsed.message;
    if (parsed && parsed.error) return parsed.error;
  } catch (_) {
    // Detail muze byt obycejny text.
  }
  return `Resend API chyba ${status}`;
}

function emailEnabled(env) {
  return googleOAuthEnabled(env) || resendEnabled(env);
}

function resendEnabled(env) {
  return Boolean(env.RESEND_API_KEY && config(env, "RESEND_FROM", ""));
}

function emailShell(title, blocks, env) {
  return `
    <div style="margin:0;padding:24px;background:#f4f6f1;font-family:Arial,Helvetica,sans-serif;color:#10211b;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #dfe4dc;border-radius:12px;overflow:hidden;">
        <div style="padding:28px 28px 10px;">
          <p style="margin:0 0 10px;color:#365847;font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">Shiatsu Danica</p>
          <h1 style="margin:0 0 18px;font-size:28px;line-height:1.15;color:#10211b;">${escapeHtml(title)}</h1>
          ${blocks.join("")}
        </div>
        <div style="padding:18px 28px;background:#edf3ee;color:#5f6b63;font-size:13px;line-height:1.6;">
          ${escapeHtml(config(env, "CONTACT_NAME", "Danica Kuštera"))}<br>
          ${escapeHtml(config(env, "CONTACT_ADDRESS", "V. Rabase 895, Kladno"))}<br>
          ${escapeHtml(config(env, "CONTACT_PHONE", "+420 733 571 783"))} · ${escapeHtml(config(env, "CONTACT_EMAIL", "danicashiatsu@gmail.com"))}
        </div>
      </div>
    </div>
  `;
}

function emailDetailsTable(rows) {
  const cells = rows.map(([label, value]) => `
    <tr>
      <td style="padding:9px 0;color:#5f6b63;width:120px;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:9px 0;color:#10211b;font-weight:700;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>
  `);
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:18px 0;border-top:1px solid #dfe4dc;border-bottom:1px solid #dfe4dc;">${cells.join("")}</table>`;
}

function eventBounds(event) {
  const start = event.start && event.start.dateTime;
  const end = event.end && event.end.dateTime;
  if (!start || !end) return null;
  return [new Date(start), new Date(end)];
}

function isAvailableEvent(event, env) {
  const summary = String(event.summary || "").trim().toLowerCase();
  if (!summary) return false;
  if (summary.startsWith(config(env, "BOOKED_PREFIX", "Rezervace").toLowerCase())) return false;
  return availableKeywords(env).some((keyword) => summary.includes(keyword));
}

function isBookedEvent(event, env) {
  const summary = String(event.summary || "").trim().toLowerCase();
  const privateProps = event.extendedProperties && event.extendedProperties.private
    ? event.extendedProperties.private
    : {};
  return privateProps.managedBy === MANAGED_MARKER || summary.startsWith(config(env, "BOOKED_PREFIX", "Rezervace").toLowerCase());
}

function availableKeywords(env) {
  return config(env, "AVAILABLE_KEYWORDS", "volno,free,available")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function slotToResponse(source, start, end, status, env) {
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return {
    id: encodeSlotId({ source, start: start.toISOString(), end: end.toISOString() }),
    source,
    start: start.toISOString(),
    end: end.toISOString(),
    date: dateKey(start, config(env, "TIMEZONE", "Europe/Prague")),
    dateLabel: dateLabel(start, config(env, "TIMEZONE", "Europe/Prague")),
    time: timeLabel(start, config(env, "TIMEZONE", "Europe/Prague")),
    durationMinutes,
    status,
  };
}

function encodeSlotId(payload) {
  return base64urlString(JSON.stringify(payload));
}

function decodeSlotId(slotId) {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(slotId)));
  } catch (error) {
    throw userError("Neplatný identifikátor termínu.", 400);
  }
}

function dateKey(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateLabel(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("cs-CZ", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}. ${parts.month}. ${parts.year}`;
}

function timeLabel(date, timezone) {
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function humanRange(start, end, env) {
  const timezone = config(env, "TIMEZONE", "Europe/Prague");
  return `${dateLabel(start, timezone)} ${timeLabel(start, timezone)}-${timeLabel(end, timezone)}`;
}

function longRangeLabel(start, end, env) {
  const timezone = config(env, "TIMEZONE", "Europe/Prague");
  const date = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(start);
  return `${capitalizeFirst(date)}, ${timeLabel(start, timezone)}-${timeLabel(end, timezone)}`;
}

function googleDateTime(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((localAsUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetRemainder = String(absolute % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetRemainder}`;
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function addDaysKey(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function publicBaseUrl(env, requestUrl) {
  return config(env, "PUBLIC_BASE_URL", new URL(requestUrl).origin).replace(/\/$/, "");
}

function config(env, key, fallback) {
  const value = env[key];
  const defaultValue = DEFAULT_CONFIG[key] !== undefined ? DEFAULT_CONFIG[key] : fallback;
  return value === undefined || value === null || value === "" ? defaultValue : String(value);
}

function secretConfig(env, key) {
  const value = env[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function numberConfig(env, key, fallback) {
  const parsed = Number(config(env, key, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bookingNoticeHours(env) {
  return numberConfig(env, "MIN_BOOKING_NOTICE_HOURS", 24);
}

function bookingNoticeLabel(env) {
  const hours = bookingNoticeHours(env);
  const unit = hours === 1 ? "hodinu" : hours >= 2 && hours <= 4 ? "hodiny" : "hodin";
  return `${hours} ${unit}`;
}

function capitalizeFirst(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function userError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function jsonResponse(payload, status, request, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
    },
  });
}

function htmlResponse(title, message, status, env) {
  const siteUrl = config(env, "SITE_URL", "/");
  const body = `<!doctype html>
<html lang="cs">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #eef3ef; color: #1f2723; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(620px, 100%); padding: 36px; border: 1px solid rgba(31, 39, 35, 0.12); border-radius: 8px; background: #fbfaf7; box-shadow: 0 24px 70px rgba(31, 39, 35, 0.12); }
      h1 { margin: 0 0 14px; font-size: clamp(32px, 7vw, 54px); line-height: 1.05; }
      p { margin: 0 0 22px; color: #66706a; font-size: 18px; line-height: 1.6; }
      a { display: inline-flex; min-height: 48px; align-items: center; padding: 0 18px; border-radius: 8px; color: white; background: #415d4d; font-weight: 700; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="${escapeHtml(siteUrl)}">Zpet na web</a>
    </main>
  </body>
</html>`;
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = config(env, "ALLOWED_ORIGINS", "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes("*") || !origin ? "*" : allowed.includes(origin) ? origin : allowed[0] || "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function randomToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64urlBytes(bytes);
}

function base64urlJson(value) {
  return base64urlString(JSON.stringify(value));
}

function base64urlString(value) {
  return base64urlBytes(new TextEncoder().encode(value));
}

function base64String(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64urlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nl2br(value) {
  return String(value).replace(/\r?\n/g, "<br>");
}
