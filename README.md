# La France des Transmissions — POC v0

Simulation animée des entreprises transmises et rachetées en France, inspirée de DataEmpire (datafa.st).
**Statut : POC branché sur les données réelles BODACC** (export statique J-1, conforme brief V0). Cadrage : brief du 11 juin 2026.

## Lancer

Aucun build, aucune dépendance :

```bash
node fetch-bodacc.mjs   # rafraîchit data.js depuis l'open data BODACC (~30 s)
open index.html
# ou pour servir en local : npx serve .
```

Si `data.js` est absent, la page bascule automatiquement sur un dataset fictif (mode démo hors-ligne).

## Phase 0 — validation data (faite le 11 juin 2026)

| Question du brief | Résultat réel |
|---|---|
| Taux de présence du prix (estimé 60–80 %) | **68 %** des cessions (regex Liquide Flow sur `listeetablissements` + fallback `acte.descriptif`) |
| Volume quotidien d'annonces « ventes » | **80–350/jour** selon les jours de parution (~420 cessions = 3 jours de flux) |
| Qualité du champ activité | Bonne — texte libre propre (`listeetablissements.etablissement.activite`), mapping mots-clés → 8 familles OK |
| Latence de publication | Annonces du jour disponibles le jour même via l'API (J0/J+1) |
| Cadence réelle | **1 cession toutes les ~10 minutes** (calculée dynamiquement, affichée dans le hook) |

## Ingestion (`fetch-bodacc.mjs`)

Node ≥ 18, zéro dépendance. Parsing aligné sur le pipeline BODACC de **Liquide Flow**
(`infra/lambdas/bodacc_daily` + `server/migrations/034_bodacc_transactions_builder.sql`) :

- Période : **tout le mois en cours par défaut** (`--since 2026-06-01`, `--max 5000`)
- Cessions : `familleavis_lib="Ventes et cessions"` + `typeavis_lib="Avis initial"`, **insertions provisoires exclues** (évite les doublons provisoire/définitif)
- Prix : regex `au prix (stipulé )de <n> eur|€` sur le texte brut de `listeetablissements`, fallback sur `acte.descriptif` (« prix principal de … »)
- Liquidations : `familleavis_lib="Procédures collectives"` + `jugement.nature` contenant « ouverture de liquidation judiciaire », **échantillonnées sur chaque jour** de la période pour s'interlacer dans le replay
- **Garde-fou RGPD** (brief) : nom affiché = dénomination personne morale > enseigne/nom commercial > libellé d'activité ; jamais un nom de personne physique quand c'est évitable
- Options : `node fetch-bodacc.mjs --since 2026-06-01 --max 5000 --liquidations 126` (liquidations : ~12 % du volume par défaut)

## Ce que contient ce POC (vs brief V0)

| Brief V0 | POC |
|---|---|
| Scène isométrique, cessions rejouées en ~3 min | ✅ **tout le mois en cours** (~1 000+ cessions) rejoué en ~3 min à ×1 — cadence du replay auto-adaptée au volume |
| 6 types de bâtiments, 4 tailles | ✅ 8 familles de secteurs, 5 paliers de prix (taille/hauteur, 2×2 + drapeau pour > 10 M€) |
| Ville | ✅ **une seule grande ville qui s'étend encore et encore** : place + parc au centre, anneaux de terrain qui se déverrouillent au rythme des constructions, boulevards concentriques tous les 5 anneaux + avenues rayonnantes (grille 71×71, ~3 500 parcelles) |
| Quartiers par secteur | ✅ quartiers angulaires **proportionnels au poids réel de chaque secteur** dans les données + garde-fou de compacité (pas de construction à plus de 3 anneaux du front global) → ville ronde et équilibrée |
| Compteur global | ✅ entreprises transmises, € échangés (~65 % des annonces avec prix), entreprises brûlées, date courante |
| Tooltips au survol | ✅ nom, secteur, ville (dept), prix, date, activité réelle de l'annonce |
| Pause / vitesse / filtre secteur | ✅ ⏸, ×1 ×2 ×4, ⛶ cadrage auto (la caméra dézoome en suivant la croissance), chips de filtre |
| Événements négatifs (v1) | ✅ liquidations judiciaires → **la maison brûle** : lueur orange, flammes, fumée, puis carcasse calcinée avec braises et fumerolles |
| Sons | ✅ synthétisés en WebAudio (marteau, carillon, embrasement) — zéro asset, toggle ♪ |
| Pixel art | ✅ **procédural** (Canvas 2D) : toits en tuiles, volets verts, auvents rayés, ombres portées, routes pavées, place + fontaine, mascotte casquette bleue, panneau « La Boutique PME » — palette crème/terracotta CEDE |
| CTA lead gen | ✅ « Votre entreprise vaudrait combien ? » → laboutiquepme.com avec UTM (`utm_source=transmissions`) |

Interactions bonus : pan (drag), zoom (molette), cadrage auto débrayable (⛶), **timeline en haut** (date courante + curseur qui avance, graduations par jour de parution), écran d'intro (hook recalculé sur la cadence réelle) et écran de fin avec récap partageable.

Ajouts notables :
- **Hôtel de ville « LA BOUTIQUE PME »** au centre de la place (frise enseigne, fronton + horloge, drapeau flamme) + mascotte casquette bleue sur le parvis, fontaine sur le parvis sud
- **Export vidéo** ⏺ : enregistre le replay (canvas + sons) en WebM/MP4 via MediaRecorder, avec habillage (titre, compteurs, watermark laboutiquepme.com) redessiné dans le canvas ; lien « Lancer en enregistrant la vidéo » sur l'intro, arrêt auto à la fin du replay
- **CTA** : « Faites-vous accompagner pour vendre votre société » (compteur + écran de fin)
- **Stats honnêtes** : toutes les cessions comptées, « ≥ X M€ » (somme des prix publiés uniquement, ~65 %), liquidations = **total réel compté via l'API** (l'animation n'en représente ~1 sur 9, tooltip explicatif), copy juridique correct (« placée en liquidation judiciaire »)

## Architecture (un seul fichier, `index.html`)

- **Données fictives** : générateur seedé (`mulberry32`) → replay déterministe. 8 secteurs pondérés, ~48 villes réelles, noms d'entreprises crédibles, prix log-distribués par palier, dates du 12 mai au 10 juin 2026.
- **Rendu** : Canvas 2D, sprites pixel-art générés procéduralement et mis en cache (aucun pack d'assets nécessaire pour la démo). `imageSmoothingEnabled=false` pour le rendu pixel.
- **Ville** : grille iso 27×27, routes en croix, 8 blocs = 8 quartiers sectoriels, parc + place + fontaine au centre.
- **Audio** : WebAudio synthétisé, activé au clic d'intro (politique autoplay).

## Format interne du moteur

`data.js` expose `window.BODACC_DATA = { period, cadenceMinutes, stats, cessions:[], liquidations:[] }`,
chaque enregistrement : `{ id, date, name, city, dept, sector: 0-7, tier: 0-4, price, priceKnown, variant, activity, url }`.
Les 70 cessions les plus anciennes servent de « ville existante » (stock initial), le reste est rejoué chronologiquement.
Les libellés (hook « toutes les X minutes », période, badge, écran de fin) se calculent depuis les données.

## Pistes V1 (hors scope POC)

- Cron quotidien (relancer `fetch-bodacc.mjs` + redéploiement, ou ingestion Supabase comme la lambda Liquide Flow)
- OG image dynamique « la ville du jour » + bouton partage LinkedIn
- Enrichissement SIREN → Intelo/Pappers (NAF propre, effectifs, ancienneté — le bâtiment « centenaire »)
- Migration PixiJS si besoin de plus de juice (perf mobile, particules, éclairage)
- Vrais assets pixel art (pack Kenney/itch.io) pour remplacer les sprites procéduraux
