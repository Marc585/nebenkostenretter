const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk').default;
const pdfParse = require('pdf-parse');
const Stripe = require('stripe');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('.'));

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
const pendingFiles = new Map();      // session_id → { files, createdAt }
const activeAnalyses = new Set();    // session_ids currently being analyzed
const completedResults = new Map();  // session_id → { result, createdAt }

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

## Prüfpunkte

1. **Umlagefähigkeit** (§ 2 BetrKV): Sind alle Posten umlagefähig? NICHT umlagefähig sind u.a.:
   - Verwaltungskosten, Instandhaltung/Instandsetzung/Reparaturen
   - Instandhaltungsrücklage (WEG), Bankgebühren, Leerstandskosten

2. **Umlageschlüssel**: Nachvollziehbar? (Wohnfläche, Personenzahl, Verbrauch, Einheiten)

3. **Abrechnungszeitraum**: Genau 12 Monate?

4. **Abrechnungsfrist**: Innerhalb von 12 Monaten nach Ende des Abrechnungszeitraums? (§ 556 Abs. 3 BGB)

5. **Vorauszahlungen**: Korrekt angerechnet?

6. **Plausibilität**: Durchschnittswerte pro m²/Jahr:
   Heizung 8-15€, Wasser 2-4€, Müll 1-2€, Grundsteuer 1-3€, Hausmeister 1-2€, Versicherung 1-2€, Aufzug 1-2€

7. **Heizkostenverordnung**: 50/70-30/50-Regel (Verbrauch/Grundkosten)?

8. **Formale Vollständigkeit**: Gesamtkosten, Mieteranteil, Vorauszahlungen, Saldo?

## Ausgabe-Format

Antworte AUSSCHLIESSLICH mit folgendem JSON (kein anderer Text):

{
  "zusammenfassung": "Kurze Zusammenfassung in 1-2 Sätzen",
  "wohnflaeche_erkannt": "z.B. 65 m² oder null",
  "abrechnungszeitraum": "z.B. 01.01.2024 - 31.12.2024 oder null",
  "gesamtkosten_mieter": "z.B. 2.450,00 € oder null",
  "ergebnisse": [
    {
      "posten": "Name des Postens",
      "betrag": "z.B. '312,00 €'",
      "status": "ok | warnung | fehler",
      "titel": "Kurzer Titel (max 8 Wörter)",
      "erklaerung": "Was ist das Problem, warum, Rechtsgrundlage. 1-3 Sätze.",
      "ersparnis_geschaetzt": 0
    }
  ],
  "potenzielle_ersparnis_gesamt": 0,
  "fehler_anzahl": 0,
  "warnungen_anzahl": 0,
  "empfehlung": "Was der Mieter tun sollte, 1-2 Sätze",
  "widerspruchsbrief": "Fertiger Brief — siehe Regeln unten"
}

## Regeln für den Widerspruchsbrief (Feld "widerspruchsbrief")

Erstelle einen FERTIGEN, kopierbaren Widerspruchsbrief an den Vermieter. Der Brief soll:
- Professionell aber freundlich im Ton sein (Siezen, sachlich, nicht aggressiv)
- Konkret die gefundenen Fehler mit Posten und Beträgen benennen
- Die jeweilige Rechtsgrundlage nennen (z.B. § 2 BetrKV, § 556 BGB)
- Eine Frist von 14 Tagen zur Korrektur setzen
- Die korrigierte Nachzahlung/das Guthaben berechnen wenn möglich
- Platzhalter verwenden: [IHR NAME], [IHRE ADRESSE], [VERMIETER NAME], [VERMIETER ADRESSE], [DATUM]
- Format: Absenderadresse, Empfängeradresse, Datum, Betreff, Anrede, Brieftext, Grußformel
- Zeilenumbrüche mit \\n kodieren

Falls KEINE Fehler gefunden wurden, setze widerspruchsbrief auf null.

## Wichtige Regeln
- Präzise und faktenbasiert. Keine Spekulationen.
- Auf Deutsch antworten.
- JEDEN erkennbaren Posten auflisten, auch wenn OK.

## STRENGE Regeln für status (UNBEDINGT einhalten!)

**"fehler"** NUR verwenden wenn ALLE 3 Bedingungen erfüllt sind:
  1. Es gibt einen klar belegbaren Verstoß gegen BetrKV, BGB oder HeizkostenV
  2. Die geschätzte Ersparnis ist GRÖSSER als 0 €
  3. Du bist dir SICHER (>90% Konfidenz)
  → Wenn die Ersparnis 0 € wäre oder du dir nicht sicher bist: NIEMALS "fehler" verwenden!

**"warnung"** verwenden wenn:
  - Ein Posten auffällig hoch ist (über Durchschnitt), aber du nicht sicher bist ob es ein Fehler ist
  - Formale Mängel die keine direkte Ersparnis bringen (z.B. fehlende Angabe)
  - Du einen Verdacht hast, aber nicht genug Infos für "fehler"
  - ersparnis_geschaetzt darf bei Warnungen 0 sein

**"ok"** verwenden wenn:
  - Der Posten plausibel und im normalen Rahmen ist
  - ersparnis_geschaetzt MUSS 0 sein

**VERBOTEN**: Status "fehler" mit ersparnis_geschaetzt = 0. Das darf NIEMALS vorkommen.
**VERBOTEN**: Posten als "fehler" markieren nur weil du den Betrag nicht überprüfen kannst.

## Konsistenz
- Analysiere systematisch jeden Posten anhand der Prüfpunkte oben.
- Verwende die Durchschnittswerte als Orientierung, nicht als harte Grenze.
- Ein Posten der 10-20% über dem Durchschnitt liegt ist "ok", nicht "warnung".
- Erst ab 50%+ über Durchschnitt ist eine "warnung" gerechtfertigt.`;

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
async function runAnalysis(files) {
    const content = await buildContentFromFiles(files);

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

    return JSON.parse(jsonStr);
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
        const ersparnis = data.potenzielle_ersparnis_gesamt || 0;

        doc.fontSize(11).fillColor('#1a1a2e')
            .text(`Gefundene Fehler: `, { continued: true }).fillColor(red).text(`${fehler.length}`)
            .fillColor('#1a1a2e').text(`Warnungen: `, { continued: true }).fillColor(orange).text(`${warnungen.length}`)
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

            // Check if we need a new page
            if (doc.y > 700) doc.addPage();

            doc.fontSize(11).fillColor(statusColor).text(`[${statusLabel}] `, { continued: true })
                .fillColor('#1a1a2e').text(`${item.posten}`, { continued: true })
                .fillColor(gray).text(`  ${item.betrag || ''}`);

            if (item.erklaerung) {
                doc.fontSize(10).fillColor(gray).text(item.erklaerung);
            }
            if (item.ersparnis_geschaetzt > 0) {
                doc.fontSize(10).fillColor(green).text(`Mögliche Ersparnis: ${Math.round(item.ersparnis_geschaetzt)} €`);
            }
            doc.moveDown(0.4);
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
    const ersparnis = data.potenzielle_ersparnis_gesamt || 0;

    const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a2e;">
            <h2 style="color: #1a6b4a;">Ihr Prüfbericht ist fertig!</h2>
            <p>Wir haben Ihre Nebenkostenabrechnung geprüft. Hier die wichtigsten Ergebnisse:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr>
                    <td style="padding: 12px; background: ${fehler.length > 0 ? '#fef2f2' : '#f0faf4'}; border-radius: 8px; text-align: center;">
                        <strong style="font-size: 24px; color: ${fehler.length > 0 ? '#c53030' : '#1a6b4a'};">${fehler.length}</strong><br>
                        <span style="color: #4a5568; font-size: 13px;">${fehler.length === 1 ? 'Fehler' : 'Fehler'}</span>
                    </td>
                    <td style="width: 12px;"></td>
                    <td style="padding: 12px; background: ${warnungen.length > 0 ? '#fffbeb' : '#f0faf4'}; border-radius: 8px; text-align: center;">
                        <strong style="font-size: 24px; color: ${warnungen.length > 0 ? '#b7791f' : '#1a6b4a'};">${warnungen.length}</strong><br>
                        <span style="color: #4a5568; font-size: 13px;">Warnungen</span>
                    </td>
                    <td style="width: 12px;"></td>
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
async function runAnalysisWithRetry(files, maxRetries = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            return await runAnalysis(files);
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

// === Start background analysis for a session ===
function startBackgroundAnalysis(sessionId) {
    if (activeAnalyses.has(sessionId)) return; // Already running

    const pending = pendingFiles.get(sessionId);
    if (!pending) return;

    activeAnalyses.add(sessionId);

    runAnalysisWithRetry(pending.files)
        .then(async (result) => {
            completedResults.set(sessionId, { result, createdAt: Date.now() });
            console.log(`Analysis complete for ${sessionId}: ${result.fehler_anzahl} errors, ${result.warnungen_anzahl} warnings`);

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

// === STEP 1: Upload files + create Stripe Checkout Session ===
app.post('/api/create-checkout', upload.array('files', 5), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
        }

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ error: 'STRIPE_SECRET_KEY nicht gesetzt.' });
        }

        // Determine base URL for redirects
        const baseUrl = `${req.protocol}://${req.get('host')}`;

        const customerEmail = req.body.email || undefined;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: customerEmail,
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: 'Nebenkostenabrechnung Prüfung',
                        description: 'Komplette Prüfung aller Posten inkl. Widerspruchsbrief',
                    },
                    unit_amount: 399,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/#upload`,
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
            createdAt: Date.now(),
        });

        console.log(`Checkout session created: ${session.id} (${req.files.length} file(s), email: ${customerEmail || 'none'})`);
        res.json({ checkoutUrl: session.url });

    } catch (err) {
        console.error('Checkout creation error:', err);
        res.status(500).json({ error: 'Zahlung konnte nicht erstellt werden. Bitte versuchen Sie es erneut.' });
    }
});

// === STEP 2: Poll for analysis result ===
// Client calls this repeatedly. First call triggers the analysis, subsequent calls check status.
app.get('/api/result/:sessionId', async (req, res) => {
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
            createdAt: Date.now(),
        });

        console.log(`Retry analysis for ${sessionId}: ${req.files.length} new file(s)`);

        // Start analysis
        startBackgroundAnalysis(sessionId);
        res.json({ status: 'processing' });

    } catch (err) {
        console.error('Retry analysis error:', err);
        res.status(500).json({ error: 'Erneuter Versuch fehlgeschlagen. Bitte kontaktieren Sie marc@marcboehle.de' });
    }
});

app.listen(PORT, () => {
    console.log(`\n  NebenkostenRetter Server läuft auf http://localhost:${PORT}\n`);

    const checks = [
        ['ANTHROPIC_API_KEY', 'API-Key'],
        ['STRIPE_SECRET_KEY', 'Stripe-Key'],
        ['RESEND_API_KEY', 'Resend-Key'],
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
