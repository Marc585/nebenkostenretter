# SEO 30 Tage Playbook (NebenkostenRetter)

Ziel: Organischen Traffic mit Kaufintention aufbauen und in bezahlte 4,99-EUR-Pruefungen umwandeln.

## North-Star
- Netto-Umsatz/Woche aus organischem Traffic

## Funnel-KPIs
- Search Impressions (GSC)
- Organic Clicks
- CTR auf Money Pages
- Conversion `upload_started -> checkout_success`
- Umsatz pro 100 organische Sitzungen

## Woche 1 (Fundament + Indexierung)
1. Search Console komplett einrichten
- Property: `https://nebenkostenretter.de`
- Sitemap einreichen: `https://nebenkostenretter.de/sitemap.xml`
- URL-Pruefung + Indexierung anstoßen fuer:
  - `/`
  - `/nebenkostenabrechnung-pruefen.html`
  - `/widerspruch-nebenkostenabrechnung-muster.html`
  - `/betriebskosten-nicht-umlagefaehig.html`
  - `/blog.html`
  - 3 Cluster-Artikel mit hoechster Intent-Naehe

2. Conversion-Basis absichern
- Täglich 1x Test-Flow:
  - Upload
  - Checkout-Start
  - Erfolgsseite
- GA4 Check: `page_view`, `upload_started`, `checkout_started`, `purchase_success`

3. Content Publishing (3 Artikel)
- Fokus: Bottom/Mid Intent
- Templates aus vorhandenen Artikeln wiederverwenden
- Jeder Artikel muss haben:
  - Canonical
  - OG/Twitter Meta
  - `Article` + `BreadcrumbList` JSON-LD
  - 2 interne Links auf Money Pages
  - 2 interne Links auf relevante Cluster-Seiten

## Woche 2 (Keyword-Expansion + Interne Links)
1. 4 neue Artikel veröffentlichen
- Priorisierte Themen:
  - Nebenkostenabrechnung Nachzahlung zu hoch
  - Nebenkostenabrechnung Belege anfordern Muster
  - Heizkostenverteiler Abrechnung falsch
  - Betriebskostenabrechnung Verteilerschlüssel ändern

2. Interne Verlinkung systematisch
- Von jeder neuen Seite:
  - 1 Link auf `/nebenkostenabrechnung-pruefen.html`
  - 1 Link auf `/widerspruch-nebenkostenabrechnung-muster.html`
- Von bestehenden Money-Pages:
  - pro Seite 3 neue Deep-Links in den Cluster

3. Snippet-Optimierung
- Titles auf CTR testen (wöchentlich):
  - Variante A: Problem + Jahr
  - Variante B: "pruefen" + "Muster" + Nutzen

## Woche 3 (Authority + GEO/AI Visibility)
1. FAQ-Ausbau auf 5 Top-URLs
- Pro URL 4-6 präzise Fragen/Antworten
- Klare, direkte Sprache (AI-Suchmaschinen bevorzugen komprimierte Antworten)

2. Quellen-Qualität erhöhen
- Jede rechtliche Aussage mit Primärquelle (BGB/BetrKV/HeizkostenV)
- Quellenbereich pro Artikel auf aktuell halten

3. GEO-Optimierung
- Jede Seite mit:
  - kurzer "TL;DR" Antwort oben
  - strukturierte Schrittlisten
  - klare Entitäten (Gesetze, Fristen, Rollen)

## Woche 4 (CRO + Scale/Stop)
1. CRO-Sprint (3 Tests)
- CTA-Text Test auf Money-Page
- Hero-Value-Proposition Test
- Social-Proof Position Test

2. Content nach Daten priorisieren
- Nur Keywords weiter ausbauen, die bereits Klicks/Impressions bringen
- Schwache Themen nach 14 Tagen ohne Impressionen pausieren

3. Entscheidungsregel
- Scale: Wenn organische Conversions 2 Wochen in Folge steigen
- Pivot: Wenn viel Traffic aber niedrige Checkout-Rate -> Offer/UX schärfen

## Woechentlicher Rhythmus (fix)
- Montag: GSC/GA4 Review (30 min)
- Dienstag: 1 neuer Artikel
- Donnerstag: 1 neuer Artikel
- Freitag: Interne Links + CTR-Titel Update
- Sonntag: Funnel-Test + KPI-Log

## Minimum-Standards pro neuer Seite (DoD)
- Indexierbar (kein noindex)
- In `sitemap.xml`
- Interne Links gesetzt (mind. 4)
- Schema valide (`Article` + `BreadcrumbList`)
- CTA auf Upload/Checkout sichtbar oberhalb der Mitte

## Realistisches 90-Tage-Szenario (konservativ)
- Monat 1: 300-800 organische Sitzungen
- Monat 2: 900-2.500 Sitzungen
- Monat 3: 2.000-6.000 Sitzungen

Bei 1,0-2,0% Conversion auf 4,99 EUR sind das grob:
- Monat 2: ca. 45-250 EUR
- Monat 3: ca. 100-600 EUR

Hebel fuer 1.000+ EUR/Monat:
- bessere Conversion (3%+)
- zusaetzlicher Higher-Ticket Upsell
- Suchvolumenstarke Cluster schneller ausbauen
