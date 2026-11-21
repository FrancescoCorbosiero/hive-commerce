<?php
/**
 * Hive Sync admin page.
 *
 * Simple view (default, for the shop owner): Panoramica · Importa
 * prodotti · Storico. Advanced view (switch in the header): the same
 * three plus the technical tabs — Connetti, Mappa, Componi, Regole,
 * Import manuale, Automatizza, Media, Esporta, Strumenti, Config.
 *
 * The page is a thin shell. All state, fetches, and rendering live in
 * assets/js/admin.js — this PHP just paints the structural HTML so
 * the JS bootstrap has stable hooks. Elements marked data-advanced are
 * hidden by CSS unless #hsync-app carries .is-advanced.
 */

defined( 'ABSPATH' ) || exit;

add_action( 'admin_menu', function () {
    add_menu_page(
        'Hive Sync',
        'Hive Sync',
        'manage_woocommerce',
        'hive-sync',
        'hsync_render_admin_page',
        'dashicons-update',
        56,
    );
} );

function hsync_render_admin_page(): void {
    if ( ! current_user_can( 'manage_woocommerce' ) ) wp_die( 'Unauthorized' );
    ?>
    <?php
    // Two views over the same engine. The SIMPLE one (default) is for the
    // shop owner: three tabs — Panoramica, Importa prodotti, Storico —
    // that work in automations and plain words. Everything technical
    // (sources, mappings, pipelines, rules, cron, JSON, cleanup tools)
    // carries data-advanced and only shows once "Modalità avanzata" is
    // switched on; the JS remembers the choice per browser. Markup ships
    // in simple mode so nothing technical flashes before the JS runs.
    ?>
    <div class="wrap hsync-wrap" id="hsync-app">
        <header class="hsync-cockpit">
            <div class="hsync-cockpit-brand">
                <span class="hsync-cockpit-logo dashicons dashicons-update" aria-hidden="true"></span>
                <div>
                    <h1 class="hsync-title">Hive Sync</h1>
                    <span class="hsync-version">v<?php echo esc_html( HSYNC_VERSION ); ?> · sincronizzazione catalogo</span>
                </div>
                <label class="hsync-mode-switch" title="Mostra tutti gli strumenti tecnici: collegamenti ai feed, mappature, flussi, regole, orari cron, pulizia. Per l'uso quotidiano non servono.">
                    <input type="checkbox" data-action="toggle-advanced">
                    <span class="hsync-switch-track" aria-hidden="true"></span>
                    <span class="hsync-mode-switch-label">Modalità avanzata</span>
                </label>
            </div>
            <div class="hsync-cockpit-tiles" data-region="cockpit-tiles" data-advanced>
                <div class="hsync-cockpit-tile is-loading">
                    <div class="hsync-cockpit-tile-label">Automazioni</div>
                    <div class="hsync-cockpit-tile-num" data-cockpit="jobs">—</div>
                    <div class="hsync-cockpit-tile-sub" data-cockpit="jobs-sub">caricamento…</div>
                </div>
                <div class="hsync-cockpit-tile is-loading">
                    <div class="hsync-cockpit-tile-label">Ultimo import</div>
                    <div class="hsync-cockpit-tile-num" data-cockpit="lastrun">—</div>
                    <div class="hsync-cockpit-tile-sub" data-cockpit="lastrun-sub">caricamento…</div>
                </div>
                <div class="hsync-cockpit-tile is-loading">
                    <div class="hsync-cockpit-tile-label">Catalogo Woo</div>
                    <div class="hsync-cockpit-tile-num" data-cockpit="products">—</div>
                    <div class="hsync-cockpit-tile-sub" data-cockpit="products-sub">prodotti pubblicati</div>
                </div>
                <div class="hsync-cockpit-tile hsync-cockpit-tile-action">
                    <button class="button button-primary button-hero" data-action="cockpit-tick">
                        <span class="dashicons dashicons-controls-play" aria-hidden="true"></span>
                        Esegui ciclo automatizzazioni
                    </button>
                    <small class="hsync-muted">Forza un giro adesso, senza aspettare il cron.</small>
                </div>
            </div>
            <div class="hsync-cockpit-status" data-region="cockpit-system-status"></div>
        </header>

        <nav class="hsync-tabs" role="tablist">
            <button class="hsync-tab is-active" data-tab="home"   role="tab" aria-selected="true"  title="Stato delle sincronizzazioni con i fornitori"><span class="hsync-tab-icon dashicons dashicons-dashboard" aria-hidden="true"></span> Panoramica</button>
            <button class="hsync-tab"           data-tab="import" role="tab" aria-selected="false" title="Aggiungi al negozio i prodotti di un fornitore, anche solo di alcune categorie"><span class="hsync-tab-icon dashicons dashicons-download" aria-hidden="true"></span> Importa prodotti</button>
            <button class="hsync-tab"           data-tab="runs"   role="tab" aria-selected="false" title="Cosa è stato importato e aggiornato, e quando"><span class="hsync-tab-icon dashicons dashicons-list-view" aria-hidden="true"></span> Storico</button>
            <span class="hsync-tab-sep" aria-hidden="true" data-advanced></span>
            <button class="hsync-tab" data-tab="sources"   role="tab" aria-selected="false" data-advanced title="I tuoi feed e API"><span class="hsync-tab-step">1</span><span class="hsync-tab-icon dashicons dashicons-admin-plugins" aria-hidden="true"></span> Connetti</button>
            <button class="hsync-tab" data-tab="mappings"  role="tab" aria-selected="false" data-advanced title="Allinea i campi del feed con WooCommerce"><span class="hsync-tab-step">2</span><span class="hsync-tab-icon dashicons dashicons-randomize" aria-hidden="true"></span> Mappa</button>
            <button class="hsync-tab" data-tab="pipelines" role="tab" aria-selected="false" data-advanced title="Cosa fare durante l'import"><span class="hsync-tab-step">3</span><span class="hsync-tab-icon dashicons dashicons-admin-settings" aria-hidden="true"></span> Componi</button>
            <button class="hsync-tab" data-tab="rules"     role="tab" aria-selected="false" data-advanced title="Azioni sui prodotti esistenti"><span class="hsync-tab-step">4</span><span class="hsync-tab-icon dashicons dashicons-filter" aria-hidden="true"></span> Regole</button>
            <button class="hsync-tab" data-tab="run"       role="tab" aria-selected="false" data-advanced title="Import con tutte le opzioni: sorgente, mappatura, flusso, prova, limiti"><span class="hsync-tab-step">5</span><span class="hsync-tab-icon dashicons dashicons-controls-play" aria-hidden="true"></span> Import manuale</button>
            <button class="hsync-tab" data-tab="jobs"      role="tab" aria-selected="false" data-advanced title="Imposta automazioni"><span class="hsync-tab-step">6</span><span class="hsync-tab-icon dashicons dashicons-clock" aria-hidden="true"></span> Automatizza</button>
            <span class="hsync-tab-sep" aria-hidden="true" data-advanced></span>
            <button class="hsync-tab" data-tab="media"   role="tab" aria-selected="false" data-advanced title="Pulizia foto e libreria"><span class="hsync-tab-icon dashicons dashicons-format-image" aria-hidden="true"></span> Media</button>
            <button class="hsync-tab" data-tab="exports" role="tab" aria-selected="false" data-advanced title="Scarica il catalogo"><span class="hsync-tab-icon dashicons dashicons-media-spreadsheet" aria-hidden="true"></span> Esporta</button>
            <button class="hsync-tab" data-tab="tools"   role="tab" aria-selected="false" data-advanced title="Pulizia avanzata"><span class="hsync-tab-icon dashicons dashicons-warning" aria-hidden="true"></span> Strumenti</button>
            <button class="hsync-tab" data-tab="config"  role="tab" aria-selected="false" data-advanced title="Configurazione come codice — esporta / incolla / applica"><span class="hsync-tab-icon dashicons dashicons-media-code" aria-hidden="true"></span> Config</button>
        </nav>

        <section class="hsync-panel is-active" data-panel="home">
            <div data-region="home-status"></div>
            <div class="hsync-feeds" data-region="home-cards">
                <p class="hsync-loading">Caricamento…</p>
            </div>
        </section>

        <section class="hsync-panel" data-panel="import">
            <div data-region="qi"><p class="hsync-loading">Caricamento…</p></div>
        </section>

        <section class="hsync-panel" data-panel="sources" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Connetti i tuoi feed.</strong>
                Aggiungi qui le credenziali dei tuoi fornitori (URL, token, API key) e dai
                un nome a ogni configurazione — es. <em>"GS produzione"</em> o
                <em>"GS staging"</em>. Le ritrovi pronte all'uso negli altri tab.
                Premi <strong>Test fetch</strong> per verificare che funzionino
                <em>prima</em> di salvarle.
            </div>
            <div class="hsync-toolbar">
                <button class="button" data-action="json-paste" data-section="sources" title="Incolla una source-config in formato JSON (sezione sources di project.json)">📋 Importa JSON</button>
            </div>
            <div class="hsync-sources-list" data-region="sources-list">
                <p class="hsync-loading">Caricamento…</p>
            </div>
        </section>

        <section class="hsync-panel" data-panel="mappings" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Allinea i campi.</strong>
                Per ogni campo di WooCommerce (a sinistra), scegli quale dato della tua
                sorgente metterci dentro (a destra). Funziona per CSV, API, qualsiasi
                feed strutturato.
                <br>
                Non sai da dove iniziare? Premi <strong>Installa default</strong> —
                ti prepariamo una mappatura standard pronta da rifinire.
            </div>
            <div class="hsync-toolbar">
                <select data-control="mappings-filter">
                    <option value="">Tutte le sorgenti</option>
                </select>
                <button class="button button-primary" data-action="mapping-new">+ Nuova mappatura</button>
                <button class="button" data-action="json-paste" data-section="mappings" title="Incolla un mapping in formato JSON (sezione mappings di project.json)">📋 Importa JSON</button>
                <button class="button" data-action="install-defaults">Installa default</button>
                <button class="button" data-action="install-defaults-force" title="Sovrascrive le mappature/flussi default per tirare dentro le ultime modifiche del codice (es. la categorizzazione automatica). I tuoi dati rimangono.">Aggiorna default</button>
            </div>
            <div class="hsync-mappings-list" data-region="mappings-list">
                <p class="hsync-loading">Caricamento…</p>
            </div>
            <div class="hsync-mapping-editor is-hidden" data-region="mapping-editor">
                <h2>Mappatura</h2>
                <div class="hsync-mapping-grid">
                    <label>Nome <input type="text" data-field="map-name" placeholder="GS → Woo standard"></label>
                    <label>Sorgente
                        <select data-field="map-source"></select>
                    </label>
                </div>

                <div class="hsync-mapping-help">
                    <strong>Come funziona.</strong>
                    A sinistra ci sono i campi standard di WooCommerce — sono fissi.
                    A destra scegli quale campo del <strong>feed esterno</strong>
                    ci finisce (es. <code>presented_price</code>, <code>brand_name</code>),
                    oppure un <em>template</em> per costruire contenuti dinamici
                    (es. <code>{brand_name} originali — {name}</code>).
                    I campi con <span class="hsync-required-marker">*</span> sono obbligatori.
                    <br>
                    <strong>Varianti?</strong> Resta tutto piatto: per le taglie/colori basta
                    puntare a un campo che restituisce una lista
                    (es. <code>pa_taglia</code> ← <code>sizes.size_eu</code>) — il sistema
                    crea le varianti automaticamente al momento dell'import.
                </div>

                <div class="hsync-mapping-toolbar">
                    <button class="button" data-action="mapping-probe">Anteprima sorgente</button>
                    <label class="hsync-toggle">
                        <input type="checkbox" data-action="mapping-toggle-json"> Modalità JSON
                    </label>
                </div>

                <div data-region="mapping-rows"></div>
                <div data-region="mapping-probe-output" class="hsync-mapping-probe is-hidden"></div>

                <div class="hsync-mapping-json is-hidden" data-region="mapping-json-view">
                    <p class="hsync-muted">Per chi sa cosa sta facendo: incolla o esporta la mappatura come JSON.</p>
                    <textarea data-field="map-config" rows="10" placeholder='{"sku":"SKU","name":"Title","regular_price":"Price"}'></textarea>
                    <div class="hsync-actions">
                        <button class="button" data-action="mapping-json-apply">Applica JSON al builder</button>
                    </div>
                </div>

                <div class="hsync-actions">
                    <button class="button button-primary" data-action="mapping-save">Salva mappatura</button>
                    <button class="button" data-action="mapping-cancel">Annulla</button>
                </div>
            </div>
        </section>

        <section class="hsync-panel" data-panel="pipelines" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Componi il tuo flusso d'import.</strong>
                Decidi <em>cosa controllare prima</em> di importare un prodotto,
                <em>cosa modificare durante</em>, e <em>cosa verificare dopo</em>.
                Es: scarica le foto, salta i prodotti senza prezzo, controlla che
                la categoria esista.
                <br>
                Senza pipeline l'import è semplice: scarica e salva. Con una pipeline
                aggiungi qualità ai dati.
            </div>
            <div class="hsync-toolbar">
                <button class="button button-primary" data-action="pipeline-new">+ Nuovo flusso</button>
                <button class="button" data-action="json-paste" data-section="pipelines" title="Incolla una pipeline in formato JSON">📋 Importa JSON</button>
            </div>
            <div data-region="pipelines-list"><p class="hsync-loading">Caricamento…</p></div>
            <div class="hsync-pipeline-editor is-hidden" data-region="pipeline-editor"></div>
        </section>

        <section class="hsync-panel" data-panel="rules" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Azioni a colpo singolo sui prodotti esistenti.</strong>
                Es: <em>"applica un margine del 20% su tutto il brand X"</em>,
                <em>"metti in bozza i prodotti senza foto"</em>,
                <em>"aggiorna lo stock dei sneaker"</em>.
                Le regole girano sui prodotti già nel catalogo, quando vuoi tu
                — manualmente o programmate.
            </div>
            <div class="hsync-toolbar">
                <button class="button button-primary" data-action="rule-new">+ Nuova regola</button>
                <button class="button" data-action="json-paste" data-section="rules" title="Incolla una regola in formato JSON">📋 Importa JSON</button>
            </div>
            <div data-region="rules-list"><p class="hsync-loading">Caricamento…</p></div>
            <div class="hsync-rule-editor is-hidden" data-region="rule-editor"></div>
        </section>

        <section class="hsync-panel" data-panel="jobs" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Metti tutto in automatico.</strong>
                Programma quando un import o una regola devono partire — ogni notte,
                ogni ora, due volte al giorno. Tu non devi più pensarci.
                <br>
                Usa <em>Esegui ora</em> se vuoi forzare un giro adesso, e
                <em>Stato del motore</em> se sospetti che qualcosa sia bloccato.
            </div>
            <div class="hsync-firstrun-callout" role="note">
                <span class="hsync-firstrun-icon dashicons dashicons-controls-play" aria-hidden="true"></span>
                <div class="hsync-firstrun-body">
                    <strong>Primo caricamento del catalogo? Puoi farlo anche dal tab <button type="button" class="hsync-firstrun-link" data-action="goto-run">Import manuale</button> (o da «Importa prodotti», anche per categoria).</strong>
                    Le automazioni qui sotto servono per il <em>mantenimento</em> (i prezzi e lo stock che
                    cambiano) e reggono anche un primo import grosso: il motore lavora a blocchi da 25 secondi
                    e li concatena senza pause, fino a ~4 minuti per giro, un giro al minuto — puoi chiudere
                    il browser. Il tab Import manuale fa lo stesso lavoro mostrandoti prodotto per prodotto cosa
                    succede. Se un run dura più dell'intervallo del cron, gli orari che passano mentre lavora
                    vengono <em>saltati</em> (e segnalati sulla card), non accodati.
                </div>
            </div>
            <div class="hsync-toolbar">
                <button class="button button-primary" data-action="job-new">+ Nuova automazione</button>
                <button class="button" data-action="json-paste" data-section="jobs" title="Incolla un job in formato JSON">📋 Importa JSON</button>
                <button class="button" data-action="jobs-tick-now">Esegui ora</button>
                <button class="button" data-action="as-health">Stato del motore</button>
            </div>
            <div data-region="as-health-output"></div>
            <div data-region="jobs-list"><p class="hsync-loading">Caricamento…</p></div>
            <div class="hsync-job-editor is-hidden" data-region="job-editor"></div>
        </section>

        <section class="hsync-panel" data-panel="media" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Tieni in ordine la libreria immagini.</strong>
                Cerca per nome, filtra le foto orfane (quelle che non sono in nessun
                prodotto) e cancellale in sicurezza con <em>Pulizia sicura</em>.
                <br>
                Vuoi proteggere un'immagine? Aggiungila alla
                <strong>whitelist</strong> e non verrà mai toccata.
            </div>
            <div class="hsync-media-toolbar">
                <input type="search" data-field="media-filename" placeholder="Cerca per nome file…">
                <select data-field="media-usage">
                    <option value="all">Tutte le immagini</option>
                    <option value="mapped">Solo in uso</option>
                    <option value="unmapped">Solo orfane</option>
                </select>
                <select data-field="media-whitelist">
                    <option value="all">Whitelist: indifferente</option>
                    <option value="yes">Solo protette</option>
                    <option value="no">Solo non protette</option>
                </select>
                <button class="button" data-action="media-search">Cerca</button>
                <button class="button" data-action="media-rebuild-index">Aggiorna indice</button>
                <button class="button" data-action="media-log-clear">Svuota log eliminazioni</button>
                <button class="button button-primary" data-action="media-cleanup-preview">Pulizia sicura…</button>
            </div>
            <div data-region="media-cleanup-output"></div>

            <div class="hsync-source-card" data-region="media-missing-card">
                <h3>🖼 Prodotti senza immagine</h3>
                <p class="hsync-muted">
                    Trova i prodotti che nel catalogo appaiono senza foto — immagine
                    mai scaricata, URL del feed rotto, o allegato cancellato dalla
                    libreria — e ri-scaricale dal feed.
                    <br>
                    <strong>L'analisi non tocca nulla</strong>: legge soltanto. La
                    riparazione parte solo quando la lanci tu, e usa la stessa
                    configurazione del tuo import (sorgente, mappatura, flusso), così
                    non può scrivere in modo diverso dalla sincronizzazione normale.
                </p>
                <div class="hsync-actions">
                    <button class="button button-primary" data-action="media-missing-scan">Analizza catalogo</button>
                </div>
                <div data-region="media-missing-output"></div>
            </div>

            <div data-region="media-list"><p class="hsync-loading">Caricamento…</p></div>
            <div class="hsync-media-pager" data-region="media-pager"></div>
        </section>

        <section class="hsync-panel" data-panel="exports" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Scarica il tuo catalogo.</strong>
                Una copia istantanea dei tuoi prodotti — CSV per Excel,
                JSON per analisi e backup.
            </div>
            <div data-region="exports-output"></div>
            <div class="hsync-export-cards">
                <div class="hsync-source-card">
                    <h3>Inventario completo</h3>
                    <p class="hsync-muted">Tutti i prodotti pubblicati con prezzi, stock, brand e categorie.</p>
                    <div class="hsync-actions">
                        <button class="button" data-action="export-inventory" data-format="csv">CSV</button>
                        <button class="button" data-action="export-inventory" data-format="json">JSON</button>
                    </div>
                </div>
                <div class="hsync-source-card">
                    <h3>Catalogo per categoria</h3>
                    <p class="hsync-muted">Vista gerarchica: categoria → brand → prodotti. Solo i dati essenziali.</p>
                    <div class="hsync-actions">
                        <button class="button" data-action="export-catalog">JSON</button>
                    </div>
                </div>
            </div>
        </section>

        <section class="hsync-panel" data-panel="run" data-advanced>
            <div class="hsync-tab-intro">
                <strong>Lancia un import quando vuoi.</strong>
                Scegli la sorgente, una mappatura, un flusso (se ne hai), e parti.
                <br>
                <strong>Prova in sicurezza:</strong> tieni acceso <em>Solo prova</em>
                per vedere cosa succederebbe senza toccare il catalogo. Soddisfatto?
                Toglilo e lancia per davvero.
            </div>
            <div class="hsync-run-form">
                <label>Sorgente
                    <select data-field="run-source"></select>
                </label>
                <label>Configurazione salvata
                    <select data-field="run-config-slug">
                        <option value="">— compila al volo qui sotto —</option>
                    </select>
                    <small class="hsync-muted">Le configurazioni si gestiscono nel tab <strong>Connetti</strong>.</small>
                </label>
                <label>Mappatura (opzionale)
                    <select data-field="run-mapping"><option value="">— nessuna —</option></select>
                </label>
                <label>Flusso d'import (opzionale)
                    <select data-field="run-pipeline"><option value="">— solo scarica e salva —</option></select>
                </label>
                <label>SKU specifici (opzionale)
                    <textarea data-field="run-skus" rows="3" placeholder="Lascia vuoto per tutto il feed. Altrimenti incolla gli SKU — uno per riga, oppure separati da virgola o spazio."></textarea>
                    <small class="hsync-muted">
                        Limita l'esecuzione a questi SKU. Vengono <strong>sempre</strong>
                        re-importati con la pipeline completa, anche se il confronto col
                        feed li considera invariati — è questo che rende l'operazione un
                        vero "ri-importa". Gli SKU non trovati nel feed vengono elencati
                        nel report. Il resto del catalogo non viene toccato.
                    </small>
                </label>
                <div data-region="run-config-fields"></div>
                <div class="hsync-actions">
                    <button class="button" data-action="run-test-fetch">Test connessione</button>
                    <button class="button" data-action="run-save-config">Salva configurazione…</button>
                    <button class="button" data-action="run-save-job">Programma…</button>
                    <label class="hsync-dryrun">
                        <input type="checkbox" data-field="run-dry-run" checked> Solo prova
                    </label>
                    <div class="hsync-mode" role="radiogroup" aria-label="Modalità di esecuzione" data-field="run-mode-group" title="Cosa fa questa esecuzione. La mappatura SKU+URL è la stessa nelle tre modalità: l'ordine non conta, nessun duplicato, nessun disallineamento.">
                        <input type="radio" id="hsync-mode-full" name="hsync-run-mode" value="full" checked>
                        <label for="hsync-mode-full" title="Pipeline standard: crea i prodotti e scarica le immagini in una passata. Più lento ma autocontenuto.">
                            <span class="hsync-mode__dot" aria-hidden="true"></span>
                            <span class="hsync-mode__label">Completa</span>
                        </label>
                        <input type="radio" id="hsync-mode-data" name="hsync-run-mode" value="data_only">
                        <label for="hsync-mode-data" title="Crea i prodotti con nome/prezzo/tassonomie/varianti, salta media.download + bridge sideload. Una passata successiva in Completa riempie le immagini.">
                            <span class="hsync-mode__dot" aria-hidden="true"></span>
                            <span class="hsync-mode__label">Solo dati</span>
                        </label>
                        <input type="radio" id="hsync-mode-media" name="hsync-run-mode" value="media_only">
                        <label for="hsync-mode-media" title="Pre-scarica le immagini come allegati orfani indicizzati dal map URL→ID. Nessun prodotto viene creato. Un import in Completa o Solo dati successivo aggancia tutto via lookup senza ri-scaricare.">
                            <span class="hsync-mode__dot" aria-hidden="true"></span>
                            <span class="hsync-mode__label">Solo media</span>
                        </label>
                    </div>
                    <label class="hsync-limit" title="Limita il numero di prodotti processati in questo run (0 = nessun limite). Utile per testare su un feed grande senza importare tutto.">
                        Max prodotti
                        <input type="number" data-field="run-limit" min="0" step="1" value="0" style="width:6em;">
                    </label>
                    <label class="hsync-limit" title="Tetto al numero di tick consecutivi che il browser eseguirà in un singolo run. 0 = nessun limite (l'operatore controlla l'esecuzione). Default 200 — quando viene raggiunto compare il bottone Riprendi per estendere il loop.">
                        Max tick
                        <input type="number" data-field="run-max-ticks" min="0" step="1" value="200" style="width:5em;">
                    </label>
                    <label class="hsync-dryrun" title="Rimette in coda i prodotti che in Woo non hanno immagine di copertina, ma per cui il feed ha un URL valido: solo quelli, con il normale percorso di update (varianti e ID intatti). Serve perché il confronto col feed guarda prezzi/stock/testi e NON le immagini, quindi un prodotto rimasto senza foto risulta 'invariato' per sempre e nessuna sync lo ripara. Sicuro da lasciare attivo anche sui cron job: si esaurisce da solo quando non c'è più niente da riparare.">
                        <input type="checkbox" data-field="run-heal-media"> Ripara immagini mancanti
                    </label>
                    <label class="hsync-dryrun" title="Spegne sul sito i prodotti che il feed ha smesso di elencare (SKU sparito dal catalogo del fornitore). Senza questa opzione restano pubblicati e acquistabili per sempre: il confronto col feed guarda solo gli SKU che il feed RESTITUISCE, quindi uno SKU tolto dal listino non finisce in nessun bucket e nessuna sync lo tocca più. Reversibile: se lo SKU torna nel feed il prodotto viene ripristinato allo stato precedente nello stesso run. Sicuro da lasciare attivo sui cron job — ha un freno che annulla la spazzata se il feed è vuoto o se sparisce più del 35% del catalogo in un colpo solo.">
                        <input type="checkbox" data-field="run-retire-missing" checked> Oscura prodotti spariti dal feed
                    </label>
                    <label class="hsync-limit" title="Percentuale massima del catalogo di questa sorgente che può essere oscurata in un singolo run. Oltre la soglia la spazzata si annulla e ti dice quanti prodotti avrebbe toccato, elencandone un campione: serve a non farti spegnere mezzo negozio per un feed troncato o un token scaduto. Alza al 100% solo dopo aver verificato che la sparizione è reale — tipicamente al primo run, quando esce fuori tutto l'arretrato accumulato da prima che la spazzata esistesse. Sotto i 20 prodotti posseduti il freno non si applica.">
                        Soglia di sicurezza
                        <input type="number" data-field="run-retire-max-ratio" min="1" max="100" step="1" value="35" style="width:5em;">%
                    </label>
                    <label class="hsync-limit" title="Cosa fare al prodotto che il feed non elenca più. 'Esaurito' lo lascia navigabile ma non acquistabile; 'Nascondi' lo toglie anche da shop e ricerca (il link diretto continua a funzionare); 'Bozza' lo toglie del tutto dal sito. Tutte e tre sono reversibili.">
                        Modo
                        <select data-field="run-retire-mode" style="max-width:15em;">
                            <option value="hidden">Nascondi dal catalogo + esaurito</option>
                            <option value="outofstock">Solo esaurito</option>
                            <option value="draft">Metti in bozza + esaurito</option>
                        </select>
                    </label>
                    <label class="hsync-dryrun" title="Per OGNI prodotto già esistente in Woo: cancella varianti + termini pa_* + meta _product_attributes, poi riscrive tutto da feed come fosse un primo import. L'ID del prodotto (e quindi gli ordini storici) viene preservato; le varianti vengono ricreate da zero — gli ID delle varianti cambiano. Da usare quando una sync normale non converge sui dati corretti (es. attributo Taglia corrotto). UN colpo solo, non lasciare attivo sui cron job.">
                        <input type="checkbox" data-field="run-force-recreate"> Forza ricreazione
                    </label>
                    <button class="button button-primary" data-action="run-now">Importa adesso</button>
                </div>
            </div>
            <div class="hsync-run-output" data-region="run-output"></div>
        </section>

        <section class="hsync-panel" data-panel="runs">
            <p class="hsync-lead">
                Ogni sincronizzazione e importazione, con il suo risultato. Le più
                vecchie di 30 giorni si cancellano da sole.
            </p>
            <div class="hsync-toolbar">
                <button class="button" data-action="runs-refresh">Aggiorna</button>
                <button class="button" data-action="runs-purge-older" data-days="7" data-advanced>Cancella più vecchi di 7 giorni</button>
                <button class="button" data-action="runs-purge-older" data-days="30" data-advanced>Cancella più vecchi di 30 giorni</button>
                <button class="button is-danger" data-action="runs-purge-all" data-advanced>Cancella tutto lo storico</button>
            </div>
            <div data-region="runs-list">
                <p class="hsync-loading">Caricamento…</p>
            </div>
        </section>


        <section class="hsync-panel" data-panel="tools" data-advanced>
            <div class="hsync-tab-intro">
                <strong>⚠ Strumenti di pulizia.</strong>
                Operazioni distruttive — quello che cancellano <em>non torna indietro</em>.
                Riservato all'admin del sito. Ogni azione mostra prima un conteggio,
                poi chiede conferma esplicita. Le immagini in
                <strong>whitelist</strong> sono sempre intoccabili.
            </div>

            <h2>Pulizia selettiva</h2>
            <p class="hsync-muted">Spunta cosa eliminare, premi <em>Anteprima</em> per vedere quanti elementi sono coinvolti, poi <em>Esegui</em>.</p>

            <div class="hsync-tools-targets">
                <label><input type="checkbox" data-tools-target="products"> <strong>Prodotti</strong> e varianti — cancella tutto il catalogo</label>
                <label><input type="checkbox" data-tools-target="media"> <strong>Immagini</strong> dalla libreria — esclude la whitelist</label>
                <label><input type="checkbox" data-tools-target="taxonomy"> <strong>Tassonomie</strong> — categorie, brand, tag</label>
                <label><input type="checkbox" data-tools-target="transients"> <strong>Cache</strong> — solo dati temporanei, sempre sicuro</label>
                <label><input type="checkbox" data-tools-target="orphan_meta"> <strong>Residui</strong> — meta orfani e sessioni scadute</label>
            </div>

            <div class="hsync-actions">
                <button class="button" data-action="tools-preview">Anteprima</button>
                <button class="button button-primary is-danger" data-action="tools-execute" disabled>Esegui pulizia</button>
            </div>
            <div data-region="tools-output"></div>

            <hr>

            <h2>Pulizia per fornitore</h2>
            <p class="hsync-muted">
                Cancella solo i prodotti che hai importato da una specifica sorgente.
                Utile quando vuoi rifare l'import da zero senza toccare il resto del catalogo.
            </p>
            <div class="hsync-tools-bysource">
                <select data-field="tools-source">
                    <option value="">— scegli un fornitore —</option>
                    <option value="goldensneakers">Golden Sneakers</option>
                    <option value="stockfirmati">StockFirmati</option>
                    <option value="csv">CSV</option>
                    <option value="kicksdb">KicksDB</option>
                    <option value="manual">Inseriti a mano</option>
                </select>
                <button class="button" data-action="tools-source-count">Conta prodotti</button>
                <button class="button is-danger" data-action="tools-source-delete">Elimina tutti</button>
            </div>
            <div data-region="tools-source-output"></div>

            <section class="hsync-section">
                <h3>Ripara attributi varianti</h3>
                <p class="hsync-muted">
                    Sistema le varianti i cui attributi tassonomici (es. <code>attribute_pa_taglia</code>) sono
                    stati salvati col valore <strong>grezzo</strong> del feed (es. <code>33.5</code>) invece
                    dello <strong>slug</strong> del termine (<code>33-5</code>). Le varianti rotte esistono
                    nel DB ma sono invisibili nel dropdown del frontend. Tipicamente colpisce taglie con
                    decimali / lettere / spazi su import GS pre-fix. Mostra un'anteprima prima di applicare;
                    la riparazione è idempotente e non tocca prezzi / stock / status.
                </p>
                <div class="hsync-actions">
                    <button class="button" data-action="tools-repair-attrs-preview">Anteprima</button>
                    <button class="button button-primary" data-action="tools-repair-attrs-apply" disabled>Applica riparazione</button>
                </div>
                <div data-region="tools-repair-attrs-output"></div>
            </section>

            <section class="hsync-section">
                <h3>Diagnostica feed vs Woo</h3>
                <p class="hsync-muted">
                    Confronta cosa l'upstream sta servendo <strong>adesso</strong> con cosa esiste in Woo,
                    per-prodotto. Utile quando "sembra che mancano varianti" — risponde a 4 domande:
                    il feed risponde? il raggruppamento per SKU funziona? per i prodotti già in Woo,
                    le taglie combaciano? quali taglie mancano vs feed?
                    Pura lettura, nessuna scrittura, nessuna cache.
                </p>
                <div class="hsync-actions">
                    <input type="text" data-field="diag-config-slug" placeholder="config slug (es. gs-prod)" style="width:18em;">
                    <input type="number" data-field="diag-sample-size" value="50" min="1" max="500" style="width:6em;" title="Quanti prodotti del feed confrontare">
                    <button class="button button-primary" data-action="tools-feed-diagnostic">Esegui diagnostica</button>
                </div>
                <div data-region="tools-feed-diagnostic-output"></div>
            </section>
        </section>

        <section class="hsync-panel" data-panel="config" data-advanced>
            <div class="hsync-tab-intro">
                <strong>📋 Configurazione come codice.</strong>
                Tutta la configurazione del plugin (source, mapping, pipeline, regole, job)
                è esportabile come <strong>un solo JSON</strong> e ri-applicabile incollandolo
                qui. Pensato per &mdash; documentare un'installazione, replicarla altrove,
                farsi generare una mappa da un LLM, gestire la config in git.
                Le credenziali sono <strong>redatte</strong> nell'export
                (<code>••••XXXX</code>) e vengono preservate dalle righe esistenti
                quando applichi.
            </div>

            <h2>Esporta</h2>
            <p class="hsync-muted">Scarica lo stato corrente come <code>project.json</code>.</p>
            <div class="hsync-actions">
                <button class="button button-primary" data-action="config-export">📥 Esporta progetto</button>
                <button class="button" data-action="config-copy">📋 Copia negli appunti</button>
                <a class="button" href="<?php echo esc_url( plugins_url( 'docs/project.schema.json', dirname( __FILE__ ) ) ); ?>" target="_blank" rel="noopener">📐 Schema JSON (per LLM)</a>
            </div>
            <div data-region="config-export-output" class="is-hidden">
                <textarea data-field="config-export-json" rows="14" spellcheck="false" readonly></textarea>
            </div>

            <hr>

            <h2>Applica</h2>
            <p class="hsync-muted">
                Incolla un <code>project.json</code>. Premi <em>Valida</em> per vedere il diff
                prima di scrivere su DB. <em>Applica</em> esegue il diff (additivo).
                Spunta <em>Prune</em> per cancellare anche le entità che non sono nel JSON
                (modalità "fonte di verità").
            </p>
            <textarea data-field="config-apply-json" rows="18" spellcheck="false" placeholder='Incolla qui un project.json — esempio:&#10;{&#10;  "$schema": "hive-sync/project/v1",&#10;  "version": 1,&#10;  "sources":   [],&#10;  "mappings":  [],&#10;  "pipelines": [],&#10;  "rules":     [],&#10;  "jobs":      []&#10;}'></textarea>
            <div class="hsync-actions">
                <button class="button" data-action="config-validate">✓ Valida + diff</button>
                <label style="margin-left:auto;display:inline-flex;align-items:center;gap:6px">
                    <input type="checkbox" data-field="config-prune">
                    <span>Prune (elimina entità non presenti nel JSON)</span>
                </label>
                <button class="button button-primary" data-action="config-apply" disabled>⚡ Applica</button>
            </div>
            <div data-region="config-apply-output"></div>
        </section>
    </div>

    <!--
        Per-tab JSON paste modal — opened by any "📋 Importa JSON" button.
        Reuses the project_validate / project_apply backend by wrapping
        the user's pasted entity (or array) into a minimal project doc
        whose only populated section is the one matching the button.
        Hidden until HSync.openJsonPaste() flips it visible.
    -->
    <div class="hsync-modal is-hidden" data-region="json-paste-modal" role="dialog" aria-modal="true" aria-labelledby="hsync-json-paste-title">
        <div class="hsync-modal-backdrop" data-action="json-paste-cancel"></div>
        <div class="hsync-modal-panel">
            <h2 id="hsync-json-paste-title">📋 Importa <span data-field="json-paste-section-label">JSON</span></h2>
            <p class="hsync-muted" data-field="json-paste-section-help">
                Incolla un singolo oggetto, un array di oggetti, oppure un <code>project.json</code>
                completo. Vengono applicati solo gli oggetti della sezione selezionata.
            </p>
            <textarea data-field="json-paste-input" rows="16" spellcheck="false" placeholder='Esempio singola entità:&#10;{ "slug": "...", "name": "..." }&#10;&#10;Esempio array:&#10;[ { ... }, { ... } ]&#10;&#10;Esempio progetto completo:&#10;{ "$schema": "hive-sync/project/v1", "version": 1, "mappings": [ ... ] }'></textarea>
            <div class="hsync-actions">
                <button class="button" data-action="json-paste-cancel">Annulla</button>
                <button class="button" data-action="json-paste-validate">✓ Valida + diff</button>
                <button class="button button-primary" data-action="json-paste-apply" disabled>⚡ Applica</button>
            </div>
            <div data-region="json-paste-output"></div>
        </div>
    </div>
    <?php
}
