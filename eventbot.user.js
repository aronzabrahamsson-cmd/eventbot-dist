// ==UserScript==
// @name         EventBot
// @namespace    visitstockholm.eventtools
// @version      7.76.1
// @description  v7.54.0: Ny källa — Nortic. Ingen dokumenterad publik API hittades, men avläsning av nortic.se/stad/stockholms egna Nuxt-SSR-svar avslöjade den exakta anrops-URL:en (services.nortic.se/public/v1/events?city=Stockholm...) som sidan själv använder; bekräftat med 320 Stockholmsevent över 16 sidor. Ingen nyckel behövs — nytt "Nortic"-hämtningsläge i fliken Kalendrar, samma mönster som Ticketmaster/Billetto/Tickster. v7.53.10: Billetto-hämtningen byter datakälla till samma Algolia-sökindex som billetto.se:s egen sajt använder, istället för det publisher/annonsbegränsade v3/public/events-API:et (bekräftat: gav t.ex. hela 540+ Stockholmsevent inom 25 km mot tidigare ~140, och inkluderar nu "Grand Antiques Art & Design" som tidigare API:et aldrig kunde returnera). Kräver ingen egen API-nyckel längre — Billetto-fälten i Inställningar är borttagna. Fix Billetto-dubbletter från v7.53.8/9 (venue_name-kollisioner) kvarstår som skyddsnät. Käll-filterchipsen i "Ej inlagda" visar antal event per källa och inverterade färger på vald källa. Rättstavning "Dubblettkoll"/"Dubblett" (2 b). Draftvy-dubblettkoll med badges och jämförelsevy. Rewrite-agent (EventChecker) på edit-sidor. All funktion från v0.7.51 bevarad.
// @match        https://www.visitstockholm.com/cms/api/event/create/*
// @match        https://www.visitstockholm.se/cms/api/event/create/*
// @match        https://www.stockholmbusinessregion.se/wt/cms/snippets/api/event/*
// @match        https://www.visitstockholm.com/cms/api/event/?*
// @match        https://www.visitstockholm.se/cms/api/event/?*
// @match        https://www.visitstockholm.com/cms/api/event/edit/*
// @match        https://www.visitstockholm.se/cms/api/event/edit/*
// @match        https://www.stockholmbusinessregion.se/wt/cms/snippets/api/event/edit/*
// @match        https://www.visitstockholm.com/cms/pages/*
// @match        https://www.visitstockholm.se/cms/pages/*
// @updateURL    https://raw.githubusercontent.com/aronzabrahamsson-cmd/eventbot-dist/main/eventbot.user.js
// @downloadURL  https://raw.githubusercontent.com/aronzabrahamsson-cmd/eventbot-dist/main/eventbot.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @connect      app.ticketmaster.com
// @connect      api.mistral.ai
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
 * STEG 5 — Skapa utkast via Mistral.
 *
 * "Skapa event"-knapp på ej-inlagda/delvis/osäkra rader:
 *   1. Anropar din Mistral-agent (Conversations API) med eventets URL.
 *   2. Agenten returnerar ETT JSON-objekt (fältnamn = era CSV-kolumner).
 *   3. Scriptet lägger JSON i sessionStorage och öppnar
 *      /cms/api/event/create/ i ny flik, där autofyll-scriptet (v32) plockar
 *      upp datan och fyller formuläret. Du granskar och sparar som utkast.
 *   4. Bildpanel visas: pressbild (auto-nedladdning + synlig länk som reserv),
 *      alttext_sv/en och fotograf med kopieringsknappar.
 *
 * Dark mode genomgående.
 *
 * Kräver: Mistral API-nyckel + agent-ID (fylls i panelen, sparas lokalt).
 */

(function () {
  'use strict';

  // Deklareras FÖRST i scriptet (inte bara före användning) så att den globala
  // unhandledrejection-lyssnaren (som kan triggas av VILKET löfte som helst på
  // sidan, när som helst) aldrig kan råka läsa den innan den är initierad.
  let activeEventIdx = null;      // vilket event-kort loggen ska speglas mot just nu
  let lastUrlAgentData = null;    // senaste agent-JSON från URL-fliken (för felsökning)

  // ---- Diagnostiklogg ------------------------------------------------------
  // Skriver till både konsolen (prefix VSEH) och en synlig loggruta i panelen,
  // så vi ser var det stannar även om konsolen verkar tyst.
  const VLOG = [];
  function vlog(msg, kind) {
    const t = new Date();
    const hhmmss = String(t.getHours()).padStart(2,'0') + ':' +
                   String(t.getMinutes()).padStart(2,'0') + ':' +
                   String(t.getSeconds()).padStart(2,'0');
    const line = '[' + hhmmss + '] ' + msg;
    VLOG.push({ line, kind: kind || 'info' });
    if (VLOG.length > 200) VLOG.shift();
    try { console.log('VSEH ' + line); } catch {}
    try { renderLog(); } catch {}
    // Spegla senaste loggraden i det event-kort som just nu bearbetas, så
    // framsteget syns direkt i listan utan att behöva öppna loggrutan.
    if (activeEventIdx != null) {
      try { setEventStatus(activeEventIdx, msg, kind === 'err' ? 'err' : (kind === 'ok' ? 'ok' : 'work')); }
      catch {}
    }
  }
  function renderLog() {
    const box = document.getElementById('vseh-log');
    if (!box) return;
    box.innerHTML = VLOG.slice(-60).map(e =>
      '<div class="vseh-logline ' + e.kind + '">' +
      e.line.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) +
      '</div>').join('');
    box.scrollTop = box.scrollHeight;
  }
  // Global felfångare — visar oväntade fel i loggrutan.
  window.addEventListener('error', e => {
    try { vlog('JS-FEL: ' + (e.message || e.error) + ' @ ' + (e.filename||'').split('/').pop() + ':' + e.lineno, 'err'); } catch {}
  });
  window.addEventListener('unhandledrejection', e => {
    try { vlog('PROMISE-FEL: ' + (e.reason && (e.reason.message || e.reason)), 'err'); } catch {}
  });

  // Läses från userscript-metadatan (GM_info) istället för att hårdkodas här,
  // så den aldrig kan halka efter @version-raden i huvudet ovan.
  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';
  vlog('Script v' + SCRIPT_VERSION + ' startar på ' + location.pathname);


  const TM_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
  const MISTRAL_CONV = 'https://api.mistral.ai/v1/conversations';
  const MISTRAL_CHAT = 'https://api.mistral.ai/v1/chat/completions';
  // Delas av alla raka MISTRAL_CHAT-anrop som skriver om ETT fälts text
  // (rewriteGuidelineIssues/rewriteTitleCasing/translateDescription) — sätts
  // ALLTID som ett explicit "svara på X"-krav i systemprompten, inte bara
  // underförstått via "behåll språket", så Mistral aldrig råkar lägga
  // svensk text i det engelska fältet eller tvärtom (på begäran 2026-09-19).
  function mistralLangName(lang) { return lang === 'en' ? 'engelska' : 'svenska'; }
  const STHLM = { lat: 59.3293, lng: 18.0686 };
  const DEFAULT_RADIUS = 25;
  // (SED_BASE definieras nedan, vid buildDedupIndex.)
  // BILLETTO: hämtar via samma Algolia-index som driver billetto.se:s EGEN
  // sökning (nätverksfliken på billetto.se → "events_by_popularity"-anropen),
  // inte det dokumenterade "public events"-API:et. Det API:et (v3/public/events)
  // visade sig — bekräftat 2026-09-15 — bara returnera events som opt-at in i
  // Billettos annonsprogram (varje träff hade utm_content=SE+7345087; ett
  // riktigt, publikt Stockholmsevent gav "not found" trots att det syns på
  // billetto.se). Algolia-indexet har ingen sådan begränsning: samma sökväg
  // som besökare på billetto.se själva använder. Appid/nyckel nedan är
  // Algolias publika "search-only"-nyckel som billetto.se skickar till varje
  // besökares webbläsare (synlig för vem som helst via DevTools) — inte en
  // hemlighet, och inte kopplad till någon specifik användare. Detta är dock
  // inte ett dokumenterat, sanktionerat tredjepartsgränssnitt, så det kan
  // sluta fungera utan förvarning vid en frontend-omgörning hos Billetto.
  const BILLETTO_ALGOLIA_APP_ID = 'YNEUY03Z8Q';
  const BILLETTO_ALGOLIA_SEARCH_KEY = '8de1d74c7c7de20e35c1f7215e7c699a';
  const BILLETTO_ALGOLIA_INDEX = 'events_by_popularity';
  const BILLETTO_ALGOLIA_URL = 'https://' + BILLETTO_ALGOLIA_APP_ID.toLowerCase() + '-dsn.algolia.net/1/indexes/'
    + BILLETTO_ALGOLIA_INDEX + '/query?x-algolia-agent=' + encodeURIComponent('Algolia for JavaScript (4.22.1); Browser (lite)')
    + '&x-algolia-api-key=' + BILLETTO_ALGOLIA_SEARCH_KEY + '&x-algolia-application-id=' + BILLETTO_ALGOLIA_APP_ID;
  // organization_id 46 = Billettos svenska konto (samma index blandar alla
  // länder Billetto verkar i — bekräftat: en sökning utan detta filter gav
  // även träffar från billetto.es).
  const BILLETTO_ORG_ID = 46;
  // Tickster v0.4 (dokumenterad filtersyntax: q=city:X). v1.0 finns men dess
  // ev. geografiska radiefilter kunde inte bekräftas (JS-renderad Swagger-sida).
  const TICKSTER_BASE = 'https://api.tickster.com/sv/api/0.4/events/upcoming';
  // Nortic: inget publikt API gick att nå. Två försök gav båda HTTP 404 med
  // tomt svar mot services.nortic.se/public/v1/events (inferred från en SSR-
  // payload) — både utan och med den X-Api-Key sidans egen "ajar"-klient
  // skickar, så antingen är path:en fel (troligen /api/ajar, ett schema-styrt
  // internt gränssnitt vars faktiska rutter inte gick att gissa) eller så är
  // hela endpointen inte menad att nås utifrån. Lösning: skrapar istället
  // HTML:en från nortic.se/stad/stockholm direkt (bekräftat 2026-09-17: ingen
  // blockering, riktig URL-paginering via ?page=N, och varje sidas
  // .BaseEventCard-kort har titel/datum/plats/länk inbäddat i klartext).
  // Kategori visas inte per kort i listvyn så alla Nortic-event taggas 'Other'.
  const NORTIC_LIST_URL = 'https://nortic.se/stad/stockholm';
  const NORTIC_MONTH_ABBR = {
    jan: 1, feb: 2, mar: 3, mars: 3, apr: 4, april: 4, maj: 5, jun: 6, juni: 6,
    jul: 7, juli: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12
  };
  // Kommun-svep för att täcka Stockholmsregionen utan ett bekräftat radiefilter.
  const TICKSTER_MUNICIPALITIES = ['stockholm', 'solna', 'sundbyberg', 'nacka',
    'danderyd', 'lidingö', 'huddinge', 'järfälla', 'sollentuna', 'täby', 'botkyrka'];

  const CACHE_CAL = 'cache_calendar_v1';
  const CACHE_TM  = 'cache_tm_v1';

  const CATEGORY_MAP = {
    'Music': 'Concerts', 'Arts & Theatre': 'Culture', 'Sports': 'Sport',
    'Family': 'Family', 'Film': 'Film', 'Miscellaneous': 'Other'
  };
  // Billettos (Algolia) category-fält → samma interna kategorier som Ticketmaster.
  // Nycklarna här är bekräftade via en riktig facet-räkning mot events_by_popularity
  // (2026-09-16), inte gissade.
  const BILLETTO_CATEGORY_MAP = {
    'music': 'Concerts', 'performing_arts': 'Culture', 'film_media': 'Film',
    'sports': 'Sport', 'family': 'Family',
    'food_drink': 'Other', 'community': 'Other', 'hobbies': 'Other',
    'health_wellness': 'Other', 'other': 'Other', 'seasonal': 'Other',
    'business': 'Other', 'travel': 'Other', 'science': 'Other', 'charity': 'Other',
    'auto_boat': 'Other', 'lifestyle': 'Other', 'religion': 'Other',
    'fashion': 'Other', 'government': 'Other'
  };
  const CATEGORY_COLOR = {
    'Concerts': '#a98bd6', 'Culture': '#d68b73', 'Sport': '#6fb98f',
    'Family': '#d6b56f', 'Film': '#7f9bd6', 'Other': '#9aa0ad'
  };
  // Källtagg per event — egen färg per arrangör/API-källa.
  const SOURCE_LABEL = { ticketmaster: 'Ticketmaster', billetto: 'Billetto', tickster: 'Tickster', nortic: 'Nortic' };
  const SOURCE_COLOR = { ticketmaster: '#4a9fe0', billetto: '#e05a9a', tickster: '#5ad1a8', nortic: '#f0a848' };
  const STATUS = {
    in:      { label: 'Inlagt',    bg: '#1f7a4d', fg: '#fff', bar: '#2f9a63' },
    partial: { label: 'Delvis',    bg: '#c9881f', fg: '#fff', bar: '#e0a52e' },
    unsure:  { label: 'Osäkert',   bg: '#c0561f', fg: '#fff', bar: '#d9722e' },
    out:     { label: 'Ej inlagt', bg: '#c02626', fg: '#fff', bar: '#d13a3a' },
    unknown: { label: '–',         bg: '#3a3f4b', fg: '#9aa0ad', bar: '#3a3f4b' }
  };

  let lastGrouped = [];
  let dedupIndex = null;
  let lastCleanupGroups = [];
  let mode = 'min';
  let activeFilter = 'out';
  let activeSourceFilter = 'all';   // käll-underfilter, gäller bara vyn "Ej inlagda"
  let monthFilter = 'all';          // 'all' | 'month' | '6m' — Kalendrar/Dubbletter-listan
  // Delad av alla vyer med månadsfiltret. dateStr är en YYYY-MM-DD-sträng
  // (ev.start_date) — 'month' = samma kalendermånad som idag, '6m' = från
  // idag till och med 6 kalendermånader fram.
  function passesMonthFilter(dateStr, filter) {
    if (filter === 'all') return true;
    if (!dateStr) return false;
    const now = new Date();
    if (filter === 'month') {
      const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      return dateStr.slice(0, 7) === ym;
    }
    if (filter === '6m') {
      const todayStr = now.toISOString().slice(0, 10);
      const future = new Date(now);
      future.setMonth(future.getMonth() + 6);
      return dateStr >= todayStr && dateStr <= future.toISOString().slice(0, 10);
    }
    return true;
  }
  const expanded = new Set();
  const busyCreate = new Set();   // event-index som just nu skapas
  const eventStatus = new Map();  // event-index -> { msg, kind }
  function setEventStatus(idx, msg, kind) {
    eventStatus.set(idx, { msg, kind: kind || 'work' });
    if (idx === 'url') {
      // URL-fliken har ingen listkort — egen fast statusruta.
      const u = document.getElementById('vseh-url-status');
      if (u) { u.textContent = msg; u.className = 'vseh-ev-status ' + (kind || 'work'); u.style.display = 'block'; }
      return;
    }
    // uppdatera bara den aktuella kortets statusrad om den finns
    const el = document.querySelector('.vseh-ev-status[data-si="' + idx + '"]');
    if (el) { el.textContent = msg; el.className = 'vseh-ev-status ' + (kind || 'work'); el.style.display = 'block'; }
    else render(lastGrouped);   // annars rita om
  }

  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload: r => {
          if (r.status === 401) return reject(new Error('401 – ogiltig nyckel'));
          if (r.status === 429) return reject(new Error('429 – för många anrop, vänta lite'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
          try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('Ogiltig JSON')); }
        },
        onerror: () => reject(new Error('Nätverksfel')),
        ontimeout: () => reject(new Error('Timeout')), timeout: 25000
      });
    });
  }
  function gmPost(url, headers, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url, headers, data: JSON.stringify(body),
        onload: r => {
          if (r.status === 401) return reject(new Error('Mistral: 401 – ogiltig API-nyckel'));
          if (r.status === 422) return reject(new Error('Mistral: 422 – kontrollera agent-ID/parametrar'));
          if (r.status === 429) return reject(new Error('Mistral: 429 – för många anrop'));
          if (r.status === 502 || r.status === 503 || r.status === 504) {
            return reject(new Error('Mistral: ' + r.status + ' – tillfälligt serverfel hos Mistral (nätverksfel), försöker igen…'));
          }
          if (r.status < 200 || r.status >= 300) return reject(new Error('Mistral: HTTP ' + r.status + ' — ' + (r.responseText || '').slice(0, 200)));
          try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('Mistral: ogiltig JSON i svaret')); }
        },
        onerror: () => reject(new Error('Mistral: nätverksfel')),
        ontimeout: () => reject(new Error('Mistral: timeout')), timeout: 120000
      });
    });
  }
  // Algolias JS-klient postar JSON men sätter Content-Type till
  // x-www-form-urlencoded (bekräftat via en riktig fångad request från
  // billetto.se) — ovanligt, men det är vad servern faktiskt förväntar sig.
  function gmPostAlgolia(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url, data: JSON.stringify(body),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        onload: r => {
          if (r.status === 429) return reject(new Error('Billetto: 429 – för många anrop, vänta lite'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('Billetto: HTTP ' + r.status + ' — ' + (r.responseText || '').slice(0, 200)));
          try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('Billetto: ogiltig JSON i svaret')); }
        },
        onerror: () => reject(new Error('Billetto: nätverksfel')),
        ontimeout: () => reject(new Error('Billetto: timeout')), timeout: 25000
      });
    });
  }
  // Hämtar en HTML-sida av nortic.se/stad/stockholm som text (ingen API-nyckel
  // eller specialheaders behövs — det är samma sida en vanlig besökare öppnar).
  function gmGetNorticHtml(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        headers: { 'Accept': 'text/html' },
        onload: r => {
          if (r.status === 429) return reject(new Error('Nortic: 429 – för många anrop, vänta lite'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('Nortic: HTTP ' + r.status));
          resolve(r.responseText || '');
        },
        onerror: () => reject(new Error('Nortic: nätverksfel')),
        ontimeout: () => reject(new Error('Nortic: timeout')), timeout: 25000
      });
    });
  }
  function sameOriginGet(url) {
    return fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' mot er kalender'); return r.json(); });
  }
  // Slår ihop förkortningar skrivna med punkt mellan varje bokstav ("C.O.F.F.I.N",
  // "R.E.M.") till ETT ord innan normalisering. Utan detta blir varje bokstav en
  // egen enbokstavs-token som filtreras bort av tokens(), vilket ger en TOM
  // ordlista och gör att titeln aldrig hittar några dedup-kandidater alls.
  function collapseAcronymDots(t) {
    return (t || '').replace(/\b(?:[A-Za-zÅÄÖåäö]\.){2,}[A-Za-zÅÄÖåäö]\.?\b/g, m => m.replace(/\./g, ''));
  }
  function normText(t) {
    return collapseAcronymDots(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9åäö ]/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  function tokens(t) {
    const STOP = new Set(['the','of','and','i','ii','iii','a','an','with','stockholm','live','tour','show']);
    return normText(t).split(' ').filter(w => w.length > 1 && !STOP.has(w));
  }
  function titleSim(a, b) {
    const ta = new Set(tokens(a)), tb = new Set(tokens(b));
    if (!ta.size || !tb.size) return 0;
    let inter = 0; for (const w of ta) if (tb.has(w)) inter++;
    return inter / Math.min(ta.size, tb.size);
  }
  function venueMatch(a, b) {
    const na = normText(a), nb = normText(b);
    if (!na || !nb) return false;
    return na === nb || na.includes(nb) || nb.includes(na);
  }
  function venueSim(a, b) {
    const na = normText(a), nb = normText(b);
    if (!na || !nb) return 0;
    if (na === nb || na.includes(nb) || nb.includes(na)) return 1;
    const ta = new Set(na.split(' ').filter(w => w.length > 1));
    const tb = new Set(nb.split(' ').filter(w => w.length > 1));
    if (!ta.size || !tb.size) return 0;
    let inter = 0; for (const w of ta) if (tb.has(w)) inter++;
    return inter / Math.min(ta.size, tb.size);
  }
  // Adress-normalisering: gemener, ta bort postnr/stad-svansar och skiljetecken,
  // så "Hornstulls strand 4" ~ "Hornstulls Strand 4, 117 39 Stockholm".
  function normAddr(a) {
    return (a || '').toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/,/g, ' ')
      .replace(/\b\d{3}\s?\d{2}\b/g, ' ')      // postnummer
      .replace(/\bstockholm\b/g, ' ')
      .replace(/[^a-z0-9åäö ]/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function addrSim(a, b) {
    const na = normAddr(a), nb = normAddr(b);
    if (!na || !nb) return 0;
    if (na === nb || na.includes(nb) || nb.includes(na)) return 1;
    const ta = new Set(na.split(' ').filter(w => w.length > 1));
    const tb = new Set(nb.split(' ').filter(w => w.length > 1));
    if (!ta.size || !tb.size) return 0;
    let inter = 0; for (const w of ta) if (tb.has(w)) inter++;
    return inter / Math.min(ta.size, tb.size);
  }
  // Platslikhet = bästa av venue-likhet ELLER adress-likhet.
  // Löser att Ticketmaster ofta har tomt venue_name men ifylld adress.
  function placeSim(evVenue, evAddr, rowVenue, rowAddr) {
    return Math.max(venueSim(evVenue, rowVenue), addrSim(evAddr, rowAddr));
  }

  // ---- Avmarkeringar (par-specifika, sparade) ------------------------------
  let dismissals = new Set();
  function loadDismissals() {
    try { const raw = GM_getValue('dismissed_pairs', ''); if (raw) dismissals = new Set(JSON.parse(raw)); } catch {}
  }
  function saveDismissals() {
    try { GM_setValue('dismissed_pairs', JSON.stringify(Array.from(dismissals))); } catch {}
  }
  function pairKey(ev, row) {
    return normText(ev.title) + '@' + normText(ev.venue_name) + '||' +
           normText(row.title) + '@' + normText(row.venue_name);
  }
  function isDismissed(ev, row) { return dismissals.has(pairKey(ev, row)); }
  function dismissPair(ev, row) { dismissals.add(pairKey(ev, row)); saveDismissals(); }

  // ---- "Ska ej läggas in" (sparad markering per event) ---------------------
  let skipList = new Set();
  function loadSkipList() {
    try { const raw = GM_getValue('skip_events', ''); if (raw) skipList = new Set(JSON.parse(raw)); } catch {}
  }
  function saveSkipList() {
    try { GM_setValue('skip_events', JSON.stringify(Array.from(skipList))); } catch {}
  }
  function eventKey(ev) { return normText(ev.title) + '@' + normText(ev.venue_name || ev.address || ''); }
  function isSkipped(ev) { return skipList.has(eventKey(ev)); }
  function toggleSkip(ev) {
    const k = eventKey(ev);
    if (skipList.has(k)) skipList.delete(k); else skipList.add(k);
    saveSkipList();
  }

  // ---- "Markera som inlagd" (manuell override, sparad) ---------------------
  let manualIn = new Set();
  function loadManualIn() {
    try { const raw = GM_getValue('manual_in', ''); if (raw) manualIn = new Set(JSON.parse(raw)); } catch {}
  }
  function saveManualIn() {
    try { GM_setValue('manual_in', JSON.stringify(Array.from(manualIn))); } catch {}
  }
  function isManualIn(ev) { return manualIn.has(eventKey(ev)); }
  function toggleManualIn(ev) {
    const k = eventKey(ev);
    if (manualIn.has(k)) manualIn.delete(k); else manualIn.add(k);
    saveManualIn();
  }

  // ---- Avflaggade dubblettgrupper (sparade) --------------------------------
  // Signatur = sorterad lista av posternas (titel@plats@startdatum), så att om
  // gruppen ändras (post till/från) ändras signaturen → gruppen återflaggas.
  let clearedGroups = new Set();
  function loadClearedGroups() {
    try { const raw = GM_getValue('cleared_groups', ''); if (raw) clearedGroups = new Set(JSON.parse(raw)); } catch {}
  }
  function saveClearedGroups() {
    try { GM_setValue('cleared_groups', JSON.stringify(Array.from(clearedGroups))); } catch {}
  }
  function groupSignature(group) {
    return group.map(r => normText(r.title) + '@' + normText(r.venue_name) + '@' + (r.start || ''))
                .sort().join('||');
  }
  function isGroupCleared(group) { return clearedGroups.has(groupSignature(group)); }
  function clearGroup(group) { clearedGroups.add(groupSignature(group)); saveClearedGroups(); }
  function unclearGroup(sig) { clearedGroups.delete(sig); saveClearedGroups(); }
  function ago(ts) {
    if (!ts) return 'aldrig';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + ' s sedan';
    if (s < 3600) return Math.floor(s / 60) + ' min sedan';
    if (s < 86400) return Math.floor(s / 3600) + ' h sedan';
    return Math.floor(s / 86400) + ' dygn sedan';
  }

  // ---- Ticketmaster --------------------------------------------------------
  function mapOccurrence(ev) {
    const venue = (ev._embedded && ev._embedded.venues && ev._embedded.venues[0]) || {};
    const cls = (ev.classifications && ev.classifications[0]) || {};
    const segment = (cls.segment && cls.segment.name) || '';
    const genre = (cls.genre && cls.genre.name) || '';
    let image = null;
    if (ev.images && ev.images.length) {
      const wide = ev.images.filter(i => i.ratio === '16_9').sort((a, b) => b.width - a.width)[0];
      const best = wide || ev.images.slice().sort((a, b) => b.width - a.width)[0];
      if (best) image = { url: best.url, width: best.width, height: best.height };
    }
    const start = (ev.dates && ev.dates.start) || {};
    const tmStatus = (ev.dates && ev.dates.status && ev.dates.status.code) || '';
    const loc = venue.location || {};
    const promoter = (ev.promoter && ev.promoter.name) ||
                     (ev.promoters && ev.promoters[0] && ev.promoters[0].name) || '';
    return {
      _tm_id: ev.id || null, title: ev.name || '',
      description: ev.info || ev.pleaseNote || '', image,
      date: start.localDate || null, time: start.localTime || null,
      tm_status: tmStatus,
      href: ev.url || '', segment, genre,
      category: CATEGORY_MAP[segment] || segment || 'Other',
      venue_name: venue.name || '', address: (venue.address && venue.address.line1) || '',
      zip_code: venue.postalCode || '', city: (venue.city && venue.city.name) || '',
      location: (loc.latitude && loc.longitude)
        ? { latitude: parseFloat(loc.latitude), longitude: parseFloat(loc.longitude) } : null,
      external_website_url: ev.url || '', promoter
    };
  }
  function groupEvents(occ, source) {
    source = source || 'ticketmaster';
    const map = new Map();
    for (const o of occ) {
      const key = normText(o.title) + '||' + normText(o.venue_name);
      if (!map.has(key)) {
        map.set(key, {
          title: o.title, description: o.description, image: o.image,
          categories: [o.segment, o.genre].filter(Boolean),
          category: { title: o.category }, subcategory: null,
          venue_name: o.venue_name, address: o.address, zip_code: o.zip_code, city: o.city,
          location: o.location, closest_station: null,
          external_website_url: o.external_website_url,
          external_website_url_text: o.promoter || (source === 'billetto' ? 'billetto.se' : source === 'tickster' ? 'tickster.com' : 'ticketmaster.se'),
          promoter: o.promoter, backend_modifiers: [], _source: source,
          _tm_status_flag: '', _tm_ids: [], dates: []
        });
      }
      const g = map.get(key);
      g._tm_ids.push(o._tm_id);
      // Samla status; om något tillfälle är inställt/flyttat, flagga eventet.
      if (o.tm_status && o.tm_status !== 'onsale' && o.tm_status !== 'offsale') {
        g._tm_status_flag = o.tm_status;   // cancelled | postponed | rescheduled
      }
      if (o.date && !g.dates.some(d => d.date === o.date && d.time === o.time))
        g.dates.push({ date: o.date, time: o.time, href: o.href });
      if (!g.description && o.description) g.description = o.description;
      if (!g.image && o.image) g.image = o.image;
    }
    const groups = Array.from(map.values());
    // Passerade datum tas bort HÄR, centralt för alla källor (Ticketmaster,
    // Billetto, Tickster) — robustare än att lita på att varje käll-API redan
    // filtrerat bort dåtid själv (Tickster gjorde uppenbarligen inte det).
    // Ett event med BLANDADE datum (t.ex. en pågående serie) behåller bara de
    // framtida tillfällena; ett event helt i dåtid utesluts helt.
    const todayStr = new Date().toISOString().split('T')[0];
    for (const g of groups) {
      g.dates = g.dates.filter(d => d.date >= todayStr);
      g.dates.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
      g.start_date = g.dates.length ? g.dates[0].date : null;
      g.end_date = g.dates.length ? g.dates[g.dates.length - 1].date : null;
      g.occurrence_count = g.dates.length;
    }
    const futureGroups = groups.filter(g => g.dates.length > 0);
    futureGroups.sort((a, b) => (a.start_date || '9999').localeCompare(b.start_date || '9999'));
    return futureGroups;
  }
  async function fetchTicketmaster({ key, radius, classification, maxPages, onProgress, onPage }) {
    const today = new Date().toISOString().split('T')[0] + 'T00:00:00Z';
    let occ = [], pagesFetched = 0;
    for (let page = 0; page < maxPages; page++) {
      onProgress(`Hämtar Ticketmaster, sida ${page + 1}/${maxPages}…`);
      if (onPage) onPage(page + 1, maxPages);
      const params = new URLSearchParams({
        apikey: key, countryCode: 'SE',
        latlong: STHLM.lat + ',' + STHLM.lng, radius: String(radius), unit: 'km',
        startDateTime: today, sort: 'date,asc', size: '20', page: String(page)
      });
      if (classification) params.set('classificationName', classification);
      const data = await gmGet(TM_BASE + '?' + params.toString());
      pagesFetched++;
      const evs = (data._embedded && data._embedded.events) || [];
      occ = occ.concat(evs.map(mapOccurrence));
      const totalPages = (data.page && data.page.totalPages) || 1;
      if (onPage) onPage(page + 1, Math.min(maxPages, totalPages));
      if (page + 1 >= totalPages) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return { grouped: groupEvents(occ, 'ticketmaster'), pagesFetched, rawCount: occ.length };
  }

  // ---- Billetto: List Public Events -----------------------------------------
  // Datum kommer som fullständig ISO-UTC ("2026-05-03T17:00:00Z"). Vi räknar om
  // till Europe/Stockholm-lokaltid oavsett besökarens egen webbläsartidszon.
  function isoToStockholm(iso) {
    if (!iso) return { date: null, time: null };
    try {
      const d = new Date(iso);
      const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
      const parts = {};
      fmt.formatToParts(d).forEach(p => { parts[p.type] = p.value; });
      return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
    } catch { return { date: null, time: null }; }
  }

  // Algolia-träffen har ingen ren gatuadress som eget fält (bara den hopslagna
  // "Venue, Ort"-strängen i `location`) — men den inbäddade schema.org JSON-LD-
  // strängen har en riktig PostalAddress. Den parsas här för en exakt adress;
  // om det skulle strula (fältet saknas/ändras) faller vi tillbaka på det som
  // finns direkt på träffen, så ett trasigt schema-fält kan aldrig kasta.
  function billettoAddressFromSchema(ev) {
    try {
      const s = JSON.parse(ev.schema);
      const a = (s && s.location && s.location.address) || {};
      return { street: a.streetAddress || '', zip: a.postalCode || '', city: a.addressLocality || '' };
    } catch { return { street: '', zip: '', city: '' }; }
  }

  function mapBillettoEvent(ev) {
    const { date, time } = isoToStockholm((ev.start_time || 0) * 1000);
    const isCancelled = ev.state === 'canceled';
    const image = ev.image ? { url: ev.image } : null;
    const schemaAddr = billettoAddressFromSchema(ev);
    const address = schemaAddr.street || ev.location || '';
    const geo = ev._geoloc && ev._geoloc.lat && ev._geoloc.lng ? ev._geoloc : null;
    return {
      _tm_id: ev.id || null, title: ev.name || '',
      description: ev.description || '', image,
      date, time, tm_status: isCancelled ? 'cancelled' : '',
      href: ev.url || '',
      segment: ev.category || '', genre: ev.subcategory || '',
      category: BILLETTO_CATEGORY_MAP[(ev.category || '').toLowerCase()] || 'Other',
      // Algolia ger (till skillnad från det gamla publisher-API:et) en riktig
      // venue_name för de flesta event — men inte alla (t.ex. Matmilens egna
      // pop-up-adresser saknar den), så vi faller tillbaka på den hopslagna
      // location-strängen istället för en tom sträng, för att undvika samma
      // titel-kollisionsbugg som tidigare (se v7.53.8).
      venue_name: ev.venue_name || ev.location || '',
      address, zip_code: schemaAddr.zip || (ev.postal_code != null ? String(ev.postal_code) : ''),
      city: schemaAddr.city || ev.city || '',
      location: geo ? { latitude: geo.lat, longitude: geo.lng } : null,
      external_website_url: ev.url || '',
      promoter: ev.brand || ''
    };
  }

  // Ticksters ISO-tider har redan svensk lokal offset inbyggd (+02:00/+01:00),
  // så vi kan klippa ut datum/tid direkt ur strängen utan omräkning.
  function ticksterDateTime(iso) {
    if (!iso || typeof iso !== 'string') return { date: null, time: null };
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
    return m ? { date: m[1], time: m[2] } : { date: null, time: null };
  }

  function mapTicksterEvent(ev) {
    const venue = ev.venue || {};
    const { date, time } = ticksterDateTime(ev.start);
    const image = (ev.images && (ev.images.large || ev.images.medium)) ? { url: ev.images.large || ev.images.medium } : null;
    return {
      _tm_id: ev.id || null, title: ev.name || '',
      description: '', image,   // Tickster ger ingen beskrivning — agenten läser infoUri själv
      date, time, tm_status: '',   // inget tydligt "inställt"-fält i detta schema
      href: ev.infoUri || ev.shopUri || '',
      segment: '', genre: '', category: 'Other',   // ingen kategoridata — agenten avgör från källan
      venue_name: venue.name || '', address: '', zip_code: '', city: venue.city || '',
      location: (venue.latitude && venue.longitude)
        ? { latitude: parseFloat(venue.latitude), longitude: parseFloat(venue.longitude) } : null,
      external_website_url: ev.infoUri || ev.shopUri || '',
      promoter: (ev.organizer && ev.organizer.name) || ''
    };
  }

  // Presentkort/vouchrar har orimligt långa datumspann och är inga riktiga
  // daterade event — samma igenkänning som används för exempel-loggningen,
  // men här avgör den vad som FAKTISKT tas med i importen.
  function ticksterLooksLikeGiftCard(ev) {
    const name = (ev.name || ev.title || '').toLowerCase();
    if (name.includes('presentkort') || name.includes('gift card')) return true;
    try {
      const days = (new Date(ev.end) - new Date(ev.start)) / 86400000;
      if (days > 180) return true;
    } catch {}
    return false;
  }

  // RÄTTAT (2026-09-16): bytt datakälla helt, från det publisher-begränsade
  // v3/public/events till samma Algolia-index som driver billetto.se:s egen
  // sökning (se kommentaren vid BILLETTO_ALGOLIA_URL). Paginerar via page/
  // nbPages (Algolias facit-svar) istället för has_more/next_url. Taket nedan
  // är samma sorts säkerhetsspärr som tidigare — ren skyddsmekanism, inte en
  // förväntad gräns (Stockholmsregionen brukar ligga runt 20-25 sidor).
  const BILLETTO_MAX_PAGES = 60;
  const BILLETTO_HITS_PER_PAGE = 1000;

  async function fetchBilletto({ onProgress, onPage }) {
    const baseBody = {
      query: '', clickAnalytics: false,
      aroundLatLng: STHLM.lat + ',' + STHLM.lng, aroundRadius: DEFAULT_RADIUS * 1000,
      hitsPerPage: BILLETTO_HITS_PER_PAGE,
      filters: 'organization_id = ' + BILLETTO_ORG_ID,
      // Utesluter event som inte laddat upp en egen bild (Billettos
      // platshållarbild) — samma filter som billetto.se:s egen sökning
      // använder, på uttrycklig begäran.
      facetFilters: ['uses_generic_billetto_image:false']
    };
    let all = [];
    let page = 0, nbPages = 1, total = null;
    while (page < nbPages && page < BILLETTO_MAX_PAGES) {
      onProgress('Hämtar Billetto, sida ' + (page + 1) + (total ? ' av ' + nbPages + ' (' + all.length + '/' + total + ' event)' : '') + '…');
      if (onPage) onPage(page + 1, nbPages);
      const data = await gmPostAlgolia(BILLETTO_ALGOLIA_URL, Object.assign({}, baseBody, { page }));
      const batch = (data && data.hits) || [];
      all = all.concat(batch);
      if (typeof data.nbPages === 'number') nbPages = data.nbPages;
      if (typeof data.nbHits === 'number') total = data.nbHits;
      page++;
      if (page < nbPages) await new Promise(r => setTimeout(r, 200));
    }
    if (page >= BILLETTO_MAX_PAGES && page < nbPages) {
      vlog('OBS: Billetto-hämtningen stoppades efter ' + BILLETTO_MAX_PAGES + ' sidor (säkerhetsspärr) — fler event kan saknas.', 'err');
    }
    vlog('Billetto: ' + all.length + ' event hämtade över ' + page + ' sida(or)' +
      (total !== null ? ' (Algolia rapporterar ' + total + ' totalt inom radien)' : '') + '.');
    const occ = all.map(mapBillettoEvent);
    return { grouped: groupEvents(occ, 'billetto'), rawCount: occ.length };
  }

  // ---- Nortic: skrapar city-sidans HTML (se kommentar vid NORTIC_LIST_URL) --
  // Tolkar "17 sep." / "5 okt. – 14 nov." / "28 mars 2027" (år utelämnas om
  // det är underförstått). Om det tolkade datumet hamnar mer än ~2 månader
  // bakåt i tiden antas det mena nästa år (hanterar årsskiften i listan).
  function parseNorticDatePart(str, refDate) {
    const m = str.trim().match(/^(\d{1,2})\s+([a-zA-ZåäöÅÄÖ]+)\.?\s*(\d{4})?$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = NORTIC_MONTH_ABBR[m[2].toLowerCase()];
    if (!month) return null;
    let year = m[3] ? parseInt(m[3], 10) : refDate.getFullYear();
    if (!m[3]) {
      const cutoff = new Date(refDate);
      cutoff.setMonth(cutoff.getMonth() - 2);
      if (new Date(year, month - 1, day) < cutoff) year += 1;
    }
    return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  // Läser ut sidantal + eventkort ur en renderad .BaseEventCard-lista.
  // Ett kort som spänner flera datum ("5 okt. – 14 nov.") ger bara start-
  // och slutdatum, inte varje enskild föreställning — grupperingen nedan
  // (groupEvents) räknar start_date/end_date från detta, så intervallet
  // blir korrekt även om occurrence_count blir en underskattning.
  function parseNorticListPage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // OBS (2026-09-19): misstänkt orsak till att Nortic-hämtningen bara gav
    // ~15 event (en enda sidas värde) trots att sajten har fler — hela
    // sidräkningen hängde på EN specifik text ("Sida X av Y") i ETT
    // specifikt element. Om Nortic bytt markup/formulering sedan detta
    // bekräftades senast slår regexen fel och totalPages föll TYST
    // tillbaka till 1, vilket stoppar hämtningen efter första sidan utan
    // något synligt fel. Lägger nu till en reservlösning (högsta sidnumret
    // bland ?page=N-länkar/paginerings-element) OCH loggar tydligt om
    // båda sätten misslyckas, så framtida sajtändringar syns direkt i
    // loggen istället för att bara ge ett för lågt antal event utan förklaring.
    let totalPages = 1;
    const pagText = doc.querySelector('.BasePagination-condensed')?.textContent || '';
    const pm = pagText.match(/Sida\s+\d+\s+av\s+(\d+)/i);
    if (pm) {
      totalPages = parseInt(pm[1], 10);
    } else {
      const pageNums = [...doc.querySelectorAll('a[href*="page="], [class*="agination"] a, [class*="agination"] button')]
        .map(el => {
          const hrefMatch = (el.getAttribute('href') || '').match(/[?&]page=(\d+)/);
          if (hrefMatch) return parseInt(hrefMatch[1], 10);
          const n = parseInt((el.textContent || '').trim(), 10);
          return Number.isFinite(n) ? n : null;
        })
        .filter(n => n && n > 0);
      if (pageNums.length) {
        totalPages = Math.max(...pageNums);
        vlog('Nortic: kunde inte läsa "Sida X av Y" (troligen ändrad markup/text hos Nortic) — gissar ' + totalPages + ' sidor från paginerings-länkarna istället.', 'err');
      } else {
        vlog('Nortic: hittade ingen sidräknare alls (.BasePagination-condensed saknas och inga paginerings-länkar hittades) — hämtar bara sida 1. Nortic har troligen ändrat sin sid-markup, dubbelkolla mot sajten.', 'err');
      }
    }
    const now = new Date();
    const items = [];
    doc.querySelectorAll('a.BaseEventCard').forEach(a => {
      const href = a.getAttribute('href') || '';
      const titleEl = a.querySelector('.BaseEventCard__title');
      const title = (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim();
      const metas = a.querySelectorAll('.BaseEventCard__meta');
      const dateText = (metas[0]?.textContent || '').trim();
      const venueText = (metas[1]?.getAttribute('title') || metas[1]?.textContent || '').trim();
      if (!title || !dateText) return;
      const [startStr, endStr] = dateText.split('–').map(s => s.trim());
      const start = parseNorticDatePart(startStr, now);
      const end = endStr ? parseNorticDatePart(endStr, now) : start;
      if (start) items.push({ title, href, venue: venueText, start, end });
    });
    return { totalPages, items };
  }

  // Kategori går inte att läsa av per kort i listvyn (bara i filterdropdownen),
  // så alla Nortic-event taggas 'Other' tills vidare.
  function norticItemToOccurrences(item) {
    const dates = (item.end && item.end !== item.start) ? [item.start, item.end] : [item.start];
    return dates.map(date => ({
      _tm_id: null, title: item.title,
      description: '', image: null,
      date, time: '', tm_status: '',
      href: item.href,
      segment: '', genre: '', category: 'Other',
      venue_name: item.venue, address: '', zip_code: '', city: '',
      location: null,
      external_website_url: item.href,
      promoter: ''
    }));
  }

  const NORTIC_MAX_PAGES = 40;   // säkerhetsspärr — Stockholm låg på ~17 sidor vid bekräftelsen

  async function fetchNortic({ onProgress, onPage }) {
    let all = [];
    let page = 1, totalPages = 1;
    while (page <= totalPages && page <= NORTIC_MAX_PAGES) {
      onProgress('Hämtar Nortic, sida ' + page + (totalPages > 1 ? ' av ' + totalPages : '') + '…');
      if (onPage) onPage(page, totalPages);
      const url = NORTIC_LIST_URL + (page > 1 ? '?page=' + page : '');
      const html = await gmGetNorticHtml(url);
      const { totalPages: tp, items } = parseNorticListPage(html);
      totalPages = tp;
      items.forEach(it => { all = all.concat(norticItemToOccurrences(it)); });
      page++;
      if (page <= totalPages) await new Promise(r => setTimeout(r, 200));
    }
    if (page > NORTIC_MAX_PAGES && page <= totalPages) {
      vlog('OBS: Nortic-hämtningen stoppades efter ' + NORTIC_MAX_PAGES + ' sidor (säkerhetsspärr) — fler event kan saknas.', 'err');
    }
    vlog('Nortic: ' + all.length + ' tillfällen hämtade över ' + (page - 1) + ' sida(or).');
    return { grouped: groupEvents(all, 'nortic'), rawCount: all.length };
  }

  // ---- Dedup ---------------------------------------------------------------
  function slimRow(r) {
    const s = r.start_date || null, e = r.end_date || r.start_date || null;
    return {
      title: r.title || '', venue_name: r.venue_name || '',
      address: r.address || '', city: r.city || '',
      start: s, end: e, isSpan: !!(s && e && s !== e),
      href: r.href || '', id: r.id || null
    };
  }
  // RÄTTAT (7.29): singulareventdates-endpointen returnerar redan BÅDA
  // språkversionerna från EN sajt (bekräftat av Aron). Att hämta båda
  // domänerna (7.26–7.28) dubblerade i stället varenda rad i hela kalendern
  // och orsakade en flodvåg av falska dubblettlarm. Tillbaka till en domän.
  const SED_BASE = location.origin + '/api/v1/singulareventdates/';

  async function buildDedupIndex(onProgress, onPage) {
    const rows = [];
    let first;
    try { onProgress('Läser er kalender, sida 1…'); first = await sameOriginGet(SED_BASE + '?page=1'); }
    catch (e) { throw new Error('Kunde inte läsa er kalender: ' + e.message + ' — inloggad i CMS:et?'); }
    const totalPages = first.total_pages || 1;
    if (onPage) onPage(1, totalPages);
    (first.results || []).forEach(r => rows.push(slimRow(r)));
    for (let p = 2; p <= totalPages; p++) {
      onProgress(`Läser er kalender, sida ${p}/${totalPages}…`);
      if (onPage) onPage(p, totalPages);
      const data = await sameOriginGet(SED_BASE + '?page=' + p);
      (data.results || []).forEach(r => rows.push(slimRow(r)));
      await new Promise(r => setTimeout(r, 80));
    }
    // Dedup på id: sidladdningen kan råka hämta SAMMA post två gånger om
    // kalendern ändras något medan scriptet bläddrar sida för sida — det ger
    // annars falska "dubblett"-larm på poster som egentligen bara är en och
    // samma rad räknad två gånger (upptäckt via en riktig export från Aron).
    const seenIds = new Set();
    const uniqueRows = [];
    let dupeCount = 0;
    rows.forEach(r => {
      if (r.id && seenIds.has(r.id)) { dupeCount++; return; }
      if (r.id) seenIds.add(r.id);
      uniqueRows.push(r);
    });
    if (dupeCount) onProgress(`Rensade ${dupeCount} dubblerad(e) rad(er) från sidladdningen.`);
    return uniqueRows;
  }
  function buildIndexFromRows(rows) {
    const byToken = new Map();
    const byAddr = new Map();   // normText(address) -> Set av radindex, för fall där
                                 // titlarna delar noll gemensamma ord (t.ex. helt
                                 // olika språk: "Öl & Sprit..." vs "Beer & Spirits...").
    rows.forEach((row, i) => {
      new Set(tokens(row.title)).forEach(tok => {
        if (!byToken.has(tok)) byToken.set(tok, new Set());
        byToken.get(tok).add(i);
      });
      const addrKey = normAddr(row.address);
      if (addrKey) {
        if (!byAddr.has(addrKey)) byAddr.set(addrKey, new Set());
        byAddr.get(addrKey).add(i);
      }
    });
    return { rows, byToken, byAddr };
  }

  // ---- Städfunktion: hitta misstänkta dubbletter i ER EGEN kalender ---------
  // Nyckelinsikt: VARJE event finns som ett språkpar (2 poster, samma plats+datum).
  // Därför:
  //   • grupp med 2 poster (liknande titel + plats + samma/överlappande datum)
  //     = förväntat språkpar → INTE en dubblett, visas inte.
  //   • grupp med 3+ poster = fler än språkparet → MISSTÄNKT dubblett, visas.
  // Ett valfritt datumintervall begränsar vilka rader som granskas.
  function datesOverlap(a, b) {
    // Kräver FAKTISK överlappning — ingen "inom 1 dag"-tolerans längre. Den
    // toleransen orsakade en kedjeeffekt tillsammans med klustersammanslagningen:
    // återkommande flerdagarsserier (t.ex. samma konsert 4 dagar i rad) länkades
    // ihop dag för dag och sågs som EN stor falsk dubblettgrupp. Alla bekräftat
    // äkta dubbletter vi sett hittills har haft exakt matchande datum ändå.
    const as = a.start, ae = a.end || a.start, bs = b.start, be = b.end || b.start;
    if (!as || !bs) return false;
    return as <= be && bs <= ae;
  }

  // ---- Diagnostik: visar ALLA rader som matchar en titelsökning, plus exakta
  // likhetspoäng parvis mellan dem — direkt i fliken (kräver INTE att loggen
  // är öppen) — så vi ser precis varför dubblettsökningen klumpar ihop
  // (eller inte klumpar ihop) ett visst fall, utan att gissa.
  function runDupDiagnostic() {
    const out = $('vseh-diag-result');
    const show = (html) => { if (out) { out.style.display = 'block'; out.innerHTML = html; } };

    const q = ($('vseh-diag-title') && $('vseh-diag-title').value || '').trim();
    if (!q) { show('<div class="vseh-diag-err">Skriv in en titel eller titeldel att söka på först.</div>'); return; }
    if (!dedupIndex) { show('<div class="vseh-diag-err">Ingen kalenderdata laddad ännu — klicka "VisitStockholm" i fliken Kalendrar först.</div>'); return; }

    const needle = normText(q);
    const matches = dedupIndex.rows.filter(r => normText(r.title).includes(needle));
    vlog('🔍 DIAGNOSTIK "' + q + '": hittade ' + matches.length + ' rad(er) i er kalender (' + dedupIndex.rows.length + ' rader totalt laddade).', 'ok');

    if (!matches.length) {
      show('<div class="vseh-diag-err">Ingen rad av totalt ' + dedupIndex.rows.length +
        ' laddade kalenderrader innehåller "' + esc(q) + '". Kontrollera stavning, eller att kalendern verkligen är laddad (se tidsstämpel vid VisitStockholm-knappen i fliken Kalendrar).</div>');
      return;
    }

    let html = '<div class="vseh-diag-hdr">' + matches.length + ' rad(er) av ' + dedupIndex.rows.length + ' totalt matchar "' + esc(q) + '":</div>';
    html += matches.map((r, i) => `<div class="vseh-diag-row">[${i}] <b>${esc(r.title)}</b><br>
      venue="${esc(r.venue_name || '(tomt)')}" · adress="${esc(r.address || '(tomt)')}"<br>
      start=${esc(r.start || '(tomt)')} · slut=${esc(r.end || '(tomt)')} · spann=${!!r.isSpan}</div>`).join('');

    if (matches.length < 2) {
      html += '<div class="vseh-diag-err">Bara en rad hittad — inget par att jämföra. Om du väntade dig fler, kanske kalenderdatan behöver laddas om.</div>';
      show(html);
      return;
    }

    html += '<div class="vseh-diag-hdr">Parvisa likhetspoäng (tröskel: titel≥0.75, plats≥0.7, datum måste överlappa):</div>';
    for (let i = 0; i < matches.length; i++) {
      for (let j = i + 1; j < matches.length; j++) {
        const a = matches[i], b = matches[j];
        const tSim = titleSim(a.title, b.title);
        const vSim = placeSim(a.venue_name, a.address, b.venue_name, b.address);
        const dOverlap = datesOverlap(a, b);
        const wouldMatch = tSim >= 0.75 && vSim >= 0.7 && dOverlap;
        const line = `[${i}]↔[${j}]: titelSim=${tSim.toFixed(2)}, platsSim=${vSim.toFixed(2)}, datumöverlapp=${dOverlap} → ${wouldMatch ? '✅ MATCHAR' : '❌ matchar EJ'}`;
        html += `<div class="vseh-diag-row ${wouldMatch ? 'ok' : 'err'}">${esc(line)}</div>`;
        vlog(line, wouldMatch ? 'ok' : 'err');
      }
    }
    show(html);
  }

  function findCalendarDuplicates(onProgress, dateFrom, dateTo) {
    if (!dedupIndex) return [];
    let rows = dedupIndex.rows.map((r, i) => ({ ...r, _i: i }));

    // Datumfilter (om angivet): behåll rader vars spann rör intervallet.
    if (dateFrom || dateTo) {
      rows = rows.filter(r => {
        const s = r.start || r.end, e = r.end || r.start;
        if (!s) return false;
        if (dateFrom && e < dateFrom) return false;
        if (dateTo && s > dateTo) return false;
        return true;
      });
    }

    // Bygg RÅA kluster: greedy union av rader med liknande titel+plats+överlappande
    // datum. OBS: denna första passering kan splittra vad som egentligen är EN
    // dubblettgrupp i flera mindre kluster (t.ex. om två råkade dubbletter var för
    // sig bildar sina egna sv/en-par) — därför slås matchande kluster ihop i steg 2
    // innan 3+-regeln tillämpas, annars missas dubbletter som består av fler än en
    // språkpar-kopia.
    const used = new Array(rows.length).fill(false);
    const rawClusters = [];
    const localTok = new Map();
    rows.forEach((r, idx) => new Set(tokens(r.title)).forEach(t => {
      if (!localTok.has(t)) localTok.set(t, []); localTok.get(t).push(idx);
    }));

    for (let i = 0; i < rows.length; i++) {
      if (used[i]) continue;
      if (onProgress && i % 100 === 0) onProgress(`Grupperar… ${i}/${rows.length}`);
      const a = rows[i];
      const cluster = [a]; used[i] = true;
      const cand = new Set();
      new Set(tokens(a.title)).forEach(t => (localTok.get(t) || []).forEach(j => { if (!used[j]) cand.add(j); }));
      cand.forEach(j => {
        const b = rows[j];
        if (used[j]) return;
        const tSim = titleSim(a.title, b.title);
        const vSim = placeSim(a.venue_name, a.address, b.venue_name, b.address);
        if (tSim >= 0.75 && vSim >= 0.7 && datesOverlap(a, b)) {   // strängare i FÖRSTA passeringen (0.75) för att minska brus
          cluster.push(b); used[j] = true;
        }
      });
      if (cluster.length >= 2) rawClusters.push(cluster);
    }

    // Steg 2: slå ihop kluster som har MINST EN inbördes matchande post — inte
    // bara jämförelse mot en enda "startpost", eftersom två splittrade kluster
    // för samma dubblettfall kan ha startat med olika språkversioner (en
    // signatur byggd på bara första posten hade missat den kopplingen).
    const parent = rawClusters.map((_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

    for (let i = 0; i < rawClusters.length; i++) {
      for (let j = i + 1; j < rawClusters.length; j++) {
        if (find(i) === find(j)) continue;
        let linked = false;
        for (const a of rawClusters[i]) {
          for (const b of rawClusters[j]) {
            if (titleSim(a.title, b.title) >= 0.75 &&
                placeSim(a.venue_name, a.address, b.venue_name, b.address) >= 0.7 &&
                datesOverlap(a, b)) { linked = true; break; }
          }
          if (linked) break;
        }
        if (linked) union(i, j);
      }
    }

    const mergedByRoot = new Map();
    rawClusters.forEach((c, i) => {
      const root = find(i);
      if (!mergedByRoot.has(root)) mergedByRoot.set(root, []);
      mergedByRoot.get(root).push(...c);
    });

    const groups = [];
    // 3+ poster = alltid misstänkt. EXAKT 2 poster antas normalt vara ett
    // legitimt språkpar och hoppas över — MEN om båda posterna har HELT
    // IDENTISK titel (inte bara lik) är det snarare ett tecken på en äkta
    // dubblett än en översättning, så då flaggas paret ändå (t.ex. Opus13:
    // två rader med bokstavligen samma engelska titel, ingen svensk motpart).
    mergedByRoot.forEach(g => {
      if (g.length >= 3) { groups.push(g); return; }
      if (g.length === 2 && normText(g[0].title) === normText(g[1].title)) groups.push(g);
    });

    // Störst grupp först (flest övertaliga poster = mest misstänkt)
    groups.sort((x, y) => y.length - x.length);
    return groups;
  }

  const SIM_THRESHOLD = 0.5;
  const VENUE_THRESHOLD = 0.5;
  // Strängare titel-tröskel när KÄLLAN inte gav någon platsdata alls (t.ex.
  // Billetto utan venue_name/adress) — då kan vi inte kräva platslikhet
  // (den blir alltid 0), så vi litar på en säkrare titelmatchning istället.
  const NO_PLACE_TITLE_THRESHOLD = 0.75;
  // Draftvyns dubblettkoll (matchStatus(ev, {strict:true})) använder denna
  // istället för SIM_THRESHOLD — bekräftat 2026-09-19 att 0.5 (bara hälften
  // av det kortaste ordsetet gemensamt) gav dubbletter mellan utkast vars
  // titlar uppenbart INTE var relaterade, bara för att de delade venue och
  // något enstaka vanligt ord. Fortfarande löst nog för riktiga
  // översättningspar (sv/en), men kräver mer överlapp än hälften.
  const DRAFT_SIM_THRESHOLD = 0.7;
  const inRange = (d, s, e) => s && e && d >= s && d <= e;
  // Spärr så DEDUP-NÄRMISS-loggning inte upprepas varje gång listan ritas om.
  const loggedNearMisses = new Set();

  function matchStatus(ev, { strict = false } = {}) {
    if (!dedupIndex) return { key: 'unknown', detail: '', matches: [] };
    if (isManualIn(ev)) return { key: 'in', detail: 'manuellt hanterat', matches: [] };
    const simThreshold = strict ? DRAFT_SIM_THRESHOLD : SIM_THRESHOLD;
    const cand = new Set();
    new Set(tokens(ev.title)).forEach(tok => { const s = dedupIndex.byToken.get(tok); if (s) s.forEach(i => cand.add(i)); });

    // Adressbaserade kandidater LÄGGS TILL separat — fångar fall där titlarna
    // delar NOLL gemensamma ord (t.ex. helt olika språk: "Öl & Sprit..." vs
    // "Beer & Spirits...", där "Stockholm" är stoppord och inget annat delas).
    // HELT AVSTÄNGD (2026-09-19, gällde tidigare bara strict-läge/draftvyn,
    // nu överallt) — bekräftat i BÅDA lägen att adress+datum utan NÅGOT
    // titelstöd ger falska träffar för adresser med hög omsättning av helt
    // orelaterade event (Sergels Torg/Kulturhuset Stadsteatern i draftvyn;
    // Hornstulls strand 4/Debaser Nova, Styckmästargatan 10/Hus 7 i
    // huvudflödet mot Nortic — "The Lemon Twigs" och "The Magic Numbers"
    // matchade var sin HELT ANNAN spelning samma kväll på Debaser Nova).
    // En falsk träff här är värre än en missad: den GÖMMER ett genuint nytt
    // event ur "ej inlagda"-listan, medan en missad översättningsträff (den
    // ursprungliga tanken med fallbacken) bara innebär att en människa
    // snabbt känner igen dubbletten manuellt istället. addrOnlyCand hålls
    // kvar (tom) hellre än att ta bort hela grenen nedan, ifall en säkrare
    // variant (t.ex. även kräva matchande klockslag) läggs till senare.
    const addrOnlyCand = new Set();

    // STRIKTARE: BÅDE titel OCH plats måste likna, och paret ej avmarkerat —
    // UTOM när källan inte gav någon platsdata alls (t.ex. Billetto utan
    // venue_name/adress), då krävs istället en säkrare titelmatchning ensam.
    const tvRows = [];
    const nearMisses = [];
    const evHasPlace = !!(normText(ev.venue_name) || normAddr(ev.address));
    cand.forEach(i => {
      const row = dedupIndex.rows[i];
      if (isDismissed(ev, row)) return;
      const tSim = titleSim(ev.title, row.title);
      const vSim = placeSim(ev.venue_name, ev.address, row.venue_name, row.address);
      const match = evHasPlace
        ? (tSim >= simThreshold && vSim >= VENUE_THRESHOLD)
        : (tSim >= Math.max(simThreshold, NO_PLACE_TITLE_THRESHOLD));
      if (match) tvRows.push(row);
      else nearMisses.push({ row, tSim, vSim });
    });
    // Diagnostik: om det fanns kandidater men INGEN blev en match, logga varför —
    // så framtida dedup-missar syns direkt i loggen utan extra skärmdumpar.
    if (cand.size && !tvRows.length && nearMisses.length) {
      nearMisses.sort((a, b) => (b.tSim + b.vSim) - (a.tSim + a.vSim));
      const top = nearMisses[0];
      const missKey = normText(ev.title) + '@' + normText(ev.venue_name) + '||' + normText(top.row.title);
      if (!loggedNearMisses.has(missKey)) {
        loggedNearMisses.add(missKey);
        vlog('DEDUP-NÄRMISS för "' + ev.title + '" (källa: venue="' + (ev.venue_name || '(tomt)') +
          '", adress="' + (ev.address || '(tomt)') + '", evHasPlace=' + evHasPlace +
          ') mot kalenderrad "' + top.row.title + '" (venue="' + (top.row.venue_name || '(tomt)') +
          '", adress="' + (top.row.address || '(tomt)') + '") — tSim=' + top.tSim.toFixed(2) +
          ', vSim=' + top.vSim.toFixed(2) + ', krav: ' +
          (evHasPlace ? ('tSim≥' + simThreshold + ' OCH vSim≥' + VENUE_THRESHOLD) : ('tSim≥' + Math.max(simThreshold, NO_PLACE_TITLE_THRESHOLD))), 'err');
      }
    }

    const evDates = ev.dates.map(d => d.date).filter(Boolean);

    // Adress+datum-baserad match: fångar par där titlarna delar NOLL ord
    // (olika språk) och därför aldrig blev kandidater via titel-tokens.
    // Kräver nästan perfekt adressmatchning (vSim≥0.9) OCH att minst ett av
    // källans datum träffar kalenderradens datum EXAKT — starkt oberoende
    // bevis som inte är beroende av titelspråket alls.
    // Spann-rader (row.isSpan) räknas MEDVETET INTE som datumträff här —
    // bekräftat 2026-09-19 (Hötorget 13-15/"Haymarket by Scandic"): en
    // byggnad med flera fristående venues på samma gatuadress kan ha egna,
    // helt orelaterade flermånaderslånga spann (t.ex. en löpande
    // "Jazz Session"-serie och en separat "An Oyster Affair"-serie) som då
    // skulle träffa NÄSTAN VILKET DATUM SOM HELST för ett helt tredje,
    // orelaterat event på samma adress. Utan något titelstöd alls är ett
    // brett spann för svagt som ensamt bevis — exakt dag mot dag krävs.
    addrOnlyCand.forEach(i => {
      const row = dedupIndex.rows[i];
      if (isDismissed(ev, row)) return;
      const vSim = placeSim(ev.venue_name, ev.address, row.venue_name, row.address);
      if (vSim < 0.9) return;
      const dateHit = evDates.some(d => !row.isSpan && row.start === d);
      if (!dateHit) return;
      if (!tvRows.includes(row)) {
        tvRows.push(row);
        vlog('Adress+datum-match (olika titelspråk, ingen delad titel-token): "' + ev.title +
          '" ↔ kalenderrad "' + row.title + '" — adress="' + (row.address || '(tomt)') + '", vSim=' + vSim.toFixed(2), 'ok');
      }
    });

    if (!tvRows.length) return { key: 'out', detail: '', matches: [] };
    let anySpanHit = false; const surelyHit = [], notHit = [];
    for (const d of evDates) {
      const exactDay = tvRows.some(r => !r.isSpan && r.start === d);
      const spanHit = tvRows.some(r => r.isSpan && inRange(d, r.start, r.end));
      if (exactDay) surelyHit.push(d);
      else if (spanHit) anySpanHit = true;
      else notHit.push(d);
    }
    if (evDates.length === 0) return { key: 'unsure', detail: 'inga datum från källan att jämföra', matches: tvRows };
    if (anySpanHit) return { key: 'unsure', detail: 'datum ligger i ett flerdagarsspann – verifiera manuellt', matches: tvRows };
    if (notHit.length === 0) return { key: 'in', detail: '', matches: tvRows };
    if (surelyHit.length === 0) return { key: 'out', detail: '', matches: tvRows };
    return { key: 'partial', detail: `${notHit.length} av ${evDates.length} datum saknas`, matches: tvRows, notHit };
  }

  // ---- Cache ---------------------------------------------------------------
  function saveCache() {
    try {
      if (dedupIndex) GM_setValue(CACHE_CAL, JSON.stringify({ ts: Date.now(), rows: dedupIndex.rows }));
      if (lastGrouped.length) GM_setValue(CACHE_TM, JSON.stringify({ ts: Date.now(), events: lastGrouped }));
    } catch {}
  }
  function loadCache() {
    let calTs = null, tmTs = null;
    try { const cal = GM_getValue(CACHE_CAL, ''); if (cal) { const o = JSON.parse(cal); dedupIndex = buildIndexFromRows(o.rows || []); calTs = o.ts; } } catch {}
    try { const tm = GM_getValue(CACHE_TM, ''); if (tm) { const o = JSON.parse(tm); lastGrouped = o.events || []; tmTs = o.ts; } } catch {}
    return { calTs, tmTs };
  }

  // ============================================================
  // BASIC FIELD INPUT
  // ============================================================

  function simulateInput(el, value) {
    if (!el) return;
    if (el.tagName === "SELECT") {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.type === "checkbox") {
      el.checked = value === "true" || value === true || value === "1";
    } else {
      el.value = value || "";
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  // ============================================================
  // DRAFTAIL RICH TEXT (React onChange via fiber)
  // ============================================================

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function mountDraftail(fieldId) {
    const hidden = document.getElementById(fieldId);
    if (!hidden) return null;
    const wrapper =
      hidden.closest(".w-field, .w-panel, [data-field]") || hidden.parentElement;
    const findRoot = () =>
      wrapper?.querySelector(".DraftEditor-root") ||
      wrapper?.querySelector(".Draftail-Editor .DraftEditor-root");
    let root = findRoot();
    if (!root) {
      hidden.scrollIntoView({ block: "center" });
      const clickTarget =
        wrapper?.querySelector(".Draftail-Editor") || wrapper || hidden;
      clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let i = 0; i < 40 && !root; i++) {
        await wait(75);
        root = findRoot();
      }
    }
    return root || null;
  }

  function getDraftProps(root) {
    const instKey = Object.keys(root).find((k) =>
      k.startsWith("__reactInternalInstance$")
    );
    let node = instKey ? root[instKey] : null;
    let hops = 0;
    while (node && hops < 30) {
      const mp = node.memoizedProps;
      if (mp && mp.onChange && mp.editorState) return mp;
      node = node.return || node._debugOwner || null;
      hops++;
    }
    return null;
  }

  async function updateDraftail(fieldId, text) {
    try {
      const root = await mountDraftail(fieldId);
      if (!root) { console.warn(`Draftail kunde inte monteras: ${fieldId}`); return; }
      const props = getDraftProps(root);
      if (!props) { console.warn(`Draftail React-props hittades inte: ${fieldId}`); return; }
      const editorState = props.editorState;
      const EditorState = editorState.constructor;
      const currentContent = editorState.getCurrentContent();
      const ContentState = currentContent.constructor;
      const newContent = ContentState.createFromText(String(text), "\n");
      let newState = EditorState.createWithContent(newContent);
      if (typeof EditorState.moveSelectionToEnd === "function") {
        newState = EditorState.moveSelectionToEnd(newState);
      }
      props.onChange(newState);
      console.log(`Draftail satt via onChange: ${fieldId} → ${String(text).slice(0, 60)}...`);
    } catch (err) {
      console.warn(`Draftail-fyllning gav fel för ${fieldId} (fortsätter):`, err);
    }
  }

  // ============================================================
  // WAGTAIL-AUTOCOMPLETE CATEGORIES
  // ============================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 2026-09-18: bekräftat via loggen att en engångs-bulksättning av värdet
  // (en `value =`-tilldelning + ett enda input/keyup) inte utlöste någon
  // filtrering alls på related_guides — samma ofiltrerade lista dök upp för
  // två helt olika söktexter. Troligen kräver den widgetens debounce/sök
  // riktiga tecken-för-tecken-tangenttryckningar (rimligt för ett sök som
  // går mot en verklig backend över hundratals guider, till skillnad från
  // en liten förladdad kategorilista som kan filtrera synkront lokalt på
  // ett enda input-event). Skriver därför in värdet tecken för tecken med
  // riktiga keydown/input/keyup-event och en kort paus mellan varje, precis
  // som en människa skulle skriva.
  async function setSearchValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const setVal = v => { if (setter) setter.call(input, v); else input.value = v; };
    input.focus();
    setVal("");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Bygger den inskrivna strängen från en egen lokal variabel istället för
    // att läsa tillbaka input.value mellan varje tecken — bekräftat
    // 2026-09-19 att widgeten ibland hinner skriva om/normalisera fältets
    // värde mellan våra tangenttryckningar, vilket annars smyger in
    // felstavningar när nästa tecken byggs vidare på ett redan ändrat värde.
    // Med en egen "sanning" rättar varje tecken automatiskt till eventuell
    // sådan drift istället för att ärva den.
    let typed = "";
    for (const ch of value) {
      typed += ch;
      setVal(typed);
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ch }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: ch }));
      await sleep(35);
    }
  }

  function getSuggestionList(input) {
    const owns = input.getAttribute("aria-owns");
    return owns ? document.getElementById(owns) : null;
  }

  function normalize(s) {
    return (s || "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // OBS (2026-09-17): tar emot `input`, inte en färdig `list` — aria-owns
  // slås upp PÅ VARJE POLL-tick istället för en gång innan väntan börjar.
  // Vissa autocomplete-fält (bekräftat: related_guides) sätter aria-owns
  // lat, först när widgeten faktiskt bestämmer sig för att visa en lista
  // (t.ex. efter ett asynkront sök-svar) — slogs den upp EN gång direkt
  // efter att vi skrivit in texten var den ofta fortfarande null, och hela
  // väntan pollade då null för evigt även om listan dök upp en stund senare.
  function waitForSuggestions(input, timeout = 4000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const list = getSuggestionList(input);
        const items = list ? Array.from(list.querySelectorAll('li[role="option"]')) : [];
        const visible = list && getComputedStyle(list).display !== "none" && items.length > 0;
        if (visible) return resolve(items);
        if (Date.now() - start > timeout) return resolve(items);
        setTimeout(check, 80);
      };
      check();
    });
  }

  // `searchText` (default: samma som `value`) är vad som faktiskt SKRIVS in —
  // `value` förblir facit för vilket förslag som väljs ur listan. Låter
  // anropare skriva in en kortare, mer träffsäker söktext (t.ex. bara de
  // första orden av en lång guidetitel) utan att ändra vilken post som
  // faktiskt räknas som "rätt" val.
  async function selectAutocompleteValue(fieldId, value, searchText) {
    const input = document.getElementById(fieldId);
    if (!input) { vlog('Autocomplete: fältet ' + fieldId + ' hittades inte.', 'err'); return false; }
    if (!value) return false;
    const target = normalize(value);
    const toType = searchText || value;
    vlog('Autocomplete: skriver "' + toType + '" i ' + fieldId + ' (mål: "' + value + '")…');
    await setSearchValue(input, toType);
    const items = await waitForSuggestions(input);
    if (!items.length) {
      vlog('Autocomplete: inga förslag dök upp för ' + fieldId + ' → "' + value + '" (väntade 4s, aria-owns hittades ' +
        (getSuggestionList(input) ? 'till slut men utan alternativ' : 'aldrig') + ').', 'err');
      return false;
    }
    const textOf = (li) => normalize(li.querySelector("span")?.textContent || li.textContent);
    let match =
      items.find((li) => textOf(li) === target) ||
      items.find((li) => textOf(li).startsWith(target)) ||
      items.find((li) => textOf(li).includes(target));
    if (!match) {
      vlog('Autocomplete: inget förslag matchade ' + fieldId + ' → "' + value + '". Alternativ: ' +
        items.map(textOf).join(' | '), 'err');
      return false;
    }
    vlog('Autocomplete: valde "' + textOf(match) + '" i ' + fieldId + '.', 'ok');
    match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    match.click();
    console.log(`Selected ${fieldId} → ${value}`);
    await sleep(250);
    return true;
  }

  async function fillCategoriesFromData(data) {
    if (data.main_category) {
      await selectAutocompleteValue("id_main_category", data.main_category);
    }
    if (data.categories) {
      const cats = data.categories.split("|").map((c) => c.trim()).filter(Boolean);
      for (const cat of cats) {
        await selectAutocompleteValue("id_categories", cat);
      }
    }
    if (data.subcategory) {
      await selectAutocompleteValue("id_subcategory", data.subcategory);
    }
  }

  // ============================================================
  // DATE BLOCKS
  // ============================================================

  function findDateAdminAddButton() {
    const root =
      document.getElementById("date_admin-root") ||
      document.querySelector('[data-contentpath="date_admin"]');
    const scope = root || document;
    const btns = [
      ...scope.querySelectorAll('.c-sf-add-button, button[data-streamfield-action="ADD"]'),
    ].filter((b) => b.offsetParent !== null);
    if (!btns.length) return null;
    return btns[btns.length - 1];
  }

  async function insertAndFillDateBlock({ date, start_time, end_time }) {
    const addBtn = findDateAdminAddButton();
    if (!addBtn) { console.warn("date_admin add-block button not found!"); return; }
    addBtn.click();

    await new Promise((resolve) => {
      let pickerTries = 0;
      const pickerInterval = setInterval(() => {
        const opts = Array.from(document.querySelectorAll(".w-combobox__option-text"));
        const singleDateOpt = opts.find(
          (el) => el.textContent.trim().toLowerCase() === "single date"
        );
        if (singleDateOpt) {
          singleDateOpt.click();
          clearInterval(pickerInterval);
          resolve();
        } else if (++pickerTries > 50) {
          clearInterval(pickerInterval);
          resolve();
        }
      }, 100);
    });

    await new Promise((resolve) => {
      let fillTries = 0;
      const fillInterval = setInterval(() => {
        const dateInputs = document.querySelectorAll(
          'input[name^="date_admin-"][name$="-value-date"]'
        );
        const nblock = dateInputs.length - 1;
        const dateInput = document.getElementById(`date_admin-${nblock}-value-date`);
        const startInput = document.getElementById(`date_admin-${nblock}-value-start_time`);
        const endInput = document.getElementById(`date_admin-${nblock}-value-end_time`);
        if (dateInput && startInput && endInput) {
          simulateInput(dateInput, date);
          simulateInput(startInput, start_time);
          simulateInput(endInput, end_time);
          console.log(`Block ${nblock}: set ${date} ${start_time} - ${end_time}`);
          clearInterval(fillInterval);
          resolve();
        } else if (++fillTries > 120) {
          clearInterval(fillInterval);
          resolve();
        }
      }, 100);
    });
  }

  async function fillDateBlocksFromCSV(data) {
    if (data.occurrences && data.occurrences !== "MANUAL_DATES_REQUIRED") {
      const occurrences = data.occurrences.split("|").map((str) => str.trim()).filter(Boolean);
      occurrences.sort((a, b) => {
        const keyOf = (occ) => {
          const [d, t] = occ.split(";").map((v) => v.trim().replace(/^"|"$/g, ""));
          return `${d} ${t || "00:00"}`;
        };
        return keyOf(a).localeCompare(keyOf(b));
      });
      console.log("Occurrences to process (kronologiskt, äldst först):",
        occurrences.length, occurrences.length ? occurrences.slice(0, 3) : []);
      for (const occ of occurrences) {
        const [date, start_time, , end_time] = occ
          .split(";").map((v) => v.trim().replace(/^"|"$/g, ""));
        await insertAndFillDateBlock({ date, start_time, end_time });
      }
    } else if (data.start_date && data.start_time && data.end_time) {
      await insertAndFillDateBlock({
        date: data.start_date.trim(),
        start_time: data.start_time.trim(),
        end_time: data.end_time.trim(),
      });
    } else if (data.occurrences === "MANUAL_DATES_REQUIRED") {
      console.warn("occurrences = MANUAL_DATES_REQUIRED — datumblock hoppas över, fyll i manuellt.");
    }
  }

  // ============================================================
  // ORCHESTRATION
  // ============================================================

  const SPECIAL_KEYS = new Set([
    "description_sv", "description_en", "occurrences",
    "start_date", "start_time", "end_date", "end_time",
    "main_category", "categories", "subcategory",
    // Image/credit fields are handled by the fetcher's image panel, not the form:
    "press_image_url", "alttext_sv", "alttext_en", "photographer", "notes",
    "dates_uncertain", "language_sv",
  ]);

  const FORCED_FIELDS = {
    submitted_by_email: "eventbot@stockholm.se",
  };

  async function fillFieldsFromData(data) {
    for (const [key, value] of Object.entries(data)) {
      if (SPECIAL_KEYS.has(key)) continue;
      if (key.startsWith('_')) continue;   // interna hjälpfält (_credit_sv etc) → ej formulärfält
      const el = document.getElementById(`id_${key}`);
      if (!el) { vlog(`Fält saknas i DOM: id_${key}`, 'err'); continue; }
      const finalValue = Object.prototype.hasOwnProperty.call(FORCED_FIELDS, key)
        ? FORCED_FIELDS[key] : value;
      simulateInput(el, finalValue);
      vlog(`Fält ifyllt: id_${key} → ${String(finalValue).slice(0,40)}`);
    }

    for (const [key, forcedValue] of Object.entries(FORCED_FIELDS)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) continue;
      const el = document.getElementById(`id_${key}`);
      if (!el) { console.warn(`Forcerat fält saknas i DOM: id_${key}`); continue; }
      simulateInput(el, forcedValue);
      console.log(`Forcerat fält ifyllt: id_${key} → ${forcedValue}`);
    }

    try {
      if (data.description_sv) await updateDraftail("id_description_sv", data.description_sv);
    } catch (err) { console.warn("description_sv gav fel (fortsätter):", err); }
    try {
      if (data.description_en) await updateDraftail("id_description_en", data.description_en);
    } catch (err) { console.warn("description_en gav fel (fortsätter):", err); }

    try { await fillCategoriesFromData(data); }
    catch (err) { console.warn("Kategorifyllning gav fel (fortsätter):", err); }

    try { activateLocationMap(); }
    catch (err) { console.warn("Location-aktivering gav fel (fortsätter):", err); }

    try { await fillDateBlocksFromCSV(data); }
    catch (err) { console.warn("Datumblock gav fel (fortsätter):", err); }
  }

  function activateLocationMap() {
    const el =
      document.getElementById("id_location_latlng") ||
      document.querySelector(".google-maps-location");
    if (!el) { console.warn("Location-fält (#id_location_latlng) hittades inte."); return; }
    el.scrollIntoView({ block: "center" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.focus();
    console.log("Location-karta aktiverad (klick/fokus skickat).");
  }

  // ---- Bygg occurrences-sträng från scriptets egna (kompletta) datum -------
  // Format per tillfälle: YYYY-MM-DD;HH:MM;YYYY-MM-DD;HH:MM (start;starttid;slut;sluttid)
  // Sluttid = starttid + 3h (din regel). Passeras midnatt → slutdatum +1 dag.
  // Nyast först, dubbletter bort. Detta är den auktoritativa datumkällan.
  function buildOccurrencesFromDates(dates) {
    const items = [];
    for (const d of dates) {
      if (!d.date) continue;
      const startT = (d.time || '00:00:00').slice(0, 5);       // HH:MM
      const [h, m] = startT.split(':').map(n => parseInt(n, 10));
      // +3h
      let endH = h + 3, endDate = d.date;
      if (endH >= 24) {
        endH -= 24;
        const dt = new Date(d.date + 'T00:00:00');
        dt.setDate(dt.getDate() + 1);
        endDate = dt.toISOString().split('T')[0];
      }
      const endT = String(endH).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      items.push(`${d.date};${startT};${endDate};${endT}`);
    }
    // unika
    const uniq = Array.from(new Set(items));
    // nyast först
    uniq.sort((a, b) => b.localeCompare(a));
    return uniq.join('|');
  }

  // ---- Forecast-data: 10 största lokaler (godkända siffror) ----------------
  // type: "Event" (arenor) eller "Fair" (mässhallar). Matchas på venue ELLER adress.
  const FORECAST_VENUES = [
    // 5 största arenorna → Event
    { names: ['strawberry arena', 'friends arena', 'nationalarenan'], addrs: ['råsta strandväg'], attendees: 65000, type: 'Event' },
    { names: ['3arena', '3 arena', 'tele2 arena'], addrs: ['arenaslingan'], attendees: 40000, type: 'Event' },
    { names: ['avicii arena', 'globen', 'ericsson globe'], addrs: ['globentorget'], attendees: 16000, type: 'Event' },
    { names: ['annexet'], addrs: ['arenaslingan 14'], attendees: 3400, type: 'Event' },
    { names: ['cirkus'], addrs: ['djurgårdsslätten'], attendees: 1750, type: 'Event' },
    // 5 största mäss-/kongresshallarna → Fair (siffror delvis uppskattade)
    { names: ['stockholmsmässan', 'stockholmsmassan'], addrs: ['mässvägen', 'massvagen', 'älvsjö'], attendees: 27250, type: 'Fair' },
    { names: ['kistamässan', 'kistamassan'], addrs: ['arne beurlings torg'], attendees: 8000, type: 'Fair' },
    { names: ['waterfront', 'stockholm waterfront'], addrs: ['nils ericsons plan'], attendees: 3000, type: 'Fair' },
    { names: ['münchenbryggeriet', 'munchenbryggeriet'], addrs: ['torkel knutssonsgatan'], attendees: 2000, type: 'Fair' },
    { names: ['nacka strandsmässan', 'nacka strand'], addrs: ['augustendalsvägen'], attendees: 2000, type: 'Fair' }
  ];

  function matchForecastVenue(venueName, address) {
    const v = normText(venueName), a = normText(address);
    for (const f of FORECAST_VENUES) {
      if (f.names.some(n => v && (v === n || v.includes(n) || n.includes(v)))) return f;
      if (f.addrs.some(ad => a && a.includes(normText(ad)))) return f;
    }
    return null;
  }

  // Fyll forecast-fälten om eventets plats matchar en av de 10 lokalerna.
  // Har eventet FLERA tillfällen (t.ex. 2 konserter samma dag/tur) multipliceras
  // maxantalet med antalet tillfällen — t.ex. Avicii Arena x2 tillfällen = 32000.
  async function fillForecastIfMatch(ev) {
    const match = matchForecastVenue(ev.venue_name, ev.address);
    if (!match) return null;
    const occCount = (ev.dates && ev.dates.length) ? ev.dates.length : 1;
    const total = match.attendees * occCount;
    const attendeesEl = document.getElementById('id_expected_attendees');
    const typeEl = document.getElementById('id_forecast_event_type');
    const addEl = document.getElementById('id_add_to_forecast');
    if (attendeesEl) simulateInput(attendeesEl, String(total));
    if (typeEl) { typeEl.value = matchSelectOption(typeEl, match.type); typeEl.dispatchEvent(new Event('change', { bubbles: true })); }
    if (addEl && !addEl.checked) { addEl.checked = true; addEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const mult = occCount > 1 ? ` (${match.attendees} × ${occCount} tillfällen)` : '';
    vlog('Forecast ifyllt: ' + total + mult + ' (' + match.type + ') — ' + (ev.venue_name || ev.address), 'ok');
    return { total, occCount, type: match.type };
  }

  // Hitta rätt <option> value för en synlig text (t.ex. "Event"/"Fair").
  function matchSelectOption(sel, label) {
    const opt = [...sel.options].find(o => (o.textContent || '').trim().toLowerCase() === label.toLowerCase());
    return opt ? opt.value : sel.value;
  }

  // ---- Bildautomation (Steg A: fyll fält; Steg B: försök ladda upp fil) -----
  const IMG_FIELDS = {
    title:      'id_image-chooser-upload-title',
    title_sv:   'id_image-chooser-upload-title_sv',
    description:'id_image-chooser-upload-description',
    credit:     'id_image-chooser-upload-credit',
    credit_sv:  'id_image-chooser-upload-credit_sv',
    alt:        'id_image-chooser-upload-alt',
    alt_sv:     'id_image-chooser-upload-alt_sv',
    file:       'id_image-chooser-upload-file',
    rights:     'id_image-chooser-upload-rights_expiry_date'
  };
  const IMG_SEARCH_TAB = 'tab-label-search';
  const IMG_SEARCH_INPUT = 'id_image-chooser-search-q';   // Wagtail sök-fält (fallback via Sök)

  const waitFor = (sel, timeout = 8000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return resolve(el);
      if (Date.now() - t0 > timeout) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });

  function setNativeValue(el, value) {
    // Sätt värde så React/Wagtail registrerar det.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') &&
                   Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Ladda ner bild via GM och injicera i filfältet (Steg B).
  // Filändelsen bestäms av den FAKTISKA content-typen från svaret — inte en
  // gissning på URL:en — annars kan en PNG döpas till .jpg och Wagtail nekar.
  const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
                      'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
  function downloadImageAsFile(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob',
        onload: r => {
          if (r.status >= 200 && r.status < 300 && r.response) {
            const actualType = r.response.type || '';
            // Läs även svarshuvudet som reserv om blob.type saknas.
            let headerType = '';
            try { const m = (r.responseHeaders || '').match(/content-type:\s*([^\s;]+)/i); if (m) headerType = m[1]; } catch {}
            const type = actualType || headerType || 'image/jpeg';
            const ext = MIME_EXT[type.toLowerCase()] || 'jpg';
            let base = (url.split('/').pop() || 'bild').split('?')[0].replace(/\.(jpe?g|png|webp|gif|avif)$/i, '');
            const name = base + '.' + ext;
            if (headerType && actualType && headerType.toLowerCase() !== actualType.toLowerCase()) {
              vlog('OBS: content-type i header (' + headerType + ') skiljer sig från blob (' + actualType + ') — använder ' + type + '.');
            }
            resolve(new File([r.response], name, { type }));
          } else reject(new Error('bildnedladdning HTTP ' + r.status));
        },
        onerror: () => reject(new Error('bildnedladdning nätverksfel')),
        ontimeout: () => reject(new Error('bildnedladdning timeout')),
        timeout: 30000
      });
    });
  }

  async function tryInjectImageFile(imageUrl) {
    const fileInput = document.getElementById(IMG_FIELDS.file);
    if (!fileInput) { vlog('Filfält hittades ej.', 'err'); return false; }
    try {
      vlog('Laddar ner bild för injektion…');
      const file = await downloadImageAsFile(imageUrl);
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      vlog('Bildfil injicerad (' + file.name + ', ' + Math.round(file.size/1024) + ' kB).', 'ok');
      return true;
    } catch (e) {
      vlog('Auto-uppladdning misslyckades: ' + e.message + '. Välj fil manuellt.', 'err');
      return false;
    }
  }

  async function automateImage(data) {
    const imageUrl = data.press_image_url || '';
    vlog('Bildautomation startar…');

    // 1) Öppna modalen via "Välj en bild"-knappen
    const chooseBtn = [...document.querySelectorAll('button')]
      .find(b => /välj en bild/i.test((b.textContent || '').trim()));
    if (!chooseBtn) { vlog('"Välj en bild"-knappen hittades ej.', 'err'); return; }
    chooseBtn.click();

    // 2) Vänta på modalen
    const uploadTab = await waitFor('#tab-label-upload', 8000);
    if (!uploadTab) { vlog('Bildmodalen dök ej upp.', 'err'); return; }

    // Om ingen pressbild: använd fallback-bilden ur bildbanken via Sök-fliken.
    if (!imageUrl) {
      vlog('Ingen pressbild — använder fallback-bild via Sök.');
      await useFallbackImage();
      return;
    }

    // Annars: Ladda upp-fliken + fyll fält + injicera fil.
    uploadTab.click();
    await new Promise(r => setTimeout(r, 400));

    const placeholder = 'Eventbild ' + (data.title_sv || data.title_en || '').trim();
    const altEn = data.alttext_en || placeholder;
    const altSv = data.alttext_sv || placeholder;
    const map = [
      [IMG_FIELDS.title,       data.title_sv || data.title_en || ''],
      [IMG_FIELDS.title_sv,    data.title_sv || ''],
      [IMG_FIELDS.description, altSv],
      [IMG_FIELDS.credit,      data._credit_en || ''],
      [IMG_FIELDS.credit_sv,   data._credit_sv || ''],
      [IMG_FIELDS.alt,         altEn],
      [IMG_FIELDS.alt_sv,      altSv],
      [IMG_FIELDS.rights,      data._rights_expiry || '']
    ];
    let filled = 0;
    for (const [id, val] of map) {
      const el = document.getElementById(id);
      if (!el) { vlog('Bildfält saknas: ' + id, 'err'); continue; }
      if (val) { setNativeValue(el, val); filled++; }
    }
    vlog('Bildfält ifyllda: ' + filled + ' st.', 'ok');

    const ok = await tryInjectImageFile(imageUrl);
    if (!ok) { vlog('Välj bildfilen manuellt (auto-injektion nekades).'); return; }

    // Bekräfta uppladdningen: klicka modalens "Ladda upp"-submit-knapp.
    await new Promise(r => setTimeout(r, 500));
    const uploadSubmit = [...document.querySelectorAll('button[type="submit"]')]
      .find(b => /^ladda upp$/i.test((b.textContent || '').trim()));
    if (uploadSubmit) {
      uploadSubmit.click();
      vlog('Klickade "Ladda upp" för att bekräfta bilden.', 'ok');
    } else {
      vlog('Hittade ej "Ladda upp"-knappen — klicka den manuellt för att slutföra.', 'err');
    }
  }

  // Fallback: växla till Sök-fliken, sök "fallback", välj enda träffen.
  async function useFallbackImage() {
    const searchTab = document.getElementById(IMG_SEARCH_TAB);
    if (!searchTab) { vlog('Sök-fliken hittades ej.', 'err'); return; }
    searchTab.click();
    await new Promise(r => setTimeout(r, 400));

    // Hitta sökfältet (id kan variera; prova känt id, annars type=text i sök-panelen)
    let searchInput = document.getElementById(IMG_SEARCH_INPUT) ||
      document.querySelector('#tab-search input[type="text"], [id^="tab-search"] input[type="text"]');
    if (!searchInput) { vlog('Bildsök-fältet hittades ej — välj fallback manuellt.', 'err'); return; }

    setNativeValue(searchInput, 'fallback');
    vlog('Söker "fallback" i bildbanken…');
    // vänta på att resultatet laddas (AJAX)
    await new Promise(r => setTimeout(r, 1200));

    // Klicka första bildträffen i sökresultatet
    const result = document.querySelector(
      '#tab-search a[class*="image"], #tab-search .chooser__image, #tab-search ul li a, [id^="tab-search"] a[href*="/images/"]'
    );
    if (result) { result.click(); vlog('Fallback-bild vald.', 'ok'); }
    else vlog('Hittade ingen fallback-träff — välj manuellt.', 'err');
  }

  // ---- Mistral: skapa event ------------------------------------------------
  // Extrahera JSON ur agentens svar (robust mot ev. omgivande text).
  // Skanna fram ALLA kompletta topp-nivå {..}-objekt i texten (balanserade
  // klammerparenteser, hoppar över strängar). Returnerar dem som parsade objekt.
  function scanJSONObjects(t) {
    const objs = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = t.slice(start, i + 1);
          try { objs.push(JSON.parse(slice)); } catch {}
          start = -1;
        }
      }
    }
    return objs;
  }

  function extractJSON(text) {
    if (!text) return null;
    let t = String(text).trim();
    // 1) direkt
    try { return JSON.parse(t); } catch {}
    // 2) ```json ... ``` -staket
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) { try { return JSON.parse(fence[1].trim()); } catch {} }
    // 3) FLERA objekt i rad → ta det SISTA kompletta som faktiskt har eventfält
    //    (skyddar mot ett avslutande tomt/ofullständigt objekt).
    const objs = scanJSONObjects(t);
    if (objs.length) {
      const useful = objs.filter(o => o && (o.title_sv || o.title_en || o.occurrences || o.description_sv));
      const chosen = useful.length ? useful[useful.length - 1] : objs[objs.length - 1];
      if (objs.length > 1) vlog('Agenten gav ' + objs.length + ' JSON-objekt (' + useful.length + ' med innehåll) — använder det sista med innehåll.', 'ok');
      return chosen;
    }
    // 4) reparation av trunkerat objekt
    const a = t.indexOf('{');
    if (a >= 0) {
      let frag = t.slice(a);
      const m = frag.match(/[\s\S]*"(?:[^"\\]|\\.)*"\s*(?=,|})/);
      if (m) {
        let repaired = m[0].replace(/,\s*$/, '') + '}';
        try { return JSON.parse(repaired); } catch {}
      }
    }
    return null;
  }
  // Plocka ut assistentens textinnehåll ur Conversations-svaret (formen kan variera).
  function extractAgentText(resp) {
    // Vanliga former: resp.outputs[].content (sträng eller [{text}]),
    // eller resp.messages[].content. Vi letar brett efter text.
    const chunks = [];
    const pushContent = c => {
      if (typeof c === 'string') chunks.push(c);
      else if (Array.isArray(c)) c.forEach(x => { if (typeof x === 'string') chunks.push(x); else if (x && x.text) chunks.push(x.text); });
      else if (c && c.text) chunks.push(c.text);
    };
    if (resp.outputs) resp.outputs.forEach(o => pushContent(o.content));
    if (resp.messages) resp.messages.forEach(m => pushContent(m.content));
    if (resp.choices) resp.choices.forEach(ch => pushContent(ch.message && ch.message.content));
    return chunks.join('\n').trim();
  }

  const doneCreate = new Map();   // idx -> klockslag "HH:MM" för skapade utkast

  // Separat, snabbt anrop till en RIKTIG synmodell (pixtral) enbart för alt-text.
  // Görs fristående från huvudagenten (som bygger på mistral-medium och inte ser bilder).
  async function fetchAltTextFromImage(imageUrl, apiKey) {
    if (!imageUrl || !apiKey) return null;
    const body = {
      model: 'pixtral-12b-2409',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Beskriv bilden i EXAKT två korta, sakliga meningar. ' +
            'Svara ENBART med JSON: {"alttext_sv":"...","alttext_en":"..."}. ' +
            'Ingen text utanför JSON. Hitta inte på detaljer du inte ser.' },
          { type: 'image_url', image_url: imageUrl }
        ]
      }],
      max_tokens: 300
    };
    try {
      const resp = await gmPost(MISTRAL_CHAT,
        { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body);
      const text = resp && resp.choices && resp.choices[0] && resp.choices[0].message &&
                   resp.choices[0].message.content;
      if (!text) return null;
      const data = extractJSON(typeof text === 'string' ? text : JSON.stringify(text));
      if (data && (data.alttext_sv || data.alttext_en)) return data;
      return null;
    } catch (e) {
      vlog('Pixtral alt-text misslyckades: ' + e.message, 'err');
      return null;
    }
  }

  async function createEvent(ev, idx) {
    const apiKey = GM_getValue('mistral_key', '').trim();
    const agentId = GM_getValue('mistral_agent', '').trim();
    if (!apiKey || !agentId) {
      setEventStatus(idx, 'Fyll i Mistral API-nyckel och agent-ID (fliken Inställningar) först.', 'err');
      switchTab('set');
      return;
    }
    const url = ev.external_website_url;
    if (!url) { setStatus('Eventet saknar käll-URL att skicka till Mistral.', 'err'); return; }

    busyCreate.add(idx);
    activeEventIdx = idx;
    setEventStatus(idx, 'Skapar via Mistral…', 'work');
    render(lastGrouped);
    vlog('createEvent: "' + ev.title + '" — URL: ' + (ev.external_website_url||'(saknas)'));
    vlog('Mistral-nyckel: ' + (apiKey ? 'satt ('+apiKey.length+' tecken)' : 'SAKNAS') + ', agent: ' + (agentId||'SAKNAS'));

    // Bygg den auktoritativa datumlistan från scriptets egna hämtade datum.
    const authoritativeOccurrences = buildOccurrencesFromDates(ev.dates || []);
    vlog('Datum från API (auktoritativa): ' + (ev.dates ? ev.dates.length : 0) + ' st');

    // VÄG 2: Ticketmaster blockerar ofta agentens sidläsning (bot-skydd).
    // Därför matar vi agenten med ALL strukturerad data vi redan har från
    // Discovery-API:t, så den inte är beroende av att läsa sidan. Agenten ska
    // använda dessa fält rakt av och bara FORMATERA/ÖVERSÄTTA det som saknas
    // (beskrivning på två språk, kategorimappning, alttext).
    const img = (ev.image && ev.image.url) || '';
    const knownData = {
      title: ev.title || '',
      venue_name: ev.venue_name || '',
      address: ev.address || '',
      zip_code: ev.zip_code || '',
      city: ev.city || 'Stockholm',
      external_website_url: url,
      promoter: ev.promoter || '',
      category_hint: (ev.category && ev.category.title) || '',
      image_url: img,
      occurrences: authoritativeOccurrences
    };
    const agentInput =
      'KÄLLA: Ticketmaster (sidan är ofta bot-skyddad — förlita dig INTE på att kunna läsa den).\n\n' +
      'STRUKTURERAD DATA (auktoritativ — använd dessa värden rakt av):\n' +
      JSON.stringify(knownData, null, 2) + '\n\n' +
      'EVENT-URL (försök läsa den för en bättre beskrivningstext; om du blockeras, ' +
      'skriv en kort saklig beskrivning utifrån titeln och den strukturerade datan istället): ' + url + '\n\n' +
      'INSTRUKTIONER:\n' +
      '- title_sv/title_en: från "title" ovan (översätt en_titel vid behov).\n' +
      '- venue_name_sv/venue_name_en, address, zip_code, city: från datan ovan.\n' +
      '- external_website_url: exakt "external_website_url" ovan.\n' +
      '- occurrences: EXAKT "occurrences" ovan (ändra inte).\n' +
      '- press_image_url: "image_url" ovan om ifyllt.\n' +
      '- main_category/categories/subcategory: mappa "category_hint" + titeln till din kategorilista.\n' +
      '- description_sv/description_en: 2-5 meningar om VAD detta konkret är (artist/verk, ' +
      'genre, vad som är unikt) så läsaren kan avgöra intresse. Läs URL:en om möjligt, annars ' +
      'utifrån titeln. FÖRBJUDET: floskler ("en kväll fylld av musik och underhållning", ' +
      '"en oförglömlig upplevelse", "signaturljud", "lovar en intensiv upplevelse"), ' +
      'lokalbeskrivning, arrangörsomnämnande, biljettinfo. Hitta inte på specifika fakta.\n' +
      '- alttext_sv/alttext_en: lämna ALLTID tomma — fylls separat av annan process.\n' +
      '- closest_station: närmaste station för adressen (uppslag tillåtet).\n' +
      'Returnera ENBART JSON-objektet enligt ditt schema.';

    setStatus(`Skapar "${ev.title}" via Mistral…`, 'work');

    try {
      // Textanrop till huvudagenten (mistral-medium ser inte bilder — alt-text
      // hämtas separat via pixtral, se längre ner).
      const postOnce = () => {
        let waited = 0;
        const ticker = setInterval(() => {
          waited += 10;
          setStatus(`Väntar på Mistral… ${waited}s`, 'work');
        }, 10000);
        return gmPost(MISTRAL_CONV,
          { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          { agent_id: agentId, inputs: agentInput, store: false })
          .finally(() => clearInterval(ticker));
      };

      let resp;
      vlog('Skickar POST till Mistral…');
      try {
        resp = await postOnce();
      } catch (e1) {
        if (/timeout|nätverksfel|50[234]/i.test(e1.message)) {
          vlog('Försök 1 misslyckades: ' + e1.message + '. Försöker igen…', 'err');
          setStatus('Agenten svarade inte, försöker 1 gång till…', 'work');
          resp = await postOnce();
          vlog('Försök 2 lyckades.', 'ok');
        } else {
          throw e1;
        }
      }
      vlog('Mistral svarade. Nycklar i svar: ' + Object.keys(resp||{}).join(', '));

      const text = extractAgentText(resp);
      vlog('Extraherad text: ' + (text ? text.length + ' tecken' : 'TOM'));
      if (text) vlog('Textens början: ' + text.slice(0,200).replace(/\n/g,'\\n'));
      const data = extractJSON(text);
      if (!data) {
        vlog('JSON-tolkning MISSLYCKADES.', 'err');
        vlog('--- RÅSVAR FRÅN MISTRAL (hela) ---', 'err');
        // Logga hela svarsobjektet strukturellt
        try { vlog('resp-nycklar: ' + JSON.stringify(Object.keys(resp||{}))); } catch {}
        try { vlog('resp (JSON): ' + JSON.stringify(resp).slice(0, 6000)); } catch {}
        vlog('--- EXTRAHERAD TEXT ---', 'err');
        vlog(text ? text.slice(0, 6000) : '(tom text)');
        vlog('--- SLUT ---', 'err');
        try { console.log('VSEH FULL resp:', resp); console.log('VSEH FULL text:', text); } catch {}
        throw new Error('Kunde inte tolka agentens svar som JSON. Se loggrutan (📋) för råsvaret.');
      }
      vlog('JSON tolkad OK. Fält (' + Object.keys(data).length + '): ' + Object.keys(data).join(', '), 'ok');
      vlog('Kontroll: title_sv="' + (data.title_sv || '(tom)') + '", main_category="' + (data.main_category || '(tom)') + '", notes="' + (data.notes || '(inga)') + '"');
      try { vlog('Rådata (JSON): ' + JSON.stringify(data).slice(0, 6000)); } catch {}

      // Skriv ALLTID över occurrences med scriptets auktoritativa datumlista.
      // API-datumen är kompletta; agentens kan vara ofullständiga.
      if (authoritativeOccurrences) {
        const before = (data.occurrences || '').split('|').filter(Boolean).length;
        data.occurrences = authoritativeOccurrences;
        const after = authoritativeOccurrences.split('|').filter(Boolean).length;
        vlog(`occurrences överskriven: agenten gav ${before}, använder ${after} från API.`, 'ok');
      }

      await finishEventCreation(ev, data, idx, apiKey);
    } catch (e) {
      setEventStatus(idx, e.message, 'err');
    } finally {
      busyCreate.delete(idx);
      if (activeEventIdx === idx) activeEventIdx = null;
      render(lastGrouped);
    }
  }

  // ---- Delad efterbearbetning: fotocred, bildrättighet, alt-text, formulär,
  //      forecast, bildautomation, slutstatus. Används av BÅDE createEvent()
  //      (kalenderlistan) och createEventFromUrl() (URL-fliken).
  async function finishEventCreation(ev, data, idx, apiKey) {
    // Språkmarkering för guidade turer & svenskspråkiga föreställningar.
    // Agenten rapporterar BARA om den kunde verifiera att eventet ges på
    // svenska (language_sv) — scriptet sköter den exakta, konsekventa
    // textformateringen deterministiskt i stället för att lita på att
    // agenten formulerar tillägget likadant varje gång.
    const isSwedishLang = String(data.language_sv || '').toLowerCase() === 'true';
    const isGuidedTour = data.main_category === 'Guided tours';
    const isPerformance = data.subcategory === 'Theater' || data.subcategory === 'Stand-up & Spoken Word';
    if (isSwedishLang && (isGuidedTour || isPerformance)) {
      if (data.title_en && !/\(in Swedish\)\s*$/i.test(data.title_en)) {
        data.title_en = data.title_en.trim() + ' (in Swedish)';
      }
      const note = isGuidedTour ? 'NOTE: The tour is given in Swedish.' : 'NOTE: The performance is given in Swedish.';
      if (data.description_en && !data.description_en.includes(note)) {
        data.description_en = data.description_en.trim() + ' ' + note;
      }
      vlog('Svenskspråkig ' + (isGuidedTour ? 'guidad tur' : 'föreställning') + ' — lade till engelsk språkmarkering.', 'ok');
    }

    // Om agenten inte gav press_image_url men vi redan har en bild, fyll i.
    if ((!data.press_image_url || !data.press_image_url.trim()) && ev.image && ev.image.url) {
      data.press_image_url = ev.image.url;
      vlog('press_image_url fylldes från befintlig bild.');
    }

    // Fotocred-fallback: photographer → "Pressbild [arrangör]" → "[titel]".
    if (!data.photographer || !data.photographer.trim()) {
      const who = (ev.promoter && ev.promoter.trim()) || (data.title_sv && data.title_sv.trim()) ||
                  (data.title_en && data.title_en.trim()) || (ev.title && ev.title.trim()) || '';
      data._credit_sv = who ? ('Pressbild ' + who) : 'Pressbild';
      data._credit_en = who ? ('Press image ' + who) : 'Press image';
      vlog('Fotocred saknas → fallback: "' + data._credit_sv + '".');
    } else {
      data._credit_sv = data.photographer;
      data._credit_en = data.photographer;
    }

    // Bildrättighetens utgångsdatum = eventets slutdatum + 2 månader (ÅÅÅÅ-MM-DD).
    const lastDate = (ev.dates && ev.dates.length) ? ev.dates[ev.dates.length - 1].date : (ev.end_date || ev.start_date);
    if (lastDate) {
      const d = new Date(lastDate + 'T00:00:00');
      d.setMonth(d.getMonth() + 2);
      data._rights_expiry = d.toISOString().split('T')[0];
      vlog('Bildrättighet utgår: ' + data._rights_expiry + ' (slutdatum + 2 mån).');
    }

    // Huvudagenten ser aldrig bilden (mistral-medium) — dess ev. alttext-gissning
    // nollas alltid, och vi hämtar istället en RIKTIG bildbeskrivning via pixtral.
    data.alttext_sv = ''; data.alttext_en = '';
    const imgForAlt = data.press_image_url || (ev.image && ev.image.url) || '';
    if (imgForAlt) {
      vlog('Hämtar alt-text från pixtral (separat synmodell)…');
      const alt = await fetchAltTextFromImage(imgForAlt, apiKey);
      if (alt) {
        data.alttext_sv = alt.alttext_sv || '';
        data.alttext_en = alt.alttext_en || '';
        vlog('Pixtral gav alt-text.', 'ok');
      } else {
        vlog('Pixtral gav ingen alt-text — använder platshållare.', 'err');
      }
    }

    // Bekräftat 2026-09-21: detta hoppade tyst över HELA formulärifyllningen
    // — även när agenten FAKTISKT gav ett fullt, användbart svar (28 fält,
    // riktig titel/beskrivning) — och loggade bara via setEventStatus (en
    // liten statusruta vid knappen), ALDRIG via vlog. Loggen såg alltså ut
    // att sluta i "Bildrättighet utgår: …" utan förklaring, medan fälten
    // förblev tomma. Fyller nu ändå i om det finns en riktig titel att gå
    // på (bättre en ifylld-men-flaggad draft att granska än en helt tom),
    // och avbryter bara om svaret verkligen saknar användbart innehåll.
    // Notisen syns ändå i slutstatusen nedan (warn-listan byggs av HELA
    // data.notes) och i vlog-raderna ovan (Kontroll/Rådata).
    if (data.notes && (data.notes.includes('could_not_fetch_url') || data.notes.includes('content_insufficient'))) {
      const why = data.notes.includes('could_not_fetch_url') ? 'kunde inte läsa sidan' : 'sidan saknade tillräckligt eventinnehåll';
      vlog('Mistral flaggade: ' + why + ' (notes="' + data.notes + '").', 'err');
      if (!data.title_sv && !data.title_en) {
        vlog('Ingen titel i svaret — fyller inte i formuläret.', 'err');
        setEventStatus(idx, 'Mistral ' + why + ' och gav ingen användbar data. Prova igen eller lägg in manuellt.', 'err');
        return;
      }
      vlog('Svaret innehöll ändå en titel — fyller i formuläret, men dubbelkolla extra noga (se flaggan i slutstatusen).', 'err');
    }

    // Fyll create-formuläret PÅ PLATS i denna flik.
    setEventStatus(idx, 'Fyller formuläret…', 'work');
    vlog('Börjar fylla formuläret…');
    await fillFieldsFromData(data);
    vlog('Formulärifyllning klar.', 'ok');

    // Forecast-fält om plats matchar en av de 10 lokalerna.
    let forecastNote = '';
    try {
      const fc = await fillForecastIfMatch(ev);
      if (fc) forecastNote = ' — OBS: granska forecast (' + fc.total + (fc.occCount > 1 ? ', ' + fc.occCount + ' tillfällen' : '') + ')';
    } catch (e) { vlog('Forecast-ifyllning fel: ' + e.message, 'err'); }

    // Bildautomation direkt efter formuläret (automatiskt).
    try { await automateImage(data); }
    catch (e) { vlog('Bildautomation gav fel (fortsätter): ' + e.message, 'err'); }

    // Markera som klar med klockslag (styr "utkast skapat"-läget på listknappar).
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    doneCreate.set(idx, hhmm);

    // dates_uncertain är en extra, mer känslig varning än de vanliga notes-koderna
    // — särskilt viktig här eftersom inget facit skriver över agentens datum.
    const uncertain = String(data.dates_uncertain || '').toLowerCase() === 'true';
    const warn = (data.notes || '').split(';').filter(Boolean);
    const uncertainNote = uncertain ? ' — ⚠️ OSÄKERT DATUM, kontrollera manuellt!' : '';
    setEventStatus(idx, 'Ifyllt — granska och spara som utkast.' + (warn.length ? ' (' + warn.join(', ') + ')' : '') + forecastNote + uncertainNote,
      (uncertain || forecastNote) ? (uncertain ? 'err' : 'warn') : 'ok');
  }

  // Räknar ut ev.dates (för forecast-multiplikatorn och bildrättighetens
  // utgångsdatum) från en occurrences-sträng "YYYY-MM-DD;HH:MM;...|...".
  function datesFromOccurrences(occStr) {
    if (!occStr || occStr === 'MANUAL_DATES_REQUIRED') return [];
    return occStr.split('|').map(s => s.trim()).filter(Boolean).map(occ => {
      const [date] = occ.split(';').map(v => v.trim().replace(/^"|"$/g, ''));
      return { date };
    }).filter(d => d.date);
  }

  // ---- URL-fliken: en enskild event-URL, agenten gör HELA jobbet själv ------
  // ---- URL-fliken: scriptet hämtar sidans text SJÄLVT (samma lösning som
  // löste hallucinationerna i EditorBot) — i stället för att skicka en bar
  // URL och lita på att agenten browsar korrekt, vilket visade sig ge
  // fabricerade adresser/venues (t.ex. Andetag- och Nordic Tech Week-fallen).
  function fetchRawPage(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 20000,
        onload: r => {
          if (r.status < 200 || r.status >= 300) return reject(new Error('Sidhämtning: HTTP ' + r.status));
          try {
            const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
            const links = [...doc.querySelectorAll('a[href], iframe[src]')]
              .map(el => el.getAttribute('href') || el.getAttribute('src'))
              .filter(h => h && /^https?:/i.test(h))
              .filter((h, i, arr) => arr.indexOf(h) === i)
              .slice(0, 80);
            doc.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
            let text = (doc.body && doc.body.textContent) || '';
            text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
            resolve({ text, links });
          } catch (e) { reject(new Error('Sidtolkning misslyckades: ' + e.message)); }
        },
        onerror: () => reject(new Error('Sidhämtning: nätverksfel')),
        ontimeout: () => reject(new Error('Sidhämtning: timeout'))
      });
    });
  }

  const EVENT_SUBPAGE_PATTERN = /kontakt|contact|om[-_]?oss|about|hitta[-_]?hit|find[-_]?us|visit[-_]?us|biljett|ticket|program|schedule|datum|dates|venue|plats|location/i;

  async function fetchEventPageText(mainUrl) {
    const main = await fetchRawPage(mainUrl);
    let mainText = main.text;
    if (mainText.length > 18000) mainText = mainText.slice(0, 18000) + '\n[...avkortat...]';
    let combined = '=== HUVUDSIDA: ' + mainUrl + ' ===\n' + mainText;

    let mainHost = '';
    try { mainHost = new URL(mainUrl).hostname; } catch {}
    const subCandidates = main.links.filter(link => {
      try {
        const u = new URL(link);
        return u.hostname === mainHost && u.href !== mainUrl && EVENT_SUBPAGE_PATTERN.test(u.pathname);
      } catch { return false; }
    }).filter((h, i, arr) => arr.indexOf(h) === i).slice(0, 2);

    if (subCandidates.length) {
      vlog('Hittade ' + subCandidates.length + ' trolig(a) undersida(or): ' + subCandidates.join(', '));
      for (const subUrl of subCandidates) {
        try {
          const sub = await fetchRawPage(subUrl);
          let subText = sub.text;
          if (subText.length > 8000) subText = subText.slice(0, 8000) + '\n[...avkortat...]';
          combined += '\n\n=== UNDERSIDA: ' + subUrl + ' ===\n' + subText;
          vlog('Hämtade undersida: ' + subUrl + ' (' + subText.length + ' tecken).', 'ok');
        } catch (e) {
          vlog('Kunde inte hämta undersida ' + subUrl + ': ' + e.message + ' (fortsätter utan den).', 'err');
        }
      }
    }
    if (main.links.length) {
      combined += '\n\n[ALLA LÄNKAR PÅ HUVUDSIDAN — kan innehålla postnummer/adress i t.ex. kart-URL:er]\n' + main.links.join('\n');
    }
    return combined;
  }

  async function createEventFromUrl(url) {
    // SBR-läget använder EGEN Mistral-nyckel/agent, separat från Visit Stockholm-
    // flödet — annars skulle en ny SBR-anpassad agent krocka med huvudagenten.
    const sbrMode = location.hostname === 'www.stockholmbusinessregion.se';
    const apiKey = GM_getValue(sbrMode ? 'sbr_mistral_key' : 'mistral_key', '').trim();
    const agentId = GM_getValue(sbrMode ? 'sbr_mistral_agent' : 'mistral_agent', '').trim();
    if (!apiKey || !agentId) {
      setEventStatus('url', sbrMode
        ? 'Fyll i SBR:s Mistral API-nyckel och agent-ID (fliken Inställningar) först.'
        : 'Fyll i Mistral API-nyckel och agent-ID (fliken Inställningar) först.', 'err');
      switchTab(sbrMode ? 'sbr-set' : 'set');
      return;
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      setEventStatus('url', 'Klistra in en giltig URL (måste börja med http:// eller https://).', 'err');
      return;
    }

    busyCreate.add('url');
    activeEventIdx = 'url';
    setEventStatus('url', 'Hämtar sidans innehåll…', 'work');
    render(lastGrouped);
    vlog('createEventFromUrl: ' + url);
    vlog('Mistral-nyckel: ' + (apiKey ? 'satt (' + apiKey.length + ' tecken)' : 'SAKNAS') + ', agent: ' + (agentId || 'SAKNAS'));

    // Minimalt ev-objekt — förhämtad text (inte agentens egen browsing) är källan.
    const ev = { title: '(URL-import)', external_website_url: url, venue_name: '', address: '',
                 city: 'Stockholm', promoter: '', image: null, dates: [] };

    let pageText = '';
    try {
      pageText = await fetchEventPageText(url);
      vlog('Sidtext hämtad av scriptet: ' + pageText.length + ' tecken.', 'ok');
    } catch (e) {
      vlog('Kunde inte hämta sidans text själv (' + e.message + ') — agenten får försöka läsa URL:en direkt istället (mindre pålitligt).', 'err');
    }

    const agentInput = pageText
      ? ('FÖRHÄMTAD SIDTEXT (hämtad av scriptet — detta ÄR sidans innehåll, använd ENDAST detta, ' +
         'försök INTE browsa/söka vidare för fakta-fält):\n\n---\n' + pageText + '\n---\n\n' +
         'KÄLL-URL (för external_website_url-fältet, exakt denna): ' + url + '\n\n' +
         'Analysera texten ovan enligt din systemprompt (KÄLLREGLER, STADSREGEL, FÄLTREGLER, TILLFÄLLEN). ' +
         'Detta är INTE Ticketmaster — ingen strukturerad eventdata medföljer separat, all information ' +
         'måste utläsas ur texten ovan, inklusive occurrences (var extra noggrann — inget facit skriver ' +
         'över dina datum här, så sätt dates_uncertain="true" om du är minsta osäker).\n\n' +
         'Returnera ENBART JSON-objektet enligt ditt schema.')
      : ('EVENT-URL: ' + url + '\n\n' +
         'Scriptet kunde inte hämta sidans text i förväg — du måste läsa URL:en själv. ' +
         'Var EXTRA försiktig: fyll bara i fält du med säkerhet kan verifiera från din egen läsning, ' +
         'och sätt dates_uncertain="true" vid minsta osäkerhet.\n\n' +
         'Returnera ENBART JSON-objektet enligt ditt schema.');

    setEventStatus('url', 'Skapar via Mistral…', 'work');

    try {
      const postOnce = () => {
        let waited = 0;
        const ticker = setInterval(() => {
          waited += 10;
          setEventStatus('url', `Väntar på Mistral… ${waited}s`, 'work');
        }, 10000);
        return gmPost(MISTRAL_CONV,
          { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          { agent_id: agentId, inputs: agentInput, store: false })
          .finally(() => clearInterval(ticker));
      };

      let resp;
      vlog('Skickar POST till Mistral (URL-läge)…');
      try {
        resp = await postOnce();
      } catch (e1) {
        if (/timeout|nätverksfel|50[234]/i.test(e1.message)) {
          vlog('Försök 1 misslyckades: ' + e1.message + '. Försöker igen…', 'err');
          resp = await postOnce();
          vlog('Försök 2 lyckades.', 'ok');
        } else throw e1;
      }
      vlog('Mistral svarade. Nycklar i svar: ' + Object.keys(resp || {}).join(', '));

      const text = extractAgentText(resp);
      vlog('Extraherad text: ' + (text ? text.length + ' tecken' : 'TOM'));
      const data = extractJSON(text);
      if (!data) {
        vlog('JSON-tolkning MISSLYCKADES.', 'err');
        try { vlog('resp (JSON): ' + JSON.stringify(resp).slice(0, 6000)); } catch {}
        throw new Error('Kunde inte tolka agentens svar som JSON. Se loggrutan (📋) för råsvaret.');
      }
      vlog('JSON tolkad OK. Fält (' + Object.keys(data).length + '): ' + Object.keys(data).join(', '), 'ok');
      vlog('Kontroll: title_sv="' + (data.title_sv || '(tom)') + '", dates_uncertain="' + (data.dates_uncertain || '(ej satt)') + '", notes="' + (data.notes || '(inga)') + '"');
      // Rådata alltid i loggen (på begäran 2026-09-21) — inte bara fältnamnen
      // ovan — så ett tyst hopp-över (t.ex. notes-kollen i finishEventCreation)
      // går att felsöka utan att gissa vad agenten faktiskt svarade.
      try { vlog('Rådata (JSON): ' + JSON.stringify(data).slice(0, 6000)); } catch {}
      lastUrlAgentData = data;   // sparas för "Kopiera senaste URL-svar"-knappen
      checkSbrManualDuplicate(data);   // no-op utanför SBR-läget (tom lista om aldrig laddad)

      // Ingen auktoritativ källa att skriva över med — härled ev.dates ur
      // agentens EGNA occurrences (för forecast-multiplikator + bildrättighet).
      ev.dates = datesFromOccurrences(data.occurrences);
      ev.title = data.title_sv || data.title_en || ev.title;

      await finishEventCreation(ev, data, 'url', apiKey);
    } catch (e) {
      setEventStatus('url', e.message, 'err');
    } finally {
      busyCreate.delete('url');
      if (activeEventIdx === 'url') activeEventIdx = null;
      render(lastGrouped);
    }
  }

  // ---- UI (dark) -----------------------------------------------------------
  const PANEL_CSS = `
    :root {
      --vd-bg:#1e222b; --vd-bg2:#262b36; --vd-bg3:#2f3542; --vd-line:#3a3f4b;
      --vd-txt:#e8eaee; --vd-txt2:#a8adb8; --vd-txt3:#787e8a; --vd-accent:#4a9fe0;
    }
    #vseh-panel { position:fixed; z-index:999999; background:var(--vd-bg); border:1px solid var(--vd-line);
      border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,.5);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--vd-txt);
      display:flex; flex-direction:column; overflow:hidden; }
    /* Minimerat läge kollapsar till en smal, vertikal flik mot höger
       fönsterkant (istället för en kort/bred remsa nertill) — på begäran
       2026-09-19. Rubriktexten får inte plats i 46px bredd och döljs;
       knapparna staplas vertikalt istället för i rad. */
    #vseh-panel.min { top:50%; right:0; bottom:auto; width:46px; max-height:80vh;
      transform:translateY(-50%); border-radius:10px 0 0 10px; }
    #vseh-panel.min #vseh-head { flex-direction:column; padding:12px 6px; }
    #vseh-panel.min #vseh-head .t { display:none; }
    #vseh-panel.min #vseh-headbtns { flex-direction:column; }
    #vseh-panel.min #vseh-headbtns .vseh-btn-gap { width:auto; height:10px; }
    /* Minimera-knappens ikon roterad 90° i minimerat läge — visar att
       panelen nu kollapsar åt sidan istället för nedåt. */
    #vseh-panel.min #vseh-headbtns button[data-m="min"] { transform:rotate(90deg); }
    #vseh-panel.max { top:18px; bottom:18px; right:18px; width:440px; }
    #vseh-panel * { box-sizing:border-box; }
    #vseh-head { padding:11px 14px; background:var(--vd-bg3); color:var(--vd-txt); display:flex; align-items:center; justify-content:space-between; gap:8px; flex-shrink:0; border-bottom:1px solid var(--vd-line); }
    #vseh-head .t { font-size:17px; font-weight:700; letter-spacing:-.01em; }
    #vseh-head .v { font-size:9px; font-weight:400; color:#1a3a6b; margin-left:6px; letter-spacing:0; }
    #vseh-headbtns { display:flex; gap:3px; align-items:center; }
    #vseh-headbtns .vseh-btn-gap { width:14px; display:inline-block; }
    #vseh-headbtns button { background:rgba(255,255,255,.08); border:none; color:var(--vd-txt); cursor:pointer; width:26px; height:24px; border-radius:6px; font-size:12px; line-height:1; display:flex; align-items:center; justify-content:center; }
    #vseh-headbtns button:hover { background:rgba(255,255,255,.18); }
    #vseh-headbtns button.on { background:var(--vd-accent); color:#0d1520; }
    /* Flikar */
    #vseh-tabs { display:flex; gap:2px; padding:0 8px; background:var(--vd-bg3); border-bottom:1px solid var(--vd-line); flex-shrink:0; }
    #vseh-panel.min #vseh-tabs { display:none; }
    .vseh-tab { background:transparent; border:none; color:var(--vd-txt2); font-family:inherit; font-size:11.5px; font-weight:600; padding:9px 11px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; white-space:nowrap; }
    .vseh-tab:hover { color:var(--vd-txt); }
    .vseh-tab.active { color:var(--vd-accent); border-bottom-color:var(--vd-accent); }
    #vseh-dup-count { font-weight:700; }
    .vseh-tabpane { display:none; }
    .vseh-tabpane.active { display:block; }
    /* Hämtningsknappar */
    .vseh-fetch-h { font-size:11px; font-weight:600; color:var(--vd-txt2); text-transform:uppercase; letter-spacing:.04em; margin-bottom:7px; }
    .vseh-fetch-divider { border-bottom:1px solid var(--vd-line); margin:2px 0 10px; }
    .vseh-url-warn { font-size:11px; font-weight:600; color:#ffcf6b; background:#332a17; border:1px solid #6a5620; border-radius:7px; padding:8px 10px; margin-top:9px; line-height:1.5; }
    #vseh-url-create { width:100%; background:var(--vd-accent); color:#0d1520; border:none; border-radius:7px; padding:10px; font-size:13px; font-weight:650; cursor:pointer; }
    #vseh-url-create:hover:not(:disabled) { filter:brightness(1.1); }
    #vseh-url-create:disabled { background:var(--vd-line); color:var(--vd-txt3); cursor:not-allowed; }
    #vseh-url-copyjson { width:100%; background:var(--vd-bg2); border:1px solid var(--vd-line); color:var(--vd-txt); border-radius:7px; padding:8px; font-size:12px; font-weight:600; cursor:pointer; }
    #vseh-url-copyjson:hover { background:var(--vd-bg3); }
    .vseh-fetch-line { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
    .vseh-fetch-line button { flex:0 0 130px; background:var(--vd-accent); color:#0d1520; border:none; border-radius:7px; padding:9px; font-size:12.5px; font-weight:650; cursor:pointer; }
    .vseh-fetch-line button:hover:not(:disabled) { filter:brightness(1.1); }
    .vseh-fetch-line button:disabled { background:var(--vd-line); color:var(--vd-txt3); cursor:not-allowed; }
    .vseh-fetch-ts { font-size:10.5px; color:var(--vd-txt3); font-family:monospace; }
    .vseh-prog { position:relative; height:16px; background:var(--vd-bg3); border-radius:8px; overflow:hidden; margin:0 0 9px; }
    .vseh-prog-bar { position:absolute; left:0; top:0; bottom:0; width:0%; background:var(--vd-accent); transition:width .2s ease; }
    .vseh-prog-txt { position:absolute; left:0; right:0; top:0; bottom:0; display:flex; align-items:center; justify-content:center; font-size:9.5px; font-weight:600; color:var(--vd-txt); }
    .vseh-hint { font-size:10.5px; color:var(--vd-txt3); margin-bottom:9px; }
    #vseh-scroll { overflow-y:auto; padding:14px 15px; flex:1; }
    #vseh-panel.min #vseh-scroll { display:none; }

    .vseh-row { margin-bottom:10px; }
    .vseh-row label { display:block; font-size:11px; font-weight:600; color:var(--vd-txt2); margin-bottom:4px; }
    .vseh-row input, .vseh-row select { width:100%; font-size:13px; padding:8px 10px; border:1px solid var(--vd-line); border-radius:7px; font-family:inherit; background:var(--vd-bg); color:var(--vd-txt); }
    .vseh-row input:focus, .vseh-row select:focus { outline:2px solid var(--vd-accent); outline-offset:-1px; }
    .vseh-key { font-family:monospace; font-size:12px !important; }
    .vseh-two { display:flex; gap:9px; } .vseh-two > div { flex:1; }

    #vseh-dedup-row { display:flex; align-items:center; gap:8px; margin:10px 0 2px; flex-wrap:wrap; }
    #vseh-dedup-btn { font-size:11.5px; font-weight:600; padding:7px 11px; border:1px solid var(--vd-line); background:var(--vd-bg2); color:var(--vd-accent); border-radius:7px; cursor:pointer; white-space:nowrap; }
    #vseh-dedup-btn:hover:not(:disabled) { background:var(--vd-bg3); } #vseh-dedup-btn:disabled { color:var(--vd-txt3); cursor:not-allowed; }
    #vseh-clean-btn { font-size:11.5px; font-weight:600; padding:7px 11px; border:1px solid var(--vd-line); background:var(--vd-bg2); color:#e0b060; border-radius:7px; cursor:pointer; white-space:nowrap; }
    #vseh-clean-btn:hover:not(:disabled) { background:var(--vd-bg3); } #vseh-clean-btn:disabled { color:var(--vd-txt3); cursor:not-allowed; }
    #vseh-dedup-state { font-size:11px; color:var(--vd-txt3); font-family:monospace; }
    #vseh-status { font-family:monospace; font-size:11.5px; color:var(--vd-txt2); margin:11px 0 4px; min-height:16px; }
    #vseh-status.err { color:#ff8080; } #vseh-status.ok { color:#7ddca0; } #vseh-status.work { color:#e0b060; }
    #vseh-stats { display:flex; gap:8px; margin:10px 0 10px; flex-wrap:wrap; }
    #vseh-stats .s { flex:1; min-width:64px; background:var(--vd-bg2); border:1.5px solid transparent; border-radius:8px; padding:9px 4px; text-align:center; cursor:pointer; transition:border-color .12s, background .12s; }
    #vseh-stats .s:hover { background:var(--vd-bg3); }
    #vseh-stats .s.active { border-color:var(--vd-accent); background:var(--vd-bg3); }
    #vseh-stats .s .n { font-size:18px; font-weight:700; } #vseh-stats .s .l { font-size:9px; text-transform:uppercase; letter-spacing:.04em; color:var(--vd-txt3); margin-top:2px; line-height:1.4; white-space:normal; }
    #vseh-srcfilter { display:flex; gap:5px; flex-wrap:wrap; margin:0 0 10px; }
    #vseh-srcfilter button { font-size:10.5px; font-weight:700; padding:3px 10px; border-radius:20px; border:1.5px solid transparent; background:var(--vd-bg2); color:var(--vd-txt2); cursor:pointer; }
    #vseh-srcfilter button.active { border-color:var(--vd-txt); color:var(--vd-txt); }
    #vseh-actions { display:flex; gap:8px; margin:6px 0 12px; }
    #vseh-actions button { flex:1; font-size:12px; font-weight:500; padding:8px; border:1px solid var(--vd-line); background:var(--vd-bg2); color:var(--vd-accent); border-radius:7px; cursor:pointer; }
    #vseh-actions button:hover:not(:disabled) { background:var(--vd-bg3); } #vseh-actions button:disabled { color:var(--vd-txt3); cursor:not-allowed; }
    #vseh-monthfilter, #sbr-crm-monthfilter { margin-top:8px; }
    #vseh-monthfilter select, #sbr-crm-monthfilter select {
      font-size:11px; font-weight:600; padding:4px 8px; border:1px solid var(--vd-line);
      background:var(--vd-bg2); color:var(--vd-txt); border-radius:6px; cursor:pointer;
    }
    #vseh-filters { display:flex; gap:5px; margin-bottom:9px; flex-wrap:wrap; }
    #vseh-filters button { font-size:10.5px; font-weight:600; padding:4px 10px; border:1px solid var(--vd-line); background:var(--vd-bg2); border-radius:20px; cursor:pointer; }
    #vseh-filters button[data-f="out"] { color:#ff8080; }
    #vseh-filters button[data-f="partial"] { color:#e0b060; }
    #vseh-filters button[data-f="in"] { color:#7ddca0; }
    #vseh-filters button[data-f="cancelled"] { color:#ff8080; }
    #vseh-filters button.active { background:var(--vd-txt); color:var(--vd-bg) !important; border-color:var(--vd-txt); }
    .vseh-ev { border:1px solid var(--vd-line); border-left-width:4px; border-radius:9px; padding:10px 11px; margin-bottom:8px; background:var(--vd-bg2); }
    .vseh-ev h4 { margin:0 0 3px; font-size:13.5px; font-weight:640; display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
    .vseh-badge { font-size:10px; font-weight:700; padding:2px 8px; border-radius:5px; white-space:nowrap; flex-shrink:0; }
    .vseh-badge.expandable { cursor:pointer; } .vseh-badge.expandable::after { content:' ⌄'; }
    .vseh-ev .m { font-size:11.5px; color:var(--vd-txt2); } .vseh-ev .v { font-weight:600; color:var(--vd-txt); }
    .vseh-ev .dates { font-size:11px; color:var(--vd-txt2); margin-top:5px; } .vseh-ev .dates b { color:var(--vd-txt); font-weight:600; }
    .vseh-ev .detail { font-size:10.5px; color:#e0b060; margin-top:3px; font-style:italic; }
    .vseh-cancel { font-size:10.5px; font-weight:700; color:#ff8080; margin-top:5px; background:#3a1f1f; border:1px solid #6a2a2a; border-radius:5px; padding:4px 7px; }
    .vseh-ev-status { font-size:11px; font-weight:600; margin-top:7px; padding:6px 9px; border-radius:6px; font-family:monospace; }
    .vseh-ev-status.work { color:#e0b060; background:#2a2620; border:1px solid #4a4230; }
    .vseh-ev-status.ok { color:#7ddca0; background:#1f2f26; border:1px solid #2f5a42; }
    .vseh-ev-status.err { color:#ff8080; background:#3a1f1f; border:1px solid #6a2a2a; }
    .vseh-ev-status.warn { color:#ffcf6b; background:#332a17; border:1px solid #6a5620; }
    .vseh-ev .tags { margin-top:7px; display:flex; gap:5px; flex-wrap:wrap; align-items:center; }
    .vseh-org { font-size:10px; font-weight:500; padding:1px 8px; border-radius:12px; color:var(--vd-txt2); background:var(--vd-bg3); border:1px solid var(--vd-line); }
    .vseh-cat { font-size:11px; font-weight:700; padding:2px 9px; border-radius:12px; color:#0d1520; }
    .vseh-src { font-size:11px; font-weight:700; padding:2px 9px; border-radius:12px; color:#0d1520; }
    .vseh-create { margin-top:8px; }
    .vseh-create button { display:inline-block; width:auto; font-size:11.5px; font-weight:650; padding:6px 12px; border:1px solid var(--vd-accent); background:transparent; color:var(--vd-accent); border-radius:7px; cursor:pointer; }
    .vseh-create button:hover:not(:disabled) { background:var(--vd-accent); color:#0d1520; }
    .vseh-create button.busy { opacity:.7; cursor:progress; }
    .vseh-create button.done { border-color:#2f9a63; color:#7ddca0; cursor:default; opacity:1; }
    .vseh-manin { display:inline-block; width:auto; margin-left:6px; font-size:11px; font-weight:600; padding:6px 11px; border:1px solid var(--vd-line); background:transparent; color:var(--vd-txt2); border-radius:7px; cursor:pointer; }
    .vseh-manin:hover { border-color:#7ddca0; color:#7ddca0; }
    .vseh-manin.on { border-color:#2f9a63; color:#7ddca0; }
    .vseh-empty { text-align:center; color:var(--vd-txt3); font-size:12.5px; padding:26px 10px; }
    .vseh-compare { margin-top:9px; border-top:1px dashed var(--vd-line); padding-top:9px; }
    .vseh-cmp-grid { display:flex; gap:10px; } .vseh-cmp-col { flex:1; min-width:0; }
    .vseh-cmp-col h5 { margin:0 0 5px; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--vd-txt3); }
    /* Enhetlig item-struktur för BÅDA kolumnerna (design 1) */
    .vseh-item { background:var(--vd-bg); border:1px solid var(--vd-line); border-radius:7px; padding:8px 9px; margin-bottom:6px; font-size:11.5px; line-height:1.5; }
    .vseh-item-title { font-weight:640; color:var(--vd-txt); margin-bottom:3px; }
    .vseh-item-row { color:var(--vd-txt2); }
    .vseh-item-row .lab { color:var(--vd-txt3); display:inline-block; min-width:42px; }
    .vseh-item-btns { display:flex; gap:5px; margin-bottom:6px; }
    .vseh-edit { font-size:10.5px; font-weight:600; color:var(--vd-accent); text-decoration:none; white-space:nowrap; border:1px solid var(--vd-line); padding:2px 9px; border-radius:5px; }
    .vseh-edit:hover { background:var(--vd-bg3); }
    .vseh-dismiss { font-size:10.5px; font-weight:600; color:#7ddca0; white-space:nowrap; border:1px solid #2f9a63; padding:2px 9px; border-radius:5px; background:transparent; cursor:pointer; }
    .vseh-dismiss:hover { background:#1f3a2a; }
    .vseh-nomatch { font-size:11px; color:var(--vd-txt3); font-style:italic; }
    /* Datumpresentation (design 2) */
    .dp-span { color:#e0a052; font-weight:600; }
    .dp-one { color:var(--vd-txt); font-weight:600; }
    .dp-multi { color:var(--vd-accent); font-weight:600; cursor:pointer; user-select:none; }
    .dp-arrow { font-size:9px; }
    .dp-dates { margin-top:4px; color:var(--vd-txt2); font-size:11px; line-height:1.6; }
    #vseh-logwrap { position:fixed; bottom:18px; left:18px; width:440px; max-height:50vh; z-index:1000001;
      background:var(--vd-bg); border:1px solid var(--vd-accent); border-radius:10px; box-shadow:0 10px 40px rgba(0,0,0,.6);
      display:flex; flex-direction:column; overflow:hidden; }
    .vseh-loghdr { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--vd-txt2); padding:8px 11px;
      background:var(--vd-bg3); border-bottom:1px solid var(--vd-line); display:flex; justify-content:space-between; align-items:center; }
    .vseh-loghdr button { background:rgba(255,255,255,.08); border:none; color:var(--vd-txt); height:20px; border-radius:5px; cursor:pointer; font-size:11px; padding:0 6px; }
    #vseh-logcopy { width:auto; font-weight:600; }
    #vseh-logclose { width:20px; }
    #vseh-log { background:#0d1117; padding:9px 11px; overflow-y:auto; font-family:monospace; font-size:10.5px; line-height:1.55; flex:1; }
    .vseh-logline { color:#a8adb8; white-space:pre-wrap; word-break:break-word; }
    .vseh-logline.ok { color:#7ddca0; } .vseh-logline.err { color:#ff8080; }
    #vseh-cleanwrap { position:fixed; top:5vh; left:50%; transform:translateX(-50%); width:min(680px,92vw); max-height:88vh; z-index:1000002;
      background:var(--vd-bg); border:1px solid #e0b060; border-radius:12px; box-shadow:0 14px 50px rgba(0,0,0,.65);
      display:flex; flex-direction:column; overflow:hidden; }
    .vseh-cleanhdr { padding:12px 15px; background:var(--vd-bg3); border-bottom:1px solid var(--vd-line); font-size:13px; font-weight:650;
      display:flex; justify-content:space-between; align-items:center; color:var(--vd-txt); }
    .vseh-cleanhdr button { background:rgba(255,255,255,.08); border:none; color:var(--vd-txt); width:22px; height:22px; border-radius:5px; cursor:pointer; }
    #vseh-cleanfilter { margin-bottom:8px; display:flex; gap:9px; align-items:center; flex-wrap:wrap; font-size:11.5px; color:var(--vd-txt2); }
    #vseh-cleanfilter label { display:flex; gap:5px; align-items:center; }
    #vseh-cleanfilter input[type=date] { background:var(--vd-bg); color:var(--vd-txt); border:1px solid var(--vd-line); border-radius:6px; padding:4px 7px; font-family:inherit; font-size:11.5px; }
    #vseh-clean-run { background:var(--vd-accent); color:#0d1520; border:none; border-radius:6px; padding:5px 12px; font-size:11.5px; font-weight:650; cursor:pointer; }
    #vseh-diagfilter { display:flex; gap:7px; margin:8px 0 12px; flex-wrap:wrap; }
    #vseh-diagfilter input { flex:1; min-width:160px; }
    #vseh-diag-export { background:var(--vd-bg2); border:1px solid var(--vd-line); color:var(--vd-txt); border-radius:6px; padding:5px 12px; font-size:11.5px; font-weight:650; cursor:pointer; white-space:nowrap; }
    #vseh-diag-export:hover { background:var(--vd-bg3); }
    #vseh-diag-run { background:var(--vd-bg2); border:1px solid var(--vd-line); color:var(--vd-txt); border-radius:6px; padding:5px 12px; font-size:11.5px; font-weight:650; cursor:pointer; white-space:nowrap; }
    #vseh-diag-run:hover { background:var(--vd-bg3); }
    #vseh-diag-result { background:var(--vd-bg2); border:1px solid var(--vd-line); border-radius:8px; padding:10px 12px; margin-bottom:14px; font-size:11.5px; font-family:monospace; line-height:1.6; }
    .vseh-diag-hdr { font-weight:700; color:var(--vd-txt); margin:8px 0 4px; }
    .vseh-diag-hdr:first-child { margin-top:0; }
    .vseh-diag-row { padding:5px 7px; border-radius:5px; margin-bottom:3px; background:var(--vd-bg); }
    .vseh-diag-row.ok { color:#7ddca0; } .vseh-diag-row.err { color:#ff8080; } .vseh-diag-row.warn { color:#ffcf6b; }
    .vseh-diag-err { color:#ff8080; font-weight:600; }
    #vseh-clean-hint { color:var(--vd-txt3); font-size:10.5px; }
    #vseh-cleanbody { padding:13px 15px; overflow-y:auto; }
    .vseh-dup-group { border:1px solid #e0b060; border-radius:9px; padding:11px; margin-bottom:12px; background:var(--vd-bg2); }
    .vseh-dup-ghdr { font-size:11px; font-weight:650; color:#e0b060; margin-bottom:8px; }
    .vseh-dup-cols { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start; }
    .vseh-dup-cols .vseh-dup-col { flex:1 1 180px; }
    .vseh-dup { border:1px solid var(--vd-line); border-radius:9px; padding:11px; margin-bottom:10px; background:var(--vd-bg2); }
    .vseh-dup-sim { font-size:10px; font-family:monospace; color:var(--vd-txt3); margin-bottom:7px; text-transform:uppercase; letter-spacing:.04em; }
    .vseh-dup-grid { display:flex; gap:10px; }
    .vseh-dup-col { flex:1; min-width:0; background:var(--vd-bg); border:1px solid var(--vd-line); border-radius:7px; padding:9px 10px; font-size:11.5px; line-height:1.5; }
    .vseh-dup-col .val { font-weight:600; color:var(--vd-txt); }
    .vseh-dup-col .lab { color:var(--vd-txt3); }
    .vseh-dup-col a { font-size:10.5px; font-weight:600; color:var(--vd-accent); text-decoration:none; border:1px solid var(--vd-line); padding:2px 8px; border-radius:5px; display:inline-block; margin-top:5px; }
    .vseh-dup-col a:hover { background:var(--vd-bg3); }
    .vseh-clean-empty { text-align:center; color:var(--vd-txt3); font-size:12.5px; padding:30px 10px; }
    .vseh-dup-ghdr { display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .vseh-notdup { font-size:10.5px; font-weight:650; color:#7ddca0; background:transparent; border:1px solid var(--vd-line); padding:3px 10px; border-radius:6px; cursor:pointer; white-space:nowrap; }
    .vseh-notdup:hover { background:#1f3a2a; border-color:#7ddca0; }
    .vseh-restore { font-size:10.5px; font-weight:650; color:var(--vd-accent); background:transparent; border:1px solid var(--vd-line); padding:3px 10px; border-radius:6px; cursor:pointer; white-space:nowrap; }
    .vseh-restore:hover { background:var(--vd-bg3); }
    .vseh-cleared-banner { font-size:11.5px; color:var(--vd-txt2); background:var(--vd-bg2); border:1px solid var(--vd-line); border-radius:7px; padding:8px 11px; margin-bottom:11px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .vseh-cleared-banner button { font-size:11px; font-weight:600; color:var(--vd-accent); background:transparent; border:1px solid var(--vd-line); padding:4px 11px; border-radius:6px; cursor:pointer; }
    .vseh-cleared-banner button:hover { background:var(--vd-bg3); }
    .sbr-src-row { display:grid; grid-template-columns:1fr auto 1fr auto; gap:8px; align-items:center;
      padding:8px 0; border-bottom:1px solid var(--vd-line); }
    .sbr-src-name { display:flex; align-items:center; gap:6px; min-width:0; }
    .sbr-src-name a { color:var(--vd-txt); font-weight:600; font-size:12.5px; text-decoration:none;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sbr-src-name a:hover { color:var(--vd-accent); text-decoration:underline; }
    .sbr-src-edit, .sbr-src-del { background:transparent; border:1px solid var(--vd-line); color:var(--vd-txt3);
      border-radius:5px; padding:2px 7px; font-size:11px; cursor:pointer; flex-shrink:0; }
    .sbr-src-edit:hover { color:var(--vd-accent); border-color:var(--vd-accent); }
    .sbr-src-del:hover { color:#ff8080; border-color:#ff8080; }
    .sbr-edit-name, .sbr-edit-url { background:var(--vd-bg2); border:1px solid var(--vd-line); color:var(--vd-txt);
      border-radius:5px; padding:4px 6px; font-size:11.5px; width:100%; }
    .sbr-edit-save { background:transparent; border:none; cursor:pointer; font-size:14px; flex-shrink:0; }
    .sbr-upd-btn { font-size:10.5px; font-weight:650; padding:5px 10px; border-radius:6px; border:none;
      cursor:pointer; white-space:nowrap; color:#0d1520; }
    .sbr-upd-green  { background:#5ad1a8; }
    .sbr-upd-yellow { background:#e0b060; }
    .sbr-upd-red    { background:#e07a7a; }
    .sbr-upd-never  { background:var(--vd-line); color:var(--vd-txt2); }
    .sbr-src-comment { background:var(--vd-bg2); border:1px solid var(--vd-line); color:var(--vd-txt);
      border-radius:5px; padding:5px 8px; font-size:11.5px; width:100%; }
    .sbr-cal-row { display:grid; grid-template-columns:1fr auto auto; gap:10px; align-items:start;
      padding:7px 0; border-bottom:1px solid var(--vd-line); font-size:11.5px; }
    .sbr-cal-hdr { font-weight:700; color:var(--vd-txt3); text-transform:uppercase; font-size:9.5px;
      letter-spacing:.04em; border-bottom:1px solid var(--vd-line); }
    .sbr-cal-sv { color:var(--vd-txt2); font-size:11px; }
  `;
  function injectStyle() { const s = document.createElement('style'); s.textContent = PANEL_CSS; document.head.appendChild(s); }

  // ---- SBR-läge (stockholmbusinessregion.se): endast URL- och Källor-flikar.
  // URL-fliken återanvänder EXAKT samma HTML/id:n och logik (createEventFromUrl)
  // som huvudpanelen — fältifyllningen matchar redan flera av SBR-formulärets
  // fält (samma Wagtail-namnkonvention), men känner ännu inte till de nya
  // fälten (language, main_subject, subjects, organizer_*, event_type m.fl.).
    function buildSbrPanel() {
    injectStyle();
    const p = document.createElement('div');
    p.id = 'vseh-panel';
    p.className = mode;
    p.innerHTML = `
      <div id="vseh-head">
        <div class="t">Eventbot SBR.se<span class="v">v${SCRIPT_VERSION}</span></div>
        <div id="vseh-headbtns">
          <button type="button" data-m="min" title="Minimera">▁</button>
          <button type="button" data-m="max" title="Maximera">▢</button>
          <span class="vseh-btn-gap"></span>
          <button type="button" id="vseh-logbtn" title="Visa logg">📋</button>
        </div>
      </div>
      <div id="vseh-tabs">
        <button type="button" class="vseh-tab active" data-tab="url">🔗 URL</button>
        <button type="button" class="vseh-tab" data-tab="sbr-crm">📥 CRM-import</button>
        <button type="button" class="vseh-tab" data-tab="sbr-src">📇 Källor</button>
        <button type="button" class="vseh-tab" data-tab="sbr-cal">📅 Eventlista <span id="sbr-cal-count"></span></button>
        <button type="button" class="vseh-tab" data-tab="sbr-set">⚙️</button>
      </div>
      <div id="vseh-scroll"><div id="vseh-inner">

        <div class="vseh-tabpane active" data-pane="url">
          <div class="vseh-fetch-h">Skapa utkast från en enskild event-URL</div>
          <div class="vseh-hint">Agenten läser sidan helt själv. OBS: fältifyllningen är byggd för
            Visit Stockholm-formuläret — delar av SBR:s formulär (språk, subjects, event type,
            arrangörsfält) fylls INTE i ännu och behöver kompletteras manuellt tills vidare.</div>
          <div class="vseh-url-warn">⚠️ Kontrollera alla fält extra noga i det här läget.</div>
          <div class="vseh-row" style="margin-top:10px;"><label>Event-URL</label>
            <input type="text" id="vseh-url-input" class="vseh-key" placeholder="https://…" autocomplete="off" spellcheck="false"></div>
          <button type="button" id="vseh-url-create" style="margin-top:8px;">✏️ Skapa eventutkast</button>
          <button type="button" id="vseh-url-copyjson" style="margin-top:6px;">📋 Kopiera senaste agent-svar (JSON)</button>
          <div class="vseh-ev-status" id="vseh-url-status" style="display:none; margin-top:12px;"></div>
        </div>

        <div class="vseh-tabpane" data-pane="sbr-crm">
          <div class="vseh-fetch-h">CRM-import (klistra in från Excel)</div>
          <div class="vseh-hint">Tab-separerade kolumner: Affärstyp, Startdatum, Slutdatum, Affärsnamn,
            Kortnamn, Antal deltagare, Vald plats, Webb. Matchas mot SBR:s manuella eventlista (och mot
            Visit-kalendern om den är laddad).</div>
          <textarea id="sbr-crm-paste" class="vseh-key" rows="5" style="width:100%; resize:vertical; font-family:inherit;" placeholder="Klistra in CRM-rader…"></textarea>
          <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
            <button type="button" id="sbr-crm-import">📥 Importera</button>
            <button type="button" id="sbr-crm-match">🔍 Matcha mot kalendrar</button>
            <button type="button" id="sbr-crm-export">📤 Exportera</button>
            <button type="button" id="sbr-crm-clear">🗑 Rensa</button>
          </div>
          <div id="vseh-filters" style="margin-top:10px;">
            <button type="button" class="crm-f active" data-f="all">Alla (<span id="crm-count-all">0</span>)</button>
            <button type="button" class="crm-f" data-f="in_visit">Visit (<span id="crm-count-in_visit">0</span>)</button>
            <button type="button" class="crm-f" data-f="in_sbr">SBR (<span id="crm-count-in_sbr">0</span>)</button>
            <button type="button" class="crm-f" data-f="not_in_cal">Ej inlagt (<span id="crm-count-not_in_cal">0</span>)</button>
            <button type="button" class="crm-f" data-f="passed">Passerat (<span id="crm-count-passed">0</span>)</button>
          </div>
          <div id="sbr-crm-monthfilter" style="margin-top:6px;">
            <select id="sbr-crm-month-select">
              <option value="all">Alla event</option>
              <option value="month">Denna månad</option>
              <option value="6m">Inom 6 månader</option>
            </select>
          </div>
          <div id="sbr-crm-body" style="margin-top:10px;"><div class="vseh-empty">Inga CRM-event ännu.</div></div>
        </div>

        <div class="vseh-tabpane" data-pane="sbr-src">
          <div class="vseh-fetch-h">Källor — arrangörslista</div>
          <div class="vseh-hint">Klistra in namn+URL kopierat från Excel (två kolumner, tabbseparerat,
            en arrangör per rad). Befintliga arrangörer (matchat på namn) får sin URL uppdaterad —
            "Uppdaterad"-datum och kommentar rörs inte.</div>
          <textarea id="sbr-src-paste" class="vseh-key" rows="3" style="width:100%; resize:vertical; font-family:inherit;"
            placeholder="Namn[TAB]URL, en rad per arrangör…"></textarea>
          <button type="button" id="sbr-src-import" style="margin-top:6px;">Importera inklistrad data</button>
          <div id="sbr-src-body" style="margin-top:14px;"></div>
        </div>

        <div class="vseh-tabpane" data-pane="sbr-cal">
          <div class="vseh-fetch-h">Eventlista — manuell dedup-koll</div>
          <div class="vseh-hint">Stå på SBR:s eventlista och klicka "Hämta synliga event" —
            den läser tabellraderna som redan syns på sidan direkt, ingen kopiering behövs.
            Klicka "nästa sida" i SBR:s egen paginering och klicka knappen igen för varje sida.
            Överlappande hämtning är säker — event som redan finns i listan (samma titlar +
            startdatum) uppdateras i stället för att dubbliceras. När du skapar ett utkast via
            URL-fliken jämförs det automatiskt mot den här listan, med en varning i loggen om
            något liknar ett befintligt event.</div>
          <button type="button" id="sbr-cal-fetch" style="margin-bottom:10px;">📋 Hämta synliga event</button>
          <div id="sbr-cal-body" style="margin-top:14px;"></div>
        </div>

        <div class="vseh-tabpane" data-pane="sbr-set">
          <div class="vseh-fetch-h">Inställningar</div>
          <div class="vseh-hint">Egen Mistral-nyckel och agent-ID för SBR-läget — helt separat
            från Visit Stockholm-agenten, de påverkar inte varandra.</div>
          <div class="vseh-row"><label>SBR Mistral API-nyckel</label>
            <input type="text" id="sbr-mkey" class="vseh-key" placeholder="Mistral API-nyckel (SBR-agent)" autocomplete="off" spellcheck="false"></div>
          <div class="vseh-row"><label>SBR Mistral agent-ID</label>
            <input type="text" id="sbr-magent" class="vseh-key" placeholder="ag_…" autocomplete="off" spellcheck="false"></div>
        </div>

      </div></div>
      <div id="vseh-logwrap" style="display:none;"><div class="vseh-loghdr">Diagnostiklogg <span style="display:flex;gap:5px;">
        <button type="button" id="vseh-logcopy" title="Kopiera loggen">📋 Kopiera</button>
        <button type="button" id="vseh-logclose" title="Stäng">✕</button></span></div><div id="vseh-log"></div></div>
    `;
    document.body.appendChild(p);

    const mb = document.querySelector('#vseh-headbtns button[data-m="' + mode + '"]');
    if (mb) mb.classList.add('on');
    document.querySelectorAll('#vseh-headbtns button[data-m]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.m)));
    document.querySelectorAll('.vseh-tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    restoreLastTab();
    $('vseh-logbtn').addEventListener('click', () => { const w = $('vseh-logwrap'); w.style.display = (w.style.display === 'none' || !w.style.display) ? 'flex' : 'none'; renderLog(); });
    { const lc = document.getElementById('vseh-logclose'); if (lc) lc.addEventListener('click', () => { $('vseh-logwrap').style.display = 'none'; }); }
    $('vseh-logcopy').addEventListener('click', async () => {
      const btn = $('vseh-logcopy');
      const text = VLOG.map(e => e.line).join('\n');
      try { await navigator.clipboard.writeText(text); btn.textContent = '✓ Kopierat'; setTimeout(() => btn.textContent = '📋 Kopiera', 1200); }
      catch { btn.textContent = 'Fel'; setTimeout(() => btn.textContent = '📋 Kopiera', 1200); }
    });

    $('vseh-url-create').addEventListener('click', () => createEventFromUrl($('vseh-url-input').value.trim()));
    { const ucj = document.getElementById('vseh-url-copyjson'); if (ucj) ucj.addEventListener('click', async () => {
        if (!lastUrlAgentData) { ucj.textContent = 'Inget svar ännu'; setTimeout(() => ucj.textContent = '📋 Kopiera senaste agent-svar (JSON)', 1500); return; }
        try { await navigator.clipboard.writeText(JSON.stringify(lastUrlAgentData, null, 2));
          ucj.textContent = '✓ Kopierat'; setTimeout(() => ucj.textContent = '📋 Kopiera senaste agent-svar (JSON)', 1500);
        } catch { ucj.textContent = 'Fel'; setTimeout(() => ucj.textContent = '📋 Kopiera senaste agent-svar (JSON)', 1500); }
      }); }

    $('sbr-mkey').value = GM_getValue('sbr_mistral_key', '');
    $('sbr-magent').value = GM_getValue('sbr_mistral_agent', '');
    $('sbr-mkey').addEventListener('change', () => GM_setValue('sbr_mistral_key', $('sbr-mkey').value.trim()));
    $('sbr-magent').addEventListener('change', () => GM_setValue('sbr_mistral_agent', $('sbr-magent').value.trim()));

    loadSbrSources();
    renderSbrSources();
    $('sbr-src-import').addEventListener('click', () => {
      const ta = $('sbr-src-paste');
      if (!ta.value.trim()) { vlog('Källor: inget att importera — klistra in data först.', 'err'); return; }
      importSbrPaste(ta.value);
      ta.value = '';
    });

    loadSbrManualCal();
    renderSbrManualCal();
    $('sbr-cal-fetch').addEventListener('click', fetchVisibleSbrEvents);

    // ---- CRM-import ----
    loadSbrCrmEvents();
    renderCrmEvents();
    $('sbr-crm-import').addEventListener('click', () => {
      const ta = $('sbr-crm-paste');
      if (!ta.value.trim()) { vlog('CRM: inget att importera — klistra in data först.', 'err'); return; }
      importCrmData(ta.value); ta.value = ''; renderCrmEvents();
    });
    $('sbr-crm-match').addEventListener('click', () => { matchCrmEvents(); renderCrmEvents(); });
    $('sbr-crm-export').addEventListener('click', async () => {
      const btn = $('sbr-crm-export');
      try { await navigator.clipboard.writeText(exportCrmData()); btn.textContent = '✓ Kopierat'; setTimeout(() => btn.textContent = '📤 Exportera', 1500); }
      catch { btn.textContent = 'Fel'; setTimeout(() => btn.textContent = '📤 Exportera', 1500); }
    });
    $('sbr-crm-clear').addEventListener('click', () => {
      if (!confirm('Radera alla CRM-event?')) return;
      sbrCrmEvents = []; saveSbrCrmEvents(); renderCrmEvents();
    });
    document.querySelectorAll('#vseh-scroll .crm-f').forEach(b => b.addEventListener('click', () => {
      crmFilter = b.dataset.f;
      document.querySelectorAll('#vseh-scroll .crm-f').forEach(x => x.classList.toggle('active', x === b));
      renderCrmEvents();
    }));
    $('sbr-crm-month-select').addEventListener('change', e => { crmMonthFilter = e.target.value; renderCrmEvents(); });

    vlog('Eventbot SBR-läge startar på ' + location.pathname);
  }

  // (Kartläggningsläget för OKÄNDA URL:er flyttat till ett eget script:
  // "Formkartläggare" — aktiveras via Tampermonkeys meny, poppar aldrig
  // upp automatiskt. Se formkartlaggare-1-0.user.js.)
  const $ = id => document.getElementById(id);

  function buildPanel() {
    const p = document.createElement('div'); p.id = 'vseh-panel'; p.className = mode;
    p.innerHTML = `
      <div id="vseh-head">
        <div class="t">Eventbot<span class="v">v${SCRIPT_VERSION}</span></div>
        <div id="vseh-headbtns">
          <button type="button" data-m="min" title="Minimera">▁</button>
          <button type="button" data-m="max" title="Maximera">▢</button>
          <span class="vseh-btn-gap"></span>
          <button type="button" id="vseh-logbtn" title="Visa logg">📋</button>
        </div>
      </div>
      <div id="vseh-tabs">
        <button type="button" class="vseh-tab active" data-tab="cal">📆 Kalendrar</button>
        <button type="button" class="vseh-tab" data-tab="url">🔗 URL</button>
        <button type="button" class="vseh-tab" data-tab="dup">🎭 Dubbletter <span id="vseh-dup-count"></span></button>
        <button type="button" class="vseh-tab" data-tab="set">⚙️</button>
      </div>
      <div id="vseh-scroll"><div id="vseh-inner">

        <!-- FLIK: KALENDRAR -->
        <div class="vseh-tabpane active" data-pane="cal">
          <div class="vseh-fetch-h">Hämta kalendrar via API</div>
          <div class="vseh-fetch-line">
            <button type="button" id="vseh-dedup-btn">VisitStockholm</button>
            <span class="vseh-fetch-ts" id="vseh-vs-ts">ej hämtad</span>
          </div>
          <div class="vseh-prog" id="vseh-vs-prog" style="display:none;"><div class="vseh-prog-bar" id="vseh-vs-bar"></div><span class="vseh-prog-txt" id="vseh-vs-ptxt"></span></div>
          <div class="vseh-fetch-divider"></div>
          <div class="vseh-fetch-line">
            <button type="button" id="vseh-fetch-bl">Billetto</button>
            <span class="vseh-fetch-ts" id="vseh-bl-ts">ej hämtad</span>
          </div>
          <div class="vseh-prog" id="vseh-bl-prog" style="display:none;"><div class="vseh-prog-bar" id="vseh-bl-bar"></div><span class="vseh-prog-txt" id="vseh-bl-ptxt"></span></div>
          <div class="vseh-fetch-line">
            <button type="button" id="vseh-fetch">Ticketmaster</button>
            <span class="vseh-fetch-ts" id="vseh-tm-ts">ej hämtad</span>
          </div>
          <div class="vseh-prog" id="vseh-tm-prog" style="display:none;"><div class="vseh-prog-bar" id="vseh-tm-bar"></div><span class="vseh-prog-txt" id="vseh-tm-ptxt"></span></div>
          <div class="vseh-fetch-line">
            <button type="button" id="vseh-fetch-tix">Tickster</button>
            <span class="vseh-fetch-ts" id="vseh-tix-ts">ej hämtad</span>
          </div>
          <div class="vseh-prog" id="vseh-tix-prog" style="display:none;"><div class="vseh-prog-bar" id="vseh-tix-bar"></div><span class="vseh-prog-txt" id="vseh-tix-ptxt"></span></div>
          <div class="vseh-fetch-line">
            <button type="button" id="vseh-fetch-nortic">Nortic</button>
            <span class="vseh-fetch-ts" id="vseh-nortic-ts">ej hämtad</span>
          </div>
          <div class="vseh-prog" id="vseh-nortic-prog" style="display:none;"><div class="vseh-prog-bar" id="vseh-nortic-bar"></div><span class="vseh-prog-txt" id="vseh-nortic-ptxt"></span></div>
          <div id="vseh-stats" style="display:none;">
            <div class="s" data-f="out"><div class="n" style="color:#ff8080" id="vseh-n-out">0</div><div class="l">Ej inlagda</div></div>
            <div class="s" data-f="partial"><div class="n" style="color:#e0b060" id="vseh-n-part">0</div><div class="l">Delvis/Osäkra</div></div>
            <div class="s" data-f="in"><div class="n" style="color:#7ddca0" id="vseh-n-in">0</div><div class="l">Inlagda/<br>hanterade</div></div>
            <div class="s" data-f="cancelled" id="vseh-stat-cancel" style="display:none;"><div class="n" style="color:#ff8080" id="vseh-n-cancel">0</div><div class="l">⚠️ Inställda</div></div>
          </div>
          <div id="vseh-srcfilter" style="display:none;"></div>
          <div id="vseh-monthfilter">
            <select id="vseh-month-select">
              <option value="all">Alla event</option>
              <option value="month">Denna månad</option>
              <option value="6m">Inom 6 månader</option>
            </select>
          </div>
          <div id="vseh-list"><div class="vseh-empty">Inga event hämtade ännu.</div></div>
        </div>

        <!-- FLIK: URL -->
        <div class="vseh-tabpane" data-pane="url">
          <div class="vseh-fetch-h">Skapa utkast från en enskild event-URL</div>
          <div class="vseh-hint">Agenten läser sidan helt själv (ingen förhämtad data) — fungerar för
            vilken sajt som helst, t.ex. arrangörens egen sida eller en biljettleverantör vi inte
            har ett API för än.</div>
          <div class="vseh-url-warn">⚠️ Kontrollera datum extra noga — ingen automatisk verifiering
            sker här (till skillnad från Ticketmaster/Billetto), så agentens avlästa datum är det
            enda facit som finns.</div>
          <div class="vseh-row" style="margin-top:10px;"><label>Event-URL</label>
            <input type="text" id="vseh-url-input" class="vseh-key" placeholder="https://…" autocomplete="off" spellcheck="false"></div>
          <button type="button" id="vseh-url-create" style="margin-top:8px;">✏️ Skapa eventutkast</button>
          <button type="button" id="vseh-url-copyjson" style="margin-top:6px;">📋 Kopiera senaste agent-svar (JSON)</button>
          <div class="vseh-ev-status" id="vseh-url-status" style="display:none; margin-top:12px;"></div>
        </div>

        <!-- FLIK: DUBBLETTER -->
        <div class="vseh-tabpane" data-pane="dup">
          <div id="vseh-cleanfilter">
            <label>Från <input type="date" id="vseh-clean-from"></label>
            <label>Till <input type="date" id="vseh-clean-to"></label>
            <button type="button" id="vseh-clean-run">Sök dubbletter</button>
          </div>
          <div class="vseh-hint">2 poster = språkpar (ignoreras). 3+ = misstänkt dubblett.</div>
          <div id="vseh-diagfilter">
            <input type="text" id="vseh-diag-title" class="vseh-key" placeholder="🔍 Diagnostik: sök en titel (t.ex. Opus13)" autocomplete="off" spellcheck="false">
            <button type="button" id="vseh-diag-run">Logga matchning</button>
            <button type="button" id="vseh-diag-export" title="Kopiera ALL laddad kalenderdata som JSON">📤 Exportera all data</button>
            <button type="button" id="vseh-diag-raw" title="Hämta EN sida rådata direkt från API:et, obearbetad">🔬 Rådata (1 sida)</button>
          </div>
          <div id="vseh-diag-result" style="display:none;"></div>
          <div id="vseh-cleanbody"><div class="vseh-empty">Ladda er kalender, klicka sedan "Sök dubbletter".</div></div>
        </div>

        <!-- FLIK: INSTÄLLNINGAR -->
        <div class="vseh-tabpane" data-pane="set">
          <div class="vseh-row"><label>Ticketmaster Consumer Key</label>
            <input type="text" id="vseh-key" class="vseh-key" placeholder="Ticketmaster-nyckel" autocomplete="off" spellcheck="false"></div>
          <div class="vseh-row"><label>Mistral API-nyckel</label>
            <input type="text" id="vseh-mkey" class="vseh-key" placeholder="Mistral Bearer-nyckel" autocomplete="off" spellcheck="false"></div>
          <div class="vseh-row"><label>Mistral agent-ID</label>
            <input type="text" id="vseh-magent" class="vseh-key" placeholder="ag_..." autocomplete="off" spellcheck="false"></div>
          <div class="vseh-hint">Billetto kräver ingen egen nyckel längre — hämtas via samma sökindex som
            billetto.se:s egen sajt använder (se kod-kommentar vid BILLETTO_ALGOLIA_URL för detaljer).</div>
          <div class="vseh-row"><label>Tickster API-nyckel</label>
            <input type="text" id="vseh-tixkey" class="vseh-key" placeholder="Tickster API-nyckel" autocomplete="off" spellcheck="false"></div>
          <div class="vseh-two">
            <div class="vseh-row"><label>Kategori</label>
              <select id="vseh-cat"><option value="">Alla</option><option value="music">Musik</option>
                <option value="arts &amp; theatre">Scen &amp; teater</option><option value="family">Familj</option><option value="sports">Sport</option></select></div>
            <div class="vseh-row"><label>Sidor att hämta</label>
              <select id="vseh-pages"><option value="1">1</option><option value="3">3</option><option value="5">5</option><option value="10" selected>10</option><option value="20">20</option></select></div>
          </div>
        </div>

      </div></div>
      <div id="vseh-logwrap" style="display:none;"><div class="vseh-loghdr">Diagnostiklogg <span style="display:flex;gap:5px;"><button type="button" id="vseh-logjson" title="Kopiera hämtad JSON">JSON</button><button type="button" id="vseh-logcopy" title="Kopiera loggen">📋 Kopiera</button><button type="button" id="vseh-logclose" title="Stäng">✕</button></span></div><div id="vseh-log"></div></div>
    `;
    document.body.appendChild(p);
    $('vseh-key').value = GM_getValue('tm_key', '');
    $('vseh-mkey').value = GM_getValue('mistral_key', '');
    $('vseh-magent').value = GM_getValue('mistral_agent', '');
    $('vseh-tixkey').value = GM_getValue('tickster_key', '');
    const mb = document.querySelector('#vseh-headbtns button[data-m="' + mode + '"]');
    if (mb) mb.classList.add('on');
    wire();
    vlog('Panel byggd. Läge: ' + mode);
  }
  function setMode(m) {
    mode = m; $('vseh-panel').className = m;
    document.querySelectorAll('#vseh-headbtns button[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    GM_setValue('window_mode', m);
  }
  // Sparar senast valda flik (delad nyckel för huvud-/SBR-läget, samma
  // mönster som window_mode nedan — läges-flikarna har egna namn så det
  // uppstår ingen förväxling) så den återställs vid omladdning istället för
  // att alltid börja om på förstafliken (på begäran 2026-09-19).
  function switchTab(name) {
    document.querySelectorAll('.vseh-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.vseh-tabpane').forEach(pn => pn.classList.toggle('active', pn.dataset.pane === name));
    GM_setValue('window_tab', name);
  }
  // Återställer senast valda flik om den finns bland de flikar som faktiskt
  // byggdes för det aktuella läget — annars lämnas HTML-mallens egen
  // förvalda flik orörd.
  function restoreLastTab() {
    const last = GM_getValue('window_tab', '');
    if (last && document.querySelector('.vseh-tab[data-tab="' + last + '"]')) switchTab(last);
  }
  // Global status → loggen (ingen global statusrad längre).
  function setStatus(msg, kind) { vlog(msg, kind === 'err' ? 'err' : (kind === 'ok' ? 'ok' : 'info')); }

  function showProgress(which, cur, total) {
    const wrap = $('vseh-' + which + '-prog'), bar = $('vseh-' + which + '-bar'), txt = $('vseh-' + which + '-ptxt');
    if (!wrap) return;
    wrap.style.display = 'block';
    const pct = total ? Math.round((cur / total) * 100) : 0;
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = 'hämtar sida ' + cur + ' av ' + total;
  }
  function hideProgress(which) { const w = $('vseh-' + which + '-prog'); if (w) w.style.display = 'none'; }
  function fmtStamp(ts) {
    if (!ts) return 'ej hämtad';
    const d = new Date(ts), now = new Date();
    const hhmm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    const sameDay = d.toDateString() === now.toDateString();
    const yst = new Date(now); yst.setDate(now.getDate() - 1);
    const isYst = d.toDateString() === yst.toDateString();
    if (sameDay) return 'hämtad idag ' + hhmm;
    if (isYst) return 'hämtad igår ' + hhmm;
    return 'hämtad ' + d.toISOString().split('T')[0] + ' ' + hhmm;
  }

  // ---- SBR-läge: Källor (arrangörslista) ------------------------------------
  const SBR_SOURCES_KEY = 'sbr_sources';
  let sbrSources = [];   // [{ name, url, updated: ts|null, comment }]

  function loadSbrSources() {
    try { sbrSources = JSON.parse(GM_getValue(SBR_SOURCES_KEY, '[]')) || []; } catch { sbrSources = []; }
  }
  function saveSbrSources() {
    GM_setValue(SBR_SOURCES_KEY, JSON.stringify(sbrSources));
  }
  function fmtUpdatedDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function updatedColorClass(ts) {
    if (!ts) return 'sbr-upd-never';
    const days = (Date.now() - ts) / 86400000;
    if (days <= 30) return 'sbr-upd-green';
    if (days <= 60) return 'sbr-upd-yellow';
    return 'sbr-upd-red';
  }

  // ---- SBR-läge: manuell eventlista (dedup-ersättning så länge inget API finns)
  const SBR_CAL_KEY = 'sbr_manual_calendar';
  let sbrManualCal = [];   // [{ title_en, title_sv, start_date, modified, status }]
  const SV_MONTHS = { januari:1, februari:2, mars:3, april:4, maj:5, juni:6, juli:7,
    augusti:8, september:9, oktober:10, november:11, december:12 };
      // ---- SBR-läge: CRM-import (Excel-inklistring) ----------------------------
  const SBR_CRM_KEY = 'sbr_crm_events';
  let sbrCrmEvents = [];
  let crmFilter = 'all';
  let crmMonthFilter = 'all';   // 'all' | 'month' | '6m'

  const CRM_STATUS = {
    in_visit:   { label: 'inlagt Visit',        bg: '#1f7a4d', fg: '#fff', bar: '#2f9a63' },
    in_sbr:     { label: 'inlagt SBR',          bg: '#1f7a4d', fg: '#fff', bar: '#2f9a63' },
    both:       { label: 'inlagt Visit + SBR',  bg: '#2f9a63', fg: '#fff', bar: '#5ad1a8' },
    passed:     { label: 'passerat datum',      bg: '#3a3f4b', fg: '#9aa0ad', bar: '#3a3f4b' },
    not_in_cal: { label: 'ej inlagt i kalender',bg: '#c02626', fg: '#fff', bar: '#d13a3a' }
  };

  function loadSbrCrmEvents() {
    try { sbrCrmEvents = JSON.parse(GM_getValue(SBR_CRM_KEY, '[]')) || []; } catch { sbrCrmEvents = []; }
  }
  function saveSbrCrmEvents() { GM_setValue(SBR_CRM_KEY, JSON.stringify(sbrCrmEvents)); }

  // Kolumnordning (tab-separerat från Excel):
  // Affärstyp, Startdatum, Slutdatum, Affärsnamn, Kortnamn, Antal deltagare, Vald plats, Webb
  function parseCrmData(text) {
    const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');
    const events = [];
    lines.forEach(line => {
      const p = line.split('\t');
      if (p.length < 8) return;
      let url = (p[7] || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      let startDate = (p[1] || '').trim();
      let endDate = (p[2] || '').trim();
      if (startDate && endDate && endDate < startDate) { const t = startDate; startDate = endDate; endDate = t; }
      const title = (p[3] || '').trim();
      if (!title) return;
      events.push({
        business_type: (p[0] || '').trim(),
        start_date: startDate,
        end_date: endDate,
        title,
        short_name: (p[4] || '').trim() || null,
        participants: parseInt((p[5] || '').trim(), 10) || 0,
        venue: (p[6] || '').trim(),
        url,
        status: null
      });
    });
    return events;
  }

  function importCrmData(text) {
    const parsed = parseCrmData(text);
    let added = 0, skipped = 0;
    parsed.forEach(ev => {
      const dup = sbrCrmEvents.some(x =>
        normText(x.title) === normText(ev.title) &&
        x.start_date === ev.start_date &&
        normText(x.venue) === normText(ev.venue));
      if (dup) { skipped++; return; }
      sbrCrmEvents.push(ev);
      added++;
    });
    saveSbrCrmEvents();
    vlog('CRM-import: ' + added + ' nya, ' + skipped + ' dubletter ignorerade av ' + parsed.length + ' rader.', 'ok');
  }

  // Matchar mot Visit-kalendern (dedupIndex) och SBR:s manuella eventlista.
  // Använder de befintliga globala funktionerna — inga lokala omdefinitioner.
  function crmDatesOverlap(aStart, aEnd, bStart, bEnd) {
    const as = aStart, ae = aEnd || aStart, bs = bStart, be = bEnd || bStart;
    if (!as || !bs) return false;
    return as <= be && bs <= ae;
  }

  function matchCrmEvents() {
    const today = new Date().toISOString().split('T')[0];
    let visitCount = 0, sbrCount = 0, noCal = 0;

    sbrCrmEvents.forEach(ev => {
      ev.status = null;
      if (ev.end_date && ev.end_date < today) { ev.status = 'passed'; return; }

      let inVisit = false;
      if (dedupIndex && dedupIndex.rows) {
        for (const row of dedupIndex.rows) {
          const tSim = titleSim(ev.title, row.title);
          const vSim = placeSim(ev.venue, '', row.venue_name, row.address);
          if (tSim >= 0.75 && vSim >= 0.7 &&
              crmDatesOverlap(ev.start_date, ev.end_date, row.start, row.end || row.start)) {
            inVisit = true; break;
          }
        }
      }

      let inSbr = false;
      if (sbrManualCal && sbrManualCal.length) {
        for (const e of sbrManualCal) {
          const tSim = Math.max(titleSim(ev.title, e.title_en || ''), titleSim(ev.title, e.title_sv || ''));
          if (tSim >= 0.75 && crmDatesOverlap(ev.start_date, ev.end_date, e.start_date, e.start_date)) {
            inSbr = true; break;
          }
        }
      }

      if (inVisit && inSbr) { ev.status = 'both'; visitCount++; sbrCount++; }
      else if (inVisit) { ev.status = 'in_visit'; visitCount++; }
      else if (inSbr) { ev.status = 'in_sbr'; sbrCount++; }
      else { ev.status = 'not_in_cal'; noCal++; }
    });

    saveSbrCrmEvents();
    vlog('CRM-matchning klar: ' + visitCount + ' i Visit, ' + sbrCount + ' i SBR, ' + noCal + ' ej inlagda.', 'ok');
  }

  function renderCrmEvents() {
    const body = $('sbr-crm-body');
    if (!body) return;
    const today = new Date().toISOString().split('T')[0];

    const shown = sbrCrmEvents.filter(ev => {
      if (!passesMonthFilter(ev.start_date, crmMonthFilter)) return false;
      if (crmFilter === 'all') return true;
      if (crmFilter === 'passed') return ev.status === 'passed' || (ev.end_date && ev.end_date < today);
      if (crmFilter === 'in_visit') return ev.status === 'in_visit' || ev.status === 'both';
      if (crmFilter === 'in_sbr') return ev.status === 'in_sbr' || ev.status === 'both';
      if (crmFilter === 'not_in_cal') return ev.status === 'not_in_cal';
      return true;
    }).sort((a, b) => (a.start_date || '9999').localeCompare(b.start_date || '9999'));

    // räknare
    const counts = { all: sbrCrmEvents.length, in_visit: 0, in_sbr: 0, passed: 0, not_in_cal: 0 };
    sbrCrmEvents.forEach(ev => {
      if (ev.status === 'passed' || (ev.end_date && ev.end_date < today)) counts.passed++;
      else if (ev.status === 'in_visit' || ev.status === 'both') counts.in_visit++;
      if (ev.status === 'in_sbr' || ev.status === 'both') counts.in_sbr++;
      if (ev.status === 'not_in_cal') counts.not_in_cal++;
    });
    ['all','in_visit','in_sbr','passed','not_in_cal'].forEach(k => {
      const el = $('crm-count-' + k); if (el) el.textContent = counts[k];
    });

    if (!shown.length) { body.innerHTML = '<div class="vseh-empty">Inga CRM-event i denna vy.</div>'; return; }

    body.innerHTML = shown.map(ev => {
      const st = CRM_STATUS[ev.status] || CRM_STATUS.not_in_cal;
      const passed = ev.status === 'passed' || (ev.end_date && ev.end_date < today);
      const dateRange = ev.start_date
        ? (ev.end_date && ev.end_date !== ev.start_date ? ev.start_date + ' – ' + ev.end_date : ev.start_date)
        : '–';
      const badge = '<span class="vseh-badge" style="background:' + st.bg + ';color:' + st.fg + '">' + esc(st.label) + '</span>';
      const createBtn = (!passed && ev.url && ev.status === 'not_in_cal')
        ? '<div class="vseh-create"><button type="button" class="vseh-crm-create" data-url="' + esc(ev.url) + '">✏️ Skapa utkast</button></div>' : '';
      return '<div class="vseh-ev" style="border-left-color:' + st.bar + ';' + (passed ? 'opacity:.6;' : '') + '">' +
        '<h4><span>' + esc(ev.title) + '</span>' + badge + '</h4>' +
        '<div class="m"><span class="v">' + esc(ev.venue || '–') + '</span>' +
          (ev.business_type ? ' · ' + esc(ev.business_type) : '') + '</div>' +
        '<div class="dates"><b>' + esc(dateRange) + '</b>' +
          (ev.participants ? ' · ' + ev.participants + ' deltagare' : '') + '</div>' +
        (ev.url ? '<div class="m"><a class="vseh-edit" href="' + esc(ev.url) + '" target="_blank" rel="noopener">🔗 Länk</a></div>' : '') +
        createBtn +
      '</div>';
    }).join('');

    body.querySelectorAll('.vseh-crm-create').forEach(b => b.addEventListener('click', () => {
      createEventFromUrl(b.dataset.url);   // återanvänder befintliga URL-flödet (SBR-läget väljer rätt agent självt)
    }));
  }

  function exportCrmData() {
    const header = 'Affärstyp\tStartdatum\tSlutdatum\tAffärsnamn\tKortnamn\tAntal deltagare\tVald plats\tWebb';
    const rows = sbrCrmEvents.map(e => [
      e.business_type || '', e.start_date || '', e.end_date || '', e.title || '',
      e.short_name || '', e.participants || '', e.venue || '', e.url || ''
    ].map(v => String(v).replace(/\t/g, ' ')).join('\t'));
    return header + '\n' + rows.join('\n');
  }

  // ---- Guide-lista (sidlistan på /cms/pages/<id>/?...content_type=46) ------
  // Wagtails egen sidlista har ingen egen export, och ett innehållstyp-filter
  // (Guide) kan spänna över flera sidor (paginering, ?p=N). Samma paste-och-
  // spara-mönster som SBR:s CRM-import: markera hela den synliga tabellen på
  // sidan (Ctrl+A i listan, kopiera), klistra in här, importera. Klistrar man
  // in flera sidor efter varandra (en per ?p=N) byggs en komplett lista upp i
  // GM-cacheminnet — samma titel skrivs över (uppdaterar status), ingen
  // dublett. "Exportera" ger en enkel radlista (titel + status) att klistra
  // in i t.ex. related_guides-sökrutan på edit-sidan.
  const GUIDE_LIST_KEY = 'guide_list_v1';
  let guideList = [];

  function loadGuideList() {
    try { guideList = JSON.parse(GM_getValue(GUIDE_LIST_KEY, '[]')) || []; }
    catch { guideList = []; }
  }
  function saveGuideList() { GM_setValue(GUIDE_LIST_KEY, JSON.stringify(guideList)); }

  // Wagtails sidlista kopieras som friliggande textrader (inte en riktig
  // HTML-tabell markerad med kolumner) — titelrad, sen en metarad med
  // "<ålder> sedan", "Guide" och "Nuvarande sidstatus:<status>" tab-
  // separerat. Tolkar det genom att låta senaste icke-metaraden bli titeln
  // på nästa metarad, istället för att anta ett fast antal rader per post
  // (robustare mot extra tomrader från copy/paste).
  function parseGuideListPaste(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const items = [];
    let pendingTitle = null;
    for (const line of lines) {
      const statusMatch = line.match(/Nuvarande sidstatus:\s*(\S+)/i);
      if (/\bGuide\b/.test(line) && statusMatch) {
        if (pendingTitle) items.push({ title: pendingTitle, status: statusMatch[1].toLowerCase() });
        pendingTitle = null;
      } else {
        pendingTitle = line;
      }
    }
    return items;
  }

  function importGuideListPaste(text) {
    const items = parseGuideListPaste(text);
    items.forEach(it => {
      const idx = guideList.findIndex(g => g.title.toLowerCase() === it.title.toLowerCase());
      if (idx >= 0) guideList[idx].status = it.status;
      else guideList.push(it);
    });
    guideList.sort((a, b) => a.title.localeCompare(b.title, 'sv'));
    saveGuideList();
    return items.length;
  }

  function exportGuideList() {
    return guideList.map(g => g.title + '\t' + g.status).join('\n');
  }

  function renderGuideList() {
    const count = document.getElementById('vseh-guide-count');
    if (count) count.textContent = guideList.length + ' guide(r) sparade';
    const body = document.getElementById('vseh-guide-body');
    if (!body) return;
    if (!guideList.length) { body.innerHTML = '<div class="vseh-empty">Inga guider sparade ännu.</div>'; return; }
    body.innerHTML = guideList.map(g =>
      '<div class="vseh-guide-row" style="padding:4px 0;border-bottom:1px solid #3a3f4b;">' +
      esc(g.title) + ' <span style="color:' + (g.status === 'publicerad' ? '#7ddca0' : '#e0b060') + ';font-size:11px;">' +
      esc(g.status) + '</span></div>'
    ).join('');
  }

  const GUIDE_LIST_CSS = `
    #vseh-guide-bar { position:sticky; top:0; z-index:9999; display:flex; align-items:center;
      flex-wrap:wrap; gap:10px; background:#2f3542; color:#e8eaee; padding:10px 14px;
      margin:0 0 14px; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,.3);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    #vseh-guide-bar button { padding:8px 14px; border:none; border-radius:5px; cursor:pointer;
      font-size:13px; font-weight:600; background:#4a9fe0; color:#fff; }
    #vseh-guide-count { font-size:12px; color:#c3c8d1; }
    #vseh-guide-panel { background:#1b1f27; color:#e8eaee; border-radius:6px; padding:14px; margin:0 0 14px; }
    #vseh-guide-paste { width:100%; min-height:120px; font-family:inherit; font-size:13px;
      box-sizing:border-box; margin-bottom:8px; }
    #vseh-guide-panel .vseh-guide-actions { display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
    #vseh-guide-panel .vseh-guide-actions button { padding:6px 12px; border:none; border-radius:5px;
      cursor:pointer; font-size:12px; font-weight:600; background:#787e8a; color:#fff; }
    #vseh-guide-body { max-height:300px; overflow-y:auto; font-size:13px; }
  `;
  function ensureGuideListStyle() {
    if (document.getElementById('vseh-guide-css')) return;
    const s = document.createElement('style');
    s.id = 'vseh-guide-css';
    s.textContent = GUIDE_LIST_CSS;
    document.head.appendChild(s);
  }

  // Delad av alla sticky bars (draft/edit/guide) som injiceras ovanpå Wagtails
  // egen sida. Wagtails admin-vyer har inte alltid samma header-markup —
  // om ingen av de vanliga selektorerna hittas (t.ex. en annan sidlayout på
  // guide-listan än på draft-listan) faller vi tillbaka på att lägga baren
  // överst i <body> istället för att tyst inte visa något alls.
  function insertBarAtTop(bar) {
    const anchor = document.querySelector('.page-header, .header, header, h1');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
  }

  function initGuideListTool() {
    vlog('GuideLista: Initierar på sidlistan (content_type=46)');
    ensureGuideListStyle();
    loadGuideList();
    if (!document.getElementById('vseh-guide-bar')) {
        const bar = document.createElement('div');
        bar.id = 'vseh-guide-bar';
        bar.innerHTML = `
          <button type="button" id="vseh-guide-toggle">📋 Guide-lista</button>
          <span id="vseh-guide-count"></span>
        `;
        insertBarAtTop(bar);
        const panel = document.createElement('div');
        panel.id = 'vseh-guide-panel';
        panel.style.display = 'none';
        panel.innerHTML = `
          <div class="vseh-hint" style="margin-bottom:8px;">Markera hela den synliga listan på sidan (t.ex. Ctrl+A), kopiera och klistra in här. Fungerar sida för sida (?p=1, ?p=2 …) — redan sparade titlar uppdateras istället för att dubbliceras.</div>
          <textarea id="vseh-guide-paste" placeholder="Klistra in kopierad text från sidlistan…"></textarea>
          <div class="vseh-guide-actions">
            <button type="button" id="vseh-guide-import">Importera inklistrad data</button>
            <button type="button" id="vseh-guide-export">📤 Exportera lista</button>
            <button type="button" id="vseh-guide-clear">🗑 Rensa allt</button>
          </div>
          <div id="vseh-guide-body"></div>
        `;
        bar.insertAdjacentElement('afterend', panel);
        document.getElementById('vseh-guide-toggle').addEventListener('click', () => {
          panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });
        document.getElementById('vseh-guide-import').addEventListener('click', () => {
          const ta = document.getElementById('vseh-guide-paste');
          const n = importGuideListPaste(ta.value);
          ta.value = '';
          renderGuideList();
          vlog('GuideLista: Importerade ' + n + ' rad(er) från inklistringen.', 'ok');
        });
        document.getElementById('vseh-guide-export').addEventListener('click', async () => {
          const btn = document.getElementById('vseh-guide-export');
          try { await navigator.clipboard.writeText(exportGuideList()); btn.textContent = '✓ Kopierat'; setTimeout(() => btn.textContent = '📤 Exportera lista', 1500); }
          catch { btn.textContent = 'Fel'; setTimeout(() => btn.textContent = '📤 Exportera lista', 1500); }
        });
        document.getElementById('vseh-guide-clear').addEventListener('click', () => {
          if (!confirm('Radera alla sparade guider?')) return;
          guideList = []; saveGuideList(); renderGuideList();
        });
    }
    renderGuideList();
  }

  function parseSwedishDate(str) {
    if (!str) return null;
    const m = /(\d{1,2})\s+([a-zåäö]+)\s+(\d{4})/i.exec(str.trim());
    if (!m) return null;
    const mon = SV_MONTHS[m[2].toLowerCase()];
    if (!mon) return null;
    return m[3] + '-' + String(mon).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  }

  function loadSbrManualCal() {
    try { sbrManualCal = JSON.parse(GM_getValue(SBR_CAL_KEY, '[]')) || []; } catch { sbrManualCal = []; }
  }
  function saveSbrManualCal() { GM_setValue(SBR_CAL_KEY, JSON.stringify(sbrManualCal)); }

  function sbrCalKey(ev) { return normText(ev.title_en) + '@' + normText(ev.title_sv) + '@' + ev.start_date; }

  // Upsert-logik för importerade rader (bara DOM-hämtningen numera — den
  // manuella inklistrings-vägen och dess parser togs bort 2026-09-19 sedan
  // fetchVisibleSbrEvents() visade sig fungera).
  function mergeSbrCalEntries(parsed, sourceLabel) {
    if (!parsed.length) return;
    const byKey = new Map(sbrManualCal.map(e => [sbrCalKey(e), e]));
    let added = 0, updated = 0;
    parsed.forEach(ev => {
      const key = sbrCalKey(ev);
      if (byKey.has(key)) { Object.assign(byKey.get(key), ev); updated++; }
      else { sbrManualCal.push(ev); byKey.set(key, ev); added++; }
    });
    saveSbrManualCal(); renderSbrManualCal();
    vlog('Eventlista: ' + added + ' nya, ' + updated + ' uppdaterade av ' + parsed.length + ' ' + sourceLabel + ' (överlappande import dublicerar inte).', 'ok');
  }

  // Läser tabellraderna som redan finns i DOM:et på SBR:s eventlista-sida
  // direkt, istället för att kräva manuell markera+kopiera+växla-flik+
  // klistra-in (~7-8 handgrepp per sida enligt användaren 2026-09-19).
  // FÖRSTA försöket antog samma markup som Visit Stockholms draftlista
  // (tr[data-object-pk], td.field-<kolumn>) — det stämde INTE. SBR:s
  // eventlista är byggd på Wagtails nyare SnippetViewSet-listmall, som
  // saknar semantiska kolumnklasser helt utom på checkbox- och titel-
  // cellerna. Bekräftat via en riktig rads kolumner (konsol-dump
  // 2026-09-19): [0] kryssruta (klass "bulk-action-checkbox-cell"),
  // [1] td.title (engelsk titel, länkad), [2] (ingen klass) svensk
  // titel, [3] (ingen klass) startdatum ("27 maj 2026"), [4] (ingen
  // klass) ändrad-tidsstämpel, [5] (ingen klass) status ("Publicerad").
  // Läser därför cellerna POSITIONELLT via td.title's syskonindex istället
  // för klassnamn, eftersom inga finns att träffa för kolumn 2-5.
  function extractSbrRowData(row) {
    const cells = row.children;
    if (!cells || cells.length < 6) return null;
    const title_en = (cells[1]?.textContent || '').trim();
    const title_sv = (cells[2]?.textContent || '').trim();
    if (!title_en && !title_sv) return null;
    const start_date = parseSwedishDate((cells[3]?.textContent || '').trim()) || '';
    const modified_raw = (cells[4]?.textContent || '').trim();
    const status = (cells[5]?.textContent || '').trim();
    return { title_en, title_sv, start_date, modified_raw, status };
  }

  function fetchVisibleSbrEvents() {
    const titleCells = [...document.querySelectorAll('td.title')];
    if (!titleCells.length) { vlog('Eventlista: hittade inga rader (ingen td.title) på sidan — är du på SBR:s eventlista?', 'err'); return; }
    const parsed = titleCells.map(td => extractSbrRowData(td.closest('tr'))).filter(Boolean);
    if (!parsed.length) { vlog('Eventlista: hittade ' + titleCells.length + ' rad(er) men kunde inte läsa ut kolumndata ur någon — sidstrukturen kan ha ändrats igen, hör av dig så kollar vi.', 'err'); return; }
    // Loggar första raden i klartext så en felaktig kolumntolkning syns
    // direkt, istället för att bara upptäckas efter en tyst felimport.
    vlog('Eventlista: första tolkade raden — EN:"' + parsed[0].title_en + '" SV:"' + parsed[0].title_sv + '" datum:"' + parsed[0].start_date + '" status:"' + parsed[0].status + '" — kontrollera att det stämmer.', 'ok');
    mergeSbrCalEntries(parsed, 'synliga rader på sidan');
  }

  // Räknare (på begäran 2026-09-19) så det syns direkt, både på flikens
  // egen badge och överst i listan, om alla sidor faktiskt hämtats — utan
  // att behöva räkna raderna manuellt.
  function renderSbrManualCal() {
    const countEl = document.getElementById('sbr-cal-count');
    if (countEl) countEl.textContent = sbrManualCal.length ? '(' + sbrManualCal.length + ')' : '';
    const body = $('sbr-cal-body');
    if (!body) return;
    if (!sbrManualCal.length) {
      body.innerHTML = '<div class="vseh-empty">Inga event importerade ännu.</div>';
      return;
    }
    const sorted = [...sbrManualCal].sort((a, b) => (a.start_date || '9999').localeCompare(b.start_date || '9999'));
    body.innerHTML = '<div class="vseh-hint" style="margin-bottom:8px;"><b>Totalt importerade: ' + sbrManualCal.length + '</b></div>' +
      '<div class="sbr-cal-hdr sbr-cal-row"><span>Titel (en/sv)</span><span>Startdatum</span><span>Status</span></div>' +
      sorted.map(e => `
        <div class="sbr-cal-row">
          <span>${esc(e.title_en)}<br><span class="sbr-cal-sv">${esc(e.title_sv)}</span></span>
          <span>${esc(e.start_date)}</span>
          <span>${esc(e.status)}</span>
        </div>`).join('');
  }

  // Jämför ett nyskapat SBR-utkast (från URL-fliken) mot den manuella eventlistan.
  // Matchar på titellikhet + EXAKT samma startdatum (ingen adress finns i
  // exportformatet att stödja sig på, till skillnad från Visit Stockholm-dedupen).
  function checkSbrManualDuplicate(data) {
    if (!sbrManualCal.length) return;
    const dates = datesFromOccurrences(data.occurrences).map(d => d.date);
    if (!dates.length) return;
    const title = data.title_sv || data.title_en || '';
    let best = null;
    sbrManualCal.forEach(e => {
      if (!dates.includes(e.start_date)) return;
      const simEn = titleSim(title, e.title_en), simSv = titleSim(title, e.title_sv);
      const sim = Math.max(simEn, simSv);
      if (sim >= 0.5 && (!best || sim > best.sim)) best = { e, sim };
    });
    if (best) {
      vlog('⚠️ LIKNAR BEFINTLIGT EVENT i eventlistan: "' + best.e.title_sv + '" / "' + best.e.title_en +
        '" (' + best.e.start_date + ', status: ' + best.e.status + ') — likhet ' + best.sim.toFixed(2) +
        '. Kontrollera manuellt innan du sparar.', 'err');
    }
  }

  function renderSbrSources() {
    const body = $('sbr-src-body');
    if (!body) return;
    const sorted = [...sbrSources].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    if (!sorted.length) {
      body.innerHTML = '<div class="vseh-empty">Inga arrangörer ännu — klistra in namn+URL ovan.</div>';
      return;
    }
    body.innerHTML = sorted.map((s, i) => {
      const realIdx = sbrSources.indexOf(s);
      const cls = updatedColorClass(s.updated);
      const label = s.updated ? 'Uppdaterad ' + fmtUpdatedDate(s.updated) : 'Uppdatera';
      return `
        <div class="sbr-src-row" data-idx="${realIdx}">
          <div class="sbr-src-name">
            <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>
            <button type="button" class="sbr-src-edit" title="Redigera namn/URL" data-idx="${realIdx}">✎</button>
          </div>
          <button type="button" class="sbr-upd-btn ${cls}" data-idx="${realIdx}">${esc(label)}</button>
          <input type="text" class="sbr-src-comment" data-idx="${realIdx}" placeholder="Kommentar…" value="${esc(s.comment || '')}">
          <button type="button" class="sbr-src-del" title="Radera" data-idx="${realIdx}">✕</button>
        </div>`;
    }).join('');

    body.querySelectorAll('.sbr-upd-btn').forEach(b => b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.idx, 10);
      sbrSources[idx].updated = Date.now();
      saveSbrSources(); renderSbrSources();
    }));
    body.querySelectorAll('.sbr-src-del').forEach(b => b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.idx, 10);
      if (!confirm('Radera "' + sbrSources[idx].name + '"?')) return;
      sbrSources.splice(idx, 1);
      saveSbrSources(); renderSbrSources();
    }));
    body.querySelectorAll('.sbr-src-comment').forEach(inp => inp.addEventListener('change', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      sbrSources[idx].comment = inp.value;
      saveSbrSources();
    }));
    body.querySelectorAll('.sbr-src-edit').forEach(b => b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.idx, 10);
      const row = body.querySelector('.sbr-src-row[data-idx="' + idx + '"]');
      const nameCell = row.querySelector('.sbr-src-name');
      const s = sbrSources[idx];
      nameCell.innerHTML = `
        <input type="text" class="sbr-edit-name" value="${esc(s.name)}" placeholder="Namn">
        <input type="text" class="sbr-edit-url" value="${esc(s.url)}" placeholder="URL">
        <button type="button" class="sbr-edit-save">💾</button>`;
      nameCell.querySelector('.sbr-edit-save').addEventListener('click', () => {
        const newName = nameCell.querySelector('.sbr-edit-name').value.trim();
        const newUrl = nameCell.querySelector('.sbr-edit-url').value.trim();
        if (newName) s.name = newName;
        if (newUrl) s.url = newUrl;
        saveSbrSources(); renderSbrSources();
      });
    }));
  }

  function importSbrPaste(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let added = 0, updated = 0;
    lines.forEach(line => {
      const parts = line.split('\t');
      if (parts.length < 2) return;
      const name = parts[0].trim(), url = parts[1].trim();
      if (!name || !url) return;
      const existing = sbrSources.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (existing) { existing.url = url; updated++; }
      else { sbrSources.push({ name, url, updated: null, comment: '' }); added++; }
    });
    saveSbrSources(); renderSbrSources();
    vlog('Källor: ' + added + ' nya, ' + updated + ' uppdaterade (URL) av ' + lines.length + ' inklistrade rader.', 'ok');
  }

  function wire() {
    document.querySelectorAll('#vseh-headbtns button[data-m]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.m)));
    document.querySelectorAll('.vseh-tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    restoreLastTab();
    $('vseh-logbtn').addEventListener('click', () => { const w = $('vseh-logwrap'); w.style.display = (w.style.display === 'none' || !w.style.display) ? 'flex' : 'none'; renderLog(); });
    { const lc = document.getElementById('vseh-logclose'); if (lc) lc.addEventListener('click', () => { $('vseh-logwrap').style.display = 'none'; }); }
    { const lcopy = document.getElementById('vseh-logcopy'); if (lcopy) lcopy.addEventListener('click', async () => {
        const text = VLOG.map(e => e.line).join('\n');
        try { await navigator.clipboard.writeText(text); lcopy.textContent = '✓ Kopierat'; setTimeout(() => lcopy.textContent = '📋 Kopiera', 1200); }
        catch { lcopy.textContent = 'Fel'; setTimeout(() => lcopy.textContent = '📋 Kopiera', 1200); }
      }); }
    { const lj = document.getElementById('vseh-logjson'); if (lj) lj.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(lastGrouped, null, 2)); lj.textContent = '✓'; setTimeout(() => lj.textContent = 'JSON', 1200); }
        catch { lj.textContent = 'Fel'; setTimeout(() => lj.textContent = 'JSON', 1200); }
      }); }
    { const cr = document.getElementById('vseh-clean-run'); if (cr) cr.addEventListener('click', doCleanupScan); }
    { const dr = document.getElementById('vseh-diag-run'); if (dr) dr.addEventListener('click', runDupDiagnostic); }
    { const de = document.getElementById('vseh-diag-export'); if (de) de.addEventListener('click', async () => {
        if (!dedupIndex) { vlog('Ingen kalenderdata laddad — klicka VisitStockholm i fliken Kalendrar först.', 'err'); return; }
        const json = JSON.stringify(dedupIndex.rows, null, 2);
        try {
          await navigator.clipboard.writeText(json);
          de.textContent = '✓ Kopierat (' + dedupIndex.rows.length + ' rader)';
          vlog('Exporterade ' + dedupIndex.rows.length + ' kalenderrader till urklipp.', 'ok');
          setTimeout(() => de.textContent = '📤 Exportera all data', 2000);
        } catch (e) {
          de.textContent = 'Fel — se logg';
          vlog('Export misslyckades: ' + e.message, 'err');
          setTimeout(() => de.textContent = '📤 Exportera all data', 2000);
        }
      }); }
    { const dr = document.getElementById('vseh-diag-raw'); if (dr) dr.addEventListener('click', async () => {
        dr.disabled = true; dr.textContent = 'Hämtar…';
        try {
          const data = await sameOriginGet(SED_BASE + '?page=1');
          const first = (data.results || [])[0];
          if (!first) { vlog('Inga resultat på sida 1.', 'err'); return; }
          const keys = Object.keys(first);
          vlog('🔬 RÅDATA — nycklar i EN post från API:et: ' + keys.join(', '), 'ok');
          const json = JSON.stringify(first, null, 2);
          vlog('Fullständig råpost:\\n' + json);
          try { await navigator.clipboard.writeText(json); vlog('Kopierade den råa posten till urklipp också.', 'ok'); } catch {}
          const out = $('vseh-diag-result');
          if (out) {
            out.style.display = 'block';
            out.innerHTML = '<div class="vseh-diag-hdr">Rå post från API:et — nycklar: ' + esc(keys.join(', ')) + '</div>' +
              '<div class="vseh-diag-row" style="white-space:pre-wrap; font-size:10.5px;">' + esc(json) + '</div>';
          }
        } catch (e) {
          vlog('Rådata-hämtning misslyckades: ' + e.message, 'err');
        } finally {
          dr.disabled = false; dr.textContent = '🔬 Rådata (1 sida)';
        }
      }); }
    $('vseh-key').addEventListener('change', () => GM_setValue('tm_key', $('vseh-key').value.trim()));
    $('vseh-mkey').addEventListener('change', () => GM_setValue('mistral_key', $('vseh-mkey').value.trim()));
    $('vseh-magent').addEventListener('change', () => GM_setValue('mistral_agent', $('vseh-magent').value.trim()));
    $('vseh-tixkey').addEventListener('change', () => GM_setValue('tickster_key', $('vseh-tixkey').value.trim()));
    $('vseh-fetch-tix').addEventListener('click', runTickster);
    $('vseh-fetch-bl').addEventListener('click', runBilletto);
    $('vseh-fetch-nortic').addEventListener('click', runNortic);
    $('vseh-url-create').addEventListener('click', () => createEventFromUrl($('vseh-url-input').value.trim()));
    { const ucj = document.getElementById('vseh-url-copyjson'); if (ucj) ucj.addEventListener('click', async () => {
        if (!lastUrlAgentData) { ucj.textContent = 'Inget svar ännu'; setTimeout(() => ucj.textContent = '📋 Kopiera senaste agent-svar (JSON)', 1500); return; }
        try { await navigator.clipboard.writeText(JSON.stringify(lastUrlAgentData, null, 2));
          ucj.textContent = '✓ Kopierat'; setTimeout(() => ucj.textContent = '📋 Kopiera senaste agent-svar (JSON)', 1500);
        } catch { ucj.textContent = 'Fel'; setTimeout(() => ucj.textContent = '📋 Kopiera senaste agent-svar (JSON)', 1500); }
      }); }
    $('vseh-fetch').addEventListener('click', run);
    $('vseh-dedup-btn').addEventListener('click', loadDedup);
    document.querySelectorAll('#vseh-stats .s[data-f]').forEach(b => b.addEventListener('click', () => {
      activeFilter = b.dataset.f;
      if (activeFilter !== 'out') activeSourceFilter = 'all';
      render(lastGrouped);
    }));
    $('vseh-month-select').addEventListener('change', e => { monthFilter = e.target.value; render(lastGrouped); });
  }

  async function loadDedup() {
    $('vseh-dedup-btn').disabled = true;
    try {
      const rows = await buildDedupIndex(
        m => setStatus(m, 'work'),
        (cur, total) => showProgress('vs', cur, total));
      dedupIndex = buildIndexFromRows(rows);
      hideProgress('vs');
      const spans = rows.filter(r => r.isSpan).length;
      GM_setValue('vs_fetched_ts', Date.now());
      { const ts = $('vseh-vs-ts'); if (ts) ts.textContent = fmtStamp(Date.now()); }
      setStatus(`Kalender laddad: ${rows.length} rader, varav ${spans} flerdagarsspann.`, 'ok');
      saveCache();
      if (lastGrouped.length) render(lastGrouped);
      // AUTOMATISK dubblettsökning efter att kalendern laddats.
      vlog('Kör automatisk dubblettsökning…');
      await doCleanupScan();
    } catch (e) { hideProgress('vs'); setStatus(e.message, 'err'); }
    finally { $('vseh-dedup-btn').disabled = false; }
  }
  async function run() {
    const key = $('vseh-key').value.trim();
    if (!key) { setStatus('Fyll i Ticketmaster-nyckel (fliken Inställningar) först.', 'err'); switchTab('set'); return; }
    GM_setValue('tm_key', key);
    $('vseh-fetch').disabled = true;
    expanded.clear();
    try {
      const { grouped, pagesFetched, rawCount } = await fetchTicketmaster({
        key, radius: DEFAULT_RADIUS, classification: $('vseh-cat').value,
        maxPages: parseInt($('vseh-pages').value, 10),
        onProgress: m => setStatus(m, 'work'),
        onPage: (cur, total) => showProgress('tm', cur, total) });
      hideProgress('tm');
      GM_setValue('tm_fetched_ts', Date.now());
      { const ts = $('vseh-tm-ts'); if (ts) ts.textContent = fmtStamp(Date.now()); }
      // Ersätt BARA Ticketmaster-posterna i den samlade listan — rör inte Billetto.
      lastGrouped = lastGrouped.filter(g => g._source !== 'ticketmaster').concat(grouped);
      render(lastGrouped); saveCache();
      const note = dedupIndex ? '' : ' (ladda er kalender för status)';
      if (!grouped.length) setStatus('Inga event för dessa filter.', 'ok');
      else { setStatus(`Klart. ${grouped.length} event (${rawCount} datum) från ${pagesFetched} sida(or).${note}`, 'ok'); }
    } catch (e) { setStatus(e.message, 'err'); } finally { $('vseh-fetch').disabled = false; }
  }

  // ---- Tickster: hämta brett, filtrera på venue.city SJÄLVA -------------------
  // Två filtersyntaxer ("city:X" och "venue.city:X") gav båda total=0 trots att
  // kontot har 9000+ event — den odokumenterade "q"-syntaxen fungerar helt enkelt
  // inte som vi gissat. I stället för att gissa en tredje gång: samma lösning som
  // för Billetto — hämta sidor av ALLA event och filtrera på venue.city klientsidan,
  // där vi VET exakt vilket fält som gäller (bekräftat via rådata).
  const TICKSTER_MAX_PAGES = 40;      // 40 × 15 ≈ 600 event genomsökta per hämtning
  const TICKSTER_PAGE_SIZE = 15;      // bekräftat via "count" i svaret utan filter

  async function fetchTicksterRaw({ apiKey, onProgress }) {
    const allRaw = [];
    const wantCities = new Set(TICKSTER_MUNICIPALITIES.map(c => c.toLowerCase()));
    let skip = 0, page = 0, totalKnown = null, matchedCount = 0;

    while (page < TICKSTER_MAX_PAGES) {
      page++;
      onProgress(`Hämtar Tickster: sida ${page} (skip=${skip})…`);
      const url = TICKSTER_BASE + '?' + new URLSearchParams({ key: apiKey, skip: String(skip) }).toString();
      let data;
      try {
        data = await gmGet(url);
      } catch (e) {
        if (/429/.test(e.message)) {
          let ok429 = false;
          for (const waitMs of [4000, 10000]) {
            vlog('Tickster: 429 (för många anrop) — väntar ' + (waitMs / 1000) + 's och försöker igen…', 'err');
            await new Promise(r => setTimeout(r, waitMs));
            try { data = await gmGet(url); ok429 = true; break; }
            catch (e2) { /* fortsätt till nästa väntetid */ }
          }
          if (!ok429) {
            vlog('Tickster: fortsatt 429 efter flera försök — kontot är troligen fortfarande i karantän från en tidigare tät hämtning. ' +
              'Vänta en minut eller två och försök igen (inget kodfel, bara Ticksters hastighetsgräns).', 'err');
            break;
          }
        } else {
          vlog('Tickster sida ' + page + ' misslyckades: ' + e.message, 'err');
          break;
        }
      }
      const hits = data.hits || data.events || data.data || data.results || [];
      if (page === 1) {
        totalKnown = data.total;
        vlog('Tickster: total=' + data.total + ' event i hela flödet. Söker igenom upp till ' +
          (TICKSTER_MAX_PAGES * TICKSTER_PAGE_SIZE) + ' av dem (skip-paginering).');
      }
      if (!Array.isArray(hits) || !hits.length) {
        vlog('Tickster: inga fler rader på sida ' + page + ' — stoppar.');
        break;
      }
      hits.forEach(ev => {
        const city = (ev.venue && ev.venue.city || '').trim().toLowerCase();
        if (wantCities.has(city)) { allRaw.push(ev); matchedCount++; }
      });
      skip += hits.length;
      if (totalKnown != null && skip >= totalKnown) { vlog('Tickster: nått slutet av flödet (skip ≥ total).'); break; }
      await new Promise(r => setTimeout(r, 800));
    }
    vlog('Tickster: genomsökte ' + skip + ' event över ' + page + ' sidor, ' + matchedCount + ' matchade Stockholmsregionen.',
      matchedCount ? 'ok' : 'err');
    return allRaw;
  }

  async function runTickster() {
    const apiKey = $('vseh-tixkey').value.trim();
    if (!apiKey) { setStatus('Fyll i Tickster API-nyckel (fliken Inställningar) först.', 'err'); switchTab('set'); return; }
    GM_setValue('tickster_key', apiKey);
    $('vseh-fetch-tix').disabled = true;
    showProgress('tix', 1, TICKSTER_MAX_PAGES);
    try {
      const raw = await fetchTicksterRaw({
        apiKey,
        onProgress: m => { setStatus(m, 'work'); const n = /sida (\d+)/.exec(m); if (n) showProgress('tix', +n[1], TICKSTER_MAX_PAGES); }
      });
      hideProgress('tix');
      GM_setValue('tickster_fetched_ts', Date.now());
      { const ts = $('vseh-tix-ts'); if (ts) ts.textContent = fmtStamp(Date.now()); }

      // Dedupe på id om det finns, annars på (osäker) titel+datum-gissning.
      const seen = new Set(); const uniq = [];
      raw.forEach(ev => {
        const key = ev.id || ev.eventId || (ev.title || ev.name || '') + '|' + (ev.startDate || ev.start || '');
        if (seen.has(key)) return; seen.add(key); uniq.push(ev);
      });

      // Presentkort/vouchrar (orimligt långa datumspann) tas INTE med i importen.
      const real = uniq.filter(ev => !ticksterLooksLikeGiftCard(ev));
      const giftCards = uniq.length - real.length;
      vlog('Tickster: ' + uniq.length + ' unika Stockholmsevent, ' + real.length + ' riktiga (' + giftCards + ' presentkort/vouchrar uteslutna).', 'ok');

      const occ = real.map(mapTicksterEvent).filter(o => o.date);   // kräver ett tolkningsbart datum
      const grouped = groupEvents(occ, 'tickster');
      // Ersätt BARA Tickster-posterna i den samlade listan — rör inte övriga källor.
      lastGrouped = lastGrouped.filter(g => g._source !== 'tickster').concat(grouped);
      expanded.clear();
      render(lastGrouped); saveCache();

      if (!grouped.length) setStatus('Tickster: inga riktiga Stockholmsevent hittades i det genomsökta intervallet.', 'ok');
      else setStatus(`Tickster: ${grouped.length} event importerade.`, 'ok');
    } catch (e) { hideProgress('tix'); setStatus(e.message, 'err'); }
    finally { $('vseh-fetch-tix').disabled = false; }
  }

  async function runBilletto() {
    $('vseh-fetch-bl').disabled = true;
    showProgress('bl', 1, 1);
    try {
      const { grouped, rawCount } = await fetchBilletto({
        onProgress: m => setStatus(m, 'work'),
        onPage: (cur, total) => showProgress('bl', cur, total)
      });
      hideProgress('bl');
      GM_setValue('billetto_fetched_ts', Date.now());
      { const ts = $('vseh-bl-ts'); if (ts) ts.textContent = fmtStamp(Date.now()); }
      // Ersätt BARA Billetto-posterna i den samlade listan — rör inte Ticketmaster.
      lastGrouped = lastGrouped.filter(g => g._source !== 'billetto').concat(grouped);
      expanded.clear();
      render(lastGrouped); saveCache();
      const note = dedupIndex ? '' : ' (ladda er kalender för status)';
      if (!grouped.length) setStatus('Inga Billetto-event i Stockholm just nu.', 'ok');
      else setStatus(`Klart. ${grouped.length} Billetto-event (${rawCount} tillfällen).${note}`, 'ok');
    } catch (e) { hideProgress('bl'); setStatus(e.message, 'err'); }
    finally { $('vseh-fetch-bl').disabled = false; }
  }

  async function runNortic() {
    $('vseh-fetch-nortic').disabled = true;
    showProgress('nortic', 1, 1);
    try {
      const { grouped, rawCount } = await fetchNortic({
        onProgress: m => setStatus(m, 'work'),
        onPage: (cur, total) => showProgress('nortic', cur, total)
      });
      hideProgress('nortic');
      GM_setValue('nortic_fetched_ts', Date.now());
      { const ts = $('vseh-nortic-ts'); if (ts) ts.textContent = fmtStamp(Date.now()); }
      // Ersätt BARA Nortic-posterna i den samlade listan — rör inte övriga källor.
      lastGrouped = lastGrouped.filter(g => g._source !== 'nortic').concat(grouped);
      expanded.clear();
      render(lastGrouped); saveCache();
      const note = dedupIndex ? '' : ' (ladda er kalender för status)';
      if (!grouped.length) setStatus('Inga Nortic-event i Stockholm just nu.', 'ok');
      else setStatus(`Klart. ${grouped.length} Nortic-event (${rawCount} tillfällen).${note}`, 'ok');
    } catch (e) { hideProgress('nortic'); setStatus(e.message, 'err'); }
    finally { $('vseh-fetch-nortic').disabled = false; }
  }

  function fmtDates(dates) {
    if (!dates.length) return 'datum saknas';
    if (dates.length === 1) return '<b>' + esc(dates[0].date) + '</b>' + (dates[0].time ? ' kl ' + esc(dates[0].time.slice(0,5)) : '');
    return `<b>${dates.length} tillfällen</b> · ${esc(dates[0].date)} – ${esc(dates[dates.length-1].date)}`;
  }
  // Enhetlig datumpresentation: spann → "start – slut", annars "[N] datum",
  // med exakta datum dolda bakom ett klick.
  function datePresent(kind, dates, isSpan, start, end, uid) {
    if (isSpan) return `<span class="dp-span">${esc(start)} – ${esc(end)} (spann)</span>`;
    const list = dates || [];
    if (list.length === 1) return `<span class="dp-one">${esc(list[0])}</span>`;
    if (!list.length) return `<span class="dp-one">${esc(start || '–')}</span>`;
    // flera diskreta datum → "[N] datum" + infällbar lista
    return `<span class="dp-multi" data-dp="${uid}">${list.length} datum <span class="dp-arrow">▸</span></span>` +
           `<div class="dp-dates" id="dp-${uid}" style="display:none;">${list.map(d => esc(d)).join(', ')}</div>`;
  }

  function compareHTML(ev, st, evIdx) {
    const tmDates = ev.dates.map(d => d.date);
    const tmSide = `
      <div class="vseh-cmp-col">
        <h5>Ticketmaster</h5>
        <div class="vseh-item">
          <div class="vseh-item-title">${esc(ev.title)}</div>
          <div class="vseh-item-row"><span class="lab">Plats</span> ${esc(ev.venue_name || ev.address) || '–'}</div>
          <div class="vseh-item-row"><span class="lab">Datum</span> ${datePresent('tm', tmDates, false, tmDates[0], tmDates[tmDates.length-1], 'tm-' + evIdx)}</div>
        </div>
      </div>`;

    let ourSide;
    if (!st.matches.length) {
      ourSide = `<div class="vseh-cmp-col"><h5>Er kalender</h5><div class="vseh-nomatch">Ingen matchande post.</div></div>`;
    } else {
      ourSide = `<div class="vseh-cmp-col"><h5>Er kalender (${st.matches.length} post${st.matches.length > 1 ? 'er' : ''})</h5>` +
        st.matches.map((m, mi) => `
          <div class="vseh-item">
            <div class="vseh-item-btns">
              <button class="vseh-dismiss" data-ev="${evIdx}" data-mi="${mi}" type="button" title="Detta är inte samma event">✔️ Ej samma</button>
              ${m.href ? `<a class="vseh-edit" href="${esc(m.href)}" target="_blank" rel="noopener">🔍 Granska</a>` : ''}
            </div>
            <div class="vseh-item-title">${esc(m.title)}</div>
            <div class="vseh-item-row"><span class="lab">Plats</span> ${esc(m.venue_name || m.address) || '–'}</div>
            <div class="vseh-item-row"><span class="lab">Datum</span> ${datePresent('cal', m.isSpan ? null : [m.start], m.isSpan, m.start, m.end, 'cal-' + evIdx + '-' + mi)}</div>
          </div>`).join('') + `</div>`;
    }
    return `<div class="vseh-compare"><div class="vseh-cmp-grid">${tmSide}${ourSide}</div></div>`;
  }

  function render(events) {
    // URL-flikens knapp delar samma ömsesidiga spärr som kalenderlistans knappar
    // (skriver till samma formulär — får aldrig köras samtidigt).
    { const ub = $('vseh-url-create'); if (ub) ub.disabled = busyCreate.size > 0; }
    const st_display = $('vseh-stats'); if (st_display) st_display.style.display = dedupIndex ? 'flex' : 'none';
    const withStatus = events.map(e => ({ ev: e, st: matchStatus(e) }));

    // Sammanslagna räknare: hanterade = inlagda + skippade; delvis/osäkra ihop.
    let cHan = 0, cPart = 0, cOut = 0, cCancel = 0;
    withStatus.forEach(w => {
      if (w.st.key === 'in') cHan++;                                   // inkl. manuellt hanterade (matchStatus returnerar 'in')
      else if (w.st.key === 'partial' || w.st.key === 'unsure') cPart++;
      else if (w.st.key === 'out') cOut++;
      // Manuellt "Hanterad"-markerade räknas ALDRIG som "Inställda – kräver åtgärd",
      // annars fastnar de där för alltid trots att du redan tagit hand om dem.
      if (w.ev._tm_status_flag && !isManualIn(w.ev) && (w.st.key === 'in' || w.st.key === 'partial')) cCancel++;
    });
    { const ei = $('vseh-n-in'); if (ei) ei.textContent = cHan; }
    { const ep = $('vseh-n-part'); if (ep) ep.textContent = cPart; }
    { const eo = $('vseh-n-out'); if (eo) eo.textContent = cOut; }
    const nc = $('vseh-n-cancel'); if (nc) nc.textContent = cCancel;

    // "Inställda"-rutan syns bara om det finns något inställt inlagt event.
    const cancelBox = $('vseh-stat-cancel');
    if (cancelBox) cancelBox.style.display = cCancel > 0 ? '' : 'none';
    if (cCancel === 0 && activeFilter === 'cancelled') activeFilter = 'out';

    // markera aktiv statruta
    document.querySelectorAll('#vseh-stats .s[data-f]').forEach(x => x.classList.toggle('active', x.dataset.f === activeFilter));

    // Käll-underfilter — bara synligt i "Ej inlagda"-vyn, byggt av de källor
    // som faktiskt finns bland de EJ INLAGDA eventen just nu.
    const srcBox = $('vseh-srcfilter');
    if (srcBox) {
      if (activeFilter === 'out') {
        const outRows = withStatus.filter(w => w.st.key === 'out');
        const outCounts = new Map();
        outRows.forEach(w => {
          const src = w.ev._source || 'okänd';
          outCounts.set(src, (outCounts.get(src) || 0) + 1);
        });
        const outSources = new Set(outCounts.keys());
        if (activeSourceFilter !== 'all' && !outSources.has(activeSourceFilter)) activeSourceFilter = 'all';
        if (outSources.size > 1) {
          srcBox.style.display = 'flex';
          const chips = ['all', ...[...outSources].sort()];
          srcBox.innerHTML = chips.map(src => {
            const label = src === 'all' ? 'Alla källor' : (SOURCE_LABEL[src] || src);
            const count = src === 'all' ? outRows.length : (outCounts.get(src) || 0);
            const active = activeSourceFilter === src;
            const baseColor = src === 'all' ? 'var(--vd-accent)' : (SOURCE_COLOR[src] || '#9aa0ad');
            // Vald källa: fylld bakgrund i källans egen färg (samma "inverterade"
            // stil som andra aktiva knappar i panelen) — ej vald: bara kantfärg.
            const style = active
              ? `background:${baseColor}; border-color:${baseColor}; color:#0d1520;`
              : `border-color:${baseColor};`;
            return `<button type="button" data-src="${esc(src)}" class="${active ? 'active' : ''}" style="${style}">${esc(label)} (${count})</button>`;
          }).join('');
          srcBox.querySelectorAll('button[data-src]').forEach(b => b.addEventListener('click', () => {
            activeSourceFilter = b.dataset.src; render(lastGrouped);
          }));
        } else {
          srcBox.style.display = 'none'; srcBox.innerHTML = '';
        }
      } else {
        srcBox.style.display = 'none'; srcBox.innerHTML = '';
      }
    }

    const shown = withStatus.map((w, i) => ({ ...w, idx: i })).filter(w => {
      if (!passesMonthFilter(w.ev.start_date, monthFilter)) return false;
      if (activeFilter === 'cancelled') {
        const isCancelled = !!w.ev._tm_status_flag && !isManualIn(w.ev);
        const inOurCal = w.st.key === 'in' || w.st.key === 'partial';
        return isCancelled && inOurCal;
      }
      if (activeFilter === 'in') return w.st.key === 'in';                  // Inlagda/hanterade
      if (activeFilter === 'partial') return w.st.key === 'partial' || w.st.key === 'unsure';
      if (activeFilter === 'out') {
        if (w.st.key !== 'out') return false;
        if (activeSourceFilter !== 'all' && (w.ev._source || 'okänd') !== activeSourceFilter) return false;
        return true;
      }
      return true;
    });
    const list = $('vseh-list');
    if (!list) return;   // SBR-läget har ingen kortlista — render() anropas ändå för knapptillstånd
    if (!shown.length) { list.innerHTML = '<div class="vseh-empty">Inga event i denna vy.</div>'; return; }

    list.innerHTML = shown.map(({ ev: e, st, idx }) => {
      const catColor = CATEGORY_COLOR[e.category.title] || '#9aa0ad';
      const s = STATUS[st.key] || STATUS.unknown;
      const canExpand = dedupIndex && (st.key === 'unsure' || st.key === 'partial');
      const barColor = dedupIndex ? s.bar : '#3a3f4b';
      const badge = dedupIndex ? `<span class="vseh-badge ${canExpand ? 'expandable' : ''}" style="background:${s.bg};color:${s.fg}" data-x="${idx}">${s.label}</span>` : '';
      const catTag = `<span class="vseh-cat" style="background:${catColor}">${esc(e.category.title)}</span>`;
      const orgTag = `<span class="vseh-org">${esc(e.promoter || 'okänd arrangör')}</span>`;
      const srcColor = SOURCE_COLOR[e._source] || '#9aa0ad';
      const srcLabel = SOURCE_LABEL[e._source] || (e._source || 'okänd källa');
      const sourceTag = `<span class="vseh-src" style="background:${srcColor}">${esc(srcLabel)}</span>`;
      const detail = (dedupIndex && st.detail) ? `<div class="detail">${esc(st.detail)}</div>` : '';
      const cancelFlag = e._tm_status_flag
        ? `<div class="vseh-cancel">⚠️ Ticketmaster: ${esc(e._tm_status_flag).toUpperCase()} — uppdatera kalendern</div>` : '';
      const cmp = (canExpand && expanded.has(idx)) ? compareHTML(e, st, idx) : '';
      // "Skapa utkast"-knapp på allt som inte är säkert inlagt
      const showCreate = !dedupIndex || st.key !== 'in';
      const busy = busyCreate.has(idx);
      const anyBusy = busyCreate.size > 0;   // spärra ALLA knappar medan ett event bearbetas
      const done = doneCreate.get(idx);
      let btnLabel, btnCls, btnDis;
      if (busy) { btnLabel = '✏️ skapar…'; btnCls = 'busy'; btnDis = 'disabled'; }
      else if (done) { btnLabel = '✏️ utkast skapat ' + done; btnCls = 'done'; btnDis = 'disabled'; }
      else if (anyBusy) { btnLabel = '✏️ skapa utkast'; btnCls = ''; btnDis = 'disabled'; }
      else { btnLabel = '✏️ skapa utkast'; btnCls = ''; btnDis = ''; }
      // "Hanterad" — en knapp för "redan inlagt", "ska medvetet inte in", ELLER
      // "detta inställda event är åtgärdat" (annars går det aldrig att markera
      // klart och "Inställda"-rutan kan aldrig tömmas).
      const manIn = isManualIn(e);
      const isCancelledEvent = !!e._tm_status_flag;
      const manInBtn = (dedupIndex && (st.key !== 'in' || manIn || isCancelledEvent))
        ? `<button class="vseh-manin ${manIn ? 'on' : ''}" data-manin="${idx}" type="button">${manIn ? '↩︎ Ångra hanterat' : '✓ Hanterat'}</button>` : '';
      const createBtn = showCreate
        ? `<div class="vseh-create"><button class="${btnCls}" data-create="${idx}" type="button" ${btnDis}>${btnLabel}</button>${manInBtn}</div>`
        : `<div class="vseh-create">${manInBtn}</div>`;
      const es = eventStatus.get(idx);
      const esLine = es ? `<div class="vseh-ev-status ${es.kind}" data-si="${idx}">${esc(es.msg)}</div>`
                        : `<div class="vseh-ev-status" data-si="${idx}" style="display:none;"></div>`;
      return `<div class="vseh-ev" style="border-left-color:${barColor}">
        <h4><span>${esc(e.title)}</span>${badge}</h4>
        <div class="m">${e.venue_name ? '<span class="v">' + esc(e.venue_name) + '</span>' : ''}${e.city ? ' · ' + esc(e.city) : ''}</div>
        <div class="dates">${fmtDates(e.dates)}</div>${detail}${cancelFlag}
        <div class="tags">${catTag}${orgTag}${sourceTag}</div>
        ${cmp}${createBtn}${esLine}
      </div>`;
    }).join('');

    list.querySelectorAll('.vseh-badge.expandable').forEach(b => b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.x, 10);
      if (expanded.has(idx)) expanded.delete(idx); else expanded.add(idx);
      render(events);
    }));
    list.querySelectorAll('button[data-create]').forEach(b => b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.create, 10);
      vlog('Klick på "skapa utkast", event-index ' + idx);
      createEvent(events[idx], idx);
    }));
    list.querySelectorAll('button[data-manin]').forEach(b => b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.manin, 10);
      toggleManualIn(events[idx]);
      render(events);
    }));
    list.querySelectorAll('.vseh-dismiss').forEach(b => b.addEventListener('click', () => {
      const evIdx = parseInt(b.dataset.ev, 10);
      const mi = parseInt(b.dataset.mi, 10);
      const ev = events[evIdx];
      const st = matchStatus(ev);
      const row = st.matches[mi];
      if (ev && row) {
        dismissPair(ev, row);
        vlog('Avmarkerade felmatchning: "' + ev.title + '" ≠ "' + row.title + '"', 'ok');
        render(events);
      }
    }));
    // Datum-utfällning (▸) inuti jämförelsen
    list.querySelectorAll('.dp-multi').forEach(el => el.addEventListener('click', () => {
      const box = document.getElementById('dp-' + el.dataset.dp);
      if (!box) return;
      const open = box.style.display !== 'none';
      box.style.display = open ? 'none' : 'block';
      const arrow = el.querySelector('.dp-arrow');
      if (arrow) arrow.textContent = open ? '▸' : '▾';
    }));
  }

  function updateDupCount(n) {
    const el = document.getElementById('vseh-dup-count');
    if (el) el.textContent = (n != null && n > 0) ? '(' + n + ')' : '';
  }

  async function doCleanupScan() {
    if (!dedupIndex) { $('vseh-cleanbody').innerHTML = '<div class="vseh-empty">Ladda er kalender först (fliken Kalendrar).</div>'; return; }
    const from = ($('vseh-clean-from') && $('vseh-clean-from').value) || '';
    const to = ($('vseh-clean-to') && $('vseh-clean-to').value) || '';
    const runBtn = document.getElementById('vseh-clean-run');
    if (runBtn) runBtn.disabled = true;
    $('vseh-cleanbody').innerHTML = '<div class="vseh-empty">Söker…</div>';
    await new Promise(r => setTimeout(r, 30));
    let allGroups;
    try {
      allGroups = findCalendarDuplicates(m => vlog(m), from || null, to || null);
    } catch (e) {
      $('vseh-cleanbody').innerHTML = '<div class="vseh-empty">Fel: ' + esc(e.message) + '</div>';
      if (runBtn) runBtn.disabled = false;
      return;
    }
    lastCleanupGroups = allGroups;
    const visible = allGroups.filter(g => !isGroupCleared(g));
    const clearedCount = allGroups.length - visible.length;
    renderCleanup(visible, clearedCount);
    updateDupCount(visible.length);
    if (runBtn) runBtn.disabled = false;
  }

  function renderCleanup(groups, clearedCount) {
    const body = $('vseh-cleanbody');
    const clearedBanner = clearedCount
      ? `<div class="vseh-cleared-banner">${clearedCount} grupp(er) avflaggade. <button id="vseh-show-cleared">Visa avflaggade</button></div>` : '';
    if (!groups.length) {
      body.innerHTML = clearedBanner + '<div class="vseh-clean-empty">Inga kvar att granska i intervallet. (Grupper om 2 tolkas som språkpar och visas inte.)</div>';
      wireClearedBanner();
      return;
    }
    const cell = r => `
      <div class="vseh-dup-col">
        <div class="val">${esc(r.title)}</div>
        <div><span class="lab">Plats:</span> ${esc(r.venue_name) || '–'}</div>
        <div><span class="lab">Datum:</span> ${r.isSpan ? esc(r.start) + ' – ' + esc(r.end) : '<b>' + esc(r.start || '–') + '</b>'}</div>
        ${r.href ? `<a href="${esc(r.href)}" target="_blank" rel="noopener">🔍 Granska</a>` : ''}
      </div>`;

    body.innerHTML = clearedBanner + groups.map((g, gi) => {
      const subsHtml = g.map(cell).join('');
      const headerText = g.length === 2
        ? `2 poster med IDENTISK titel på båda — inget uppenbart språkpar, kontrollera manuellt`
        : `${g.length} poster — förväntat 2 (språkpar), så ${g.length - 2} kan vara dubblett(er)`;
      return `
      <div class="vseh-dup-group" data-sig="${esc(groupSignature(g))}">
        <div class="vseh-dup-ghdr">
          <span>${headerText}</span>
          <button class="vseh-notdup" data-gi="${gi}">Inte dubblett</button>
        </div>
        <div class="vseh-dup-cols">${subsHtml}</div>
      </div>`;
    }).join('');

    // Wire "Inte dubblett" buttons
    body.querySelectorAll('.vseh-notdup').forEach(b => b.addEventListener('click', () => {
      const gi = parseInt(b.dataset.gi, 10);
      const g = groups[gi];
      if (!g) return;
      clearGroup(g);
      vlog('Avflaggade grupp (inte dubblett): ' + g.map(r => r.title).join(' / '), 'ok');
      // Rita om utan den avflaggade
      const from = ($('vseh-clean-from') && $('vseh-clean-from').value) || '';
      const to = ($('vseh-clean-to') && $('vseh-clean-to').value) || '';
      const visible = lastCleanupGroups.filter(x => !isGroupCleared(x));
      const clearedNow = lastCleanupGroups.length - visible.length;
      renderCleanup(visible, clearedNow);
      updateDupCount(visible.length);
    }));
    wireClearedBanner();
  }

  function wireClearedBanner() {
    const btn = document.getElementById('vseh-show-cleared');
    if (btn) btn.addEventListener('click', showClearedGroups);
  }

  function showClearedGroups() {
    const cleared = lastCleanupGroups.filter(g => isGroupCleared(g));
    const body = $('vseh-cleanbody');

    const cell = r => `
      <div class="vseh-dup-col">
        <div class="val">${esc(r.title)}</div>
        <div><span class="lab">Plats:</span> ${esc(r.venue_name) || '–'}</div>
        <div><span class="lab">Datum:</span> ${r.isSpan ? esc(r.start) + ' – ' + esc(r.end) : '<b>' + esc(r.start || '–') + '</b>'}</div>
        ${r.href ? `<a href="${esc(r.href)}" target="_blank" rel="noopener">🔍 Granska</a>` : ''}
      </div>`;
    body.innerHTML = `<div class="vseh-cleared-banner"><button id="vseh-back-suspect">← Tillbaka till misstänkta</button></div>` +
      (cleared.length ? cleared.map((g, gi) => `
      <div class="vseh-dup-group" style="border-color:var(--vd-line);opacity:.85;">
        <div class="vseh-dup-ghdr">
          <span>${g.length} poster — avflaggad som "inte dubblett"</span>
          <button class="vseh-restore" data-gi="${gi}">Återställ</button>
        </div>
        <div class="vseh-dup-cols">${g.map(cell).join('')}</div>
      </div>`).join('') : '<div class="vseh-clean-empty">Inga avflaggade grupper.</div>');

    document.getElementById('vseh-back-suspect').addEventListener('click', () => {
      const visible = lastCleanupGroups.filter(x => !isGroupCleared(x));
      renderCleanup(visible, lastCleanupGroups.length - visible.length);
    });
    body.querySelectorAll('.vseh-restore').forEach(b => b.addEventListener('click', () => {
      const gi = parseInt(b.dataset.gi, 10);
      const g = cleared[gi];
      if (!g) return;
      unclearGroup(groupSignature(g));
      vlog('Återställde avflaggad grupp: ' + g.map(r => r.title).join(' / '), 'ok');
      showClearedGroups();  // rita om avflaggade-vyn
      const visible = lastCleanupGroups.filter(x => !isGroupCleared(x));
      updateDupCount(visible.length);
    }));
  }

  // ---- Draftvy-Dubblettkoll (draft-listan) ---------------------------------
  // Ny sidtyp: draft-listan (KNOWN_DRAFT_URL). Ingen egen panel — märker bara
  // synliga rader i Wagtails egen listvy med en färgad kant baserad på samma
  // matchStatus()/dedupIndex som huvudpanelen redan använder.
  // Egen liten stilbit för draft-listans stapel — själva märkena/jämförelse-
  // vyn återanvänder PANEL_CSS:s .vseh-badge/.vseh-compare/.vseh-item-klasser
  // rakt av (de är alla fristående klassregler, inte beroende av #vseh-panel
  // som förälder), så de ser likadana ut som i huvudpanelens dubblettvy.
  const DRAFT_EXTRA_CSS = `
    #vseh-draft-bar { position:sticky; top:0; z-index:9999; display:flex; align-items:center;
      flex-wrap:wrap; gap:10px; background:#2f3542; color:#e8eaee; padding:10px 14px;
      margin:0 0 14px; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,.3);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    #vseh-draft-bar button { padding:8px 14px; border:none; border-radius:5px; cursor:pointer;
      font-size:13px; font-weight:600; }
    #vseh-draft-check-btn { background:#4a9fe0; color:#fff; }
    #vseh-draft-fetch-btn { background:#787e8a; color:#fff; }
    #vseh-draft-bar button:disabled { opacity:.6; cursor:not-allowed; }
    #vseh-draft-ts, #vseh-draft-progress { font-size:12px; color:#c3c8d1; }
    .vseh-draft-cmp-row td { background:var(--vd-bg2); padding:10px 14px; }
  `;

  function ensureDraftStyle() {
    if (document.getElementById('vseh-draft-css')) return;
    const s = document.createElement('style');
    s.id = 'vseh-draft-css';
    s.textContent = PANEL_CSS + DRAFT_EXTRA_CSS;
    document.head.appendChild(s);
  }

  function initDraftvyDubblettkoll() {
    vlog('Draftvy-Dubblettkoll: Initierar på draft-lista');
    ensureDraftStyle();
    if (!document.getElementById('vseh-draft-bar')) {
        const bar = document.createElement('div');
        bar.id = 'vseh-draft-bar';
        bar.innerHTML = `
          <button type="button" id="vseh-draft-check-btn">🎭Dubblettkoll</button>
          <button type="button" id="vseh-draft-fetch-btn">Hämta Visit-Kalendern</button>
          <span id="vseh-draft-ts"></span>
          <span id="vseh-draft-progress"></span>
        `;
        insertBarAtTop(bar);
        document.getElementById('vseh-draft-check-btn').addEventListener('click', runDraftvyCheck);
        document.getElementById('vseh-draft-fetch-btn').addEventListener('click', loadDedupForDraft);
    }
    updateDraftvyTs();
    // Ingen automatisk hämtning här (den är tung — läser hela Visit-kalendern
    // sida för sida). Vi hydrerar bara från det som redan finns sparat i
    // GM-cacheminnet (CACHE_CAL, samma cache som huvudpanelens "VisitStockholm"-
    // knapp sparar till) och visar dubblettmärken direkt från det om det finns
    // — annars väntar vi på att "Hämta Visit-Kalendern" klickas manuellt.
    if (!dedupIndex) loadCache();
    if (dedupIndex) runDraftvyCheck();
  }

  function updateDraftvyTs() {
    const ts = document.getElementById('vseh-draft-ts');
    if (ts) ts.textContent = fmtStamp(GM_getValue('vs_fetched_ts', 0));
  }

  async function loadDedupForDraft() {
    const btn = document.getElementById('vseh-draft-fetch-btn');
    if (btn) btn.disabled = true;
    const prog = document.getElementById('vseh-draft-progress');
    try {
      const rows = await buildDedupIndex(
        m => vlog(m),
        (cur, total) => { if (prog) prog.textContent = `Läser sida ${cur}/${total}`; }
      );
      dedupIndex = buildIndexFromRows(rows);
      GM_setValue('vs_fetched_ts', Date.now());
      updateDraftvyTs();
      saveCache();
      if (prog) prog.textContent = '';
      vlog(`Draftvy: Kalender laddad med ${rows.length} rader`, 'ok');
      runDraftvyCheck();
    } catch (error) {
      if (prog) prog.textContent = '';
      vlog('Draftvy: Fel vid laddning - ' + error.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Draft-vyns egna badge-kategorier — OBS: detta är INTE samma färgmappning
  // som huvudpanelens STATUS (där "Ej inlagt" är rött, för att den vyn visar
  // KÄLL-event som saknas i kalendern och alltså bör skapas). Här är
  // semantiken den omvända: "ej inlagd" för ett UTKAST är den trygga,
  // förväntade statusen (grön), medan en bekräftad träff ("in") betyder att
  // utkastet redan finns i kalendern som en riktig dubblett (röd).
  function draftBadgeInfo(st) {
    if (st.key === 'out') return { emoji: '✅', label: 'Ej inlagd', bg: '#1f7a4d', fg: '#fff', expandable: false };
    if (st.key === 'in') return { emoji: '🎭', label: 'Dubblett', bg: '#c02626', fg: '#fff', expandable: true };
    if (st.key === 'partial' || st.key === 'unsure') return { emoji: '🤔', label: 'Osäker', bg: '#c9881f', fg: '#fff', expandable: true };
    return null;   // 'unknown' — dedupIndex ej laddat än
  }

  const draftExpandedPks = new Set();

  function runDraftvyCheck() {
    if (!dedupIndex) {
      vlog('Draftvy: Ingen kalenderdata', 'err');
      return;
    }
    vlog('Draftvy: Kör dubblettkontroll på synliga rader');
    const rows = document.querySelectorAll('tr[data-object-pk]');
    if (rows.length === 0) {
      vlog('Draftvy: Inga rader funna', 'err');
      return;
    }
    // Städa bort ev. märken/jämförelserader från en tidigare körning innan
    // vi ritar om, så de inte dubbleras.
    document.querySelectorAll('.vseh-draft-badge').forEach(b => b.remove());
    document.querySelectorAll('.vseh-draft-cmp-row').forEach(r => r.remove());

    let checked = 0;
    const counts = { 'Ej inlagd': 0, Osäker: 0, Dubblett: 0 };
    rows.forEach(row => {
      const rowData = extractRowData(row);
      if (!rowData || !rowData.title) return;
      checked++;
      const st = matchStatus(rowData, { strict: true });
      const info = draftBadgeInfo(st);
      if (!info) return;
      counts[info.label] = (counts[info.label] || 0) + 1;

      const titleWrap = row.querySelector('td.field-title_en .title-wrapper');
      if (!titleWrap) return;
      titleWrap.style.display = 'inline-flex';
      titleWrap.style.alignItems = 'center';
      titleWrap.style.gap = '6px';

      const badge = document.createElement('span');
      badge.className = 'vseh-badge vseh-draft-badge' + (info.expandable ? ' expandable' : '');
      badge.style.background = info.bg;
      badge.style.color = info.fg;
      badge.textContent = info.emoji + ' ' + info.label;
      titleWrap.insertBefore(badge, titleWrap.firstChild);

      const pk = row.dataset.objectPk;
      if (info.expandable) {
        if (draftExpandedPks.has(pk)) insertDraftCompareRow(row, rowData, st, pk);
        badge.addEventListener('click', () => {
          if (draftExpandedPks.has(pk)) {
            draftExpandedPks.delete(pk);
            const next = row.nextElementSibling;
            if (next && next.classList.contains('vseh-draft-cmp-row')) next.remove();
          } else {
            draftExpandedPks.add(pk);
            insertDraftCompareRow(row, rowData, st, pk);
          }
        });
      }
    });
    vlog(`Draftvy: Kontrollerade ${checked} rader — ${counts.Dubblett} dubblett(er), ${counts.Osäker} osäkra, ${counts['Ej inlagd']} ej inlagda`,
      (counts.Dubblett || counts.Osäker) ? 'err' : 'ok');
  }

  function insertDraftCompareRow(row, rowData, st, pk) {
    const old = row.nextElementSibling;
    if (old && old.classList.contains('vseh-draft-cmp-row')) old.remove();
    const tr = document.createElement('tr');
    tr.className = 'vseh-draft-cmp-row';
    const td = document.createElement('td');
    td.colSpan = row.children.length;
    td.innerHTML = draftCompareHTML(rowData, st, pk);
    tr.appendChild(td);
    row.insertAdjacentElement('afterend', tr);
    tr.querySelectorAll('.dp-multi').forEach(el => el.addEventListener('click', () => {
      const box = document.getElementById('dp-' + el.dataset.dp);
      if (!box) return;
      const open = box.style.display !== 'none';
      box.style.display = open ? 'none' : 'block';
      const arrow = el.querySelector('.dp-arrow');
      if (arrow) arrow.textContent = open ? '▸' : '▾';
    }));
    // Samma par-specifika avmarkering (dismissPair/isDismissed) som huvud-
    // panelens "✔️ Ej samma"-knapp redan använder — matchStatus() hoppar
    // sedan automatiskt över det paret nästa gång (körs om via
    // runDraftvyCheck() nedan, som ritar om hela raden med uppdaterad status).
    tr.querySelectorAll('.vseh-draft-notdup').forEach(btn => btn.addEventListener('click', () => {
      const mi = parseInt(btn.dataset.mi, 10);
      const match = st.matches[mi];
      if (!match) return;
      dismissPair(rowData, match);
      vlog('Draftvy: Avmarkerade felmatchning: "' + rowData.title + '" ≠ "' + match.title + '"', 'ok');
      runDraftvyCheck();
    }));
  }

  // Jämförelsevy för draft-listan — samma visuella mönster som huvud-
  // panelens compareHTML() (vseh-compare/vseh-cmp-grid/vseh-item), men
  // vänster kolumn visar UTKASTET (verktygets egen import av tabellraden)
  // istället för en API-källa som Ticketmaster.
  function draftCompareHTML(rowData, st, pk) {
    const ourDates = rowData.dates.map(d => d.date);
    const draftSide = `
      <div class="vseh-cmp-col">
        <h5>Detta utkast</h5>
        <div class="vseh-item">
          <div class="vseh-item-title">${esc(rowData.title)}</div>
          <div class="vseh-item-row"><span class="lab">Adress</span> ${esc(rowData.address) || '–'}</div>
          <div class="vseh-item-row"><span class="lab">Datum</span> ${datePresent('draft', ourDates, false, ourDates[0], ourDates[ourDates.length - 1], 'draft-' + pk)}</div>
        </div>
      </div>`;

    let calSide;
    if (!st.matches.length) {
      calSide = `<div class="vseh-cmp-col"><h5>Visit-kalendern</h5><div class="vseh-nomatch">Ingen matchande post.</div></div>`;
    } else {
      calSide = `<div class="vseh-cmp-col"><h5>Visit-kalendern (${st.matches.length} post${st.matches.length > 1 ? 'er' : ''})</h5>` +
        st.matches.map((m, mi) => `
          <div class="vseh-item">
            <div class="vseh-item-btns">
              <button class="vseh-dismiss vseh-draft-notdup" data-mi="${mi}" type="button" title="Detta är inte samma event">✅ Ej dublett</button>
              ${m.href ? `<a class="vseh-edit" href="${esc(m.href)}" target="_blank" rel="noopener">🔍 Granska</a>` : ''}
            </div>
            <div class="vseh-item-title">${esc(m.title)}</div>
            <div class="vseh-item-row"><span class="lab">Plats</span> ${esc(m.venue_name || m.address) || '–'}</div>
            <div class="vseh-item-row"><span class="lab">Datum</span> ${datePresent('cal', m.isSpan ? null : [m.start], m.isSpan, m.start, m.end, 'draftcal-' + pk + '-' + mi)}</div>
          </div>`).join('') + `</div>`;
    }
    return `<div class="vseh-compare"><div class="vseh-cmp-grid">${draftSide}${calSide}</div></div>`;
  }

  // Kolumnerna är td.field-title_en / field-title_sv / field-address /
  // field-start_date / field-modified_at / field-status, bekräftat mot
  // riktig markup från draft-listan (2026-09-14). Titeln ligger i en <a>
  // inuti .title-wrapper — "Redigera"/"Radera" är separata <li>-element i
  // en .actions-lista i SAMMA <td>, inte en del av titeltexten, så inget
  // behöver städas bort.
  function extractRowData(row) {
    const titleEl = row.querySelector('td.field-title_en .title-wrapper a, td.field-title_en a');
    const title = (titleEl?.textContent || '').trim();
    if (!title) return null;

    const address = (row.querySelector('td.field-address')?.textContent || '').trim();
    const startRaw = (row.querySelector('td.field-start_date')?.textContent || '').trim();
    const start_date = parseSwedishDate(startRaw);

    return {
      title,
      venue_name: '',
      address,
      start_date,
      end_date: null,
      dates: start_date ? [{ date: start_date }] : [],
      _source: 'draft'
    };
  }

  // ---- EventChecker (sticky bar, edit-sida) --------------------------------
  // Ny sidtyp: edit-sidan (KNOWN_EDIT_URL). Sticky bar högst upp (samma
  // mönster som draft-vyns #vseh-draft-bar) med avvikelsesammanfattningen
  // och diagnostikloggen. Hade tidigare även en egen "Skriv om 🤖"-knapp som
  // skickade HELA formuläret till en Mistral-agent för omskrivning — borttagen
  // 2026-09-19 (på begäran) eftersom de per-fält-knapparna som redan sitter
  // bredvid respektive fält (checkGuidelineIssues/checkTitleCasing) gör
  // samma jobb mer träffsäkert.
  const EDIT_BAR_CSS = `
    #vseh-edit-bar { position:sticky; top:0; z-index:9999; display:flex; align-items:center;
      flex-wrap:wrap; gap:10px; background:#2f3542; color:#e8eaee; padding:10px 14px;
      margin:0 0 14px; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,.3);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    #vseh-edit-bar button { padding:8px 14px; border:none; border-radius:5px; cursor:pointer;
      font-size:13px; font-weight:600; background:#4a9fe0; color:#fff; }
    #vseh-edit-bar button:disabled { opacity:.6; cursor:not-allowed; }
    #vseh-consent-bar { position:sticky; top:0; z-index:9999; display:flex; align-items:center;
      flex-wrap:wrap; gap:10px; background:#5a3a1a; color:#fff; padding:10px 14px;
      margin:0 0 14px; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,.3); font-weight:600;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    #vseh-consent-bar button { padding:8px 14px; border:none; border-radius:5px; cursor:pointer; font-size:13px; font-weight:600; }
    #vseh-consent-yes { background:#1f7a4d; color:#fff; }
    #vseh-consent-no { background:#787e8a; color:#fff; }
  `;
  function ensureEditBarStyle() {
    if (document.getElementById('vseh-edit-css')) return;
    const s = document.createElement('style');
    s.id = 'vseh-edit-css';
    // PANEL_CSS ger :root-variablerna (--vd-*) och de färdiga
    // #vseh-logwrap/#vseh-log-reglerna som loggfönstret nedan återanvänder.
    s.textContent = PANEL_CSS + EDIT_BAR_CSS;
    document.head.appendChild(s);
  }
  function initEventChecker() {
    vlog('EventChecker: Initierar på edit-sida');
    ensureEditBarStyle();
    if (!document.getElementById('vseh-edit-bar')) {
      const anchor = document.querySelector('.page-header, .header, header, h1') || document.querySelector('form');
      if (anchor) {
        const bar = document.createElement('div');
        bar.id = 'vseh-edit-bar';
        bar.innerHTML = `
          <span id="vseh-issues-summary" style="color:#e0a052;font-weight:600;"></span>
          <button type="button" id="vseh-edit-logbtn" title="Visa logg">📋 Logg</button>
        `;
        anchor.parentNode.insertBefore(bar, anchor.nextSibling);
        const logWrap = document.createElement('div');
        logWrap.id = 'vseh-logwrap';
        logWrap.style.display = 'none';
        logWrap.innerHTML = `
          <div class="vseh-loghdr">Diagnostiklogg <span style="display:flex;gap:5px;">
            <button type="button" id="vseh-logcopy" title="Kopiera loggen">📋 Kopiera</button>
            <button type="button" id="vseh-logclose" title="Stäng">✕</button></span></div>
          <div id="vseh-log"></div>
        `;
        document.body.appendChild(logWrap);
        document.getElementById('vseh-edit-logbtn').addEventListener('click', () => {
          const w = document.getElementById('vseh-logwrap');
          w.style.display = (w.style.display === 'none' || !w.style.display) ? 'flex' : 'none';
          renderLog();
        });
        document.getElementById('vseh-logclose').addEventListener('click', () => {
          document.getElementById('vseh-logwrap').style.display = 'none';
        });
        document.getElementById('vseh-logcopy').addEventListener('click', async () => {
          const btn = document.getElementById('vseh-logcopy');
          const text = VLOG.map(e => e.line).join('\n');
          try { await navigator.clipboard.writeText(text); btn.textContent = '✓ Kopierat'; setTimeout(() => btn.textContent = '📋 Kopiera', 1200); }
          catch { btn.textContent = 'Fel'; setTimeout(() => btn.textContent = '📋 Kopiera', 1200); }
        });
      }
    }
  }

  // ---- Edit-sidans automatiska kontroller (v7.56.0) -------------------------
  // Körs automatiskt på edit-sidan (KNOWN_EDIT_URL), utöver EventChecker-
  // rewrite-baren ovan (initEventEditAutomation anropar båda). Emoji tas bort
  // automatiskt ur både titlar och beskrivning (bekräftat OK — texten är i
  // regel oformaterad). Pris-flaggen är bara läsande. Guide-taggning lägger
  // bara till, ändrar inget befintligt. Adress-aktiveringen återställer
  // exakt samma värde den läste.
  const PRICE_WORD_RE = /\b(sek|kr|eur)\b|€/gi;
  const EMOJI_RE = /\p{Extended_Pictographic}/gu;
  // Klockslag i löptext ("18:00", "kl 19", "kl. 19", "klockan 20") — tid ska
  // stå i datumfälten, inte i beskrivningen.
  const TIME_IN_TEXT_RE = /\b\d{1,2}[:.]\d{2}\b|\bkl\.?\s?\d{1,2}\b|\bklockan\b/i;
  // Kalenderdatum i löptext ("Den 23–24 oktober", "On 23–24 October") —
  // samma princip som TIME_IN_TEXT_RE ovan, fast för datum: ska fyllas i i
  // datumfälten, inte skrivas i beskrivningen. Kräver ett tal intill
  // månadsnamnet (inte bara "i mars" eller "oktoberfest") för att undvika
  // falska positiver på månadsnamn som förekommer i annan betydelse.
  const MONTH_NAMES_RE = 'januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december|' +
    'january|february|march|may|june|july|august|october';
  const DATE_IN_TEXT_RE = new RegExp(
    '\\b\\d{1,2}(\\s*[-–]\\s*\\d{1,2})?\\s+(' + MONTH_NAMES_RE + ')\\b|' +
    '\\b(' + MONTH_NAMES_RE + ')\\s+\\d{1,2}(\\s*[-–]\\s*\\d{1,2})?\\b', 'i');
  // Länkar skrivna rakt in i löptexten ("Boka på www.example.com" /
  // "https://...") — länkar ska fyllas i i External website url-fältet,
  // inte i beskrivningen (samma princip som pris/tid/datum ovan).
  const URL_IN_TEXT_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;
  // Draftails RIKTIGA hyperlänkar (skapade via länk-knappen i editorn) syns
  // inte nödvändigtvis som URL-text i den platta text readDraftailText()
  // extraherar — ankartexten kan vara vad som helst, t.ex. "Läs mer här" —
  // så de måste kollas separat mot Draft.js-JSON:ens egen entityMap.
  function draftailHasLinkEntity(fieldId) {
    const hidden = document.getElementById(fieldId);
    if (!hidden || !hidden.value) return false;
    try {
      const data = JSON.parse(hidden.value);
      return Object.values(data.entityMap || {}).some(e => e.type === 'LINK');
    } catch { return false; }
  }
  // Kontaktuppgifter (telefon/mejl) i löptext — riktlinjerna kräver att man
  // hänvisar till arrangörens egen sida istället för att skriva ut direkt
  // kontaktväg (samma princip som pris/länk ovan). Telefonregexen kräver
  // ledande "+46"/"0" (svenskt riktnummer/landsnummer) och minst 7 siffror
  // totalt (mellanslag/bindestreck tillåtna som separatorer) för att inte
  // träffa datum ("23-24 oktober"), tider ("09:00-17:00") eller postnummer.
  const PHONE_IN_TEXT_RE = /(?:\+?46[\s-]?|\b0)\d(?:[\s-]?\d){6,9}\b/;
  const EMAIL_IN_TEXT_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const WE_US_WORDS_SV = ['vi', 'oss', 'vår', 'vårt', 'våra'];
  const WE_US_WORDS_EN = ['we', 'us', 'our'];
  // Bekräftade 2026-09-18 (+ "vänner och familj"/"kompisgänget"/"unik
  // upplevelse"/"missa inte chansen" tillagda på begäran).
  const HYPE_WORDS = ['fantastisk', 'magisk', 'underbar', 'vänner och familj',
    'kompisgänget', 'unik upplevelse', 'missa inte chansen'];
  // Nyckelord för "Vi publicerar inte"-kategorier ur riktlinjerna — bara de
  // som bedömdes tillräckligt träffsäkra att flagga med enkla nyckelord
  // (privata boka-själv-upplägg och "utanför Stockholmsregionen" är för
  // otillförlitliga att fånga så här, och hoppas därför över helt).
  // "mässa" hanteras separat (se checkGuidelineIssues) eftersom ordet också
  // är helt legitimt för kategorin Fairs.
  const INELIGIBLE_EVENT_WORDS = ['happy hour', 'aw', 'rea', 'rabatt', 'erbjudande',
    'årsmöte', 'medlemsmöte', 'endast medlemmar', 'valmöte', 'torgmöte', 'partimöte'];

  // De riktlinjeavvikelser som faktiskt går att ÅTGÄRDA med en textomskrivning
  // (till skillnad från "Möjlig otillåten eventtyp"/"mässa", som är en
  // redaktionell bedömningsfråga om eventet överhuvudtaget ska publiceras —
  // ingen omskrivning kan lösa det). `frag` är den korta beskrivningen under
  // knappen ("Mistral " + fragment + ", " + fragment + ..."), `instruction`
  // är raden som faktiskt skickas till Mistral som redigeringsinstruktion.
  const GUIDELINE_FIXES = {
    'Prisinfo': { frag: 'tar bort prisuppgifter', instruction: 'Ta bort alla prisuppgifter/kronbelopp.' },
    'Tidsinfo i fält': { frag: 'tar bort klockslag', instruction: 'Ta bort klockslag/tidsangivelser (tiden fylls redan i i datumfälten).' },
    'Datuminfo i fält': { frag: 'tar bort datumangivelser', instruction: 'Ta bort datumangivelser (datumet fylls redan i i datumfälten).' },
    'Platsinfo i fält': { frag: 'tar bort upprepat platsnamn', instruction: 'Ta bort upprepning av platsnamnet/venue (det fylls redan i i ett eget fält).' },
    'Adressinfo i fält': { frag: 'tar bort upprepad adress', instruction: 'Ta bort upprepning av adressen (den fylls redan i i ett eget fält).' },
    'Länk i fält': { frag: 'tar bort länkar/webbadresser', instruction: 'Ta bort webbadresser/länkar ur texten (länkar fylls redan i i länkfältet).' },
    'Kontaktuppgift i fält': { frag: 'tar bort telefonnummer/mejladresser', instruction: 'Ta bort telefonnummer och mejladresser ur texten — hänvisa till arrangörens egen sida istället.' },
    'Vi/oss-språk': { frag: 'skriver om "vi"/"oss" till tredje person', instruction: 'Skriv om "vi"/"oss"/"vår"-formuleringar till tredje person, så det inte ser ut som Visit Stockholm är arrangören.' },
    'Säljspråk': { frag: 'tar bort säljande formuleringar', instruction: 'Ta bort säljande/hypande formuleringar — håll tonen neutral och saklig.' }
  };

  // En typspecifik emoji per avvikelse istället för samma ⚠️ upprepad på
  // varje rad (på begäran 2026-09-19) — gör det lättare att skanna VILKEN
  // sorts fel det är utan att läsa hela raden.
  const GUIDELINE_ISSUE_EMOJI = {
    'Prisinfo': '💰',
    'Tidsinfo i fält': '🕐',
    'Datuminfo i fält': '🕐',
    'Platsinfo i fält': '📍',
    'Adressinfo i fält': '📍',
    'Länk i fält': '🔗',
    'Kontaktuppgift i fält': '📞',
    'Vi/oss-språk': '🗣️',
    'Säljspråk': '📢',
    'Möjlig otillåten eventtyp': '🚫'
  };

  function fieldWrapper(el) {
    return (el && (el.closest('.w-field, .w-panel, [data-field]') || el.parentElement)) || null;
  }

  // Beskrivningsfältens dolda input hålls av Draftail synkad med en rå
  // Draft.js-JSON ({"blocks":[{"text":"..."}]}) — läser den direkt istället
  // för att montera/röra själva rich text-editorn, eftersom vi bara LÄSER.
  function readDraftailText(fieldId) {
    const hidden = document.getElementById(fieldId);
    if (!hidden || !hidden.value) return '';
    try { return (JSON.parse(hidden.value).blocks || []).map(b => b.text || '').join('\n'); }
    catch { return ''; }
  }

  function setFieldNote(el, key, html) {
    const wrap = fieldWrapper(el);
    if (!wrap) return;
    let note = wrap.querySelector('.vseh-field-note-' + key);
    if (!html) { if (note) note.remove(); return; }
    if (!note) {
      note = document.createElement('div');
      note.className = 'vseh-field-note vseh-field-note-' + key;
      note.style.cssText = 'font-size:13px;margin:4px 0;';
      wrap.insertBefore(note, wrap.firstChild);
    }
    note.innerHTML = html;
  }

  // JS \b räknar å/ä/ö som "icke-ordtecken", vilket gör vanliga \b-gränser
  // opålitliga för svenska ord: "öl"/"årsmöte"/"äventyr" (ord som börjar/
  // slutar på å/ä/ö) matchar aldrig som fristående ord, samtidigt som t.ex.
  // "snö" felaktigt matchar inuti "snöar" (ö→a ser ut som en ordgräns för
  // \b). Bygger därför gränserna själva med lookaround mot en explicit
  // teckenklass som inkluderar å/ä/ö, istället för att lita på \b.
  const WORD_CHAR_CLASS = 'a-zA-ZåäöÅÄÖ0-9_';
  function wordBoundaryPattern(word) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return '(?<![' + WORD_CHAR_CLASS + '])' + esc + '(?![' + WORD_CHAR_CLASS + '])';
  }

  // Ordgräns-regex av en lista fraser (kan innehålla mellanslag) — bygger
  // en enda regex som matchar valfri fras i listan, var för sig ordgränsad.
  function wordListRe(words) {
    return new RegExp(words.map(wordBoundaryPattern).join('|'), 'i');
  }

  // Läsande granskning enligt riktlinjerna, bara nyckelordsbaserad (inga
  // språkbedömningar) för att hålla sig träffsäker och billig att köra i en
  // poll. Sätter röd text vid respektive fält (setFieldNote, key='guideline')
  // OCH returnerar en samlad lista för listens sammanfattningsrad.
  function checkGuidelineIssues() {
    const categoriesLower = currentCategoryTitles().map(c => c.toLowerCase());
    // Plats-/venuenamnet är redan ett eget fält — nämns det ordagrant i
    // löptexten också är det onödig dubblering (samma princip som pris/tid).
    const venueNames = [document.getElementById('id_venue_name_en')?.value, document.getElementById('id_venue_name_sv')?.value]
      .map(v => (v || '').trim()).filter(v => v.length > 2);
    // Samma sak för gatuadressen — återanvänder normAddr()/normText() (samma
    // normalisering dedup-matchningen redan kör) så skiljetecken/postnr/
    // "Stockholm" i löptexten ("Hälsingegatan 33, Stockholm") inte hindrar
    // igenkänning mot adressfältets "Hälsingegatan 33".
    const addressRaw = (document.getElementById('id_address')?.value || '').trim();
    const addressNorm = normAddr(addressRaw);
    const allIssues = [];
    ['en', 'sv'].forEach(lang => {
      const fieldId = 'id_description_' + lang;
      const el = document.getElementById(fieldId);
      const text = readDraftailText(fieldId);
      if (!text) { setFieldNote(el, 'guideline', ''); return; }
      const lower = text.toLowerCase();
      const fieldIssues = [];

      const priceHits = text.match(PRICE_WORD_RE);
      if (priceHits && priceHits.length) {
        fieldIssues.push({ label: 'Prisinfo', msg: 'Möjlig prisuppgift (' + [...new Set(priceHits.map(h => h.toLowerCase()))].join(', ') + ') — hänvisa till arrangörens sida istället.' });
      }
      if (TIME_IN_TEXT_RE.test(text)) {
        fieldIssues.push({ label: 'Tidsinfo i fält', msg: 'Möjlig tidsangivelse i texten — tid ska fyllas i i datumfälten, inte skrivas i beskrivningen.' });
      }
      const dateHit = text.match(DATE_IN_TEXT_RE);
      if (dateHit) {
        fieldIssues.push({ label: 'Datuminfo i fält', msg: 'Möjlig datumangivelse i texten ("' + dateHit[0].trim() + '") — datum ska fyllas i i datumfälten, inte skrivas i beskrivningen.' });
      }
      const venueHit = venueNames.find(v => new RegExp(wordBoundaryPattern(v), 'i').test(text));
      if (venueHit) {
        fieldIssues.push({ label: 'Platsinfo i fält', msg: 'Platsnamnet ("' + venueHit + '") nämns i texten — plats/venue fylls redan i i det fältet och behöver inte upprepas i beskrivningen.' });
      }
      if (addressNorm.length > 4 && normText(text).includes(addressNorm)) {
        fieldIssues.push({ label: 'Adressinfo i fält', msg: 'Adressen ("' + addressRaw + '") nämns i texten — adress fylls redan i i det fältet och behöver inte upprepas i beskrivningen.' });
      }
      const urlHit = text.match(URL_IN_TEXT_RE);
      if (urlHit) {
        fieldIssues.push({ label: 'Länk i fält', msg: 'Möjlig länk i texten ("' + urlHit[0] + '") — länkar ska fyllas i i länkfältet (External website url), inte skrivas i beskrivningen.' });
      } else if (draftailHasLinkEntity(fieldId)) {
        fieldIssues.push({ label: 'Länk i fält', msg: 'En hyperlänk är inbäddad i texten — länkar ska fyllas i i länkfältet (External website url), inte länkas i beskrivningen.' });
      }
      const phoneHit = text.match(PHONE_IN_TEXT_RE);
      const emailHit = text.match(EMAIL_IN_TEXT_RE);
      if (phoneHit || emailHit) {
        fieldIssues.push({ label: 'Kontaktuppgift i fält', msg: 'Möjlig kontaktuppgift i texten ("' + (phoneHit || emailHit)[0] + '") — hänvisa till arrangörens sida istället för telefonnummer/mejladress i beskrivningen.' });
      }
      const pronounRe = wordListRe(lang === 'sv' ? WE_US_WORDS_SV : WE_US_WORDS_EN);
      if (pronounRe.test(text)) {
        fieldIssues.push({ label: 'Vi/oss-språk', msg: 'Undvik "vi"/"oss" — skriv i tredje person så det inte ser ut som Visit Stockholm är arrangören.' });
      }
      if (lang === 'sv') {
        const hypeHit = HYPE_WORDS.find(w => lower.includes(w.toLowerCase()));
        if (hypeHit) {
          fieldIssues.push({ label: 'Säljspråk', msg: 'Säljande formulering ("' + hypeHit + '") — håll beskrivningen neutral och saklig.' });
        }
        const ineligibleHit = INELIGIBLE_EVENT_WORDS.find(w => wordListRe([w]).test(text));
        if (ineligibleHit) {
          fieldIssues.push({ label: 'Möjlig otillåten eventtyp', msg: '"' + ineligibleHit + '" kan tyda på en eventtyp vi inte publicerar (rabatt/erbjudande, förenings- eller partimöte) — dubbelkolla mot riktlinjerna.' });
        }
        if (/\bmässa\b/i.test(text) && !categoriesLower.includes('fairs')) {
          fieldIssues.push({ label: 'Möjlig otillåten eventtyp', msg: '"mässa" utan kategorin Fairs kan syfta på en religiös gudstjänst, vilket vi inte publicerar.' });
        }
      }

      const fixLabels = fieldIssues.map(i => i.label).filter(l => GUIDELINE_FIXES[l]);
      let html = '';
      if (fieldIssues.length) {
        // Samma paneltema som listen högst upp (var(--vd-*)) istället för
        // röd text — svårläst enligt feedback — med en tunn klarröd ram
        // runt hela rutan som varningssignal istället (på begäran
        // 2026-09-19). Rubrik + en rad per fel, med en typspecifik emoji
        // (GUIDELINE_ISSUE_EMOJI) och etiketten i fetstil, följt av
        // förklaringen på egen rad i vanlig vikt (utan kolon).
        html += '<div style="background:var(--vd-bg2);border:1px solid #ff3b3b;border-radius:7px;padding:8px 10px;color:var(--vd-txt);">' +
          '<div style="font-weight:700;margin-bottom:6px;">⚠️ Åtgärder</div>' +
          fieldIssues.map(i =>
            '<div style="margin-bottom:6px;">' +
            '<div style="font-weight:700;">' + (GUIDELINE_ISSUE_EMOJI[i.label] || '⚠️') + ' ' + esc(i.label) + '</div>' +
            '<div>' + esc(i.msg) + '</div>' +
            '</div>'
          ).join('');
        if (fixLabels.length) {
          const frags = [...new Set(fixLabels.map(l => GUIDELINE_FIXES[l].frag))];
          const fragText = frags.length > 1
            ? frags.slice(0, -1).join(', ') + ' och ' + frags[frags.length - 1]
            : frags[0];
          html += '<div style="margin-top:6px;">' +
            '<button type="button" class="vseh-guideline-fix-btn" data-lang="' + lang + '" data-fix="' + esc(fixLabels.join('|')) + '" style="font-size:12px;padding:2px 8px;cursor:pointer;">Skriv om 🤖 (åtgärdar riktlinjer)</button>' +
            '<div style="font-size:11px;color:var(--vd-txt3);margin-top:3px;">Mistral ' + esc(fragText) + '.</div>' +
            '</div>';
        }
        html += '</div>';
      }
      setFieldNote(el, 'guideline', html);
      allIssues.push(...fieldIssues);
    });
    renderGuidelineSummary(allIssues);
    document.querySelectorAll('.vseh-guideline-fix-btn').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Anropar Mistral…';
        await rewriteGuidelineIssues(btn.dataset.lang, btn.dataset.fix.split('|'));
        btn.disabled = false;
        btn.textContent = orig;
      });
    });
  }

  // Skickar EXAKT de riktlinjeavvikelser som upptäckts (GUIDELINE_FIXES) som
  // redigeringsinstruktioner till Mistral — samma raka chat/completions-anrop
  // som translateDescription() redan använder, eftersom detta bara ska
  // ändra EXAKT det som flaggats och inget annat.
  async function rewriteGuidelineIssues(lang, fixLabels) {
    const fieldId = 'id_description_' + lang;
    const text = readDraftailText(fieldId);
    if (!text) return;
    const mistralKey = GM_getValue('mistral_key', '');
    if (!mistralKey) { vlog('Riktlinje-omskrivning: Mistral API-nyckel saknas (fliken Inställningar).', 'err'); return; }
    const instructions = fixLabels.map(l => GUIDELINE_FIXES[l]?.instruction).filter(Boolean);
    if (!instructions.length) return;
    try {
      vlog('Riktlinje-omskrivning: Skickar text till Mistral (' + fieldId + ')…');
      const payload = {
        model: 'mistral-small-latest',
        messages: [
          { role: 'system', content: 'Du är redaktör för Visit Stockholms evenemangstexter. Skriv om texten användaren ger EXAKT enligt instruktionerna nedan, men ändra INGET annat — behåll tonen och all annan sakinformation orörd. Texten är på ' + mistralLangName(lang) + ' — svara ENDAST på ' + mistralLangName(lang) + ', översätt INTE till något annat språk. Svara ENDAST med den omskrivna texten — ingen kommentar, inga citattecken, ingen extra formatering.\n\n' +
              instructions.map(i => '- ' + i).join('\n') },
          { role: 'user', content: text }
        ]
      };
      const resp = await gmPost(MISTRAL_CHAT, { 'Authorization': 'Bearer ' + mistralKey, 'Content-Type': 'application/json' }, payload);
      const rewritten = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      if (!rewritten) throw new Error('Tomt svar från Mistral');
      await updateDraftail(fieldId, rewritten.trim());
      vlog('Riktlinje-omskrivning: Klar (' + fieldId + ').', 'ok');
    } catch (e) {
      vlog('Riktlinje-omskrivning: Fel — ' + e.message, 'err');
    }
  }

  // Sammanfattningsrad i listen: "Prisinfo, tidsinfo i fält och 2 avvikelser
  // till." — unika etiketter (samma flagga på båda språken räknas en gång),
  // full mening bara för de två första, resten som en räknad klump.
  function renderGuidelineSummary(issues) {
    const el = document.getElementById('vseh-issues-summary');
    if (!el) return;
    const labels = [...new Set(issues.map(i => i.label))];
    if (!labels.length) { el.textContent = ''; return; }
    const shown = labels.slice(0, 2).map((l, i) => i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1));
    const rest = labels.length - shown.length;
    el.textContent = '⚠️ ' + shown.join(', ') + (rest > 0 ? ' och ' + rest + ' avvikelser till.' : '.');
  }

  // Tar bort emojis direkt ur title_en/title_sv (vanliga textfält — säkert
  // att skriva om via simulateInput, syns direkt, lätt att ångra manuellt).
  function stripEmojisFromTitles() {
    ['id_title_en', 'id_title_sv'].forEach(id => {
      const el = document.getElementById(id);
      if (!el || !el.value || !EMOJI_RE.test(el.value)) return;
      const stripped = el.value.replace(EMOJI_RE, '').replace(/ {2,}/g, ' ').trim();
      if (stripped !== el.value) simulateInput(el, stripped);
    });
  }

  // VERSALRUBRIKER ("IKEA'S NEW EXHIBITION") bryter mot stilguiden — flaggar
  // titlar som (i praktiken) är helt versala och erbjuder en Mistral-
  // omskrivning, samma knapp-mönster som checkGuidelineIssues() (på begäran
  // 2026-09-19). Kräver >3 bokstäver totalt (bortser från siffror/
  // skiljetecken/apostrofer) för att inte flagga korta initialförkortningar.
  function isAllCapsTitle(title) {
    const letters = (title || '').replace(/[^a-zA-ZåäöÅÄÖ]/g, '');
    return letters.length > 3 && title === title.toUpperCase() && title !== title.toLowerCase();
  }

  // Skickar bara SJÄLVA TITELN (inte hela beskrivningen) till Mistral, med en
  // språkspecifik instruktion: engelska till Title Case (småord som "the"/
  // "and"/"of" gemena om de inte är första ordet), svenska till ren
  // meningscase (bara första bokstaven stor — matchar exemplet "IKEAS NYA
  // UTSTÄLLNING" → "Ikeas nya utställning", inte "IKEAs Nya Utställning").
  async function rewriteTitleCasing(lang) {
    const el = document.getElementById('id_title_' + lang);
    const title = (el?.value || '').trim();
    if (!title) return;
    const mistralKey = GM_getValue('mistral_key', '');
    if (!mistralKey) { vlog('Versalrubrik: Mistral API-nyckel saknas (fliken Inställningar).', 'err'); return; }
    const instruction = lang === 'en'
      ? 'Skriv om till Title Case (stor bokstav i början av varje ord), UTOM korta artiklar/konjunktioner/prepositioner ("a", "an", "the", "and", "or", "of", "in", "on", "at", "for", "to"), som ska vara gemena om de inte är första ordet.'
      : 'Skriv om till meningscase: bara första bokstaven i titeln stor, resten gemener (behåll dock versaler mitt i ett ord om de redan är en del av ett egennamn/en förkortning, t.ex. "IKEA" i "Ikeas").';
    try {
      vlog('Versalrubrik: Skickar titel till Mistral (id_title_' + lang + ')…');
      const payload = {
        model: 'mistral-small-latest',
        messages: [
          { role: 'system', content: 'Du är redaktör för Visit Stockholms evenemangstitlar. ' + instruction +
              ' Ändra ENDAST skiftläget — samma ord, samma ordning, samma skiljetecken. Titeln är på ' + mistralLangName(lang) + ' — svara ENDAST på ' + mistralLangName(lang) + ', översätt INTE till något annat språk. Svara ENDAST med den omskrivna titeln, ingen kommentar, inga citattecken.' },
          { role: 'user', content: title }
        ]
      };
      const resp = await gmPost(MISTRAL_CHAT, { 'Authorization': 'Bearer ' + mistralKey, 'Content-Type': 'application/json' }, payload);
      const rewritten = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      if (!rewritten) throw new Error('Tomt svar från Mistral');
      simulateInput(el, rewritten.trim());
      vlog('Versalrubrik: Klar (id_title_' + lang + ').', 'ok');
    } catch (e) {
      vlog('Versalrubrik: Fel — ' + e.message, 'err');
    }
  }

  function checkTitleCasing() {
    ['en', 'sv'].forEach(lang => {
      const el = document.getElementById('id_title_' + lang);
      const title = el?.value || '';
      if (!isAllCapsTitle(title)) { setFieldNote(el, 'caps', ''); return; }
      const fixDesc = lang === 'en'
        ? 'Mistral skriver om till Title Case (småord som "the"/"and"/"of" förblir gemena).'
        : 'Mistral skriver om till meningscase (bara första bokstaven stor).';
      setFieldNote(el, 'caps',
        '<div style="color:#c02626;font-weight:600;">⚠️ Versalrubrik: Rubriken är skriven i VERSALER — bryter mot stilguiden.</div>' +
        '<div style="margin-top:6px;">' +
        '<button type="button" class="vseh-caps-fix-btn" data-lang="' + lang + '" style="font-size:12px;padding:2px 8px;cursor:pointer;">Skriv om 🤖 (rättar VERSALER)</button>' +
        '<div style="font-size:11px;color:var(--vd-txt3);margin-top:3px;">' + esc(fixDesc) + '</div>' +
        '</div>');
    });
    document.querySelectorAll('.vseh-caps-fix-btn').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Anropar Mistral…';
        await rewriteTitleCasing(btn.dataset.lang);
        btn.disabled = false;
        btn.textContent = orig;
      });
    });
  }

  // Beskrivningen är Draftail (rich text) — enda sättet i det här scriptet
  // att skriva till den (updateDraftail) gör det via en total nyskriven
  // ContentState, vilket plattar ut eventuell befintlig formatering (fetstil,
  // länkar) till vanliga textstycken. Bekräftat OK (2026-09-17): texten är i
  // regel oformaterad ändå, så vi kör detta automatiskt precis som titlarna.
  function stripDescriptionEmoji() {
    ['id_description_en', 'id_description_sv'].forEach(async fieldId => {
      const text = readDraftailText(fieldId);
      if (!text || !EMOJI_RE.test(text)) return;
      await updateDraftail(fieldId, text.replace(EMOJI_RE, '').replace(/ {2,}/g, ' '));
    });
  }

  // ---- Guide-auto-taggning: generell regelmotor -----------------------------
  // Varje regel i GUIDE_TAG_RULES matchar mot en "kontext" (kategori, venue,
  // titel/beskrivning, eventdatum) och taggar related_guides om den träffar.
  // Lägga till en ny regel = lägga till ett objekt i listan, ingen ny
  // funktion behövs. Ett villkor som utelämnas (t.ex. ingen `keywords`)
  // räknas som "kravlöst" — bara de villkor som faktiskt anges måste stämma.

  // Kategorierna är den bekräftade fullständiga listan (2026-09-17) — exakt
  // jämförelse mot main_category/categories/subcategory-titeln (engelska,
  // som är vad JSON-fälten faktiskt lagrar, t.ex. "Theater" — bekräftad
  // stavning från befintlig kod, se isPerformance-checken vid rad ~2009)
  // istället för en löst gissad regex. Subcategory togs med 2026-09-19 så
  // guide-taggningsraderna kan matcha mot den (samma `category`-cell/
  // buildCategoryTest som redan finns — ingen ny kolumn behövs).
  function currentCategoryTitles() {
    let sub = null;
    try { sub = JSON.parse(document.querySelector('input[name="subcategory"]')?.value || 'null'); } catch {}
    try {
      const main = JSON.parse(document.querySelector('input[name="main_category"]')?.value || 'null');
      const cats = JSON.parse(document.querySelector('input[name="categories"]')?.value || 'null');
      return [main?.title, ...(Array.isArray(cats) ? cats.map(c => c.title) : []), sub?.title].filter(Boolean);
    } catch { return []; }
  }

  // Alla ifyllda datum för eventet (date_admin-0, -1, … — samma fältmönster
  // som findDateAdminAddButton/insertAndFillDateBlock ovan använder), som
  // rena 'YYYY-MM-DD'-strängar.
  function currentEventDates() {
    return [...document.querySelectorAll('input[name^="date_admin-"][name$="-value-date"]')]
      .map(el => el.value).filter(Boolean);
  }

  // Bygger den kontext varje regels `match`-funktion får att titta på.
  function buildGuideTagContext() {
    const categories = currentCategoryTitles();
    const categoriesLower = categories.map(c => c.toLowerCase());
    const venue = ((document.getElementById('id_venue_name_en')?.value || '') + ' ' +
      (document.getElementById('id_venue_name_sv')?.value || '')).toLowerCase();
    const text = ((document.getElementById('id_title_en')?.value || '') + ' ' +
      (document.getElementById('id_title_sv')?.value || '') + ' ' +
      readDraftailText('id_description_en') + ' ' + readDraftailText('id_description_sv') + ' ' + venue).toLowerCase();
    const dates = currentEventDates();
    return { categories, categoriesLower, venue, text, dates };
  }

  // Tar bort omslutande citattecken runt en term ("free admission" → free admission).
  function stripQuotes(s) {
    s = s.trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
    return s.trim();
  }

  // Tolkar en kategori- eller nyckelordscell från kalkylarket: komma = ELLER
  // mellan grupper, plus = OCH inom en grupp, citattecken runt en flerords-
  // fras tas bort. Ett "-" framför en term (bara meningsfullt för nyckelord)
  // gör den till ett globalt uteslutningsvillkor — måste INTE finnas, oavsett
  // vilken OR-grupp som annars träffade (t.ex. "slott, -\"kungliga slottet\"").
  function parseOrAndCell(cellRaw) {
    const orGroups = [];
    const exclude = [];
    (cellRaw || '').split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
      if (tok.startsWith('-')) {
        const t = stripQuotes(tok.slice(1)).toLowerCase();
        if (t) exclude.push(t);
      } else {
        const group = tok.split('+').map(t => stripQuotes(t).toLowerCase()).filter(Boolean);
        if (group.length) orGroups.push(group);
      }
    });
    return { orGroups, exclude };
  }

  // null = inget villkor angivet (raden bryr sig inte om kategori).
  function buildCategoryTest(cell) {
    const { orGroups } = parseOrAndCell(cell);
    if (!orGroups.length) return null;
    return categoriesLower => orGroups.some(group => group.every(term => categoriesLower.includes(term)));
  }

  // null = inget villkor angivet. Uteslutningar (`-term`) vinner alltid,
  // oavsett om det finns några OR-grupper eller inte. Ordgränsad matchning
  // (samma lookaround-baserade gräns som wordListRe) så att t.ex. "hund"
  // inte träffar inuti "hundra" — ren substrängsmatchning gav falska
  // positiver för alla korta nyckelord som råkar ingå i längre ord.
  function buildKeywordTest(cell) {
    const { orGroups, exclude } = parseOrAndCell(cell);
    if (!orGroups.length && !exclude.length) return null;
    const termRe = term => new RegExp(wordBoundaryPattern(term), 'i');
    const excludeRe = exclude.map(termRe);
    const orGroupsRe = orGroups.map(group => group.map(termRe));
    return text => {
      if (excludeRe.some(re => re.test(text))) return false;
      if (!orGroupsRe.length) return true;
      return orGroupsRe.some(group => group.every(re => re.test(text)));
    };
  }

  // Tolkar "[YYYY-MM-DD-YYYY-MM-DD]" till ett test mot eventets datum —
  // bara månad+dag jämförs (årtal ignoreras helt), och intervall som går
  // över årsskiftet (start > slut, t.ex. dec→jan) hanteras också.
  function buildDateTest(cellRaw) {
    const m = /^\[YYYY-(\d{2})-(\d{2})-YYYY-(\d{2})-(\d{2})\]$/.exec((cellRaw || '').trim());
    if (!m) return null;
    const start = parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
    const end = parseInt(m[3], 10) * 100 + parseInt(m[4], 10);
    return dates => dates.some(d => {
      const dm = /^\d{4}-(\d{2})-(\d{2})$/.exec(d);
      if (!dm) return false;
      const val = parseInt(dm[1], 10) * 100 + parseInt(dm[2], 10);
      return start <= end ? (val >= start && val <= end) : (val >= start || val <= end);
    });
  }

  // Ett guide-fält kan vara tomt eller "ENDAST SVENSKA"/"ENDAST ENGELSKA" —
  // båda betyder "tagga inte det här språket alls" för raden.
  function resolveGuideTitle(cellRaw) {
    const v = (cellRaw || '').trim();
    if (!v || /^ENDAST (SVENSKA|ENGELSKA)$/i.test(v)) return null;
    return v;
  }

  // Guide-titlar innehåller ofta innevarande/kommande år ("...i Stockholm
  // 2026") som byts ut när sidan uppdateras nästa år. selectAutocompleteValue
  // matchar redan på startsWith/includes mot den riktiga sökningen, så vi
  // stryker ett avslutande årtal (med eller utan föregående "in ") innan vi
  // skriver in texten — regeln fortsätter då träffa rätt guide oavsett
  // vilket år som råkar stå i dess titel just nu, utan att kalkylarkets
  // egen (människoläsbara) text behöver hållas årtalsfri.
  function stripTrailingYear(title) {
    return title.replace(/\s+(in\s+)?\d{4}\s*$/i, '').trim();
  }

  // [kategori, nyckelord, datumvillkor, guide (EN), guide (SV)] — en rad per
  // post i "autofiltrering_guider.xlsx" (granskad + rättad 2026-09-18), plus
  // några extra rader (sist) som inte kommer från kalkylarket: Avicii/Friends
  // Arena-regeln som fanns innan kalkylarket, Nalen/Debaser/Kollektivet Livet
  // (2026-09-19, på begäran) — matchar mot venue-namnet, som ingår i
  // buildGuideTagContext's `text` — samt Theater-subcategoryn (2026-09-19,
  // på begäran) — kategori-cellen matchar numera även mot subcategory, inte
  // bara main_category/categories (se currentCategoryTitles()). En rad utan
  // NÅGOT villkor (kategori+nyckelord+datum alla tomma) hoppas över helt av
  // buildGuideRuleFromRow — den ska INTE tagga sin guide ovillkorligen
  // (bekräftat 2026-09-18).
  const GUIDE_TAG_ROWS = [
    [null, 'adrenalin, uthållig, sport, svettas, ansträng', null, 'Have an Active Vacation', 'Aktiv semester i Stockholm'],
    [null, 'äventyr, adrenalin', null, 'ENDAST SVENSKA', 'Aktiviteter för den äventyrlige'],
    ['Family+Stage & Film, Family+Exhibitions', null, null, 'Stockholm for Kids', 'Aktiviteter med barn i Stockholm'],
    [null, 'sauna, bastu', null, 'Sauna in Stockholm', 'Bada bastu i Stockholm'],
    [null, 'läsa, bok, författar', null, 'Find a good read: Bookshops in Stockholm', 'Bibliotek och bokaffärer i Stockholm – hitta läslust'],
    [null, 'kräftor, crayfish', null, "It's time for crayfish!", 'Dags för kräftor!'],
    [null, 'vegan, vegetarian, plant-based, växtbaserad', null, 'Plant-based and vegetarian restaurants in Stockholm 2026', 'De bästa veganska och vegetariska restaurangerna i Stockholm 2026'],
    ['Festivals', null, null, 'The biggest Stockholm events', 'De största evenemangen i Stockholm'],
    ['Exhibitions, Music, Stage & Film', '"free admission", "fritt inträde", "gratis", "free of charge"', null, 'Stockholm on a Budget', 'En budgetsemester i Stockholm'],
    [null, 'Rain, regn', null, 'Stockholm on a Rainy Day', 'En regnig dag i Stockholm'],
    ['Eat & Drink', '"nobel"', null, 'Have a bite of Nobel cuisine', 'En smak av Nobelmiddagen'],
    [null, 'gamer, gaming, arcade', null, 'Late night gaming in Stockholm', 'En utekväll med arkadspel'],
    [null, null, null, 'Afternoon Tea', 'ENDAST ENGELSKA'],
    ['Exhibitions', 'alkohol, öl, beer', null, 'Alcohol in Sweden - understanding the swedish drinking mentality', 'ENDAST ENGELSKA'],
    [null, 'kanelbulle, "cinnamon bun", princesstårta, "swedish fika"', null, 'Cinnamon Bun & Princess Cake: Swedish Fika in Stockholm', 'ENDAST ENGELSKA'],
    ['Networking & Community', null, null, 'Find a community of friends', 'ENDAST ENGELSKA'],
    [null, '"design week"', null, 'Guide: Stockholm Design Week', 'ENDAST ENGELSKA'],
    [null, 'ramadan', null, 'How to celebrate Ramadan in Stockholm as a visitor', 'ENDAST ENGELSKA'],
    [null, 'jobbmässa, arbetssökande', null, "How to find work when you're new in Stockholm", 'ENDAST ENGELSKA'],
    ['Careers & Leadership', null, null, 'How to kickstart your career in Stockholm', 'ENDAST ENGELSKA'],
    ['Family, Guided tours & Lectures', 'djur, animals', null, 'Meet the Animals of Stockholm', 'ENDAST ENGELSKA'],
    ['Clubs & Parties', null, null, 'Stockholm nightlife', 'ENDAST ENGELSKA'],
    ['Guided tours & Lectures', 'Subway, tunnelbana', null, 'Transportation', 'ENDAST ENGELSKA'],
    [null, 'parkour, climb, klätt', null, 'Urban Play in Stockholm', 'ENDAST ENGELSKA'],
    [null, 'cykel, bike, bicycle', null, 'Vacation on Two Wheels', 'ENDAST ENGELSKA'],
    [null, 'afternoon tea', null, 'Where to go for Afternoon Tea in Stockholm', 'ENDAST ENGELSKA'],
    ['Careers & Leadership+Networking & Community', null, null, 'Where to network in Stockholm', 'ENDAST ENGELSKA'],
    [null, 'naturvin, "natural wine", "orange wine"', null, 'Five bars to drink natural wines in Stockholm', 'Fem bra naturvinshak i Stockholm'],
    ['Festivals', null, '[YYYY-05-24-YYYY-09-03]', 'Festival Summer in Stockholm', 'Festivalsommar i Stockholm'],
    [null, 'halloween, ghost, spök, horror', null, 'The Haunting of Stockholm – Find the Spookiest Places in Town', 'Fira Halloween i kusliga Stockholm'],
    [null, 'valborg', null, 'Walpurgis Night in Stockholm', 'Fira valborg i Stockholm 2026'],
    [null, 'slaktkyrkan, fållan, slaktis, slakthusområdet', null, 'Things to do in Slakthusområdet', 'Få en fantastisk dag i Slakthusområdet'],
    [null, '"greta garbo"', null, "Greta Garbo's Stockholm", 'Greta Garbos Stockholm'],
    ['Guided tours & Lectures', 'Annorlunda, oväntad, adrenalin, twist', null, 'Guided Tours With a Twist', 'Guidade turer med en tvist'],
    [null, 'fiska, fisketur', null, 'Go Fish! – Fishing in Stockholm', 'Gå och fiska'],
    ['Family', null, '[YYYY-02-15-YYYY-03-10]', 'Have a Fun Winter Break in Stockholm', 'Ha ett härligt sportlov i Stockholm'],
    [null, 'sportlov, skidor, pulka', '[YYYY-02-15-YYYY-03-10]', 'Have a Fun Winter Break in Stockholm', 'Ha ett härligt sportlov i Stockholm'],
    ['Music, Clubs & Parties', 'gay, queer', null, 'LGBTQ+ Events & Clubs', 'HBTQI-evenemang och klubbar'],
    [null, 'loppis, loppmarknad, flea market', null, 'Weekend Markets & Flea Markets in Stockholm', 'Hitta fynden på Stockholms helgmarknader och loppisar'],
    [null, 'hund, "människans bästa vän"', null, 'Dog-friendly Stockholm — a guide for you and your dog', 'Hundvänliga Stockholm — en guide för dig med hund'],
    [null, 'cykel, bike, bicycle', null, 'By bike in Stockholm', 'Hyr cykel i Stockholm – Semester på två hjul'],
    [null, 'mixolog, cocktail', null, 'The best drinks in Stockholm: creative cocktail bars', 'Här dricker du Stockholms bästa drinkar'],
    [null, '"Stockholm pride", "prideveckan"', null, 'Celebrate Stockholm Pride 2026', 'Här kan du fira Stockholm Pride 2026'],
    [null, '"nationaldag"', null, "Celebrate Sweden's National Day in Stockholm", 'Här kan du fira Sveriges nationaldag i Stockholm 2026'],
    [null, 'höstlov, läslov', null, null, 'Höstlov i Stockholm 2026'],
    [null, 'ingmar bergman', null, "Ingmar Bergman's Stockholm", 'Ingmar Bergmans Stockholm'],
    [null, 'julbord, julmeny, julservering', null, 'Christmas dinner in Stockholm 2026', 'Julbord i Stockholm 2026'],
    ['Music', 'jul', null, 'Christmas Concerts and Events in Stockholm 2026', 'Julkonserter och julshower i Stockholm 2026'],
    [null, 'jullov', null, 'Have a Great Christmas Holiday in Stockholm', 'Jullov i Stockholm 2026 för hela familjen'],
    [null, 'julmarknad', null, 'Christmas markets in Stockholm 2026', 'Julmarknader i Stockholm 2026'],
    [null, 'kajak', null, 'Kayak Adventures in Stockholm', 'Kajakäventyr i Stockholm'],
    [null, 'Stjärna, fans', null, 'Upcoming concerts and music festivals', 'Kommande konserter & festivaler'],
    ['Music+Festivals', null, null, 'Upcoming concerts and music festivals', 'Kommande konserter & festivaler'],
    ['Guided tours & Lectures', 'Tunnelbana', null, 'Art in the Subway: Explore 14 Beautiful Stations', 'Konst i tunnelbanan: Upptäck 14 vackra stationer'],
    [null, 'Arkitektur, "offentlig konst", jugend, brutalism', null, 'ENDAST SVENSKA', 'Konst och arkitektur i Stockholm'],
    [null, 'kulturnatt', null, 'Stockholm Culture Night 2026', 'Kulturnatt Stockholm 2026'],
    ['Exhibitions', 'kväll', null, 'Night at the Museum – Evening-open Attractions in Stockholm', 'Kvällsöppna museer i Stockholm'],
    [null, 'Lucia', null, 'Lucia in Stockholm 2026', 'Lucia i Stockholm 2026'],
    ['Sports & Wellbeing', 'lopp, mil, stafett', null, 'Stockholm for Runners: Long-Distance Races and Competitions', 'Löparens Stockholm: lopp och tävlingar i huvudstaden'],
    [null, '"Drive-in", veteranbil, bilmässa, "car meet"', null, 'By car in Stockholm', 'Med bil i Stockholm'],
    [null, 'midsommar', null, 'Midsummer in Stockholm 2026', 'Midsommar i Stockholm 2026'],
    ['Exhibitions', 'historia', null, 'Museums for History Buffs in Stockholm', 'Museer för historieintresserade i Stockholm'],
    ['Exhibitions', 'forskning, vetenskap, tech', null, 'Science Museums in Stockholm', 'Museer för vetgiriga'],
    [null, 'film festival, filmfestival', null, 'At the Movies: Cinemas and Film Festivals Stockholm', 'Mysiga biografer och filmfestivaler i Stockholm'],
    // Extra rad (2026-09-19, på begäran): kategori Festivals + subcategory
    // Film ska tagga samma guide som ovan, oavsett nyckelord i text/venue.
    // "+" = AND inom en OR-grupp — kräver BÅDA (categoriesLower innehåller
    // numera även subcategory, se currentCategoryTitles()).
    ['Festivals+Film', null, null, 'At the Movies: Cinemas and Film Festivals Stockholm', 'Mysiga biografer och filmfestivaler i Stockholm'],
    ['Guided tours & Lectures', 'Natur', null, "Enjoy Allemansrätten – Sweden's Right to Roam", 'Njut av allemansrätten i Stockholms natur'],
    ['Music', 'dirigent, orkester, kvartett, kvintett, stråk, kammarkör', null, 'An Evening With Classical Music in Stockholm', 'Njut av klassisk musik i Stockholm'],
    ['Sports & Wellbeing', 'Spa', null, 'Enjoy a Spa Weekend in Stockholm City', 'Njut av spa i Stockholm'],
    [null, 'Semla', null, 'Fat Tuesday – the day of the Semla 2026', 'Njut av Stockholms bästa semlor 2027'],
    ["Christmas & New Year's", 'Nyår', null, "New Year's Eve in Stockholm 2026", 'Nyår i Stockholm 2026'],
    [null, 'påsk, easter', null, 'Easter in Stockholm', 'Påsk i Stockholm 2026'],
    [null, 'Quiz, frågesport', null, 'Quiz night in Stockholm', 'Quizkväll i Stockholm'],
    [null, 'ridtur, häst', null, 'Saddle up: Horseback Riding in Stockholm', 'Sadla upp: Se Stockholm från hästryggen'],
    ['Eat & Drink', 'skärgård', null, 'Gastronomic archipelago', 'Skärgårdssmaker'],
    [null, 'skärgård+spännande, skärgård+äventyr', null, 'Be Adventurous in the Stockholm archipelago', 'Skärgårdsäventyr'],
    [null, '"slow fashion"', null, 'Slow Fashion District – second hand and vintage in Stockholm', 'Slow Fashion District – second hand och vintage på Södermalm'],
    ['Eat & Drink+Fairs', null, null, 'Delicious events in Stockholm', 'Smakfulla evenemang i Stockholm'],
    [null, 'slaktkyrkan, fållan, slaktis, slakthusområdet', null, 'Sunrise over Slakthusområdet', 'Solen går upp över Slakthusområdet'],
    [null, 'Golf', null, 'Tee Up On Your Vacation', 'Spela golf på semestern'],
    [null, 'nörd, "tv-spel", rollspel, fantasy, "sci-fi", "cosplay"', null, 'Stockholm ❤️ Nerds', 'Stockholm ❤️ Nördar'],
    [null, 'teenager', null, "The Teenager's Guide to Stockholm", 'Stockholm för tonårsfamiljen'],
    ['Guided tours & Lectures', 'Film', null, 'Stockholm in the Movies', 'Stockholm i filmens värld'],
    [null, 'brunch', null, 'The best brunch in Stockholm', 'Stockholms bästa brunch'],
    [null, 'kräftor, surströmming, mårten gås, "inlagd sill", senapssill, knäckebröd, "västerbottens"', null, 'Traditional Swedish food in Stockholm', 'Svensk husmanskost i Stockholm'],
    [null, 'fashion, mode', null, 'Swedish Fashion', 'Svenskt mode'],
    [null, 'takbar, "rooftop bar", skybar', null, 'Fantastic rooftop bars in Stockholm', 'Takbarer i Stockholm'],
    ['Guided tours & Lectures', 'Arkitektur, "offentlig konst", jugend, brutalism', null, 'Architecture Highlights in Stockholm', 'Upptäck Stockholms arkitektur'],
    [null, 'slott, -"kungliga slottet"', null, 'Day-trips to the Historic Castles of Stockholm', 'Utflyktstips: fantastiska slott i Stockholm'],
    [null, '"offentlig konst"', null, 'Public Art in Stockholm', 'Utomhuskonst i Stockholm'],
    ['Exhibitions', null, null, 'Current and Upcoming Exhibitions in Stockholm', 'Utställningar i Stockholm - Aktuella och kommande'],
    [null, '"viking"', null, 'Follow in the Footsteps of the Vikings in Stockholm', 'Vikingar i Stockholm'],
    [null, 'vinprovning, vin+provning', null, 'Wine bars in Stockholm', 'Vinbarer i Stockholm'],
    [null, '"snö", "skidor", pulka, skridsko, vinterbad', null, 'Winter Activities in Stockholm', 'Vinteraktiviteter i Stockholm'],
    [null, 'vinterbad', null, 'Brave the Cold: A Winter Swim in Stockholm', 'Vinterbada i Stockholm'],
    [null, 'pulka', null, 'Fun Sled Slopes in Stockholm', 'Åk pulka i Stockholm'],
    [null, 'skridskor', null, 'Ice Skating in Stockholm', 'Åk skridskor i Stockholm'],
    [null, 'halloween', null, 'Halloween and Fall break in Stockholm', null],
    ['Music', 'avicii arena, friends arena', null, 'The biggest Stockholm events', 'De största evenemangen i Stockholm'],
    ['Music', 'nalen, debaser, kollektivet livet', null, 'Upcoming concerts and music festivals', 'Kommande konserter & festivaler'],
    ['Theater', null, null, null, 'Teater i Stockholm – anrika tiljor och nyskapande drama']
  ];

  function buildGuideRuleFromRow(row, idx) {
    const [category, keyword, dateRange, guideEnRaw, guideSvRaw] = row;
    const categoryTest = buildCategoryTest(category);
    const keywordTest = buildKeywordTest(keyword);
    const dateTest = buildDateTest(dateRange);
    const guideEn = resolveGuideTitle(guideEnRaw);
    const guideSv = resolveGuideTitle(guideSvRaw);
    if (!categoryTest && !keywordTest && !dateTest) {
      vlog('GuideRegel #' + idx + ' (' + (guideEn || guideSv || '?') + '): inga villkor angivna — hoppas över.', 'err');
      return null;
    }
    if (!guideEn && !guideSv) {
      vlog('GuideRegel #' + idx + ': ingen guide angiven på något språk — hoppas över.', 'err');
      return null;
    }
    return {
      name: 'row' + idx,
      match: ctx =>
        (!categoryTest || categoryTest(ctx.categoriesLower)) &&
        (!keywordTest || keywordTest(ctx.text)) &&
        (!dateTest || dateTest(ctx.dates)),
      guideEn: guideEn ? stripTrailingYear(guideEn) : null,
      guideSv: guideSv ? stripTrailingYear(guideSv) : null
    };
  }

  // Byggs LATT (första gången getGuideTagRules() faktiskt anropas, dvs. bara
  // på edit-sidan) istället för som en direkt konstant vid scriptets start —
  // bekräftat 2026-09-19 att "GuideRegel #12 (Afternoon Tea): inga villkor
  // angivna — hoppas över"-varningen (från en rad utan kategori/nyckelord/
  // datum, avsiktligt hoppad) annars loggades på VARJE sida scriptet laddas
  // på, inklusive SBR-lägets sidor där guide-taggning inte ens är relevant.
  let _guideTagRules = null;
  function getGuideTagRules() {
    if (!_guideTagRules) _guideTagRules = GUIDE_TAG_ROWS.map(buildGuideRuleFromRow).filter(Boolean);
    return _guideTagRules;
  }

  // Guide-titlarnas EN/SV-motsvarighet, byggd från raderna som har BÅDA
  // språken definierade (rader med bara ett språk — "ENDAST SVENSKA/
  // ENGELSKA" — saknar en riktig motsvarighet att synka mot). Samma
  // lat-byggnad som ovan.
  let _guideLangPairRows = null;
  function getGuideLangPairRows() {
    if (!_guideLangPairRows) {
      _guideLangPairRows = getGuideTagRules()
        .filter(rule => rule.guideEn && rule.guideSv)
        .map(rule => ({ en: rule.guideEn, sv: rule.guideSv }));
    }
    return _guideLangPairRows;
  }

  // Fuzzy jämförelse (samma princip som selectAutocompleteValue's egen
  // förslags-matchning: normalize() + startsWith/includes, inte exakt
  // likhet) — bekräftat 2026-09-19 att en EXAKT (om än normaliserad)
  // strängjämförelse missade ett riktigt par ("Mysiga biografer och
  // filmfestivaler i Stockholm" ↔ "At the Movies: Cinemas and Film
  // Festivals Stockholm") troligen för att den FAKTISKT taggade guidens
  // titel skiljer sig något från vad som råkar stå hårdkodat i
  // GUIDE_TAG_ROWS (transkriberat för hand från ett kalkylark).
  function titleMatches(a, b) {
    const na = normalize(stripTrailingYear(a)), nb = normalize(stripTrailingYear(b));
    return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
  }

  // related_guides-fältets dolda JSON följer samma [{"pk":…,"title":"…"}]-
  // mönster som categories (bekräftat via fältkartläggningen 2026-09-19).
  function currentRelatedGuideTitles() {
    try {
      const raw = JSON.parse(document.querySelector('input[name="related_guides"]')?.value || 'null');
      return Array.isArray(raw) ? raw.map(g => g.title).filter(Boolean) : [];
    } catch { return []; }
  }

  const guideTagRulesFired = new Set();
  const guidesAlreadyTagged = new Set();
  // Fältets sök filtrerar redan bra på bara de första orden av guidetiteln —
  // ingen anledning att skriva in HELA (ofta långa) titeln tecken för tecken
  // (på begäran 2026-09-19: kortare inskrivning = snabbare och mindre yta
  // för ev. skrivfel). Den FULLA titeln används fortfarande som facit när
  // rätt förslag ska väljas ur listan (selectAutocompleteValue's `value`).
  function guideSearchPrefix(title) {
    return title.split(/\s+/).slice(0, 2).join(' ');
  }

  // window.scrollTo() räcker bara om DOKUMENTET/fönstret självt är det som
  // scrollar, och att sedan manuellt gå uppåt i DOM:et och nollställa varje
  // förfader med scrollTop > 0 (försök #2, 2026-09-19) räckte INTE HELLER
  // (bekräftat: efterfrågades en tredje gång). Använder därför istället
  // elementets EGEN .scrollIntoView() på ett riktigt fält högst upp i
  // formuläret (id_title_en) — webbläsaren räknar då själv ut och rullar
  // ALLA nästlade scrollbara förfäder som faktiskt behövs, oavsett hur
  // många det är eller vad de heter, istället för att vi ska gissa rätt
  // container manuellt. Körs dessutom vid tre tillfällen (direkt + två
  // korta fördröjningar) ifall någon annan samtidig åtgärd (t.ex. ett
  // fokus-byte från en efterföljande poll-tick) annars skulle rulla ner
  // sidan igen precis efter vårt första försök.
  function scrollAllToTop() {
    const anchor = document.getElementById('id_title_en') || document.querySelector('form');
    const doScroll = () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    doScroll();
    setTimeout(doScroll, 300);
    setTimeout(doScroll, 900);
  }

  // Om EN av två guider som hör ihop som språkpar (t.ex. "Stockholm on a
  // Budget"/"En budgetsemester i Stockholm") är taggad — oavsett om det var
  // en GUIDE_TAG_RULES-träff eller ett manuellt val i fältet — taggas den
  // andra automatiskt också (på begäran 2026-09-19). Körs som en del av
  // runGuideTagRules() (samma spärr, se kommentaren nedan) så den aldrig
  // skriver in i related_guides-fältet samtidigt som huvudloopen.
  async function syncGuideLangPairs() {
    const liveTitles = currentRelatedGuideTitles();
    for (const liveTitle of liveTitles) {
      const pairRow = getGuideLangPairRows().find(r => titleMatches(liveTitle, r.en) || titleMatches(liveTitle, r.sv));
      if (!pairRow) continue;
      const counterpart = titleMatches(liveTitle, pairRow.en) ? pairRow.sv : pairRow.en;
      if (liveTitles.some(t => titleMatches(t, counterpart))) continue;
      const counterpartKey = counterpart.toLowerCase();
      guidesAlreadyTagged.add(counterpartKey);
      const ok = await selectAutocompleteValue('id_related_guides', counterpart, guideSearchPrefix(counterpart));
      if (ok) {
        vlog('EventEdit: Taggade "' + counterpart + '" automatiskt (språkpar till "' + liveTitle + '").', 'ok');
        liveTitles.push(counterpart);
      } else {
        guidesAlreadyTagged.delete(counterpartKey);
      }
    }
  }

  // runEditPageChecks() (och därmed denna funktion) körs var 1.5:e sekund
  // via setInterval — men en enda selectAutocompleteValue-inskrivning tar
  // flera sekunder (tecken-för-tecken-skrivning + upp till 4s väntan på
  // förslag), så utan spärr hann flera anrop av runGuideTagRules() vara
  // igång SAMTIDIGT. Varje anrop skriver då sin egen guidetitel in i SAMMA
  // id_related_guides-fält parallellt, och tangenttryckningarna interfolieras
  // till rent nonsens (bekräftat 2026-09-19: "SSttoocckkhhoollmms" —
  // "Stockholms" skrivet två gånger samtidigt, tecken för tecken). Enkel
  // spärrflagga: ett nytt anrop avbryts direkt om ett tidigare fortfarande
  // pågår, istället för att köra parallellt.
  let guideTagRulesRunning = false;
  let autoScrolledAfterGuideTagging = false;
  async function runGuideTagRules() {
    if (guideTagRulesRunning) return;
    guideTagRulesRunning = true;
    try {
      const ctx = buildGuideTagContext();
      for (const rule of getGuideTagRules()) {
        if (guideTagRulesFired.has(rule.name)) continue;
        let hit;
        try { hit = rule.match(ctx); } catch (e) { vlog('GuideRegel "' + rule.name + '": fel i match() — ' + e.message, 'err'); continue; }
        if (!hit) continue;
        guideTagRulesFired.add(rule.name);
        const applied = [];
        for (const g of [rule.guideEn, rule.guideSv]) {
          if (!g) continue;
          const key = g.toLowerCase();
          if (guidesAlreadyTagged.has(key)) continue;
          // Märks som taggad/loggas bara vid FAKTISK träff — tidigare
          // markerades och loggades den som klar oavsett resultat, så ett
          // misslyckat/avbrutet val (t.ex. korrupt text från race-buggen
          // ovan) rapporterades som lyckat i loggen trots att inget
          // faktiskt valdes i fältet.
          const ok = await selectAutocompleteValue('id_related_guides', g, guideSearchPrefix(g));
          if (ok) {
            guidesAlreadyTagged.add(key);
            applied.push(g);
          }
        }
        if (applied.length) vlog('EventEdit: Guideregel "' + rule.name + '" taggade ' + applied.map(g => '"' + g + '"').join('/') + '.', 'ok');
      }
      await syncGuideLangPairs();
    } finally {
      guideTagRulesRunning = false;
      // Guide-autocompleten fokuserar/scrollar upprepade gånger ner mot
      // related_guides-fältet under inskrivningen och lämnar sidan mitt i
      // efteråt — rullar tillbaka till toppen EN gång när den första
      // kompletta taggningsomgången är klar (på begäran 2026-09-19). Görs
      // här i finally, INTE i ett .then() på anropet i runEditPageChecks(),
      // eftersom ett spärrat (no-op) anrop annars skulle trigga det direkt,
      // långt innan det RIKTIGA pågående anropet faktiskt är klart.
      if (!autoScrolledAfterGuideTagging) {
        autoScrolledAfterGuideTagging = true;
        scrollAllToTop();
      }
    }
  }

  // Geotaggning aktiveras av något som lyssnar på INTERAKTION med
  // adressfältet — bekräftat 2026-09-18 att bara simulerad textändring
  // (utan riktiga musklick) inte räcker (kartan aktiverades aldrig), och
  // 2026-09-19 att mousedown/mouseup/click INTE heller räcker (fortfarande
  // ingen karta), och (samma dag) att funktionen "ibland" inte aktiverade
  // fältet alls — den kördes tidigare BARA en gång, synkront, direkt vid
  // initEventEditAutomation() (utanför 1.5s-polling-loopen alla andra
  // kontroller får), så om adressfältet råkade vara TOMT i just det ögon-
  // blicket (t.ex. ett nytt utkast vars adress fylls i asynkront en stund
  // efter sidladdning) gav `!el.value`-kollen upp permanent, utan någon
  // ny chans. Anropas därför nu från runEditPageChecks() istället, så den
  // försöker igen var 1.5:e sekund tills fältet faktiskt har ett värde
  // (addressActivated-flaggan ser ändå till att den bara KÖR en gång).
  // Troliga orsaken till att synkrona musevent inte hjälper: syntetiska (script-dispatchade) mus-event
  // flyttar ALDRIG webbläsarens fokus — det gör bara riktiga, betrodda
  // användarklick. Om widgeten aktiverar kartan via en focus/focusin-lyssnare
  // på fältet har den alltså aldrig sett något fokus alls hittills. Anropar
  // därför den RIKTIGA .focus()-metoden (till skillnad från en syntetisk
  // FocusEvent, som av samma anledning inte heller flyttar fokus) och håller
  // fältet fokuserat genom hela sekvensen — simulateInput() blurrar annars
  // fältet mellan varje anrop, vilket skulle bryta av precis den
  // fokus-hållning vi nu försöker åstadkomma.
  let addressActivated = false;
  function activateAddressGeotag() {
    if (addressActivated) return;
    const el = document.getElementById('id_address');
    if (!el || !el.value) return;
    addressActivated = true;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.focus();
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const original = el.value;
    el.value = original + ' ';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = original;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    vlog('EventEdit: Aktiverade adressfältet för geotaggning (riktig .focus()/.blur() + klick + tillfällig textändring).', 'ok');
  }

  // Sätter statusfältet till "Publicerad" i stället för "Utkast" (på begäran
  // 2026-09-19) — EN gång per sida (samma engångsmönster som
  // linkTextAutofilled nedan), inte om och om igen varje poll-tick, så en
  // medveten manuell återställning till Utkast inte omedelbart körs över.
  // Matchar mot alternativets SYNLIGA TEXT ("publ...", dvs "Publicerad"/
  // "Published") istället för ett gissat value-attribut, eftersom den
  // faktiska lagrade strängen inte är bekräftad — bara fält-ID:t id_status
  // är det (samma id_<fältnamn>-konvention som alla andra fält i formuläret).
  let statusAutoPublished = false;
  function autoPublishStatus() {
    if (statusAutoPublished) return;
    const el = document.getElementById('id_status');
    if (!el || el.tagName !== 'SELECT') return;
    const target = [...el.options].find(o => /publ/i.test(o.textContent));
    if (!target) { vlog('EventEdit: Hittade inget "Publicerad"-alternativ i statusfältet (id_status).', 'err'); return; }
    statusAutoPublished = true;
    if (el.value === target.value) return;
    simulateInput(el, target.value);
    vlog('EventEdit: Ändrade status till "' + target.textContent.trim() + '".', 'ok');
  }

  // Om description_en och description_sv är identiska (samma text i båda
  // fälten, dvs bara en översättning saknas) visas en översätt-knapp vid
  // VARDERA fältet. Fältets EGET språk antas vara MÅLSPRÅKET — knappen vid
  // engelska fältet antar alltså att den delade texten egentligen är
  // svenska och översätter den till engelska (och tvärtom), eftersom
  // scriptet inte kan veta vilket av de två identiska fälten som "är fel".
  function checkIdenticalDescriptions() {
    const enText = readDraftailText('id_description_en').trim();
    const svText = readDraftailText('id_description_sv').trim();
    const identical = !!enText && !!svText && enText.toLowerCase() === svText.toLowerCase();
    ['en', 'sv'].forEach(lang => {
      const el = document.getElementById('id_description_' + lang);
      if (!identical) { setFieldNote(el, 'translate', ''); return; }
      const label = lang === 'en' ? 'engelska' : 'svenska';
      setFieldNote(el, 'translate',
        '<span style="color:#4a9fe0;">🌐 Samma text i båda fälten — </span>' +
        '<button type="button" class="vseh-translate-btn" data-lang="' + lang + '" style="font-size:12px;padding:2px 8px;cursor:pointer;">Översätt till ' + label + '</button>');
    });
    document.querySelectorAll('.vseh-translate-btn').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Översätter…';
        await translateDescription(btn.dataset.lang);
      });
    });
  }

  // Mistral har ingen egen "översättnings-endpoint" — det är samma
  // chat/completions-anrop som resten av scriptet redan använder (MISTRAL_CHAT),
  // bara med en översättningsprompt istället för agentens egna instruktioner
  // (agenten är byggd för att skriva om/skapa event, inte för ren översättning,
  // så vi går förbi den och kör en enkel, fristående modell direkt).
  async function translateDescription(targetLang) {
    const sourceText = readDraftailText('id_description_' + (targetLang === 'en' ? 'sv' : 'en'));
    const mistralKey = GM_getValue('mistral_key', '');
    if (!mistralKey) { vlog('Översättning: Mistral API-nyckel saknas (fliken Inställningar).', 'err'); return; }
    const targetName = mistralLangName(targetLang);
    try {
      vlog('Översättning: Skickar text till Mistral (→ ' + targetName + ')…');
      const payload = {
        model: 'mistral-small-latest',
        messages: [
          { role: 'system', content: 'Du är en professionell översättare. Översätt EXAKT texten användaren ger till ' + targetName + '. Svara UTESLUTANDE på ' + targetName + ', oavsett vad källtexten är skriven på. Svara ENDAST med den översatta texten — ingen kommentar, inga citattecken, ingen extra formatering.' },
          { role: 'user', content: sourceText }
        ]
      };
      const resp = await gmPost(MISTRAL_CHAT, { 'Authorization': 'Bearer ' + mistralKey, 'Content-Type': 'application/json' }, payload);
      const translated = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      if (!translated) throw new Error('Tomt svar från Mistral');
      await updateDraftail('id_description_' + targetLang, translated.trim());
      vlog('Översättning: Klar (' + targetName + ').', 'ok');
    } catch (e) {
      vlog('Översättning: Fel — ' + e.message, 'err');
    }
  }

  // Andrahandssajter för biljetter (sekundärmarknad) — vi länkar bara till
  // arrangörens EGEN officiella försäljning enligt riktlinjerna. Sparande
  // spärras (submit-guard nedan) tills länken ändras ELLER "URL granskad"
  // klickas för just den URL:en (manuell överstyrning av en falsk positiv).
  const RESALE_DOMAINS = ['viagogo', 'evenemangsbiljetter.se', 'stubhub', 'biljett24', 'biljettnu', 'biljettshop'];
  let resaleReviewedUrl = null;
  let resaleBlocked = false;
  function checkResaleUrl() {
    const el = document.getElementById('id_external_website_url');
    if (!el) return;
    const url = (el.value || '').toLowerCase();
    const hit = RESALE_DOMAINS.find(d => url.includes(d));
    if (!hit) { resaleBlocked = false; setFieldNote(el, 'resale', ''); return; }
    if (url === resaleReviewedUrl) {
      resaleBlocked = false;
      setFieldNote(el, 'resale', '<span style="color:#1f7a4d;font-weight:600;">✅ URL granskad och godkänd trots träff på "' + esc(hit) + '".</span>');
      return;
    }
    resaleBlocked = true;
    setFieldNote(el, 'resale',
      '<div style="color:#c02626;font-weight:600;">🚫 Möjlig andrahandssajt (biljettåterförsäljare) i länken: "' + esc(hit) + '". ' +
      'Vi länkar bara till arrangörens officiella biljettförsäljning — sparande är spärrat. ' +
      '<button type="button" id="vseh-resale-ok-btn" style="font-size:12px;padding:2px 8px;cursor:pointer;">URL granskad ✅</button></div>');
    const btn = document.getElementById('vseh-resale-ok-btn');
    if (btn) btn.onclick = () => { resaleReviewedUrl = url; checkResaleUrl(); };
  }
  function installResaleSubmitGuard() {
    const form = document.querySelector('form');
    if (!form || form.dataset.resaleGuardInstalled) return;
    form.dataset.resaleGuardInstalled = '1';
    form.addEventListener('submit', e => {
      if (!resaleBlocked) return;
      e.preventDefault();
      e.stopPropagation();
      vlog('EventEdit: Sparande blockerat — möjlig andrahandssajt i länken. Ändra URL:en eller klicka "URL granskad".', 'err');
      alert('Länken pekar mot en möjlig andrahandssajt för biljetter. Ändra länken eller klicka "URL granskad" bredvid fältet innan du sparar.');
    }, true);
  }

  // Fyller bara i om fältet är tomt (rör aldrig text du redan skrivit).
  // "Biljetter / Tickets" om länken går till en känd biljettleverantör ELLER
  // kategorin är Stage & Film — annars "Mer information / More information"
  // om en länk finns men fältet står tomt.
  // OBS (2026-09-19): "nortic.se" togs bort härifrån — norticItemToOccurrences()
  // sätter external_website_url till Nortic-eventets EGEN listningssida (den
  // skrapade aggregator-sidan), inte en biljettköp-länk. Eftersom Nortic är en
  // av de stora importkällorna fick nästan ALLA importerade utkast "Biljetter"
  // istället för "Mer information" så länge domänen stod kvar i listan.
  const TICKET_VENDOR_DOMAINS = ['ticketmaster.se', 'axs.com', 'eventim.se', 'tickster.com',
    'kulturbiljetter.se', 'billetto.se', 'tixly.com', 'kulturcentralen.nu', 'showtic.se', 'wannado.se',
    'ticketco.se', 'eventix.io', 'stockholmlive.se', 'gotevent.se'];
  let linkTextAutofilled = false;
  function autofillLinkText() {
    if (linkTextAutofilled) return;
    const urlEl = document.getElementById('id_external_website_url');
    const textEl = document.getElementById('id_external_website_url_text');
    if (!urlEl || !textEl || textEl.value.trim() || !urlEl.value.trim()) return;
    const url = urlEl.value.toLowerCase();
    const isTicketVendor = TICKET_VENDOR_DOMAINS.some(d => url.includes(d));
    const isStageFilm = currentCategoryTitles().map(c => c.toLowerCase()).includes('stage & film');
    linkTextAutofilled = true;
    const text = (isTicketVendor || isStageFilm) ? 'Biljetter / Tickets' : 'Mer information / More information';
    simulateInput(textEl, text);
    vlog('EventEdit: Fyllde i länktext "' + text + '".', 'ok');
  }

  function runEditPageChecks() {
    activateAddressGeotag();
    autoPublishStatus();
    stripEmojisFromTitles();
    checkTitleCasing();
    stripDescriptionEmoji();
    checkGuidelineIssues();
    checkIdenticalDescriptions();
    checkResaleUrl();
    autofillLinkText();
    runGuideTagRules().catch(() => {});
  }

  // Wagtails egen "Senast ändrad"-rad (avatar + tidsstämpel i sidfoten/
  // redigeringshistoriken) betyder att eventet redan har hanterats/
  // redigerats tidigare — inte bara den ursprungliga automatiska draften.
  // Ett HELT NYTT event (utan denna rad) körs som vanligt, utan fråga.
  function findAlreadyHandledIndicator() {
    return [...document.querySelectorAll('li')].find(li => li.textContent.includes('Senast ändrad'));
  }

  // Frågar INNAN någon automatik körs på ett redan hanterat event — annars
  // riskerar vi att skriva över en redaktörs egna, medvetna val (taggning,
  // publiceringsstatus, texträttningar) utan att de bad om det (på begäran
  // 2026-09-19).
  function showAutomationConsentBar(onAccept) {
    ensureEditBarStyle();
    if (document.getElementById('vseh-consent-bar')) return;
    const anchor = document.querySelector('.page-header, .header, header, h1') || document.querySelector('form');
    const bar = document.createElement('div');
    bar.id = 'vseh-consent-bar';
    bar.innerHTML = `
      <span>⚠️ Detta event har redan hanterats — vill du tillåta automatiska ändringsförslag och taggade guider?</span>
      <button type="button" id="vseh-consent-yes">Ja</button>
      <button type="button" id="vseh-consent-no">Nej</button>
    `;
    if (anchor) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById('vseh-consent-yes').addEventListener('click', () => {
      bar.remove();
      vlog('EventEdit: Automatik godkänd (eventet redan hanterat sedan tidigare).', 'ok');
      onAccept();
    });
    document.getElementById('vseh-consent-no').addEventListener('click', () => {
      bar.innerHTML = '<span>Automatik avstängd för detta event — inga ändringar görs.</span>';
      vlog('EventEdit: Automatik avvisad (eventet redan hanterat sedan tidigare) — ingen automatik körs.', 'ok');
    });
  }

  function initEventEditAutomation() {
    vlog('EventEdit: Initierar automatiska kontroller på edit-sidan');
    const startAutomation = () => {
      initEventChecker();
      installResaleSubmitGuard();
      runEditPageChecks();
      // Formuläret uppdaterar sina dolda fält utan DOM-mutationer vi enkelt
      // kan observera (Draftails onChange, autocompletens val-klick) — en
      // enkel poll täcker alla kontrollerna ovan billigt nog för ett
      // formulär av den här storleken.
      setInterval(runEditPageChecks, 1500);
    };
    if (findAlreadyHandledIndicator()) {
      showAutomationConsentBar(startAutomation);
    } else {
      startAutomation();
    }
  }

  // ---- Init ----------------------------------------------------------------
  // Full produktionsdrift ENDAST på de kända Wagtail-skapa-sidorna — där antar
  // vi specifika fält-id:n (id_title_sv m.fl.) som bara finns där. På alla
  // andra sidor (t.ex. nya formulär under kartläggning) visas bara det
  // generella kartläggningsverktyget, inget som förutsätter Wagtails struktur.
  const KNOWN_PRODUCTION_URL = /^https:\/\/www\.visitstockholm\.(com|se)\/cms\/api\/event\/create\//;
  const KNOWN_SBR_URL = /^https:\/\/www\.stockholmbusinessregion\.se\/wt\/cms\/snippets\/api\/event\//;
  // Nya sidtyper (v0.7.52): draft-listan och edit-sidan. Läggs som egna,
  // fristående grenar — rör inte create-grenen ovan.
  // status__exact=draft kan stå var som helst i query-strängen (Wagtails
  // egen sortering lägger t.ex. till o=4.3 eller o=3.-4 FÖRE den), så vi
  // matchar på förekomst av parametern snarare än en exakt query-sträng.
  const KNOWN_DRAFT_URL = /\/(?:cms\/api\/event|wt\/cms\/snippets\/api\/event)\/\?(?:.*&)?status__exact=draft(?:&|$)/;
  const KNOWN_EDIT_URL = /(\/cms\/api\/event\/edit\/)|(\/wt\/cms\/snippets\/api\/event\/edit\/)/;
  // Sidlistan (Wagtails generella explorer/sökresultat) filtrerad på
  // content_type=46 (bekräftat värde för "Guide") — samma "kan stå var som
  // helst i query-strängen"-logik som draft-listan ovan.
  const KNOWN_GUIDE_LIST_URL = /\/cms\/pages\/\d+\/\?(?:.*&)?content_type=46(?:&|$)/;
  if (KNOWN_PRODUCTION_URL.test(location.href)) {
    injectStyle();
    loadDismissals();
    loadClearedGroups();
    loadSkipList();
    loadManualIn();
    // Engångsmigrering: gamla "Ska ej in"-markeringar blir nu "Hanterad".
    if (skipList.size) {
      let migrated = 0;
      skipList.forEach(k => { if (!manualIn.has(k)) { manualIn.add(k); migrated++; } });
      if (migrated) { saveManualIn(); vlog('Migrerade ' + migrated + ' "Ska ej in"-markeringar till "Hanterad".'); }
      skipList.clear(); saveSkipList();
    }
    mode = GM_getValue('window_mode', 'min');
    if (mode === 'small') mode = 'max';            // legacy-läge → maximera
    if (!['min', 'max'].includes(mode)) mode = 'min';
    buildPanel();
    { const t1 = GM_getValue('tm_fetched_ts', 0); const e1 = $('vseh-tm-ts'); if (e1 && t1) e1.textContent = fmtStamp(t1);
      const t2 = GM_getValue('vs_fetched_ts', 0); const e2 = $('vseh-vs-ts'); if (e2 && t2) e2.textContent = fmtStamp(t2);
      const t3 = GM_getValue('billetto_fetched_ts', 0); const e3 = $('vseh-bl-ts'); if (e3 && t3) e3.textContent = fmtStamp(t3);
      const t4 = GM_getValue('tickster_fetched_ts', 0); const e4 = $('vseh-tix-ts'); if (e4 && t4) e4.textContent = fmtStamp(t4);
      const t5 = GM_getValue('nortic_fetched_ts', 0); const e5 = $('vseh-nortic-ts'); if (e5 && t5) e5.textContent = fmtStamp(t5); }
    const { calTs, tmTs } = loadCache();
    if (dedupIndex && calTs) {
      // dedup-tidsstämpeln visas nu vid VisitStockholm-raden
      const e2 = $('vseh-vs-ts'); if (e2) e2.textContent = fmtStamp(calTs);
    }
    if (lastGrouped.length) {
      render(lastGrouped);
      setStatus(`Från cache: ${lastGrouped.length} event · hämtat ${ago(tmTs)}. Klicka Hämta för att uppdatera.`, 'ok');
    }
  } else if (KNOWN_SBR_URL.test(location.href)) {
    mode = GM_getValue('window_mode', 'min');
    if (mode === 'small') mode = 'max';            // legacy-läge → maximera
    if (!['min', 'max'].includes(mode)) mode = 'min';
    buildSbrPanel();
  } else if (KNOWN_DRAFT_URL.test(location.href)) {
    initDraftvyDubblettkoll();
  } else if (KNOWN_EDIT_URL.test(location.href)) {
    initEventEditAutomation();
  } else if (KNOWN_GUIDE_LIST_URL.test(location.href)) {
    initGuideListTool();
  }
  // (Ingen else-gren längre — scriptet matchar numera bara de kända URL:erna
  // ovan, se @match. Kartläggningsverktyget för okända sidor lever nu i ett
  // separat script: Formkartläggare.)
})();
