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
| Samsung DeX / tastiera | Scorciatoie: `Ctrl+Z/Y`, `1–5` strumenti, `[` `]` spessore, `PgSu/PgGiù` pagine, `M` quaderni, `Ctrl+0` zoom 100% |

## Funzioni

- **6 strumenti**: stilografica (pressione+inclinazione), penna a sfera, matita, evidenziatore, gomma a tratti, **lazo** (seleziona, sposta, duplica, elimina)
- **Forme automatiche**: tieni ferma la penna a fine tratto e diventa una linea (con aggancio a 45°), un'ellisse o un rettangolo perfetti
- **Quaderni e pagine** illimitati, salvati in locale (IndexedDB) con salvataggio automatico; miniature delle pagine nella sidebar
- **Tela infinita** per pagina, con carta bianca / a righe / a quadretti / a puntini
- **Undo/redo** completo (fino a 200 operazioni), 8 colori + selettore personalizzato
- **Esportazioni**: pagina in PNG, quaderno in **PDF multi-pagina**, backup/ripristino JSON di tutti i quaderni
- **PWA installabile**: si apre a schermo intero come un'app nativa e funziona offline (gli aggiornamenti arrivano da soli alla riapertura)

## Installazione sul tablet

L'app è composta solo da file statici: serve un qualunque hosting HTTPS
(GitHub Pages è perfetto).

1. Pubblica il repository con GitHub Pages (Settings → Pages → branch).
2. Apri l'URL con **Samsung Internet o Chrome** sul tablet.
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
app.js                motore d'inchiostro, input S Pen, gesti, UI
store.js              persistenza IndexedDB (quaderni, pagine, tratti vettoriali)
sw.js                 service worker (offline, cache-first)
manifest.webmanifest  installazione PWA
icons/                icona app (SVG + PNG)
```

I tratti sono salvati in forma **vettoriale** (punti con pressione e
inclinazione), quindi lo zoom non sgrana e la gomma cancella per tratti.
