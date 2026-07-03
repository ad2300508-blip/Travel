# Inchiostro — note a mano per Galaxy Tab S10 Ultra

App web di note-taking a mano libera (PWA) progettata per sfruttare al massimo il
Galaxy Tab S10 Ultra e la S Pen. Nessun server, nessun account: tutto resta sul
tablet, funziona anche offline.

![Anteprima](icons/icon.svg)

## Come sfrutta l'hardware del tablet

| Caratteristica del tablet | Come viene usata |
|---|---|
| S Pen — 4096 livelli di pressione | Spessore del tratto dinamico (stilografica, penna, matita) |
| S Pen — inclinazione | La matita "ombreggia" come una matita vera, la stilografica si allarga |
| S Pen — hover | Anteprima del pennello (dimensione e colore) prima di toccare lo schermo |
| S Pen — pulsante laterale | Gomma temporanea mentre lo tieni premuto (disattivabile) |
| Campionamento penna ad alta frequenza | `getCoalescedEvents()`: nessun campione perso, curve fedeli |
| Display 120 Hz | Layer d'inchiostro `desynchronized` + `getPredictedEvents()` per latenza percepita minima |
| Schermo 14,6″ | Barra strumenti completa sempre visibile, pan/zoom fluido fino a 8× |
| AMOLED | Tema scuro a nero puro (consuma meno e non affatica) — l'inchiostro nero diventa automaticamente chiaro |
| Palm rejection | Il palmo/le dita non scrivono mai: un dito trascina, due dita zoomano |
| Samsung DeX / tastiera | Scorciatoie: `Ctrl+Z/Y`, `1–6` strumenti, `[` `]` spessore, `PgSu/PgGiù` pagine, `M` quaderni, `Ctrl+0` zoom 100%, `F` adatta al contenuto, `Canc` elimina selezione |

## Funzioni

- **6 strumenti**: stilografica (pressione+inclinazione), penna a sfera, matita, evidenziatore, gomma a tratti, **lazo** (seleziona, sposta, **ridimensiona** con la maniglia d'angolo, duplica, ricolora, elimina)
- **Forme automatiche**: tieni ferma la penna a fine tratto e diventa una linea (con aggancio a 45°), un'ellisse, un rettangolo, un triangolo o un quadrilatero perfetti
- **Immagini nella pagina**: inserisci foto/screenshot dalla galleria, spostali e ridimensionali col lazo
- **Quaderni e pagine** illimitati, salvati in locale (IndexedDB) con salvataggio automatico; miniature delle pagine nella sidebar con riordino ed eliminazione
- **Tela infinita** per pagina, con carta bianca / a righe / a quadretti / a puntini; zoom "adatta al contenuto" e vista ricordata per ogni pagina
- **Undo/redo** completo (fino a 200 operazioni), 8 colori + selettore personalizzato
- **Esportazioni e condivisione**: pagina in PNG, quaderno in **PDF multi-pagina** (foglio di condivisione Android), backup/ripristino JSON di tutti i quaderni
- **Prestazioni**: inchiostrazione a bassissima latenza e pan/zoom che trasla la bitmap durante il gesto (fluido a 120 Hz anche con pagine piene)
- **PWA installabile**: si apre a schermo intero come un'app nativa e funziona offline (gli aggiornamenti arrivano da soli alla riapertura)

## Installazione sul tablet

L'app è composta solo da file statici e il repository include già il
workflow di deploy automatico su GitHub Pages.

1. Una volta sola: **Settings → Pages → Source: "GitHub Actions"** sul repo.
   Da lì in poi ogni push pubblica l'app (vedi `.github/workflows/pages.yml`).
2. Apri l'URL di Pages con **Samsung Internet o Chrome** sul tablet.
3. Menu del browser → **"Aggiungi a schermata Home" / "Installa app"**.
4. Avviala dall'icona: schermo intero, offline, con i tuoi quaderni.

Per provarla in locale: `python3 -m http.server` nella cartella del progetto,
poi apri `http://localhost:8000`.

> Nota: serve HTTPS (o localhost) per il service worker e l'installazione PWA.

## Suggerimenti d'uso

- **Scrivi appoggiando il palmo**: viene ignorato, solo la S Pen lascia inchiostro.
- **Un dito** trascina il foglio, **due dita** zoomano, **doppio tap** torna al 100%.
- **Pulsante S Pen premuto** = gomma al volo, senza cambiare strumento.
- **Inclina la S Pen** con la matita per ombreggiare, come su carta.
- Se preferisci disegnare col dito (senza S Pen): Impostazioni → "Disegna col dito".

## Struttura del codice

```
index.html            interfaccia
style.css             tema chiaro/scuro (AMOLED)
app.js                motore d'inchiostro, input S Pen, lazo, forme, gesti, UI
store.js              persistenza IndexedDB (quaderni, pagine, tratti vettoriali)
pdf.js                generatore PDF senza dipendenze
sw.js                 service worker (offline, stale-while-revalidate)
manifest.webmanifest  installazione PWA
icons/                icona app (SVG + PNG)
```

I tratti sono salvati in forma **vettoriale** (punti con pressione e
inclinazione), quindi lo zoom non sgrana e la gomma cancella per tratti.
