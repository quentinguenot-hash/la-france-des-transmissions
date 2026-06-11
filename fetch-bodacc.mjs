#!/usr/bin/env node
/**
 * La France des Transmissions — ingestion BODACC (export statique, brief V0)
 * ==========================================================================
 * Récupère les dernières cessions + liquidations depuis l'open data DILA et
 * génère `data.js` (window.BODACC_DATA) consommé par index.html.
 *
 * Parsing aligné sur le pipeline Liquide Flow
 * (infra/lambdas/bodacc_daily + server/migrations/034_bodacc_transactions_builder.sql) :
 *   - familleavis_lib = 'Ventes et cessions' AND typeavis_lib = 'Avis initial'
 *   - exclusion des « insertions provisoires » (acte.descriptif / categorieVente)
 *   - prix : regex `au prix (stipulé )?de <n> eur|€` sur le TEXT brut de
 *     listeetablissements, fallback sur acte.descriptif
 *   - activité : listeetablissements.etablissement.activite
 *   - liquidations : familleavis_lib = 'Procédures collectives' + jugement.nature
 *     « ouverture de liquidation judiciaire »
 *
 * RGPD (garde-fou du brief) : on n'affiche jamais un nom de personne physique
 * quand c'est évitable → priorité dénomination PM > nom commercial > libellé
 * d'activité.
 *
 * Usage : node fetch-bodacc.mjs [--cessions 420] [--liquidations 45]
 */

const BASE = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
/* défaut : depuis le 1er du mois courant */
const now = new Date();
const SINCE = argVal('--since', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
const MAX_CESSIONS = parseInt(argVal('--max', '5000'), 10);
/* liquidations : ~12 % du volume de cessions par défaut, ou --liquidations N */
const LIQUID_ARG = argVal('--liquidations', null);

/* ---------- Secteurs (mêmes index que SECTORS dans index.html) ---------- */
const SECTOR_KEYWORDS = [
  // 0 — Commerces de bouche
  ['boulanger', 'pâtisser', 'patisser', 'boucher', 'charcut', 'fromag', 'poissonn',
   'traiteur', 'primeur', 'épicerie', 'epicerie', 'chocolat', 'viennois', 'alimentation générale',
   'caviste', 'vins et spiritueux', 'biscuiter', 'confiser', 'torréfact'],
  // 1 — Cafés & restaurants
  ['restaurant', 'restaur', 'brasserie', 'pizzer', 'crêper', 'creper', 'snack', 'kebab',
   'café', 'cafe,', ' bar', 'bar,', 'bar ', 'débit de boissons', 'debit de boissons',
   'hôtel', 'hotel', 'camping', 'chambres d’hôtes', "chambres d'hôtes", 'gîte',
   'salon de thé', 'restauration'],
  // 2 — Commerces de détail
  ['librairie', 'presse', 'tabac', 'fleuriste', 'prêt-à-porter', 'pret-a-porter', 'vêtement',
   'vetement', 'chaussure', 'bijou', 'maroquin', 'mercerie', 'jouet', 'papeterie', 'bazar',
   'droguerie', 'quincailler', 'coiffure', 'coiffeur', 'esthétique', 'esthetique',
   'institut de beauté', 'parfumerie', 'toilettage', 'animalerie', 'décoration', 'meuble',
   'antiquité', 'brocante', 'supermarché', 'supérette', 'superette', 'commerce de détail',
   'magasin', 'boutique', 'négoce', 'negoce', 'commerce de'],
  // 3 — Garages & auto
  ['garage', 'automobile', 'véhicule', 'vehicule', 'carrosserie', 'pneu', 'auto-école',
   'auto-ecole', 'mécanique auto', 'cycles', 'motocycle', 'station-service', 'station service',
   'lavage auto', 'contrôle technique', 'controle technique', 'dépannage auto', 'taxi', 'vtc',
   'ambulance'],
  // 4 — BTP & artisanat
  ['maçonnerie', 'maconnerie', 'plomberie', 'électricité', 'electricite', 'menuiserie',
   'charpente', 'couverture', 'zinguerie', 'peinture', 'carrelage', 'bâtiment', 'batiment',
   'travaux', 'rénovation', 'renovation', 'serrurerie', 'terrassement', 'paysag', 'plâtrerie',
   'platrerie', 'isolation', 'chauffage', 'climatisation', 'ébénisterie', 'ebenisterie',
   'artisan'],
  // 5 — Industrie
  ['fabrication', 'usine', 'industrie', 'production de', 'fonderie', 'usinage', 'métallerie',
   'metallerie', 'imprimerie', 'scierie', 'conserverie', 'transformation de', 'atelier de',
   'mécanique de précision', 'mecanique de precision', 'chaudronnerie', 'plasturgie', 'textile'],
  // 6 — Services & bureaux
  ['conseil', 'agence', 'immobili', 'transport', 'nettoyage', 'sécurité', 'securite',
   'gardiennage', 'formation', 'informatique', 'logiciel', 'comptab', 'assurance', 'gestion',
   'location de', 'courtage', 'marketing', 'communication', 'étude', 'ingénierie', 'ingenierie',
   'expertise', 'services aux', 'prestations de services', 'consulting', 'avocat', 'notaire',
   'déménagement', 'demenagement', 'blanchisserie', 'pressing'],
  // 7 — Santé & soins
  ['pharmacie', 'médical', 'medical', 'dentaire', 'infirmier', 'laboratoire d’analyses',
   "laboratoire d'analyses", 'orthopéd', 'orthoped', 'optique', 'audioproth', 'kinésith',
   'kinesith', 'ostéopath', 'osteopath', 'paramédical', 'paramedical', 'santé'],
];
// ordre de test : santé et resto avant commerce (mots plus spécifiques d'abord)
const SECTOR_TEST_ORDER = [7, 0, 1, 3, 4, 5, 6, 2];

function mapSector(activity) {
  const a = (activity || '').toLowerCase();
  if (!a) return 6;
  for (const s of SECTOR_TEST_ORDER) {
    if (SECTOR_KEYWORDS[s].some(k => a.includes(k))) return s;
  }
  return 2; // défaut : commerce de détail
}

/* ---------- Utilitaires ---------- */
const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const tierOf = p => p < 100e3 ? 0 : p < 500e3 ? 1 : p < 2e6 ? 2 : p < 10e6 ? 3 : 4;

function titleCaseIfShouting(name) {
  if (!name || name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(Sarl|Sas|Sasu|Eurl|Sci|Snc|Sa)\b/g, m => m.toUpperCase());
}

function parseMaybeJson(s) {
  if (!s || typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}
const asArray = v => v == null ? [] : Array.isArray(v) ? v : [v];

/* Prix — regex Liquide Flow sur le TEXT brut, + fallback descriptif */
const PRICE_RE_LF = /au\s+prix\s+(?:stipul[ée]e?\s+)?de\s+(\d+(?:[.,]\d{1,2})?)\s*(?:euros?|eur|€)/i;
const PRICE_RE_DESC = /prix\s+(?:principal\s+|global\s+|de\s+vente\s+|de\s+cession\s+)?de\s+[^()]{0,90}?\(?\s*([\d][\d\s .]{2,14}(?:,\d{1,2})?)\s*(?:euros?|eur|€)/i;

function extractPrice(leText, descriptif) {
  let m = PRICE_RE_LF.exec(leText || '');
  if (m) {
    const v = parseFloat(m[1].replace(',', '.'));
    if (v >= 500 && v < 100e6) return Math.round(v);
  }
  m = PRICE_RE_DESC.exec(descriptif || '');
  if (m) {
    // "55 000.00" / "320 000" / "1.250.000" → on retire séparateurs de milliers
    let raw = m[1].replace(/[\s ]/g, '');
    if (/\.\d{3}(\.|$)/.test(raw)) raw = raw.replace(/\./g, '');      // points = milliers
    const v = parseFloat(raw.replace(',', '.'));
    if (v >= 500 && v < 100e6) return Math.round(v);
  }
  return null;
}

/* Nom affiché — garde-fou RGPD : dénomination PM > nom commercial > activité */
function cleanActivityLabel(activity) {
  let a = (activity || '').split(/[,;.()]/)[0].trim();
  a = a.replace(/^(exploitation\s+(d'|d’|de\s+|d'un\s+|d’un\s+)?)/i, '')
       .replace(/^(fonds\s+(artisanal\s+et\s+commercial|de\s+commerce|artisanal)\s+(de\s+|d'|d’)?)/i, '')
       .replace(/^(activité\s+(de\s+|d'|d’)?)/i, '')
       .trim();
  if (!a) return null;
  a = a.charAt(0).toUpperCase() + a.slice(1);
  return a.length > 44 ? a.slice(0, 42).trimEnd() + '…' : a;
}

function displayName(fields, activity) {
  const lp = parseMaybeJson(fields.listepersonnes);
  const persons = asArray(lp && lp.personne);
  const pm = persons.find(p => p && p.typePersonne === 'pm' && p.denomination);
  if (pm) return titleCaseIfShouting(pm.denomination).slice(0, 44);
  const le = parseMaybeJson(fields.listeetablissements);
  const etabs = asArray(le && le.etablissement);
  const nomCo = etabs.map(e => e && (e.enseigne || e.nomCommercial)).find(Boolean);
  if (nomCo) return titleCaseIfShouting(nomCo).slice(0, 44);
  const fromActivity = cleanActivityLabel(activity);
  if (fromActivity) return fromActivity;
  // dernier recours : commercant (peut contenir un nom de personne physique)
  return titleCaseIfShouting((fields.commercant || 'Entreprise').split(',')[0].trim()).slice(0, 44);
}

/* ---------- Client API ---------- */
async function fetchPage(where, offset, limit = 100) {
  const u = new URL(BASE);
  u.searchParams.set('where', where);
  u.searchParams.set('order_by', 'dateparution ASC, id ASC');
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('offset', String(offset));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(u, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (![429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`DILA HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error('DILA: trop de retries');
}

/* ---------- Cessions (toutes depuis SINCE) ---------- */
async function fetchCessions() {
  const where = `familleavis_lib="Ventes et cessions" AND typeavis_lib="Avis initial" AND dateparution>=date'${SINCE}'`;
  const kept = [];
  let scanned = 0, provisoires = 0, withPrice = 0, locGerance = 0;
  for (let offset = 0; kept.length < MAX_CESSIONS && offset < 9900; offset += 100) {
    const page = await fetchPage(where, offset);
    const results = page.results || [];
    if (!results.length) break;
    for (const f of results) {
      scanned++;
      const acte = parseMaybeJson(f.acte) || {};
      const catVente = (acte.vente && acte.vente.categorieVente) || '';
      const descriptif = acte.descriptif || '';
      if (/insertion provisoire/i.test(descriptif) || /insertion provisoire/i.test(catVente)) {
        provisoires++; continue;                       // évite le doublon provisoire/définitif
      }
      if (/location[\s-]?g[ée]rance/i.test(catVente)) {
        locGerance++; continue;                        // pas un transfert de propriété
      }
      const le = parseMaybeJson(f.listeetablissements);
      const etabs = asArray(le && le.etablissement);
      const activity = etabs.map(e => e && e.activite).find(Boolean) || '';
      const price = extractPrice(f.listeetablissements, descriptif);
      if (price) withPrice++;
      const sector = mapSector(activity);
      kept.push({
        id: f.id,
        date: f.dateparution,
        name: displayName(f, activity),
        city: (f.ville || '—').split(',')[0].trim(),
        dept: f.numerodepartement || (f.cp || '').slice(0, 2) || '—',
        sector,
        tier: price ? tierOf(price) : hash(f.id) % 2,
        price: price || 0,
        priceKnown: !!price,
        variant: hash(f.id) % 4,
        activity: (activity || '').slice(0, 110),
        url: f.url_complete || '',
      });
      if (kept.length >= MAX_CESSIONS) break;
    }
    process.stdout.write(`\r  cessions : ${kept.length} (scannées ${scanned}, provisoires ${provisoires})   `);
  }
  console.log();
  return { kept, scanned, provisoires, withPrice, locGerance }; // déjà en ordre chronologique (ASC)
}

/* jugement d'ouverture de liquidation judiciaire (exclut les avis de dépôt
   de liste des créances, qui mentionnent aussi « liquidation judiciaire ») */
function isLJOpening(f) {
  const jug = parseMaybeJson(f.jugement) || {};
  const fam = (jug.famille || '').toLowerCase();
  const nature = (jug.nature || '').toLowerCase();
  return fam.includes("jugement d'ouverture") && nature.includes('liquidation judiciaire');
}

/* compte RÉEL des jugements d'ouverture de LJ sur la période (pour afficher un
   chiffre exact même si l'animation n'en représente qu'un échantillon) */
async function countLiquidationsTotal(from, to) {
  const where = `familleavis_lib="Procédures collectives" AND typeavis_lib="Avis initial" AND dateparution>=date'${from}' AND dateparution<=date'${to}' AND search(jugement, "ouverture de liquidation judiciaire")`;
  let total = 0, scanned = 0;
  for (let offset = 0; offset < 9900; offset += 100) {
    const page = await fetchPage(where, offset);
    const results = page.results || [];
    if (!results.length) break;
    for (const f of results) { scanned++; if (isLJOpening(f)) total++; }
    process.stdout.write(`\r  comptage liquidations réelles : ${total} (scannées ${scanned})   `);
  }
  console.log();
  return total;
}

/* ---------- Liquidations — échantillonnées sur chaque jour de la période ----------
   Les jugements de liquidation sont publiés par centaines chaque jour : si on
   prenait juste les N plus récents, ils seraient tous datés du dernier jour et
   se déclencheraient en bloc à la fin du replay. On prélève donc ~N/jours par
   date de parution couverte par les cessions. */
async function fetchLiquidations(parutionDates, target) {
  const perDay = Math.max(1, Math.ceil(target / parutionDates.length));
  const kept = [];
  let scanned = 0;
  for (const day of parutionDates) {
    const where = `familleavis_lib="Procédures collectives" AND typeavis_lib="Avis initial" AND dateparution=date'${day}' AND search(jugement, "ouverture de liquidation judiciaire")`;
    let dayKept = 0;
    for (let offset = 0; dayKept < perDay && kept.length < target && offset < 500; offset += 100) {
      const page = await fetchPage(where, offset);
      const results = page.results || [];
      if (!results.length) break;
      for (const f of results) {
        scanned++;
        if (!isLJOpening(f)) continue;
        const lp = parseMaybeJson(f.listepersonnes);
        const persons = asArray(lp && lp.personne);
        const activity = persons.map(p => p && p.activite).find(Boolean) || '';
        kept.push({
          id: f.id,
          date: f.dateparution,
          name: displayName(f, activity),
          city: (f.ville || '—').split(',')[0].trim(),
          dept: f.numerodepartement || (f.cp || '').slice(0, 2) || '—',
          sector: mapSector(activity),
          tier: hash(f.id) % 2,
          price: 0,
          priceKnown: false,
          variant: hash(f.id) % 4,
          activity: (activity || '').slice(0, 110),
          url: f.url_complete || '',
        });
        dayKept++;
        if (dayKept >= perDay || kept.length >= target) break;
      }
    }
    process.stdout.write(`\r  liquidations : ${kept.length}/${target} (scannées ${scanned})   `);
  }
  console.log();
  return kept.sort((a, b) => a.date < b.date ? -1 : 1);
}

/* ---------- Main ---------- */
console.log('BODACC → La France des Transmissions');
const { kept: cessions, scanned, provisoires, withPrice, locGerance } = await fetchCessions();
const parutionDates = [...new Set(cessions.map(c => c.date))].sort();
const liquidTarget = LIQUID_ARG ? parseInt(LIQUID_ARG, 10) : Math.max(10, Math.round(cessions.length * 0.12));
const liquidations = await fetchLiquidations(parutionDates, liquidTarget);
const liquidationsTotal = await countLiquidationsTotal(cessions[0]?.date, cessions[cessions.length - 1]?.date);

if (!cessions.length) { console.error('Aucune cession récupérée — abort.'); process.exit(1); }

const from = cessions[0].date, to = cessions[cessions.length - 1].date;
const periodDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400e3) + 1);
const cadenceMinutes = Math.max(1, Math.round((periodDays * 1440) / cessions.length));
const priceRate = Math.round((withPrice / cessions.length) * 100);

const sectorCounts = {};
for (const c of cessions) sectorCounts[c.sector] = (sectorCounts[c.sector] || 0) + 1;

const data = {
  generatedAt: new Date().toISOString(),
  source: 'BODACC open data (DILA) — bodacc-datadila.opendatasoft.com',
  period: { from, to, days: periodDays },
  cadenceMinutes,
  stats: { cessions: cessions.length, liquidations: liquidations.length, liquidationsTotal,
           priceRate, scanned, provisoires, locGerance },
  cessions,
  liquidations,
};

const js = '/* Généré par fetch-bodacc.mjs — ne pas éditer à la main */\nwindow.BODACC_DATA = ' +
  JSON.stringify(data, null, 1) + ';\n';
await import('node:fs/promises').then(fs => fs.writeFile(new URL('./data.js', import.meta.url), js));

console.log(`\n✔ data.js généré`);
console.log(`  période     : ${from} → ${to} (${periodDays} j)`);
console.log(`  cessions    : ${cessions.length} (prix présent : ${priceRate} %, provisoires exclues : ${provisoires})`);
console.log(`  liquidations: ${liquidations.length} animées / ${liquidationsTotal} réelles sur la période (loc-gérances exclues : ${locGerance})`);
console.log(`  cadence     : 1 cession toutes les ~${cadenceMinutes} min`);
console.log(`  secteurs    : ${JSON.stringify(sectorCounts)}`);
