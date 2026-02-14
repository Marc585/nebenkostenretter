const express = require('express');
const multer = require('multer');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;
const pdfParse = require('pdf-parse');
const Stripe = require('stripe');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Nginx/Reverse proxies we must trust X-Forwarded-* headers.
// Required so express-rate-limit can correctly identify client IPs.
app.set('trust proxy', 1);

// Security & performance middleware
app.use(compression());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));

function requireAdminAuth(req, res, next) {
    const adminUser = process.env.ADMIN_DASHBOARD_USER;
    const adminPass = process.env.ADMIN_DASHBOARD_PASS;

    if (!adminUser || !adminPass) {
        return res.status(503).send('Admin dashboard is not configured.');
    }

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="NebenkostenRetter Admin"');
        return res.status(401).send('Authentication required.');
    }

    const encoded = auth.split(' ')[1] || '';
    let decoded = '';
    try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch (err) {
        return res.status(401).send('Invalid authentication header.');
    }

    const sepIdx = decoded.indexOf(':');
    if (sepIdx < 0) {
        return res.status(401).send('Invalid credentials.');
    }

    const user = decoded.slice(0, sepIdx);
    const pass = decoded.slice(sepIdx + 1);
    if (user !== adminUser || pass !== adminPass) {
        res.setHeader('WWW-Authenticate', 'Basic realm="NebenkostenRetter Admin"');
        return res.status(401).send('Invalid credentials.');
    }

    return next();
}

// Protect revenue/analytics dashboard endpoints from public access.
app.use(['/admin-funnel.html', '/api/funnel-summary'], requireAdminAuth);

// Google Analytics helper script (optional, only active if GA_MEASUREMENT_ID is set)
app.get('/analytics.js', (req, res) => {
    const measurementId = process.env.GA_MEASUREMENT_ID || 'G-G22GLKY9EG';
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');

    if (!measurementId) {
        return res.send('// GA disabled: set GA_MEASUREMENT_ID to enable tracking.\n');
    }

    return res.send(`
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}

const script = document.createElement('script');
script.async = true;
script.src = 'https://www.googletagmanager.com/gtag/js?id=${measurementId}';
document.head.appendChild(script);

gtag('js', new Date());
gtag('config', '${measurementId}', {
  anonymize_ip: true,
  page_path: window.location.pathname + window.location.search
});
`);
});

app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // `/api/result/:sessionId` is polled while the analysis runs. Keep API protection,
    // but don't rate-limit high-frequency polling/telemetry endpoints.
    max: 120, // max requests per window (other endpoints remain protected)
    message: { error: 'Zu viele Anfragen. Bitte versuchen Sie es in einigen Minuten erneut.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // req.path is relative to the mount path `/api/`
        return (
            req.path.startsWith('/result/') ||
            req.path.startsWith('/track-event') ||
            req.path.startsWith('/download-pdf/')
        );
    },
});
app.use('/api/', apiLimiter);

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Resend (email) — optional, skips email if not set
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// File upload config — store in memory, max 20MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Nur PDF, JPG oder PNG erlaubt.'));
        }
    }
});

// Claude API client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// === State Management ===
const pendingFiles = new Map();      // session_id → { files, email, plan, source, campaign, createdAt }
const activeAnalyses = new Set();    // session_ids currently being analyzed
const completedResults = new Map();  // session_id → { result, createdAt }

const PLAN_CONFIG = {
    basic: {
        amountCents: 499,
        label: 'Basic',
        description: 'Komplette Prüfung aller Posten inkl. Widerspruchsbrief',
    },
};

const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function readJsonArray(filePath) {
    ensureDataDir();
    if (!fs.existsSync(filePath)) return [];
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error(`Failed to read ${filePath}:`, err.message);
        return [];
    }
}

function writeJsonArray(filePath, data) {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function sanitizeText(value, maxLen = 200) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLen);
}

function parseLivingAreaSqm(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = raw.replace(',', '.').replace(/[^0-9.]/g, '');
    const num = Number(normalized);
    if (!Number.isFinite(num)) return null;
    if (num < 10 || num > 500) return null;
    return Math.round(num * 10) / 10;
}

function getPlanConfig(planName) {
    return PLAN_CONFIG[planName] || PLAN_CONFIG.basic;
}

function hasEvent(sessionId, eventName) {
    const events = readJsonArray(EVENTS_FILE);
    return events.some(e => e.session_id === sessionId && e.event_name === eventName);
}

function appendEvent({
    sessionId = null,
    eventName,
    source = null,
    campaign = null,
    meta = {},
    ts = null,
}) {
    if (!eventName) return;
    let createdAt = new Date().toISOString();
    if (ts) {
        const parsed = new Date(ts);
        if (!Number.isNaN(parsed.getTime())) {
            createdAt = parsed.toISOString();
        }
    }
    const events = readJsonArray(EVENTS_FILE);
    events.push({
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        event_name: eventName,
        source: sanitizeText(source, 120),
        campaign: sanitizeText(campaign, 120),
        meta: meta && typeof meta === 'object' ? meta : {},
        created_at: createdAt,
    });
    writeJsonArray(EVENTS_FILE, events);
}

function upsertOrder(orderPatch) {
    if (!orderPatch || !orderPatch.session_id) return;
    const orders = readJsonArray(ORDERS_FILE);
    const idx = orders.findIndex(o => o.session_id === orderPatch.session_id);
    const nowIso = new Date().toISOString();
    const merged = {
        ...(idx >= 0 ? orders[idx] : { created_at: nowIso }),
        ...orderPatch,
        updated_at: nowIso,
    };
    if (idx >= 0) {
        orders[idx] = merged;
    } else {
        orders.push(merged);
    }
    writeJsonArray(ORDERS_FILE, orders);
}

function summarizeFunnel(fromDate, toDate) {
    const parsedFrom = fromDate ? new Date(fromDate).getTime() : 0;
    const parsedTo = toDate ? new Date(toDate).getTime() : Date.now();
    const fromTs = Number.isNaN(parsedFrom) ? 0 : parsedFrom;
    const toTs = Number.isNaN(parsedTo) ? Date.now() : parsedTo;

    const events = readJsonArray(EVENTS_FILE).filter(e => {
        const t = new Date(e.created_at).getTime();
        return t >= fromTs && t <= toTs;
    });

    const orders = readJsonArray(ORDERS_FILE).filter(o => {
        const t = new Date(o.created_at || o.updated_at).getTime();
        return t >= fromTs && t <= toTs;
    });

    const eventCounts = events.reduce((acc, e) => {
        acc[e.event_name] = (acc[e.event_name] || 0) + 1;
        return acc;
    }, {});

    const paidOrders = orders.filter(o => o.payment_status === 'paid');
    const refundedOrders = orders.filter(o => o.refund_status === 'refunded');
    const grossRevenue = paidOrders.reduce((sum, o) => sum + (Number(o.gross_eur) || 0), 0);
    const refundedRevenue = refundedOrders.reduce((sum, o) => sum + (Number(o.gross_eur) || 0), 0);

    const planBreakdown = paidOrders.reduce((acc, order) => {
        const key = order.plan || 'basic';
        if (!acc[key]) acc[key] = { orders: 0, gross_eur: 0 };
        acc[key].orders += 1;
        acc[key].gross_eur += Number(order.gross_eur) || 0;
        return acc;
    }, {});

    return {
        range: {
            from: fromDate || null,
            to: toDate || null,
        },
        events_total: events.length,
        event_counts: eventCounts,
        orders_total: orders.length,
        paid_orders: paidOrders.length,
        refunded_orders: refundedOrders.length,
        gross_revenue_eur: Number(grossRevenue.toFixed(2)),
        refunded_revenue_eur: Number(refundedRevenue.toFixed(2)),
        net_revenue_eur: Number((grossRevenue - refundedRevenue).toFixed(2)),
        plan_breakdown: planBreakdown,
    };
}

// Clean up old entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    const TTL_FILES = 30 * 60 * 1000;    // 30 min for uploaded files
    const TTL_RESULTS = 60 * 60 * 1000;  // 60 min for cached results

    for (const [key, value] of pendingFiles) {
        if (now - value.createdAt > TTL_FILES) pendingFiles.delete(key);
    }
    for (const [key, value] of completedResults) {
        if (now - value.createdAt > TTL_RESULTS) completedResults.delete(key);
    }
}, 5 * 60 * 1000);

const SYSTEM_PROMPT = `Du bist ein Experte für deutsche Nebenkostenabrechnungen (Betriebskostenabrechnungen).
Deine Aufgabe: Analysiere die hochgeladene Nebenkostenabrechnung auf Fehler und erstelle einen Widerspruchsbrief.

## PRODUKTPHILOSOPHIE: Nur BOMBENSICHERE Fälle!

Du arbeitest für den MIETER. Dein Ziel: Dem Mieter sicher Geld sparen — OHNE Streitpotenzial.
- Der Mieter soll den Brief an den Vermieter schicken können, OHNE sich unwohl zu fühlen.
- Jeder gemeldete "fehler" muss so klar sein, dass der Vermieter ihn nicht bestreiten kann.
- Lieber WENIGER Fehler finden die SICHER sind, als VIELE die vielleicht falsch sind.
- Ein falsch gemeldeter Fehler beschädigt das Vertrauensverhältnis zum Vermieter — das wollen wir NICHT.

**Konkret:**
- Wenn der Mieteranteil für einen Posten 0,00 € ist → "ok" (der Mieter zahlt nichts)
- Wenn ein Posten nicht auf den Mieter umgelegt wird → "ok"
- NUR wenn der Mieter ZU VIEL zahlt UND das eindeutig belegbar ist → "fehler"
- Im Zweifel: "warnung" oder "unklar" — NIEMALS im Zweifel "fehler"

## PRÜFUNG MIT FEHLERCODES (jeden Posten systematisch prüfen)

### E1: Nicht umlagefähige Kosten (§ 2 BetrKV)
**Automatisch "fehler"** wenn der Postenname EXPLIZIT eines dieser Wörter enthält:
  - "Verwaltung", "Verwaltungskosten", "Hausverwaltung"
  - "Instandhaltung", "Instandsetzung", "Reparatur" (als eigenständiger Posten)
  - "Bankgebühren", "Kontoführung", "Porto"
  - "Rücklage", "Instandhaltungsrücklage"
  - "Leerstandskosten"
**Sonderregeln:**
  - "Hausmeister" / "Hauswart": Nur E1 wenn Text explizit "inkl. Reparatur" o.ä. enthält. Sonst: "unklar" (Aufschlüsselung nötig).
  - "Sonstiges" / "Sonstige Kosten": Nur E1 wenn KEINE Erklärung im Dokument. Sonst: "unklar".
  - Ersparnis = voller Mieteranteil dieses Postens.

### E2: Rechenfehler (Arithmetische Prüfung)
**Formel:** (Gesamtkosten ÷ Gesamtverteiler) × Eigener Anteil = erwarteter Betrag
  - Wenn das Dokument Gesamtkosten, Gesamtverteiler und Eigenen Anteil zeigt: Nachrechnen!
  - Toleranz: ±0,05 € (Rundungsdifferenz)
  - Abweichung > Toleranz UND zum Nachteil des Mieters → "fehler" mit Ersparnis = Differenz
  - Abweichung zum Vorteil des Mieters → ignorieren ("ok")

### E3: Falscher Umlageschlüssel
  - Nur flaggen wenn aus dem Dokument KLAR hervorgeht, dass ein anderer Schlüssel verwendet wird als üblich/erlaubt
  - Z.B. Heizkosten nach Wohnfläche statt nach Verbrauch → "warnung"

### E4: Gewerbeanteil nicht berücksichtigt
  - Nur wenn das Dokument EXPLIZIT Gewerbeeinheiten erwähnt UND bei Grundsteuer/Versicherung kein Gewerbeabzug erkennbar → "warnung"

### E5: Heizkostenverstoß (HeizkostenV)
  - Heizkosten-Aufteilung muss zwischen 50-70% Verbrauch und 30-50% Grundkosten liegen
  - 100% Festkosten oder 100% Verbrauch → "warnung" (nur "fehler" wenn Aufteilung klar aus Dokument ablesbar UND eindeutig illegal)
  - CO2-Kosten gelistet aber kein Stufenmodell angewendet → "warnung"

### Weitere Prüfpunkte:
  - **Abrechnungszeitraum**: Genau 12 Monate? Wenn nicht: "warnung" (nie "fehler")
  - **Abrechnungsfrist** (§ 556 Abs. 3 BGB): SCHRITT-FÜR-SCHRITT prüfen:
    1. Ende des Abrechnungszeitraums ablesen (z.B. 31.12.2024)
    2. Fristende = Ende + 12 Monate (z.B. 31.12.2024 + 12 Monate = 31.12.2025)
    3. Zustelldatum/Erstelldatum der Abrechnung ablesen (z.B. 17.11.2025)
    4. VERGLEICHEN: Ist das Zustelldatum VOR dem Fristende? Dann ist die Frist EINGEHALTEN → "ok"
    5. NUR wenn Zustelldatum NACH dem Fristende liegt → "fehler"
    BEISPIEL: Zeitraum endet 31.12.2024, Frist bis 31.12.2025, Zustellung 17.11.2025 → 17.11.2025 < 31.12.2025 → Frist EINGEHALTEN → "ok"!
    ACHTUNG: Häufiger Fehler — rechne genau! Schreibe den Rechenweg in das "beweis" Feld.
    Wenn du das Zustelldatum nicht sicher ablesen kannst → "unklar" (NICHT "fehler"!)
  - **Vorauszahlungen**: Korrekt angerechnet? Wenn nachrechenbar und falsch → "fehler". Wenn nicht nachrechenbar → "ok" (nicht raten!)
  - **Plausibilität** (Durchschnittswerte pro m²/Jahr als Orientierung):
    Heizung 8-15€, Wasser 2-4€, Müll 1-2€, Grundsteuer 1-3€, Hausmeister 1-2€, Versicherung 1-2€, Aufzug 1-2€
    WICHTIG: Plausibilitätsprüfungen dürfen NIEMALS "fehler" sein — immer nur "warnung" oder "ok".
    Ohne Wohnfläche im Dokument → Plausibilitätsprüfung pro m² ist nicht möglich → überspringen (nicht schätzen!)

## Ausgabe-Format

Antworte AUSSCHLIESSLICH mit folgendem JSON (kein anderer Text):

{
  "validierung": "ok | nicht_lesbar | keine_abrechnung | unvollstaendig",
  "validierung_grund": "Nur ausfüllen wenn validierung != ok. Kurze Erklärung für den Nutzer.",
  "zusammenfassung": "Kurze Zusammenfassung in 1-2 Sätzen",
  "wohnflaeche_erkannt": "z.B. 65 m² oder null",
  "abrechnungszeitraum": "z.B. 01.01.2024 - 31.12.2024 oder null",
  "gesamtkosten_mieter": "z.B. 2.450,00 € oder null",
  "ergebnisse": [
    {
      "posten": "Name des Postens",
      "betrag": "z.B. '312,00 €'",
      "status": "ok | warnung | fehler | unklar",
      "fehlercode": "E1 | E2 | E3 | E4 | E5 | null",
      "titel": "Kurzer Titel (max 8 Wörter)",
      "erklaerung": "Was ist das Problem, warum, Rechtsgrundlage. 1-3 Sätze.",
      "beweis": "Exaktes Zitat aus dem Dokument das den Befund belegt, oder null",
      "ersparnis_geschaetzt": 0
    }
  ],
  "unklar_pruefungen": ["Was fehlt um die Prüfung abzuschließen, z.B. 'Hauswart-Rechnung für Aufschlüsselung nötig'"],
  "potenzielle_ersparnis_gesamt": 0,
  "fehler_anzahl": 0,
  "warnungen_anzahl": 0,
  "unklar_anzahl": 0,
  "empfehlung": "Was der Mieter tun sollte, 1-2 Sätze",
  "widerspruchsbrief": "Fertiger Brief — siehe Regeln unten"
}

## Regeln für den Widerspruchsbrief (Feld "widerspruchsbrief")

Erstelle einen FERTIGEN, kopierbaren Brief an den Vermieter. Der Brief soll:
- FREUNDLICH und respektvoll im Ton sein — der Mieter möchte sein Verhältnis zum Vermieter NICHT belasten
- Siezen, sachlich, NICHT aggressiv oder fordernd — eher "Ich bitte Sie um Prüfung" als "Ich fordere Sie auf"
- Keine Drohungen, keine Anwaltsdrohungen, keine Klageandrohungen
- Formulierung: "Mir ist bei der Durchsicht aufgefallen..." oder "Ich bitte Sie, folgende Punkte zu prüfen..."
- Konkret die gefundenen Fehler mit Posten und Beträgen benennen
- Die Rechtsgrundlage dezent erwähnen (z.B. "gemäß § 2 BetrKV") — nicht belehrend
- Höflich um Korrektur und korrigierte Abrechnung bitten
- Die korrigierte Nachzahlung/das Guthaben berechnen wenn möglich
- Platzhalter verwenden: [IHR NAME], [IHRE ADRESSE], [VERMIETER NAME], [VERMIETER ADRESSE], [DATUM]
- Format: Absenderadresse, Empfängeradresse, Datum, Betreff, Anrede, Brieftext, Grußformel
- Zeilenumbrüche mit \\n kodieren
- KEINE Fehlercodes im Brief (E1, E2 etc.) — das ist intern, der Vermieter soll das nicht sehen
- Am Ende des Briefs (vor der Grußformel) folgenden Hinweis einfügen: "Dieses Schreiben wurde mit Unterstützung einer softwaregestützten Plausibilitätsprüfung erstellt und stellt keine Rechtsberatung dar."

Falls KEINE Fehler gefunden wurden, setze widerspruchsbrief auf null.
Falls NUR Warnungen gefunden wurden, erstelle einen freundlichen Brief der um Prüfung/Erläuterung der auffälligen Posten bittet (nicht um Korrektur).

## STRENGE Regeln für status (UNBEDINGT einhalten!)

**"fehler"** — nur für BOMBENSICHERE, nicht diskutierbare Fälle! ALLE Bedingungen müssen erfüllt sein:
  1. Der Mieter zahlt nachweislich ZU VIEL
  2. Die Ersparnis ist mindestens 5 €
  3. Es ist ein KLARER Gesetzesverstoß (E1: nicht umlagefähig, E2: nachweisbarer Rechenfehler, Fristüberschreitung mit klarem Beweis)
  4. Du bist dir 100% SICHER — kein "wahrscheinlich", kein "möglicherweise"
  5. Du hast einen konkreten Beweis aus dem Dokument (Feld "beweis")
  6. Der Vermieter kann diesen Punkt NICHT bestreiten — es ist schwarz auf weiß

**Was "fehler" sein DARF (abschließende Liste):**
  - E1: Posten der EXPLIZIT "Verwaltung", "Reparatur", "Instandhaltung" etc. heißt → nicht umlagefähig, Punkt.
  - E2: Nachrechenbare Arithmetik die zum Nachteil des Mieters falsch ist (Zahlen aus dem Dokument!)
  - Fristüberschreitung: NUR wenn Zustelldatum EINDEUTIG nach Fristende liegt (mit Rechenweg!)
  - Vorauszahlungen: NUR wenn die Zahl im Dokument nachweislich falsch angerechnet wurde

**Was NIEMALS "fehler" sein darf:**
  - Plausibilitätsprüfungen ("Kosten scheinen hoch") → immer nur "warnung"
  - Fehlender Umlageschlüssel → "warnung" oder "unklar"
  - Vermutungen ("könnte Instandhaltung enthalten") → "unklar"
  - Alles wo du nicht 100% sicher bist → "warnung" oder "unklar"

**"warnung"** verwenden wenn:
  - Der Mieter möglicherweise zu viel zahlt, aber du nicht 100% sicher bist
  - Ein Posten auffällig hoch ist (>50% über Durchschnitt, NUR wenn Wohnfläche bekannt)
  - Es formale Auffälligkeiten gibt die der Mieter beim Vermieter freundlich ansprechen könnte
  - ersparnis_geschaetzt darf bei Warnungen 0 sein

**"unklar"** verwenden wenn:
  - Du den Posten nicht abschließend beurteilen kannst (fehlende Information)
  - Z.B. "Hausmeister" ohne Aufschlüsselung, "Sonstige Kosten" ohne Erklärung
  - Es KÖNNTE ein Fehler sein, aber du brauchst zusätzliche Unterlagen
  - Erkläre im Feld "erklaerung" was fehlt und was der Mieter tun sollte
  - ersparnis_geschaetzt = 0

**"ok"** verwenden wenn:
  - Der Posten plausibel und im normalen Rahmen ist
  - Der Mieteranteil 0,00 € ist (egal ob das korrekt berechnet wurde oder nicht)
  - ersparnis_geschaetzt MUSS 0 sein

## VERBOTEN (Verstöße machen den Bericht unbrauchbar!)
- "fehler" mit ersparnis_geschaetzt = 0 → VERBOTEN
- "fehler" mit ersparnis_geschaetzt unter 5 € → VERBOTEN, stattdessen "warnung"
- "fehler" bei Posten wo Mieteranteil 0 € ist → VERBOTEN (der Mieter zahlt ja nichts!)
- "fehler" bei Posten die dem VERMIETER schaden aber dem Mieter helfen → VERBOTEN
- "fehler" OHNE beweis-Zitat aus dem Dokument → VERBOTEN
- Titel der dem Erklärungstext widerspricht → VERBOTEN (z.B. Titel sagt "Frist überschritten" aber Text sagt "noch fristgerecht")
- Posten als "fehler" markieren nur weil du den Betrag nicht verifizieren kannst → VERBOTEN, stattdessen "unklar"
- Falsche Datumsberechnungen → VERBOTEN. Bei JEDER Frist- oder Datumsberechnung: Schreibe den VOLLSTÄNDIGEN Rechenweg ins "beweis" Feld (z.B. "Ende 31.12.2024 + 12 Monate = Frist bis 31.12.2025. Zustellung 17.11.2025 → fristgerecht"). Wenn du nicht 100% sicher rechnen kannst → "unklar"
- Zusammenfassung die "fehler" erwähnt, wenn die Ergebnisliste diesen Fehler gar nicht enthält oder widerlegt → VERBOTEN
- "fehler" basierend auf Plausibilität/Durchschnittswerten → VERBOTEN (immer nur "warnung")
- "fehler" basierend auf Schätzungen oder Vermutungen → VERBOTEN
- Fehlercodes (E1, E2 etc.) im Widerspruchsbrief erwähnen → VERBOTEN (nur intern)

## Konsistenz & Zahlenverarbeitung
- Deutsches Zahlenformat: 1.000,00 = eintausend. Intern korrekt umrechnen vor Arithmetik.
- Analysiere systematisch jeden Posten anhand der Fehlercodes E1-E5 oben.
- Verwende die Durchschnittswerte als Orientierung, nicht als harte Grenze.
- 10-20% über Durchschnitt = "ok", nicht "warnung".
- 50%+ über Durchschnitt = "warnung".
- Nur klar belegbare Verstöße mit >5 € Ersparnis = "fehler".
- Der Titel muss EXAKT widerspiegeln was das Problem ist. Keine Übertreibungen.
- JEDEN erkennbaren Posten auflisten, auch wenn OK.
- Auf Deutsch antworten. Präzise und faktenbasiert. Keine Spekulationen.

## SELBSTPRÜFUNG (vor dem Absenden durchführen!)
Bevor du dein JSON ausgibst, prüfe JEDEN "fehler"-Eintrag nochmal:
1. Lies den Titel, die Erklärung und den Beweis nochmal durch. Widersprechen sie sich?
2. Stimmt die Berechnung? Rechne Datumsvergleiche und Arithmetik nochmal nach.
3. Ist die Zusammenfassung konsistent mit den Einzelergebnissen?
4. Enthält die Zusammenfassung Behauptungen, die die Einzelanalyse widerlegt?
Wenn du bei der Selbstprüfung einen Fehler findest → korrigiere ihn BEVOR du antwortest.

## Dokument-Validierung (Feld "validierung")

BEVOR du die Analyse startest, prüfe das Dokument:

**"nicht_lesbar"** — wenn:
  - Das Bild/PDF so unscharf ist, dass du weniger als 50% der Zahlen/Posten lesen kannst
  - Der Text komplett unleserlich ist
  - validierung_grund: Erkläre was das Problem ist (z.B. "Das Foto ist zu unscharf. Bitte fotografieren Sie die Abrechnung bei guter Beleuchtung und ohne Bewegungsunschärfe.")

**"keine_abrechnung"** — wenn:
  - Das Dokument offensichtlich KEINE Nebenkostenabrechnung/Betriebskostenabrechnung ist
  - Z.B. ein Mietvertrag, Kontoauszug, Stromrechnung, beliebiges anderes Dokument, leere Seite
  - validierung_grund: Erkläre was du stattdessen erkannt hast (z.B. "Dies scheint ein Mietvertrag zu sein, keine Nebenkostenabrechnung.")

**"unvollstaendig"** — wenn:
  - Offensichtlich wichtige Teile fehlen (z.B. nur die letzte Seite mit der Summe, aber keine Einzelposten)
  - Weniger als 3 Kostenposten erkennbar sind
  - NICHT verwenden wenn nur kleine Teile fehlen — dann normal analysieren mit Hinweis

**"ok"** — in allen anderen Fällen. Dann normal analysieren.

Wenn validierung != "ok": Setze alle anderen Felder auf sinnvolle Defaults (leere Arrays, null, 0). Die Analyse wird nicht durchgeführt.`;

const PREVIEW_SYSTEM_PROMPT = `Du bist ein Assistent für einen kostenlosen Vorab-Check von Nebenkostenabrechnungen.
Deine Aufgabe ist eine kurze, vorsichtige Ersteinschätzung vor dem Kauf einer vollständigen Prüfung.

WICHTIG:
- Keine Rechtsberatung.
- Keine endgültigen Bewertungen.
- Formuliere konservativ: "Hinweis", "Auffälligkeit", "bitte genauer prüfen".
- Gib maximal 3 Auffälligkeiten zurück.
- Wenn das Dokument nicht lesbar/unvollständig/kein Nebenkosten-Dokument ist, setze validierung entsprechend.
- Datumslogik strikt:
  1) Abrechnungszeitraum 2024 darf ein Erstellungs-/Zustelldatum in 2025 haben.
  2) Das ist normal und darf NICHT als "Datum liegt in der Zukunft" markiert werden.
  3) Hinweis nur, wenn das Datum NACH Fristende liegt (Ende Abrechnungszeitraum + 12 Monate, § 556 Abs. 3 BGB).

Antworte ausschließlich als JSON in genau diesem Format:
{
  "validierung": "ok | nicht_lesbar | keine_abrechnung | unvollstaendig",
  "validierung_grund": "Kurze Erklärung oder null",
  "dokument_qualitaet": 0,
  "lesbarkeit": "gut | mittel | schlecht",
  "erkannte_basisdaten": {
    "abrechnungszeitraum": "String oder null",
    "wohnflaeche": "String oder null",
    "gesamtkosten_mieter": "String oder null"
  },
  "auffaelligkeiten": [
    {
      "titel": "Maximal 8 Wörter",
      "kurz": "Maximal 140 Zeichen, konkrete erste Einschätzung",
      "status_hint": "hinweis | auffaellig | pruefen"
    }
  ],
  "erkannte_daten": [
    {
      "feld": "abrechnungszeitraum | abrechnungsdatum | wohnflaeche | gesamtkosten_mieter | vorauszahlungen | nachzahlung_oder_guthaben",
      "wert": "String",
      "confidence": "sicher | unsicher"
    }
  ],
  "fristcheck": {
    "zeitraum_ende": "DD.MM.YYYY oder null",
    "fristende": "DD.MM.YYYY oder null",
    "abrechnungsdatum": "DD.MM.YYYY oder null",
    "status": "fristgerecht | frist_ueberschritten | nicht_ermittelbar",
    "erklaerung": "Kurze Erklärung"
  },
  "einsparpotenzial_geschaetzt_eur": 0,
  "einsparpotenzial_erklaerung": "1 kurzer Satz, warum dieses Potenzial im Vollcheck realistisch sein kann",
  "naechster_schritt": "1 kurzer Satz mit Empfehlung zur vollständigen Prüfung"
}`;

// === Token cost limits ===
const MAX_PDF_TEXT_CHARS = 15000;  // ~4K tokens, plenty for a Nebenkostenabrechnung
const MAX_PDF_BASE64_MB = 5;      // Skip vision for huge PDFs
const MAX_IMAGE_WIDTH = 1200;     // Enough for OCR, saves ~35% tokens vs 1500px
const IMAGE_QUALITY = 75;

// === Image compression ===
async function compressImage(buffer, mimetype) {
    const metadata = await sharp(buffer).metadata();
    const originalKB = Math.round(buffer.length / 1024);

    let processed = sharp(buffer);

    if (metadata.width > MAX_IMAGE_WIDTH) {
        processed = processed.resize(MAX_IMAGE_WIDTH, null, { withoutEnlargement: true });
    }

    const result = await processed.jpeg({ quality: IMAGE_QUALITY }).toBuffer();
    const newKB = Math.round(result.length / 1024);

    console.log(`  Image compressed: ${originalKB} KB → ${newKB} KB (${metadata.width}px → max ${MAX_IMAGE_WIDTH}px)`);
    return result;
}

// Build Claude API content blocks from uploaded files
async function buildContentFromFiles(files) {
    const content = [];

    for (const file of files) {
        if (file.mimetype === 'application/pdf') {
            try {
                const pdfData = await pdfParse(file.buffer);
                let text = pdfData.text.trim();

                if (text.length > 100) {
                    // Cap text to limit token usage
                    if (text.length > MAX_PDF_TEXT_CHARS) {
                        console.log(`  PDF text truncated: ${text.length} → ${MAX_PDF_TEXT_CHARS} chars`);
                        text = text.substring(0, MAX_PDF_TEXT_CHARS) + '\n\n[... Text gekürzt, restliche Seiten nicht einbezogen ...]';
                    }
                    content.push({
                        type: 'text',
                        text: `--- PDF: ${file.originalname} ---\n${text}\n---`
                    });
                } else {
                    // No usable text — use vision, but only if PDF isn't huge
                    const sizeMB = file.buffer.length / (1024 * 1024);
                    if (sizeMB > MAX_PDF_BASE64_MB) {
                        console.log(`  PDF too large for vision (${sizeMB.toFixed(1)} MB), skipping`);
                        content.push({
                            type: 'text',
                            text: `--- PDF: ${file.originalname} ---\n[Dokument konnte nicht gelesen werden. Die Datei ist zu groß (${sizeMB.toFixed(1)} MB). Bitte laden Sie einzelne Fotos der Seiten hoch.]\n---`
                        });
                    } else {
                        content.push({
                            type: 'document',
                            source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') }
                        });
                    }
                }
            } catch (pdfErr) {
                const sizeMB = file.buffer.length / (1024 * 1024);
                if (sizeMB > MAX_PDF_BASE64_MB) {
                    console.log(`  PDF parse failed and too large for vision (${sizeMB.toFixed(1)} MB)`);
                    content.push({
                        type: 'text',
                        text: `--- PDF: ${file.originalname} ---\n[Dokument konnte nicht gelesen werden. Bitte laden Sie Fotos der einzelnen Seiten hoch.]\n---`
                    });
                } else {
                    content.push({
                        type: 'document',
                        source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') }
                    });
                }
            }
        } else {
            // Compress images before sending
            const compressed = await compressImage(file.buffer, file.mimetype);
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: compressed.toString('base64') }
            });
        }
    }

    content.push({
        type: 'text',
        text: files.length > 1
            ? `Dies sind ${files.length} Seiten/Fotos einer Nebenkostenabrechnung. Bitte analysiere sie zusammen als ein Dokument.`
            : 'Bitte analysiere diese Nebenkostenabrechnung.'
    });

    return content;
}

// Run Claude analysis and return parsed result
async function runAnalysis(files, analysisContext = {}) {
    const content = await buildContentFromFiles(files);
    if (analysisContext.livingAreaSqm) {
        content.push({
            type: 'text',
            text: `Zusatzangabe vom Nutzer: Wohnfläche ${analysisContext.livingAreaSqm} m². Verwende diese Angabe für Plausibilitätsprüfungen pro m², falls im Dokument keine Wohnfläche klar erkennbar ist.`,
        });
    }

    const fileNames = files.map(f => f.originalname).join(', ');
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    console.log(`Analyzing ${files.length} file(s): ${fileNames} (${(totalSize / 1024).toFixed(0)} KB original)...`);

    const startTime = Date.now();

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 8192,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }]
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stopReason = response.stop_reason;
    console.log(`  Claude response received in ${elapsed}s (stop: ${stopReason})`);

    const responseText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('Kein JSON in der Antwort gefunden');
    }

    let jsonStr = jsonMatch[0];

    // If response was truncated, try to repair the JSON
    if (stopReason === 'max_tokens') {
        console.log('  Response was truncated, attempting JSON repair...');
        // Close any open strings, arrays, and objects
        let openBraces = 0, openBrackets = 0, inString = false, escaped = false;
        for (const ch of jsonStr) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') openBraces++;
            if (ch === '}') openBraces--;
            if (ch === '[') openBrackets++;
            if (ch === ']') openBrackets--;
        }
        if (inString) jsonStr += '"';
        // Remove trailing comma if present
        jsonStr = jsonStr.replace(/,\s*$/, '');
        for (let i = 0; i < openBrackets; i++) jsonStr += ']';
        for (let i = 0; i < openBraces; i++) jsonStr += '}';
    }

    const parsed = JSON.parse(jsonStr);
    if ((!parsed.wohnflaeche_erkannt || parsed.wohnflaeche_erkannt === 'null') && analysisContext.livingAreaSqm) {
        parsed.wohnflaeche_erkannt = `${analysisContext.livingAreaSqm} m² (vom Nutzer angegeben)`;
    }
    return parsed;
}

function normalizePreviewResult(raw) {
    const safe = raw && typeof raw === 'object' ? raw : {};
    const validierung = ['ok', 'nicht_lesbar', 'keine_abrechnung', 'unvollstaendig'].includes(safe.validierung)
        ? safe.validierung
        : 'ok';
    const lesbarkeit = ['gut', 'mittel', 'schlecht'].includes(safe.lesbarkeit)
        ? safe.lesbarkeit
        : 'mittel';
    const qualitaetNum = Number(safe.dokument_qualitaet);
    const dokumentQualitaet = Number.isFinite(qualitaetNum)
        ? Math.max(0, Math.min(100, Math.round(qualitaetNum)))
        : (lesbarkeit === 'gut' ? 85 : lesbarkeit === 'schlecht' ? 45 : 70);
    const basis = safe.erkannte_basisdaten && typeof safe.erkannte_basisdaten === 'object'
        ? safe.erkannte_basisdaten
        : {};
    const auffaelligkeiten = Array.isArray(safe.auffaelligkeiten)
        ? safe.auffaelligkeiten.slice(0, 3).map((item) => ({
            titel: sanitizeText(item?.titel, 80) || 'Mögliche Auffälligkeit',
            kurz: sanitizeText(item?.kurz, 180) || 'Bitte im vollständigen Check genauer prüfen.',
            status_hint: ['hinweis', 'auffaellig', 'pruefen'].includes(item?.status_hint)
                ? item.status_hint
                : 'hinweis',
        }))
        : [];

    const potNum = Number(safe.einsparpotenzial_geschaetzt_eur);
    const einsparpotenzial = Number.isFinite(potNum)
        ? Math.max(0, Math.min(5000, Math.round(potNum)))
        : 0;
    const erkannteDatenRaw = Array.isArray(safe.erkannte_daten)
        ? safe.erkannte_daten.slice(0, 10)
        : [];
    const erkannteDaten = erkannteDatenRaw
        .map((row) => ({
            feld: sanitizeText(row?.feld, 80),
            wert: sanitizeText(row?.wert, 120),
            confidence: ['sicher', 'unsicher'].includes(row?.confidence) ? row.confidence : 'unsicher',
        }))
        .filter((row) => row.feld && row.wert);
    const fristRaw = safe.fristcheck && typeof safe.fristcheck === 'object'
        ? safe.fristcheck
        : {};
    return applyPreviewLogicGuards({
        validierung,
        validierung_grund: sanitizeText(safe.validierung_grund, 220),
        dokument_qualitaet: dokumentQualitaet,
        lesbarkeit,
        erkannte_basisdaten: {
            abrechnungszeitraum: sanitizeText(basis.abrechnungszeitraum, 80),
            wohnflaeche: sanitizeText(basis.wohnflaeche, 40),
            gesamtkosten_mieter: sanitizeText(basis.gesamtkosten_mieter, 60),
        },
        auffaelligkeiten,
        erkannte_daten: erkannteDaten,
        fristcheck: {
            zeitraum_ende: sanitizeText(fristRaw.zeitraum_ende, 30),
            fristende: sanitizeText(fristRaw.fristende, 30),
            abrechnungsdatum: sanitizeText(fristRaw.abrechnungsdatum, 30),
            status: ['fristgerecht', 'frist_ueberschritten', 'nicht_ermittelbar'].includes(fristRaw.status)
                ? fristRaw.status
                : 'nicht_ermittelbar',
            erklaerung: sanitizeText(fristRaw.erklaerung, 220),
        },
        einsparpotenzial_geschaetzt_eur: einsparpotenzial,
        einsparpotenzial_erklaerung: sanitizeText(safe.einsparpotenzial_erklaerung, 220)
            || 'Im vollständigen Check werden alle Posten, Umlageschlüssel und Fristen detailliert geprüft.',
        naechster_schritt: sanitizeText(safe.naechster_schritt, 220)
            || 'Wenn Sie sicher gehen möchten, starten Sie die vollständige Prüfung mit fertigem Widerspruchsbrief.',
    });
}

function parseGermanDate(dateText) {
    if (typeof dateText !== 'string') return null;
    const s = dateText.trim();

    const dotMatch = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
    if (dotMatch) {
        const d = Number(dotMatch[1]);
        const m = Number(dotMatch[2]) - 1;
        const y = Number(dotMatch[3]);
        const dt = new Date(y, m, d);
        if (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) return dt;
    }

    const monthMap = {
        januar: 0, februar: 1, maerz: 2, märz: 2, april: 3, mai: 4, juni: 5,
        juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11,
    };
    const wordMatch = s.match(/\b(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})\b/);
    if (wordMatch) {
        const d = Number(wordMatch[1]);
        const monthRaw = wordMatch[2].toLowerCase();
        const y = Number(wordMatch[3]);
        const m = monthMap[monthRaw];
        if (typeof m === 'number') {
            const dt = new Date(y, m, d);
            if (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) return dt;
        }
    }
    return null;
}

function parsePeriodEndDate(periodText) {
    if (typeof periodText !== 'string') return null;
    const matches = periodText.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g);
    if (!matches || matches.length === 0) return null;
    return parseGermanDate(matches[matches.length - 1]);
}

function extractDateFromText(text) {
    if (typeof text !== 'string') return null;
    const dot = text.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/);
    if (dot) return parseGermanDate(dot[0]);
    const word = text.match(/\b\d{1,2}\.\s*[A-Za-zÄÖÜäöü]+\s+\d{4}\b/);
    if (word) return parseGermanDate(word[0]);
    return null;
}

function formatDateDE(dateObj) {
    if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const yyyy = String(dateObj.getFullYear());
    return `${dd}.${mm}.${yyyy}`;
}

function getRecognizedValue(recognizedRows, wantedField) {
    const hit = (recognizedRows || []).find((r) => r.feld === wantedField && r.wert);
    return hit ? hit.wert : null;
}

function mergeRecognizedData(base, additions) {
    const list = Array.isArray(base) ? [...base] : [];
    for (const row of additions) {
        if (!row || !row.feld || !row.wert) continue;
        const idx = list.findIndex((x) => x.feld === row.feld);
        if (idx >= 0) {
            list[idx] = row;
        } else {
            list.push(row);
        }
    }
    return list.slice(0, 12);
}

function deriveSavingsFromAuffaelligkeiten(auffaelligkeiten) {
    let max = 0;
    for (const item of (auffaelligkeiten || [])) {
        const text = `${item.titel || ''} ${item.kurz || ''}`;
        const m = text.match(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?)\s*€/);
        if (m) {
            const value = Number(m[1].replace(/\./g, '').replace(/\s/g, '').replace(',', '.'));
            if (Number.isFinite(value)) max = Math.max(max, Math.round(value));
        }
    }
    return max;
}

function applyPreviewLogicGuards(preview) {
    const out = {
        ...preview,
        auffaelligkeiten: [...(preview.auffaelligkeiten || [])],
        erkannte_daten: [...(preview.erkannte_daten || [])],
    };
    const periodEnd = parsePeriodEndDate(out.erkannte_basisdaten?.abrechnungszeitraum || '');
    let deadline = null;
    if (periodEnd) {
        deadline = new Date(periodEnd);
        deadline.setFullYear(deadline.getFullYear() + 1);
    }

    // Filter false "date in future" warnings when date is still within statutory deadline.
    out.auffaelligkeiten = out.auffaelligkeiten.filter((item) => {
        const joined = `${item.titel || ''} ${item.kurz || ''}`.toLowerCase();
        const mentionsFuture = joined.includes('zukunft');
        if (!mentionsFuture) return true;
        if (!deadline) return false;
        const detectedDate = extractDateFromText(`${item.titel || ''} ${item.kurz || ''}`);
        if (!detectedDate) return false;
        return detectedDate > deadline;
    });

    if (out.auffaelligkeiten.length === 0) {
        out.auffaelligkeiten.push({
            titel: 'Erste Plausibilitätsprüfung',
            kurz: 'Die Daten wirken grundsätzlich plausibel. Für belastbare Ergebnisse empfehlen wir die vollständige Prüfung.',
            status_hint: 'hinweis',
        });
    }

    const abrechnungszeitraumText = out.erkannte_basisdaten?.abrechnungszeitraum || null;
    const abrechnungsdatumFromRows = getRecognizedValue(out.erkannte_daten, 'abrechnungsdatum');
    const abrechnungsdatumFromHints = out.auffaelligkeiten
        .map((item) => extractDateFromText(`${item.titel || ''} ${item.kurz || ''}`))
        .find(Boolean);
    const abrechnungsdatum = parseGermanDate(abrechnungsdatumFromRows || '') || abrechnungsdatumFromHints || null;

    const fristcheck = {
        zeitraum_ende: periodEnd ? formatDateDE(periodEnd) : null,
        fristende: deadline ? formatDateDE(deadline) : null,
        abrechnungsdatum: abrechnungsdatum ? formatDateDE(abrechnungsdatum) : null,
        status: 'nicht_ermittelbar',
        erklaerung: 'Frist konnte im Vorab-Check nicht sicher berechnet werden.',
    };
    if (deadline && abrechnungsdatum) {
        if (abrechnungsdatum <= deadline) {
            fristcheck.status = 'fristgerecht';
            fristcheck.erklaerung = `Abrechnung datiert auf ${formatDateDE(abrechnungsdatum)}. Fristende für den Zeitraum ist ${formatDateDE(deadline)}.`;
        } else {
            fristcheck.status = 'frist_ueberschritten';
            fristcheck.erklaerung = `Abrechnung datiert auf ${formatDateDE(abrechnungsdatum)} und liegt nach dem Fristende ${formatDateDE(deadline)}.`;
        }
    } else if (deadline && !abrechnungsdatum) {
        fristcheck.erklaerung = `Fristende wäre ${formatDateDE(deadline)}, aber ein Abrechnungsdatum wurde nicht sicher erkannt.`;
    } else if (abrechnungszeitraumText) {
        fristcheck.erklaerung = 'Abrechnungszeitraum erkannt, aber Fristende konnte nicht sicher bestimmt werden.';
    }
    out.fristcheck = fristcheck;

    out.erkannte_daten = mergeRecognizedData(out.erkannte_daten, [
        {
            feld: 'abrechnungszeitraum',
            wert: abrechnungszeitraumText || '',
            confidence: abrechnungszeitraumText ? 'sicher' : 'unsicher',
        },
        {
            feld: 'abrechnungsdatum',
            wert: fristcheck.abrechnungsdatum || '',
            confidence: fristcheck.abrechnungsdatum ? 'sicher' : 'unsicher',
        },
        {
            feld: 'wohnflaeche',
            wert: out.erkannte_basisdaten?.wohnflaeche || '',
            confidence: out.erkannte_basisdaten?.wohnflaeche ? 'sicher' : 'unsicher',
        },
        {
            feld: 'gesamtkosten_mieter',
            wert: out.erkannte_basisdaten?.gesamtkosten_mieter || '',
            confidence: out.erkannte_basisdaten?.gesamtkosten_mieter ? 'sicher' : 'unsicher',
        },
    ]);

    if (!out.einsparpotenzial_geschaetzt_eur || out.einsparpotenzial_geschaetzt_eur <= 0) {
        const derived = deriveSavingsFromAuffaelligkeiten(out.auffaelligkeiten);
        out.einsparpotenzial_geschaetzt_eur = Math.max(0, Math.min(5000, derived || 0));
    }

    return out;
}

async function runFreePreview(files, analysisContext = {}) {
    const content = await buildContentFromFiles(files);
    if (analysisContext.livingAreaSqm) {
        content.push({
            type: 'text',
            text: `Zusatzangabe vom Nutzer: Wohnfläche ${analysisContext.livingAreaSqm} m². Nutze diese Angabe für eine bessere Plausibilitätsbewertung.`,
        });
    }
    content.push({
        type: 'text',
        text: `Heutiges Datum (für Fristlogik): ${new Date().toLocaleDateString('de-DE')}.`,
    });
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1800,
        temperature: 0,
        system: PREVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
    });

    const responseText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('Kein JSON im Vorab-Check gefunden');
    }

    const normalized = normalizePreviewResult(JSON.parse(jsonMatch[0]));
    if ((!normalized.erkannte_basisdaten?.wohnflaeche || normalized.erkannte_basisdaten.wohnflaeche === 'null') && analysisContext.livingAreaSqm) {
        normalized.erkannte_basisdaten.wohnflaeche = `${analysisContext.livingAreaSqm} m² (vom Nutzer angegeben)`;
    }
    return normalized;
}

// === PDF Generation ===
function generatePDF(data) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const green = '#1a6b4a';
        const red = '#c53030';
        const orange = '#b7791f';
        const blue = '#2563eb';
        const gray = '#4a5568';

        // Header
        doc.fontSize(24).fillColor(green).text('NebenkostenRetter', { align: 'center' });
        doc.fontSize(11).fillColor(gray).text('Prüfbericht Ihrer Nebenkostenabrechnung', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e2dfd9').stroke();
        doc.moveDown(0.8);

        // Meta info
        if (data.abrechnungszeitraum) doc.fontSize(10).fillColor(gray).text(`Abrechnungszeitraum: ${data.abrechnungszeitraum}`);
        if (data.wohnflaeche_erkannt) doc.fontSize(10).fillColor(gray).text(`Wohnfläche: ${data.wohnflaeche_erkannt}`);
        if (data.gesamtkosten_mieter) doc.fontSize(10).fillColor(gray).text(`Gesamtkosten Mieter: ${data.gesamtkosten_mieter}`);
        doc.moveDown(0.5);

        // Summary
        doc.fontSize(13).fillColor('#1a1a2e').text('Zusammenfassung', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(11).fillColor(gray).text(data.zusammenfassung);
        doc.moveDown(0.3);

        const fehler = (data.ergebnisse || []).filter(e => e.status === 'fehler');
        const warnungen = (data.ergebnisse || []).filter(e => e.status === 'warnung');
        const unklarItems = (data.ergebnisse || []).filter(e => e.status === 'unklar');
        const ersparnis = data.potenzielle_ersparnis_gesamt || 0;

        doc.fontSize(11).fillColor('#1a1a2e')
            .text(`Gefundene Fehler: `, { continued: true }).fillColor(red).text(`${fehler.length}`)
            .fillColor('#1a1a2e').text(`Warnungen: `, { continued: true }).fillColor(orange).text(`${warnungen.length}`)
            .fillColor('#1a1a2e').text(`Offene Punkte: `, { continued: true }).fillColor(blue).text(`${unklarItems.length}`)
            .fillColor('#1a1a2e').text(`Potenzielle Ersparnis: `, { continued: true }).fillColor(green).text(`${Math.round(ersparnis)} €`);
        doc.moveDown(1);

        // Results
        doc.fontSize(13).fillColor('#1a1a2e').text('Prüfergebnisse', { underline: true });
        doc.moveDown(0.5);

        for (const item of (data.ergebnisse || [])) {
            let statusColor = green;
            let statusLabel = 'OK';
            if (item.status === 'fehler') { statusColor = red; statusLabel = 'FEHLER'; }
            if (item.status === 'warnung') { statusColor = orange; statusLabel = 'WARNUNG'; }
            if (item.status === 'unklar') { statusColor = blue; statusLabel = 'UNKLAR'; }

            const codeStr = item.fehlercode ? ` (${item.fehlercode})` : '';

            // Check if we need a new page
            if (doc.y > 700) doc.addPage();

            doc.fontSize(11).fillColor(statusColor).text(`[${statusLabel}${codeStr}] `, { continued: true })
                .fillColor('#1a1a2e').text(`${item.posten}`, { continued: true })
                .fillColor(gray).text(`  ${item.betrag || ''}`);

            if (item.erklaerung) {
                doc.fontSize(10).fillColor(gray).text(item.erklaerung);
            }
            if (item.beweis) {
                doc.fontSize(9).fillColor('#6b7280').text(`Beleg: „${item.beweis}"`, { oblique: true });
            }
            if (item.ersparnis_geschaetzt > 0) {
                doc.fontSize(10).fillColor(green).text(`Mögliche Ersparnis: ${Math.round(item.ersparnis_geschaetzt)} €`);
            }
            doc.moveDown(0.4);
        }

        // Unklar section with evidence requests
        if (data.unklar_pruefungen && data.unklar_pruefungen.length > 0) {
            if (doc.y > 650) doc.addPage();
            doc.moveDown(0.5);
            doc.fontSize(13).fillColor('#1a1a2e').text('Offene Prüfpunkte', { underline: true });
            doc.moveDown(0.3);
            doc.fontSize(10).fillColor(gray).text('Folgende Punkte konnten nicht abschließend geprüft werden. Fordern Sie ggf. Belegeinsicht beim Vermieter an:');
            doc.moveDown(0.2);
            for (const pruefung of data.unklar_pruefungen) {
                doc.fontSize(10).fillColor(gray).text(`• ${pruefung}`);
            }
        }

        // Recommendation
        if (data.empfehlung) {
            if (doc.y > 680) doc.addPage();
            doc.moveDown(0.5);
            doc.fontSize(13).fillColor('#1a1a2e').text('Empfehlung', { underline: true });
            doc.moveDown(0.3);
            doc.fontSize(11).fillColor(gray).text(data.empfehlung);
        }

        // Letter
        if (data.widerspruchsbrief) {
            doc.addPage();
            doc.fontSize(13).fillColor('#1a1a2e').text('Muster-Widerspruchsbrief', { underline: true });
            doc.moveDown(0.5);
            const briefText = data.widerspruchsbrief.replace(/\\n/g, '\n');
            doc.fontSize(10).fillColor('#1a1a2e').text(briefText, { lineGap: 3 });
        }

        // Footer
        doc.moveDown(1);
        doc.fontSize(8).fillColor(gray).text(
            'Dieser Bericht wurde automatisch erstellt und stellt keine Rechtsberatung dar. Bei komplexen Fällen empfehlen wir einen Fachanwalt oder Mieterverein.',
            { align: 'center' }
        );
        doc.fontSize(8).fillColor(gray).text(`Erstellt am ${new Date().toLocaleDateString('de-DE')} — nebenkostenretter.de`, { align: 'center' });

        doc.end();
    });
}

// === Email sending via Resend ===
async function sendResultEmail(email, data, pdfBuffer) {
    if (!resend) {
        console.log('  RESEND_API_KEY not set, skipping email.');
        return;
    }

    const fehler = (data.ergebnisse || []).filter(e => e.status === 'fehler');
    const warnungen = (data.ergebnisse || []).filter(e => e.status === 'warnung');
    const unklarEmail = (data.ergebnisse || []).filter(e => e.status === 'unklar');
    const ersparnis = data.potenzielle_ersparnis_gesamt || 0;

    const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a2e;">
            <h2 style="color: #1a6b4a;">Ihr Prüfbericht ist fertig!</h2>
            <p>Wir haben Ihre Nebenkostenabrechnung geprüft. Hier die wichtigsten Ergebnisse:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr>
                    <td style="padding: 12px; background: ${fehler.length > 0 ? '#fef2f2' : '#f0faf4'}; border-radius: 8px; text-align: center;">
                        <strong style="font-size: 24px; color: ${fehler.length > 0 ? '#c53030' : '#1a6b4a'};">${fehler.length}</strong><br>
                        <span style="color: #4a5568; font-size: 13px;">Fehler</span>
                    </td>
                    <td style="width: 8px;"></td>
                    <td style="padding: 12px; background: ${warnungen.length > 0 ? '#fffbeb' : '#f0faf4'}; border-radius: 8px; text-align: center;">
                        <strong style="font-size: 24px; color: ${warnungen.length > 0 ? '#b7791f' : '#1a6b4a'};">${warnungen.length}</strong><br>
                        <span style="color: #4a5568; font-size: 13px;">Warnungen</span>
                    </td>
                    <td style="width: 8px;"></td>
                    <td style="padding: 12px; background: ${unklarEmail.length > 0 ? '#eff6ff' : '#f0faf4'}; border-radius: 8px; text-align: center;">
                        <strong style="font-size: 24px; color: ${unklarEmail.length > 0 ? '#2563eb' : '#1a6b4a'};">${unklarEmail.length}</strong><br>
                        <span style="color: #4a5568; font-size: 13px;">Offen</span>
                    </td>
                    <td style="width: 8px;"></td>
                    <td style="padding: 12px; background: #f0faf4; border-radius: 8px; text-align: center;">
                        <strong style="font-size: 24px; color: #1a6b4a;">${Math.round(ersparnis)} €</strong><br>
                        <span style="color: #4a5568; font-size: 13px;">Ersparnis</span>
                    </td>
                </tr>
            </table>
            <p><strong>Zusammenfassung:</strong> ${data.zusammenfassung}</p>
            ${data.widerspruchsbrief ? '<p>Im angehängten PDF finden Sie auch einen <strong>fertigen Muster-Widerspruchsbrief</strong>, den Sie direkt an Ihren Vermieter schicken können.</p>' : ''}
            <p style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2dfd9; font-size: 12px; color: #8896a6;">
                Dieser Bericht wurde automatisch erstellt und stellt keine Rechtsberatung dar.<br>
                NebenkostenRetter — nebenkostenretter.de
            </p>
        </div>
    `;

    try {
        await resend.emails.send({
            from: 'NebenkostenRetter <onboarding@resend.dev>',
            to: [email],
            subject: `Ihr Prüfbericht: ${fehler.length} Fehler gefunden${ersparnis > 0 ? ` — bis zu ${Math.round(ersparnis)} € Ersparnis` : ''}`,
            html: htmlBody,
            attachments: [{
                filename: 'Pruefbericht-Nebenkosten.pdf',
                content: pdfBuffer.toString('base64'),
            }],
        });
        console.log(`  Email sent to ${email}`);
    } catch (err) {
        console.error(`  Email sending failed:`, err.message);
    }
}

// === Run analysis with automatic retry for transient errors ===
async function runAnalysisWithRetry(files, analysisContext = {}, maxRetries = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            return await runAnalysis(files, analysisContext);
        } catch (err) {
            lastError = err;
            const isTransient = err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || !err.status;
            if (isTransient && attempt <= maxRetries) {
                const delay = attempt * 3000; // 3s, 6s
                console.log(`  Retry ${attempt}/${maxRetries} in ${delay/1000}s (${err.message})`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}

// === Auto-refund via Stripe ===
async function autoRefund(sessionId, reason) {
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_intent && session.payment_status === 'paid') {
            await stripe.refunds.create({
                payment_intent: session.payment_intent,
                reason: 'requested_by_customer',
            });
            console.log(`  Auto-refund issued for ${sessionId}: ${reason}`);
            upsertOrder({
                session_id: sessionId,
                payment_status: 'paid',
                refund_status: 'refunded',
            });
            if (!hasEvent(sessionId, 'refund_issued')) {
                appendEvent({
                    sessionId,
                    eventName: 'refund_issued',
                    meta: { reason },
                });
            }
            return true;
        }
    } catch (err) {
        console.error(`  Auto-refund failed for ${sessionId}:`, err.message);
    }
    return false;
}

// === Start background analysis for a session ===
function startBackgroundAnalysis(sessionId) {
    if (activeAnalyses.has(sessionId)) return; // Already running

    const pending = pendingFiles.get(sessionId);
    if (!pending) return;

    activeAnalyses.add(sessionId);

    runAnalysisWithRetry(pending.files, { livingAreaSqm: pending.livingAreaSqm || null })
        .then(async (result) => {
            // Check document validation
            if (result.validierung && result.validierung !== 'ok') {
                const validierungMessages = {
                    'nicht_lesbar': 'Das Dokument konnte leider nicht gelesen werden. Bitte laden Sie deutlichere Fotos oder ein besseres PDF hoch.',
                    'keine_abrechnung': 'Das hochgeladene Dokument scheint keine Nebenkostenabrechnung zu sein.',
                    'unvollstaendig': 'Das Dokument scheint unvollständig zu sein. Bitte laden Sie alle Seiten Ihrer Abrechnung hoch.',
                };

                let errorMsg = validierungMessages[result.validierung] || 'Dokument konnte nicht verarbeitet werden.';
                if (result.validierung_grund) {
                    errorMsg += ' ' + result.validierung_grund;
                }

                // Auto-refund — customer shouldn't pay for an unusable document
                const refunded = await autoRefund(sessionId, result.validierung);
                if (refunded) {
                    const refundedAmount = (getPlanConfig(pending.plan || 'basic').amountCents / 100).toFixed(2).replace('.', ',');
                    errorMsg += ` Ihr Geld (${refundedAmount} €) wurde automatisch zurückerstattet.`;
                }

                console.log(`Validation failed for ${sessionId}: ${result.validierung} — ${result.validierung_grund || 'no reason'}`);
                completedResults.set(sessionId, {
                    error: errorMsg,
                    errorType: 'validation_' + result.validierung,
                    refunded,
                    createdAt: Date.now(),
                });
                return;
            }

            completedResults.set(sessionId, { result, createdAt: Date.now() });
            console.log(`Analysis complete for ${sessionId}: ${result.fehler_anzahl} errors, ${result.warnungen_anzahl} warnings`);
            appendEvent({
                sessionId,
                eventName: 'analysis_completed',
                source: pending.source,
                campaign: pending.campaign,
                meta: {
                    plan: pending.plan || 'basic',
                    fehler: result.fehler_anzahl || 0,
                    warnungen: result.warnungen_anzahl || 0,
                    ersparnis: result.potenzielle_ersparnis_gesamt || 0,
                },
            });

            // Send email with PDF if email was provided
            if (pending.email) {
                try {
                    const pdfBuffer = await generatePDF(result);
                    await sendResultEmail(pending.email, result, pdfBuffer);
                } catch (emailErr) {
                    console.error(`  PDF/Email error:`, emailErr.message);
                }
            }
        })
        .catch(err => {
            console.error(`Analysis failed for ${sessionId}:`, err.message);
            let errorType = 'analysis_failed';
            let errorMsg = 'Die Analyse konnte leider nicht abgeschlossen werden.';
            if (err.status === 401) {
                errorType = 'config_error';
                errorMsg = 'Interner Konfigurationsfehler. Bitte kontaktieren Sie den Support.';
            }
            if (err.status === 429) {
                errorType = 'rate_limit';
                errorMsg = 'Unser System ist gerade überlastet. Bitte versuchen Sie es in wenigen Minuten erneut.';
            }
            completedResults.set(sessionId, { error: errorMsg, errorType, createdAt: Date.now() });
        })
        .finally(() => {
            activeAnalyses.delete(sessionId);
            pendingFiles.delete(sessionId);
        });
}

async function createCheckoutHandler(req, res, fallbackPlan = 'basic') {
    try {
        const consentAccepted = req.body?.consent === '1' || req.body?.consent === 'true' || req.body?.consent === true;
        if (!consentAccepted) {
            return res.status(400).json({ error: 'Bitte stimmen Sie der Datenverarbeitung zu (Pflichtangabe).' });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
        }

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ error: 'STRIPE_SECRET_KEY nicht gesetzt.' });
        }

        // Determine base URL for redirects
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const selectedPlanRaw = sanitizeText(req.body.plan, 20) || fallbackPlan;
        const selectedPlan = Object.prototype.hasOwnProperty.call(PLAN_CONFIG, selectedPlanRaw)
            ? selectedPlanRaw
            : 'basic';
        const planConfig = getPlanConfig(selectedPlan);
        const source = sanitizeText(req.body.source || req.query.source, 120);
        const campaign = sanitizeText(req.body.campaign || req.query.campaign, 120);
        const livingAreaSqm = parseLivingAreaSqm(req.body.living_area_sqm || req.query.living_area_sqm);

        const customerEmail = req.body.email || undefined;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: customerEmail,
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: `Nebenkostenabrechnung Prüfung (${planConfig.label})`,
                        description: planConfig.description,
                    },
                    unit_amount: planConfig.amountCents,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/#upload`,
            metadata: {
                plan: selectedPlan,
                source: source || '',
                campaign: campaign || '',
                living_area_sqm: livingAreaSqm ? String(livingAreaSqm) : '',
            },
        });

        // Store files + email temporarily
        pendingFiles.set(session.id, {
            files: req.files.map(f => ({
                originalname: f.originalname,
                mimetype: f.mimetype,
                buffer: f.buffer,
                size: f.size,
            })),
            email: customerEmail,
            plan: selectedPlan,
            source,
            campaign,
            livingAreaSqm,
            createdAt: Date.now(),
        });

        upsertOrder({
            session_id: session.id,
            plan: selectedPlan,
            gross_eur: Number((planConfig.amountCents / 100).toFixed(2)),
            net_eur: Number((planConfig.amountCents / 100).toFixed(2)),
            payment_status: 'pending',
            refund_status: 'none',
            source,
            campaign,
        });

        appendEvent({
            sessionId: session.id,
            eventName: 'checkout_started',
            source,
            campaign,
            meta: {
                plan: selectedPlan,
                file_count: req.files.length,
                living_area_sqm: livingAreaSqm,
            },
        });

        console.log(`Checkout session created: ${session.id} (${selectedPlan}, ${req.files.length} file(s), email: ${customerEmail || 'none'})`);
        res.json({ checkoutUrl: session.url });

    } catch (err) {
        console.error('Checkout creation error:', err);
        res.status(500).json({ error: 'Zahlung konnte nicht erstellt werden. Bitte versuchen Sie es erneut.' });
    }
}

// === STEP 1: Upload files + create Stripe Checkout Session ===
app.post('/api/create-checkout', upload.array('files', 5), async (req, res) => {
    return createCheckoutHandler(req, res, 'basic');
});

// === New V2 checkout with explicit plan ===
app.post('/api/create-checkout-v2', upload.array('files', 5), async (req, res) => {
    return createCheckoutHandler(req, res, 'basic');
});

// === Kostenloser Vorab-Check (ohne Zahlung) ===
app.post('/api/free-preview', upload.array('files', 5), async (req, res) => {
    try {
        const consentAccepted = req.body?.consent === '1' || req.body?.consent === 'true' || req.body?.consent === true;
        if (!consentAccepted) {
            return res.status(400).json({ error: 'Bitte stimmen Sie der Datenverarbeitung zu (Pflichtangabe).' });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
        }
        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(503).json({ error: 'Vorab-Check derzeit nicht verfügbar.' });
        }

        const source = sanitizeText(req.body.source || req.query.source, 120);
        const campaign = sanitizeText(req.body.campaign || req.query.campaign, 120);
        const livingAreaSqm = parseLivingAreaSqm(req.body.living_area_sqm || req.query.living_area_sqm);

        appendEvent({
            eventName: 'free_preview_started',
            source,
            campaign,
            meta: { file_count: req.files.length, living_area_sqm: livingAreaSqm },
        });

        const files = req.files.map(f => ({
            originalname: f.originalname,
            mimetype: f.mimetype,
            buffer: f.buffer,
            size: f.size,
        }));

        const preview = await runFreePreview(files, { livingAreaSqm });

        appendEvent({
            eventName: 'free_preview_completed',
            source,
            campaign,
            meta: {
                file_count: req.files.length,
                validierung: preview.validierung,
                auffaelligkeiten: preview.auffaelligkeiten.length,
                living_area_sqm: livingAreaSqm,
            },
        });

        return res.json({ ok: true, preview });
    } catch (err) {
        console.error('free-preview error:', err.message);
        return res.status(500).json({ error: 'Vorab-Check fehlgeschlagen. Bitte erneut versuchen.' });
    }
});

// === STEP 2: Poll for analysis result ===
// Client calls this repeatedly. First call triggers the analysis, subsequent calls check status.
app.get('/api/result/:sessionId', async (req, res) => {
    // Never cache polling responses. Some browsers will send If-None-Match and receive 304,
    // which breaks JSON parsing and leaves the UI stuck in "processing".
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    try {
        const { sessionId } = req.params;

        // 1. Already completed? Return cached result
        const cached = completedResults.get(sessionId);
        if (cached) {
            if (cached.error) {
                return res.json({ status: 'error', error: cached.error, errorType: cached.errorType || 'unknown' });
            }
            return res.json({ status: 'done', data: cached.result });
        }

        // 2. Currently being analyzed? Tell client to keep polling
        if (activeAnalyses.has(sessionId)) {
            return res.json({ status: 'processing' });
        }

        // 3. First call — verify payment and start analysis
        if (!process.env.ANTHROPIC_API_KEY) {
            return res.json({ status: 'error', error: 'ANTHROPIC_API_KEY nicht gesetzt.' });
        }

        // Verify payment with Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') {
            return res.json({ status: 'error', error: 'Zahlung nicht abgeschlossen.' });
        }

        upsertOrder({
            session_id: sessionId,
            plan: session.metadata?.plan || 'basic',
            payment_status: 'paid',
            refund_status: 'none',
            source: session.metadata?.source || null,
            campaign: session.metadata?.campaign || null,
        });
        if (!hasEvent(sessionId, 'payment_completed')) {
            appendEvent({
                sessionId,
                eventName: 'payment_completed',
                source: session.metadata?.source || null,
                campaign: session.metadata?.campaign || null,
                meta: {
                    plan: session.metadata?.plan || 'basic',
                    amount_total: session.amount_total || null,
                },
            });
        }

        // Check if files exist
        if (!pendingFiles.has(sessionId)) {
            return res.json({
                status: 'error',
                error: 'Ihre Dateien konnten nicht mehr gefunden werden. Bitte laden Sie Ihre Abrechnung kostenlos erneut hoch.',
                errorType: 'files_expired'
            });
        }

        // Start analysis in background
        startBackgroundAnalysis(sessionId);
        return res.json({ status: 'processing' });

    } catch (err) {
        console.error('Result check error:', err);
        res.json({ status: 'error', error: 'Fehler bei der Abfrage. Bitte versuchen Sie es erneut.' });
    }
});

// === STEP 3: Retry analysis with re-uploaded files (free, payment already verified) ===
app.post('/api/retry-analysis', upload.array('files', 5), async (req, res) => {
    try {
        const sessionId = req.body.session_id;
        if (!sessionId) {
            return res.status(400).json({ error: 'Keine Session-ID angegeben.' });
        }
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
        }

        // Verify payment with Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') {
            return res.status(403).json({ error: 'Zahlung nicht gefunden.' });
        }

        // Clear any old error result for this session
        completedResults.delete(sessionId);
        activeAnalyses.delete(sessionId);

        // Store new files
        pendingFiles.set(sessionId, {
            files: req.files.map(f => ({
                originalname: f.originalname,
                mimetype: f.mimetype,
                buffer: f.buffer,
                size: f.size,
            })),
            email: session.customer_email || undefined,
            plan: session.metadata?.plan || 'basic',
            source: session.metadata?.source || null,
            campaign: session.metadata?.campaign || null,
            livingAreaSqm: parseLivingAreaSqm(session.metadata?.living_area_sqm),
            createdAt: Date.now(),
        });

        console.log(`Retry analysis for ${sessionId}: ${req.files.length} new file(s)`);

        // Start analysis
        startBackgroundAnalysis(sessionId);
        appendEvent({
            sessionId,
            eventName: 'analysis_retry_started',
            source: session.metadata?.source || null,
            campaign: session.metadata?.campaign || null,
            meta: { file_count: req.files.length },
        });
        res.json({ status: 'processing' });

    } catch (err) {
        console.error('Retry analysis error:', err);
        res.status(500).json({ error: 'Erneuter Versuch fehlgeschlagen. Bitte kontaktieren Sie marc@marcboehle.de' });
    }
});

// === Funnel event tracking ===
app.post('/api/track-event', express.json(), (req, res) => {
    try {
        const eventName = sanitizeText(req.body.event_name, 80);
        if (!eventName) {
            return res.status(400).json({ error: 'event_name fehlt.' });
        }

        appendEvent({
            sessionId: sanitizeText(req.body.session_id, 120),
            eventName,
            source: sanitizeText(req.body.source, 120),
            campaign: sanitizeText(req.body.campaign, 120),
            meta: req.body.meta && typeof req.body.meta === 'object' ? req.body.meta : {},
            ts: req.body.ts,
        });

        res.json({ ok: true });
    } catch (err) {
        console.error('track-event error:', err.message);
        res.status(500).json({ error: 'Tracking fehlgeschlagen.' });
    }
});

// === Daily funnel summary ===
app.get('/api/funnel-summary', (req, res) => {
    try {
        const from = sanitizeText(req.query.from, 30);
        const to = sanitizeText(req.query.to, 30);
        const summary = summarizeFunnel(from, to);
        res.json(summary);
    } catch (err) {
        console.error('funnel-summary error:', err.message);
        res.status(500).json({ error: 'Funnel-Summary fehlgeschlagen.' });
    }
});

// === Stripe Webhook (triggers analysis even if user closes browser) ===
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        // Webhook not configured — skip silently
        return res.json({ received: true });
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log(`Webhook: checkout.session.completed for ${session.id}`);
        upsertOrder({
            session_id: session.id,
            plan: session.metadata?.plan || 'basic',
            payment_status: 'paid',
            refund_status: 'none',
            source: session.metadata?.source || null,
            campaign: session.metadata?.campaign || null,
            gross_eur: session.amount_total ? Number((session.amount_total / 100).toFixed(2)) : undefined,
            net_eur: session.amount_total ? Number((session.amount_total / 100).toFixed(2)) : undefined,
        });
        if (!hasEvent(session.id, 'payment_completed')) {
            appendEvent({
                sessionId: session.id,
                eventName: 'payment_completed',
                source: session.metadata?.source || null,
                campaign: session.metadata?.campaign || null,
                meta: {
                    plan: session.metadata?.plan || 'basic',
                    amount_total: session.amount_total || null,
                },
            });
        }
        // Start analysis if files are pending and not already running
        if (pendingFiles.has(session.id) && !activeAnalyses.has(session.id) && !completedResults.has(session.id)) {
            startBackgroundAnalysis(session.id);
        }
    }

    res.json({ received: true });
});

// === PDF Download endpoint ===
app.get('/api/download-pdf/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const cached = completedResults.get(sessionId);

        if (!cached || !cached.result) {
            return res.status(404).json({ error: 'Kein Ergebnis gefunden.' });
        }

        const pdfBuffer = await generatePDF(cached.result);
        appendEvent({
            sessionId,
            eventName: 'result_pdf_downloaded',
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="Pruefbericht-Nebenkosten.pdf"');
        res.send(pdfBuffer);
    } catch (err) {
        console.error('PDF download error:', err.message);
        res.status(500).json({ error: 'PDF konnte nicht erstellt werden.' });
    }
});

// === Reminder opt-in (save email for annual reminder) ===
app.post('/api/reminder-optin', express.json(), (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Keine E-Mail angegeben.' });

    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        const remindersFile = path.join(dataDir, 'reminders.json');
        let reminders = [];
        if (fs.existsSync(remindersFile)) {
            reminders = JSON.parse(fs.readFileSync(remindersFile, 'utf-8'));
        }

        // Avoid duplicates
        if (!reminders.some(r => r.email === email)) {
            reminders.push({ email, createdAt: new Date().toISOString() });
            fs.writeFileSync(remindersFile, JSON.stringify(reminders, null, 2));
            console.log(`Reminder opt-in: ${email}`);
            appendEvent({
                eventName: 'reminder_optin',
                meta: { email_hash_hint: `${email.slice(0, 2)}***` },
            });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('Reminder opt-in error:', err.message);
        res.status(500).json({ error: 'Speichern fehlgeschlagen.' });
    }
});

app.listen(PORT, () => {
    console.log(`\n  NebenkostenRetter Server läuft auf http://localhost:${PORT}\n`);

    const checks = [
        ['ANTHROPIC_API_KEY', 'API-Key'],
        ['STRIPE_SECRET_KEY', 'Stripe-Key'],
        ['RESEND_API_KEY', 'Resend-Key'],
        ['STRIPE_WEBHOOK_SECRET', 'Webhook-Secret (optional)'],
    ];

    let allGood = true;
    for (const [envVar, label] of checks) {
        if (process.env[envVar]) {
            console.log(`  ✓  ${label} erkannt.`);
        } else {
            console.log(`  ⚠  ${envVar} nicht gesetzt!`);
            allGood = false;
        }
    }

    if (!allGood) {
        console.log('\n  Starte mit: STRIPE_SECRET_KEY=sk_... ANTHROPIC_API_KEY=sk-ant-... node server.js\n');
    } else {
        console.log('  Ready.\n');
    }
});
