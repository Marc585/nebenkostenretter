// === Elements ===
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const fileListItems = document.getElementById('fileListItems');
const addMoreBtn = document.getElementById('addMoreBtn');
const startFreePreviewBtn = document.getElementById('startFreePreviewBtn');
const startAnalysisBtn = document.getElementById('startAnalysisBtn');
const emailInput = document.getElementById('emailInput');
const uploadProgress = document.getElementById('uploadProgress');
const resultPreview = document.getElementById('resultPreview');

// Collected files
let collectedFiles = [];

// === On page load: check if returning from Stripe or resuming session ===
let analysisResult = null;
let analysisError = null;
let analysisErrorType = null;
let currentSessionId = null;
let apiDone = false;
let selectedPlan = 'basic';
let uploadTracked = false;
let freePreviewRunning = false;

const PLAN_LABELS = {
    basic: 'Für 4,99 € prüfen lassen',
};

function getAttribution() {
    const url = new URL(window.location.href);
    const params = url.searchParams;

    const source = params.get('utm_source') || params.get('source') || localStorage.getItem('nk_source') || 'direct';
    const campaign = params.get('utm_campaign') || params.get('campaign') || localStorage.getItem('nk_campaign') || 'none';

    localStorage.setItem('nk_source', source);
    localStorage.setItem('nk_campaign', campaign);

    return { source, campaign };
}

function trackEvent(eventName, extra = {}) {
    const attribution = getAttribution();
    const payload = {
        event_name: eventName,
        session_id: currentSessionId || localStorage.getItem('nk_session_id') || null,
        source: attribution.source,
        campaign: attribution.campaign,
        ts: new Date().toISOString(),
        meta: {
            plan: selectedPlan,
            ...extra,
        },
    };

    fetch('/api/track-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
    }).catch(() => {});
}

(function checkSession() {
    const params = new URLSearchParams(window.location.search);
    let sessionId = params.get('session_id');

    // If no URL param, check localStorage for a saved session
    if (!sessionId) {
        sessionId = localStorage.getItem('nk_session_id');
    }

    if (sessionId) {
        currentSessionId = sessionId;

        // Save to localStorage (backup for reload/close)
        localStorage.setItem('nk_session_id', sessionId);

        // Clean URL (keep session in localStorage)
        if (params.has('session_id')) {
            window.history.replaceState({}, '', '/');
        }

        // Show progress spinner
        uploadArea.style.display = 'none';
        uploadProgress.style.display = 'block';

        // Scroll to upload section
        setTimeout(() => {
            document.getElementById('upload').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);

        // Start spinner + poll for results
        animateProgress();
        pollForResults(sessionId);
    }
})();

trackEvent('page_view');
updateButtonState();

// === Poll server for analysis result ===
function pollForResults(sessionId) {
    analysisResult = null;
    analysisError = null;
    analysisErrorType = null;
    apiDone = false;

    const poll = async () => {
        try {
            const res = await fetch(`/api/result/${encodeURIComponent(sessionId)}`);
            const data = await res.json();

            if (data.status === 'done') {
                analysisResult = data.data;
                apiDone = true;
                localStorage.removeItem('nk_session_id');
                trackEvent('analysis_result_ready');
            } else if (data.status === 'error') {
                analysisError = data.error;
                analysisErrorType = data.errorType || 'unknown';
                apiDone = true;
                // Keep session_id in localStorage for retry
                trackEvent('analysis_error', { error_type: analysisErrorType });
            } else if (data.status === 'processing') {
                // Keep polling every 2 seconds
                setTimeout(poll, 2000);
            }
        } catch (err) {
            // Network error — retry in 3 seconds
            setTimeout(poll, 3000);
        }
    };

    poll();
}

// Click to upload
uploadArea.addEventListener('click', () => fileInput.click());

// Drag events
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    addFiles(Array.from(e.dataTransfer.files));
});

// File input change
fileInput.addEventListener('change', (e) => {
    addFiles(Array.from(e.target.files));
    fileInput.value = '';
});

// Add more button
addMoreBtn.addEventListener('click', () => fileInput.click());

// Consent checkbox + email → enable/disable payment button
const consentCheckbox = document.getElementById('consentCheckbox');

function updateButtonState() {
    const hasFiles = collectedFiles.length > 0;
    const emailValid = emailInput.value.trim() !== '' && emailInput.validity.valid;
    startAnalysisBtn.disabled = freePreviewRunning || !(hasFiles && consentCheckbox.checked && emailValid);
    if (startFreePreviewBtn) {
        startFreePreviewBtn.disabled = freePreviewRunning || !hasFiles;
    }
}

consentCheckbox.addEventListener('change', updateButtonState);
emailInput.addEventListener('input', updateButtonState);

if (startFreePreviewBtn) {
    startFreePreviewBtn.addEventListener('click', () => startFreePreview());
}

// Start analysis button → now triggers Stripe Checkout
startAnalysisBtn.addEventListener('click', () => startCheckout());

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function addFiles(files) {
    const validTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];

    for (const file of files) {
        if (!validTypes.includes(file.type)) {
            alert(`"${file.name}" wird nicht unterstützt. Nur PDF, JPG, PNG.`);
            continue;
        }
        if (file.size > 10 * 1024 * 1024) {
            alert(`"${file.name}" ist zu groß. Maximal 10 MB pro Datei.`);
            continue;
        }
        if (file.type !== 'application/pdf' && file.size < 15 * 1024) {
            alert(`"${file.name}" ist zu klein (${Math.round(file.size / 1024)} KB). Das Bild ist vermutlich leer oder beschädigt. Bitte fotografieren Sie Ihre Abrechnung erneut.`);
            continue;
        }
        if (file.type === 'application/pdf' && file.size < 5 * 1024) {
            alert(`"${file.name}" ist zu klein (${Math.round(file.size / 1024)} KB). Die PDF-Datei scheint leer oder beschädigt zu sein.`);
            continue;
        }
        if (collectedFiles.length >= 5 && file.type !== 'application/pdf') {
            alert('Maximal 5 Dateien erlaubt.');
            break;
        }
        // For PDFs, replace the file list (single PDF = whole document)
        if (file.type === 'application/pdf') {
            collectedFiles = [file];
        } else {
            collectedFiles.push(file);
        }
    }

    if (collectedFiles.length > 0) {
        renderFileList();
        if (!uploadTracked) {
            uploadTracked = true;
            trackEvent('upload_added', { file_count: collectedFiles.length });
        } else {
            trackEvent('upload_updated', { file_count: collectedFiles.length });
        }
    }
    updateButtonState();
}

function renderFileList() {
    uploadArea.style.display = 'none';
    fileList.style.display = 'block';
    resultPreview.style.display = 'none';

    fileListItems.innerHTML = collectedFiles.map((f, i) => `
        <div class="file-list-item">
            <span class="file-list-icon">${f.type === 'application/pdf' ? '&#128196;' : '&#128247;'}</span>
            <span class="file-list-name">${escapeHTML(f.name)}</span>
            <span class="file-list-size">${formatFileSize(f.size)}</span>
            <button class="file-list-remove" onclick="removeFile(${i})" title="Entfernen">&times;</button>
        </div>
    `).join('');
}

function removeFile(index) {
    collectedFiles.splice(index, 1);
    if (collectedFiles.length === 0) {
        resetUpload();
    } else {
        renderFileList();
        updateButtonState();
    }
}

// === Upload files to server + redirect to Stripe Checkout ===
async function startFreePreview() {
    if (collectedFiles.length === 0 || freePreviewRunning) return;
    const attribution = getAttribution();
    freePreviewRunning = true;
    updateButtonState();
    trackEvent('free_preview_clicked', { file_count: collectedFiles.length });

    resultPreview.style.display = 'block';
    resultPreview.innerHTML = `
        <div class="result-summary">
            <p><strong>Kostenloser Vorab-Check läuft...</strong><br>Wir prüfen jetzt Lesbarkeit und erste Auffälligkeiten. Das dauert in der Regel unter 30 Sekunden.</p>
        </div>
    `;

    const formData = new FormData();
    for (const file of collectedFiles) {
        formData.append('files', file);
    }
    formData.append('source', attribution.source);
    formData.append('campaign', attribution.campaign);

    try {
        const res = await fetch('/api/free-preview', {
            method: 'POST',
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || 'Vorab-Check fehlgeschlagen.');
        }
        renderFreePreview(data.preview);
        trackEvent('free_preview_rendered', {
            validierung: data.preview?.validierung || 'ok',
            auffaelligkeiten: data.preview?.auffaelligkeiten?.length || 0,
        });
    } catch (err) {
        resultPreview.innerHTML = `
            <div class="result-summary">
                <p><strong>Vorab-Check aktuell nicht verfügbar.</strong><br>${escapeHTML(err.message || 'Bitte versuchen Sie es erneut.')}</p>
            </div>
        `;
    } finally {
        freePreviewRunning = false;
        updateButtonState();
    }
}

async function startCheckout() {
    if (collectedFiles.length === 0) return;
    const attribution = getAttribution();

    // Disable button and show loading state
    startAnalysisBtn.disabled = true;
    if (startFreePreviewBtn) startFreePreviewBtn.disabled = true;
    startAnalysisBtn.textContent = 'Wird vorbereitet...';

    const formData = new FormData();
    for (const file of collectedFiles) {
        formData.append('files', file);
    }
    formData.append('email', emailInput.value.trim());
    formData.append('plan', selectedPlan);
    formData.append('source', attribution.source);
    formData.append('campaign', attribution.campaign);
    trackEvent('checkout_clicked', { file_count: collectedFiles.length });

    try {
        const res = await fetch('/api/create-checkout-v2', {
            method: 'POST',
            body: formData,
        });

        const data = await res.json();

        if (!res.ok) {
            alert(data.error || 'Fehler beim Erstellen der Zahlung.');
            startAnalysisBtn.textContent = PLAN_LABELS[selectedPlan] || PLAN_LABELS.basic;
            updateButtonState();
            return;
        }

        // Save email for reminder opt-in later
        const emailVal = emailInput.value.trim();
        if (emailVal) localStorage.setItem('nk_email', emailVal);

        // Redirect to Stripe Checkout
        trackEvent('checkout_redirected');
        window.location.href = data.checkoutUrl;

    } catch (err) {
        alert('Verbindung zum Server fehlgeschlagen. Läuft der Server?');
        startAnalysisBtn.textContent = PLAN_LABELS[selectedPlan] || PLAN_LABELS.basic;
        updateButtonState();
    }
}

// === Progress animation ===
function animateProgress() {
    const spinnerStatus = document.getElementById('spinnerStatus');
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step3 = document.getElementById('step3');
    const step4 = document.getElementById('step4');
    const allSteps = [step1, step2, step3, step4];

    const statusTexts = [
        'Dokument wird eingelesen...',
        'Posten werden auf Fehler geprüft...',
        'Widerspruchsbrief wird erstellt...',
        'Ergebnis wird zusammengestellt...'
    ];

    // Reset
    allSteps.forEach(s => s.classList.remove('active', 'done'));
    step1.classList.add('active');
    spinnerStatus.textContent = statusTexts[0];

    // Step 1 → done after 2s
    setTimeout(() => {
        step1.classList.remove('active');
        step1.classList.add('done');
        step2.classList.add('active');
        spinnerStatus.textContent = statusTexts[1];
    }, 2000);

    // Step 2 → done after 6s
    setTimeout(() => {
        step2.classList.remove('active');
        step2.classList.add('done');
        step3.classList.add('active');
        spinnerStatus.textContent = statusTexts[2];
    }, 6000);

    // Step 3 → done after 10s
    setTimeout(() => {
        step3.classList.remove('active');
        step3.classList.add('done');
        step4.classList.add('active');
        spinnerStatus.textContent = statusTexts[3];
    }, 10000);

    // Poll for API completion
    const pollInterval = setInterval(() => {
        if (apiDone) {
            clearInterval(pollInterval);

            // Mark all steps as done
            allSteps.forEach(s => {
                s.classList.remove('active');
                s.classList.add('done');
            });
            spinnerStatus.textContent = 'Fertig!';

            setTimeout(() => {
                uploadProgress.style.display = 'none';

                if (analysisError) {
                    showError(analysisError);
                } else {
                    renderResults(analysisResult);
                }
            }, 600);
        }
    }, 300);
}

function showError(message) {
    const isValidationError = analysisErrorType && analysisErrorType.startsWith('validation_');
    const canRetry = !isValidationError && currentSessionId && (analysisErrorType === 'files_expired' || analysisErrorType === 'analysis_failed' || analysisErrorType === 'rate_limit');

    let contentHTML = '';

    if (isValidationError) {
        // Validation errors: friendly message, refund info, link back to upload
        const icon = analysisErrorType === 'validation_keine_abrechnung' ? '&#128196;' :
                     analysisErrorType === 'validation_nicht_lesbar' ? '&#128247;' : '&#128203;';
        const title = analysisErrorType === 'validation_keine_abrechnung' ? 'Keine Nebenkostenabrechnung erkannt' :
                      analysisErrorType === 'validation_nicht_lesbar' ? 'Dokument nicht lesbar' : 'Dokument unvollständig';

        contentHTML = `
            <div style="padding: 40px; text-align: center;">
                <div style="font-size: 48px; margin-bottom: 16px;">${icon}</div>
                <h3 style="margin-bottom: 12px;">${title}</h3>
                <p style="color: #6b7280; margin-bottom: 24px; max-width: 500px; margin-left: auto; margin-right: auto;">${escapeHTML(message)}</p>
                <a href="/#upload" class="btn btn-lg" style="display: inline-block; text-decoration: none; margin-top: 8px;">Neue Abrechnung hochladen</a>
            </div>
        `;
    } else {
        // Technical errors: retry option + support contact
        let retryHTML = '';
        if (canRetry) {
            retryHTML = `
                <div style="background: #f0faf4; border-radius: 12px; padding: 24px; margin-bottom: 20px; text-align: left;">
                    <h4 style="margin: 0 0 8px 0; color: #1a6b4a;">Kostenlos erneut versuchen</h4>
                    <p style="color: #4a5568; margin: 0 0 16px 0; font-size: 14px;">
                        Sie haben bereits bezahlt. Laden Sie Ihre Abrechnung einfach nochmal hoch — die Prüfung wird kostenlos wiederholt.
                    </p>
                    <input type="file" id="retryFileInput" accept=".pdf,.jpg,.jpeg,.png" multiple hidden>
                    <button class="btn" id="retryUploadBtn">Abrechnung erneut hochladen</button>
                </div>
            `;
        }

        contentHTML = `
            <div style="padding: 40px; text-align: center;">
                <div style="font-size: 48px; margin-bottom: 16px;">&#9888;</div>
                <h3 style="margin-bottom: 12px;">Analyse fehlgeschlagen</h3>
                <p style="color: #6b7280; margin-bottom: 24px;">${escapeHTML(message)}</p>
                ${retryHTML}
                <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-top: 8px;">
                    <p style="color: #6b7280; font-size: 14px; margin-bottom: 12px;">
                        Problem besteht weiterhin? Schreiben Sie uns:
                    </p>
                    <a href="mailto:marc@marcboehle.de?subject=Analyse fehlgeschlagen (${currentSessionId || 'keine Session'})&body=Meine Analyse ist fehlgeschlagen. Session: ${currentSessionId || 'unbekannt'}"
                       style="color: #1a6b4a; font-weight: 600; text-decoration: underline;">
                        marc@marcboehle.de
                    </a>
                    <p style="color: #9ca3af; font-size: 12px; margin-top: 8px;">Wir melden uns innerhalb von 24 Stunden und finden eine Lösung.</p>
                </div>
            </div>
        `;
    }

    resultPreview.innerHTML = contentHTML;
    resultPreview.style.display = 'block';
    resultPreview.style.animation = 'fadeInUp 0.5s ease';
    trackEvent('result_rendered_error', { error_type: analysisErrorType || 'unknown' });

    // Attach retry handlers if applicable
    if (canRetry) {
        const retryBtn = document.getElementById('retryUploadBtn');
        const retryInput = document.getElementById('retryFileInput');
        retryBtn.addEventListener('click', () => retryInput.click());
        retryInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                startRetryAnalysis(currentSessionId, files);
            }
        });
    }
}

// === Retry analysis with re-uploaded files (free) ===
async function startRetryAnalysis(sessionId, files) {
    // Show progress spinner
    resultPreview.style.display = 'none';
    uploadProgress.style.display = 'block';

    const formData = new FormData();
    formData.append('session_id', sessionId);
    for (const file of files) {
        formData.append('files', file);
    }

    try {
        const res = await fetch('/api/retry-analysis', {
            method: 'POST',
            body: formData,
        });
        const data = await res.json();

        if (!res.ok) {
            uploadProgress.style.display = 'none';
            analysisError = data.error || 'Erneuter Versuch fehlgeschlagen.';
            analysisErrorType = 'unknown';
            showError(analysisError);
            return;
        }

        // Re-poll for results
        animateProgress();
        pollForResults(sessionId);

    } catch (err) {
        uploadProgress.style.display = 'none';
        analysisError = 'Verbindung zum Server fehlgeschlagen. Bitte versuchen Sie es später erneut.';
        analysisErrorType = 'unknown';
        showError(analysisError);
    }
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderFreePreview(preview) {
    if (!preview) return;

    if (preview.validierung && preview.validierung !== 'ok') {
        const message = preview.validierung_grund || 'Das Dokument konnte im Vorab-Check nicht sicher erkannt werden.';
        resultPreview.innerHTML = `
            <div class="result-summary">
                <p><strong>Vorab-Check: Bitte Upload verbessern</strong><br>${escapeHTML(message)}</p>
            </div>
            <div class="result-actions">
                <button class="btn btn-outline" onclick="resetUpload()">Neue Dateien hochladen</button>
            </div>
        `;
        resultPreview.style.display = 'block';
        resultPreview.style.animation = 'fadeInUp 0.5s ease';
        return;
    }

    const basis = preview.erkannte_basisdaten || {};
    const chips = [];
    if (basis.abrechnungszeitraum) chips.push(`Zeitraum: ${basis.abrechnungszeitraum}`);
    if (basis.wohnflaeche) chips.push(`Wohnfläche: ${basis.wohnflaeche}`);
    if (basis.gesamtkosten_mieter) chips.push(`Gesamtkosten: ${basis.gesamtkosten_mieter}`);

    const items = Array.isArray(preview.auffaelligkeiten) ? preview.auffaelligkeiten : [];
    const einsparpotenzial = Number(preview.einsparpotenzial_geschaetzt_eur || 0);
    const savingsText = einsparpotenzial > 0
        ? `Bis zu ${einsparpotenzial.toLocaleString('de-DE')} € möglich`
        : 'Einsparpotenzial wird im Vollcheck berechnet';
    const itemHtml = items.length > 0
        ? items.map((item) => `
            <div class="preview-item ${escapeHTML(item.status_hint || 'hinweis')}">
                <strong>${escapeHTML(item.titel || 'Hinweis')}</strong>
                <p>${escapeHTML(item.kurz || '')}</p>
            </div>
        `).join('')
        : '<div class="preview-item hinweis"><strong>Keine klaren Auffälligkeiten im Vorab-Check.</strong><p>Für eine belastbare Bewertung empfehlen wir trotzdem die vollständige Prüfung.</p></div>';

    resultPreview.innerHTML = `
        <div class="result-summary free-preview">
            <div class="preview-headline">
                <h3>Kostenloser Vorab-Check</h3>
                <span class="preview-quality">Dokumentqualität: ${Number(preview.dokument_qualitaet || 0)} / 100 (${escapeHTML(preview.lesbarkeit || 'mittel')})</span>
            </div>
            <div class="preview-savings-card">
                <span class="preview-savings-label">Einsparpotenzial</span>
                <strong class="preview-savings-amount">${escapeHTML(savingsText)}</strong>
                <p>${escapeHTML(preview.einsparpotenzial_erklaerung || 'Im Vollcheck sehen Sie konkrete Fehler, Beträge und den fertigen Widerspruchsbrief.')}</p>
            </div>
            <p class="preview-note">Dies ist eine erste Einschätzung. Für konkrete Fehlerbewertung, Ersparnis und fertigen Widerspruchsbrief ist die vollständige Prüfung nötig.</p>
            ${chips.length > 0 ? `<div class="preview-meta">${chips.map((c) => `<span class="preview-chip">${escapeHTML(c)}</span>`).join('')}</div>` : ''}
            <div class="preview-actions preview-actions-top">
                <button class="btn" id="proceedFullCheckBtnTop">Jetzt vollständige Prüfung starten (4,99 €)</button>
            </div>
            <div class="preview-items">${itemHtml}</div>
            <p>${escapeHTML(preview.naechster_schritt || 'Wenn Sie sicher gehen möchten, starten Sie jetzt die vollständige Prüfung für 4,99 €.')}</p>
            <div class="preview-actions">
                <button class="btn" id="proceedFullCheckBtn">Jetzt vollständige Prüfung starten (4,99 €)</button>
                <button class="btn btn-outline" onclick="resetUpload()">Neue Abrechnung laden</button>
            </div>
        </div>
    `;

    function continueToCheckoutFocus() {
            const target = document.getElementById('emailInput');
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.focus();
            }
            startAnalysisBtn.classList.add('checkout-highlight');
            setTimeout(() => startAnalysisBtn.classList.remove('checkout-highlight'), 1800);
            trackEvent('free_preview_to_checkout');
    }

    const proceedBtn = document.getElementById('proceedFullCheckBtn');
    const proceedBtnTop = document.getElementById('proceedFullCheckBtnTop');
    if (proceedBtn) {
        proceedBtn.addEventListener('click', continueToCheckoutFocus);
    }
    if (proceedBtnTop) {
        proceedBtnTop.addEventListener('click', continueToCheckoutFocus);
    }

    resultPreview.style.display = 'block';
    resultPreview.style.animation = 'fadeInUp 0.5s ease';
}

function renderResults(data) {
    const fehler = data.ergebnisse.filter(e => e.status === 'fehler');
    const warnungen = data.ergebnisse.filter(e => e.status === 'warnung');
    const unklar = data.ergebnisse.filter(e => e.status === 'unklar');
    const ok = data.ergebnisse.filter(e => e.status === 'ok');
    const totalProbleme = fehler.length + warnungen.length;
    const ersparnis = data.potenzielle_ersparnis_gesamt || 0;

    // Score badge color
    let scoreClass = 'good';
    if (fehler.length > 0) scoreClass = 'bad';
    else if (warnungen.length > 0) scoreClass = 'warn';

    // Build result items HTML
    let itemsHTML = '';

    // Errors first
    fehler.forEach(item => {
        itemsHTML += buildResultItem(item, 'red', 'Fehler');
    });

    // Warnings
    warnungen.forEach(item => {
        itemsHTML += buildResultItem(item, 'orange', 'Prüfen');
    });

    // Unklar items
    unklar.forEach(item => {
        itemsHTML += buildResultItem(item, 'blue', 'Unklar');
    });

    // OK items (collapsed)
    if (ok.length > 0) {
        let okItemsHTML = '';
        ok.forEach(item => {
            okItemsHTML += `
                <div class="result-item green">
                    <div class="result-item-header">
                        <span class="result-tag green">OK</span>
                        <strong>${escapeHTML(item.posten)}</strong>
                        <span class="result-betrag">${escapeHTML(item.betrag)}</span>
                    </div>
                </div>
            `;
        });
        itemsHTML += `
            <details class="ok-details">
                <summary class="ok-summary">${ok.length} Posten ohne Beanstandung anzeigen</summary>
                ${okItemsHTML}
            </details>
        `;
    }

    // Meta info
    let metaHTML = '';
    if (data.wohnflaeche_erkannt || data.abrechnungszeitraum) {
        metaHTML = `<div class="result-meta">`;
        if (data.abrechnungszeitraum) metaHTML += `<span>Zeitraum: ${escapeHTML(data.abrechnungszeitraum)}</span>`;
        if (data.wohnflaeche_erkannt) metaHTML += `<span>Wohnfläche: ${escapeHTML(data.wohnflaeche_erkannt)}</span>`;
        if (data.gesamtkosten_mieter) metaHTML += `<span>Gesamtkosten: ${escapeHTML(data.gesamtkosten_mieter)}</span>`;
        metaHTML += `</div>`;
    }

    // Letter section
    let letterHTML = '';
    if (data.widerspruchsbrief) {
        const briefText = data.widerspruchsbrief.replace(/\\n/g, '\n');
        letterHTML = `
            <div class="letter-section">
                <div class="letter-header">
                    <div class="letter-header-left">
                        <span class="letter-icon">&#9993;</span>
                        <div>
                            <h3>Fertiger Widerspruchsbrief</h3>
                            <p>Ersetzen Sie die [PLATZHALTER] mit Ihren Daten und schicken Sie den Brief an Ihren Vermieter.</p>
                        </div>
                    </div>
                    <button class="btn btn-sm copy-btn" id="copyLetterBtn">Kopieren</button>
                </div>
                <div class="letter-body">
                    <pre class="letter-text" id="letterText">${escapeHTML(briefText)}</pre>
                </div>
                <div class="letter-footer">
                    <button class="btn copy-btn" id="copyLetterBtn2">Brief in Zwischenablage kopieren</button>
                </div>
            </div>
        `;
    }

    resultPreview.innerHTML = `
        <div class="result-header">
            <div class="result-score ${scoreClass}">
                <span class="score-number">${totalProbleme}</span>
                <span class="score-label">${totalProbleme === 1 ? 'Problem gefunden' : 'Probleme gefunden'}</span>
            </div>
            ${ersparnis > 0 ? `
                <div class="result-savings">
                    <span class="savings-label">Potenzielle Ersparnis</span>
                    <span class="savings-amount">bis zu ${Math.round(ersparnis)} €</span>
                </div>
            ` : `
                <div class="result-savings">
                    <span class="savings-amount" style="color: var(--green);">Alles in Ordnung!</span>
                </div>
            `}
        </div>

        ${metaHTML}

        <div class="result-summary">
            <p>${escapeHTML(data.zusammenfassung)}</p>
        </div>

        <div class="result-items">
            ${itemsHTML}
        </div>

        ${unklar.length > 0 && data.unklar_pruefungen && data.unklar_pruefungen.length > 0 ? `
            <div class="result-unklar-box">
                <h4>Offene Prüfpunkte</h4>
                <p>Folgende Punkte konnten nicht abschließend geprüft werden. Fordern Sie ggf. Belegeinsicht beim Vermieter an:</p>
                <ul>${data.unklar_pruefungen.map(p => `<li>${escapeHTML(p)}</li>`).join('')}</ul>
            </div>
        ` : ''}

        ${data.empfehlung ? `
            <div class="result-recommendation">
                <strong>Empfehlung:</strong> ${escapeHTML(data.empfehlung)}
            </div>
        ` : ''}

        ${letterHTML}

        <div class="reminder-optin" id="reminderOptin">
            <p>Nebenkostenabrechnungen kommen jedes Jahr. Sollen wir Sie erinnern?</p>
            <label>
                <input type="checkbox" id="reminderCheckbox">
                Ja, erinnert mich in 12 Monaten per E-Mail an die Prüfung meiner nächsten Abrechnung.
            </label>
        </div>

        <div class="result-actions">
            ${currentSessionId ? `<a class="result-download-btn" href="/api/download-pdf/${encodeURIComponent(currentSessionId)}" download>PDF herunterladen</a>` : ''}
            <button class="btn btn-outline" onclick="resetUpload()">Neue Abrechnung prüfen</button>
        </div>
    `;

    resultPreview.style.display = 'block';
    resultPreview.style.animation = 'fadeInUp 0.5s ease';
    trackEvent('result_rendered_success', {
        fehler_anzahl: data.fehler_anzahl || 0,
        warnungen_anzahl: data.warnungen_anzahl || 0,
        ersparnis: data.potenzielle_ersparnis_gesamt || 0,
    });

    // Attach copy handlers
    document.querySelectorAll('#copyLetterBtn, #copyLetterBtn2').forEach(btn => {
        btn.addEventListener('click', () => copyLetter());
    });

    const pdfLink = document.querySelector('.result-download-btn');
    if (pdfLink) {
        pdfLink.addEventListener('click', () => trackEvent('result_pdf_click'));
    }

    // Attach reminder opt-in handler
    const reminderCb = document.getElementById('reminderCheckbox');
    if (reminderCb) {
        reminderCb.addEventListener('change', async () => {
            if (reminderCb.checked) {
                const email = localStorage.getItem('nk_email') || '';
                if (!email) return;
                try {
                    await fetch('/api/reminder-optin', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email }),
                    });
                    const optinDiv = document.getElementById('reminderOptin');
                    optinDiv.innerHTML = '<p class="reminder-success">Wir erinnern Sie in 12 Monaten. Vielen Dank!</p>';
                } catch (e) { /* silent */ }
            }
        });
    }
}

function buildResultItem(item, color, label) {
    const codeLabel = item.fehlercode ? ` <span class="result-code">${escapeHTML(item.fehlercode)}</span>` : '';
    return `
        <div class="result-item ${color}">
            <div class="result-item-header">
                <span class="result-tag ${color}">${label}${codeLabel}</span>
                <strong>${escapeHTML(item.titel || item.posten)}</strong>
                <span class="result-betrag">${escapeHTML(item.betrag)}</span>
            </div>
            <p>${escapeHTML(item.erklaerung)}</p>
            ${item.beweis ? `<div class="result-item-beweis">&bdquo;${escapeHTML(item.beweis)}&ldquo;</div>` : ''}
            ${item.ersparnis_geschaetzt > 0 ? `<div class="result-item-savings">Mögliche Ersparnis: ${Math.round(item.ersparnis_geschaetzt)} €</div>` : ''}
        </div>
    `;
}

function copyLetter() {
    const letterEl = document.getElementById('letterText');
    if (!letterEl) return;
    navigator.clipboard.writeText(letterEl.textContent).then(() => {
        document.querySelectorAll('#copyLetterBtn, #copyLetterBtn2').forEach(btn => {
            const original = btn.textContent;
            btn.textContent = 'Kopiert!';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = original;
                btn.classList.remove('copied');
            }, 2000);
        });
    });
}

function resetUpload() {
    collectedFiles = [];
    uploadTracked = false;
    freePreviewRunning = false;
    uploadArea.style.display = 'block';
    fileList.style.display = 'none';
    uploadProgress.style.display = 'none';
    resultPreview.style.display = 'none';
    fileInput.value = '';
    startAnalysisBtn.textContent = PLAN_LABELS[selectedPlan] || PLAN_LABELS.basic;
    updateButtonState();
}

// === Smooth Scroll for anchor links ===
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});

// === Reset: click logo to go back to upload ===
document.querySelector('.logo').addEventListener('click', (e) => {
    e.preventDefault();
    resetUpload();
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// === Add animations ===
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeInUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
    }
`;
document.head.appendChild(style);

// === Intersection Observer for scroll animations ===
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.step, .check-card, .price-card, .faq-item').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    observer.observe(el);
});

// === Social Proof Counter Animation ===
(function animateCounter() {
    const counterEl = document.getElementById('proofCounter');
    if (!counterEl) return;
    const target = 3212;
    const duration = 1500;
    const start = performance.now();

    const counterObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            counterObserver.disconnect();
            function tick(now) {
                const elapsed = now - start;
                const progress = Math.min(elapsed / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
                counterEl.textContent = Math.round(eased * target).toLocaleString('de-DE');
                if (progress < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        }
    }, { threshold: 0.5 });
    counterObserver.observe(counterEl);
})();
