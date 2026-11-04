<?php
/**
 * Bulk Creator — crea prodotti WooCommerce in massa da JSON.
 * Usa il product factory condiviso (core/product-factory.php).
 */

defined( 'ABSPATH' ) || exit;

/**
 * Valida e normalizza il JSON di bulk import.
 *
 * @param mixed $data JSON decodificato.
 * @return array|WP_Error
 */
function rp_cm_validate_bulk_json( mixed $data ): array|WP_Error {

    if ( is_array( $data ) && isset( $data[0] ) ) {
        $data = [ 'products' => $data ];
    }

    if ( empty( $data['products'] ) || ! is_array( $data['products'] ) ) {
        return new WP_Error( 'no_products', 'Array "products" mancante o vuoto.' );
    }

    foreach ( $data['products'] as $i => $p ) {
        if ( empty( $p['name'] ) ) {
            return new WP_Error( 'missing_name', "Prodotto indice {$i}: campo 'name' obbligatorio." );
        }
        $type = $p['type'] ?? 'simple';
        // is_numeric, non empty(): empty("0") è true e un prezzo 0 è
        // legittimo (omaggi, sample). Il batch intero veniva rifiutato.
        if ( $type === 'simple' && ( ! isset( $p['regular_price'] ) || ! is_numeric( $p['regular_price'] ) ) ) {
            return new WP_Error( 'missing_price', "Prodotto '{$p['name']}': 'regular_price' obbligatorio per simple." );
        }
        if ( $type === 'variable' && empty( $p['variations'] ) ) {
            return new WP_Error( 'missing_variations', "Prodotto '{$p['name']}': 'variations' obbligatorio per variable." );
        }
    }

    return $data;
}

/**
 * Preview del bulk import.
 *
 * @param array  $data Dati validati.
 * @param string $mode 'create' | 'create_or_update' | 'sync'
 * @return array
 */
function rp_cm_bulk_preview( array $data, string $mode = 'create' ): array {

    // 'sync' matcha per SKU come 'create_or_update', ma in piu calcola quante
    // varianti esistenti verrebbero nascoste (assenti dal JSON).
    $update = in_array( $mode, [ 'create_or_update', 'sync' ], true );
    $hide   = ( $mode === 'sync' );

    $details = [];

    foreach ( $data['products'] as $entry ) {
        $sku       = $entry['sku'] ?? null;
        $action    = 'create';
        $existing  = null;
        $hide_count = 0;

        if ( $update && $sku ) {
            $existing_id = wc_get_product_id_by_sku( $sku );
            if ( $existing_id ) {
                $action   = 'update';
                $existing = $existing_id;

                if ( $hide ) {
                    $hide_count = gh_cm_count_missing_variations( $existing_id, $entry['variations'] ?? [] );
                }
            }
        }

        $details[] = [
            'name'            => $entry['name'],
            'sku'             => $sku,
            'type'            => $entry['type'] ?? 'simple',
            'status'          => $entry['status'] ?? 'publish',
            'action'          => $action,
            'existing_id'     => $existing,
            'variation_count' => count( $entry['variations'] ?? [] ),
            'hide_count'      => $hide_count,
            // Piano immagini senza effetti: quante si riusano dalla media
            // library, quante si scaricano, quante sono invalide.
            'images'          => function_exists( 'gh_img_plan_summary' ) ? gh_img_plan_summary( $entry ) : null,
        ];
    }

    $img = static fn( string $k ) => array_sum( array_map( fn( $d ) => (int) ( $d['images'][ $k ] ?? 0 ), $details ) );

    return [
        'summary' => [
            'total'          => count( $details ),
            'to_create'      => count( array_filter( $details, fn( $d ) => $d['action'] === 'create' ) ),
            'to_update'      => count( array_filter( $details, fn( $d ) => $d['action'] === 'update' ) ),
            'to_hide'        => array_sum( array_map( fn( $d ) => (int) $d['hide_count'], $details ) ),
            'img_existing'   => $img( 'existing' ) + $img( 'local_file' ),
            'img_download'   => $img( 'download' ),
            'img_invalid'    => $img( 'invalid' ),
        ],
        'details' => $details,
    ];
}

/**
 * Applica il bulk import. Usa gh_create_* per la creazione.
 *
 * @param array  $data Dati validati.
 * @param string $mode 'create' | 'create_or_update' | 'sync'
 * @return array
 */
function rp_cm_bulk_apply( array $data, string $mode = 'create' ): array {

    // 'sync' = 'create_or_update' + nasconde le varianti esistenti assenti dal
    // JSON (0 stock + disabilitate) invece di lasciarle orfane e in vendita.
    $update       = in_array( $mode, [ 'create_or_update', 'sync' ], true );
    $hide_missing = ( $mode === 'sync' );

    $details = [];

    foreach ( $data['products'] as $entry ) {
        $sku = $entry['sku'] ?? null;

        // Check per aggiornamento
        $existing_id = null;
        if ( $update && $sku ) {
            $existing_id = wc_get_product_id_by_sku( $sku );
        }

        try {
            if ( $existing_id ) {
                $result = rp_cm_bulk_update_existing( $existing_id, $entry, $hide_missing );
            } else {
                $type       = $entry['type'] ?? 'simple';
                $product_id = $type === 'variable'
                    ? gh_create_variable_product( $entry )
                    : gh_create_simple_product( $entry );

                $result = [
                    'name'            => $entry['name'],
                    'sku'             => $sku,
                    'type'            => $type,
                    'status'          => 'created',
                    'id'              => $product_id,
                    'variation_count' => count( $entry['variations'] ?? [] ),
                    'images'          => gh_cm_bulk_apply_images(
                        $product_id,
                        $entry,
                        $type === 'variable' ? gh_cm_fresh_variation_ids( $product_id ) : []
                    ),
                ];
            }
            $details[] = $result;
        } catch ( \Exception $e ) {
            $details[] = [
                'name'   => $entry['name'],
                'sku'    => $sku,
                'type'   => $entry['type'] ?? '?',
                'status' => 'error',
                'reason' => $e->getMessage(),
                'id'     => null,
            ];
        }
    }

    $img = static fn( string $k ) => array_sum( array_map(
        fn( $d ) => $k === 'failed' ? count( $d['images']['failed'] ?? [] ) : (int) ( $d['images'][ $k ] ?? 0 ),
        $details
    ) );

    return [
        'summary' => [
            'total'          => count( $details ),
            'created'        => count( array_filter( $details, fn( $d ) => $d['status'] === 'created' ) ),
            'updated'        => count( array_filter( $details, fn( $d ) => $d['status'] === 'updated' ) ),
            'errors'         => count( array_filter( $details, fn( $d ) => $d['status'] === 'error' ) ),
            'hidden'         => array_sum( array_map( fn( $d ) => (int) ( $d['hidden'] ?? 0 ), $details ) ),
            'img_reused'     => $img( 'reused' ) + $img( 'registered' ),
            'img_downloaded' => $img( 'downloaded' ),
            'img_failed'     => $img( 'failed' ),
        ],
        'details' => $details,
    ];
}

/**
 * Aggiorna un prodotto esistente con i dati dal JSON.
 *
 * @param int   $product_id   ID del prodotto WC.
 * @param array $entry        Dati dal JSON.
 * @param bool  $hide_missing Se true (mode 'sync'), le varianti esistenti la cui
 *                            SKU non compare nel JSON vengono nascoste (0 stock +
 *                            disabilitate) invece di restare orfane e in vendita.
 * @return array
 */
function rp_cm_bulk_update_existing( int $product_id, array $entry, bool $hide_missing = false ): array {

    $product = wc_get_product( $product_id );
    if ( ! $product ) {
        return [ 'name' => $entry['name'], 'sku' => $entry['sku'] ?? null, 'type' => '?', 'status' => 'error', 'reason' => 'Non trovato', 'id' => null ];
    }

    gh_apply_product_fields( $product, $entry );

    if ( $product->is_type( 'variable' ) && ! empty( $entry['attributes'] ) ) {
        $product->set_attributes( gh_build_wc_attributes( $entry['attributes'] ) );
    }

    $product->save();
    gh_apply_product_meta( $product_id, $entry );

    // Varianti
    $var_count = 0;
    $hidden    = 0;
    $var_ids   = []; // indice nel JSON → variation ID (per le immagini variante)
    if ( $product->is_type( 'variable' ) && ! empty( $entry['variations'] ) ) {
        foreach ( array_values( $entry['variations'] ) as $i => $var_data ) {
            $var_id = null;
            if ( ! empty( $var_data['sku'] ) ) {
                $var_id = wc_get_product_id_by_sku( $var_data['sku'] );
            }
            if ( $var_id ) {
                $v = wc_get_product( $var_id );
                if ( $v && $v->is_type( 'variation' ) ) {
                    gh_apply_product_fields( $v, $var_data );
                    $v->save();
                    $var_ids[ $i ] = (int) $var_id;
                }
            } else {
                $var_ids[ $i ] = (int) gh_create_variation( $product_id, $var_data );
            }
            $var_count++;
        }

        // Sync mode: nascondi le taglie non piu presenti nel JSON. Va fatto
        // DOPO il loop di upsert (cosi una SKU che torna nel feed viene prima
        // ri-abilitata dall'upsert) e PRIMA della sync del parent.
        if ( $hide_missing ) {
            $hidden = gh_cm_hide_missing_variations( $product_id, $entry['variations'] );
        }

        WC_Product_Variable::sync( $product_id );

        // La sync del parent puo lasciare uno stock_status stantio quando le
        // uniche varianti in stock sono appena state nascoste: riallinea.
        if ( $hidden > 0 && function_exists( 'gh_fix_variable_stock_status' ) ) {
            gh_fix_variable_stock_status( $product_id );
        }
    }

    // Dopo varianti e sync: gh_img_apply_to_product ricarica il prodotto,
    // quindi non sovrascrive con un oggetto stantio quanto salvato sopra.
    $images = gh_cm_bulk_apply_images( $product_id, $entry, $var_ids );

    return [
        'name'            => $product->get_name(),
        'sku'             => $product->get_sku(),
        'type'            => $product->get_type(),
        'status'          => 'updated',
        'id'              => $product_id,
        'variation_count' => $var_count,
        'hidden'          => $hidden,
        'images'          => $images,
    ];
}

/**
 * Collega le immagini dell'entry al prodotto. Non lancia mai: un problema
 * con le immagini non deve far risultare in errore un prodotto già salvato,
 * finisce nel report (`failed`).
 *
 * @param int   $product_id
 * @param array $entry
 * @param array $variation_ids Indice variante nel JSON → variation ID.
 * @return array|null Report di gh_img_apply_to_product, null se il modulo manca.
 */
function gh_cm_bulk_apply_images( int $product_id, array $entry, array $variation_ids = [] ): ?array {
    if ( ! function_exists( 'gh_img_apply_to_product' ) ) {
        return null;
    }
    try {
        return gh_img_apply_to_product( $product_id, $entry, $variation_ids );
    } catch ( \Throwable $e ) {
        return [ 'touched' => true, 'failed' => [ [ 'src' => '', 'reason' => 'Errore immagini: ' . $e->getMessage() ] ] ];
    }
}

/**
 * ID delle varianti di un prodotto appena creato, in ordine di creazione.
 * gh_create_variable_product le crea nell'ordine del JSON, quindi l'indice
 * i-esimo corrisponde alla variante i-esima dell'entry. Query diretta (non
 * get_children) per includere anche varianti draft/private.
 *
 * @param int $product_id
 * @return int[]
 */
function gh_cm_fresh_variation_ids( int $product_id ): array {
    return array_map( 'intval', get_posts( [
        'post_type'      => 'product_variation',
        'post_parent'    => $product_id,
        'post_status'    => 'any',
        'posts_per_page' => -1,
        'orderby'        => 'ID',
        'order'          => 'ASC',
        'fields'         => 'ids',
        'no_found_rows'  => true,
    ] ) );
}

/**
 * Peso di un'entry per il batching dell'import (AJAX chunked e job in
 * background): 1 per il prodotto + 1 per variante + GH_IMG_IMPORT_WEIGHT per
 * immagine dichiarata (un download con miniature costa ~1-3s). Il JS
 * (bulkWeight in gh-core.js) usa la stessa formula.
 *
 * @param array $entry
 * @return int
 */
function gh_cm_bulk_entry_weight( array $entry ): int {
    $w = 1 + ( is_array( $entry['variations'] ?? null ) ? count( $entry['variations'] ) : 0 );
    if ( function_exists( 'gh_img_count_in_entry' ) ) {
        $w += gh_img_count_in_entry( $entry ) * GH_IMG_IMPORT_WEIGHT;
    }
    return $w;
}

/**
 * Conta le varianti esistenti di un prodotto la cui SKU NON compare tra le
 * varianti in arrivo dal JSON. Usato dal preview del mode 'sync'.
 *
 * @param int   $product_id           ID del prodotto padre.
 * @param array $incoming_variations  Array di varianti dal JSON (ognuna con 'sku').
 * @return int
 */
function gh_cm_count_missing_variations( int $product_id, array $incoming_variations ): int {

    $product = wc_get_product( $product_id );
    if ( ! $product || ! $product->is_type( 'variable' ) ) {
        return 0;
    }

    $incoming = gh_cm_incoming_sku_set( $incoming_variations );
    if ( empty( $incoming ) ) {
        return 0; // Nessuna SKU in arrivo → non sappiamo cosa tenere: non nascondiamo nulla.
    }

    $count = 0;
    foreach ( $product->get_children() as $child_id ) {
        $v   = wc_get_product( $child_id );
        if ( ! $v ) continue;
        $sku = trim( (string) $v->get_sku() );
        if ( $sku === '' ) continue;              // Senza SKU non possiamo matchare in sicurezza.
        if ( isset( $incoming[ $sku ] ) ) continue;
        if ( $v->get_status() === 'private' && ! $v->is_in_stock() ) continue; // Gia nascosta.
        $count++;
    }
    return $count;
}

/**
 * Nasconde le varianti esistenti assenti dal JSON: stock a 0 + out-of-stock +
 * variante disabilitata (status 'private'), cosi WooCommerce non la mostra piu
 * nel selettore taglie della pagina prodotto. Non elimina nulla — la variante
 * (e il suo storico ordini) resta, e un import successivo che re-include quella
 * SKU la ri-abilita tramite il normale path di upsert.
 *
 * @param int   $product_id           ID del prodotto padre.
 * @param array $incoming_variations  Array di varianti dal JSON (ognuna con 'sku').
 * @return int Numero di varianti nascoste.
 */
function gh_cm_hide_missing_variations( int $product_id, array $incoming_variations ): int {

    $product = wc_get_product( $product_id );
    if ( ! $product || ! $product->is_type( 'variable' ) ) {
        return 0;
    }

    $incoming = gh_cm_incoming_sku_set( $incoming_variations );
    // Guardia di sicurezza: se il JSON non porta NESSUNA SKU non abbiamo un
    // riferimento affidabile per decidere cosa nascondere → non tocchiamo nulla.
    if ( empty( $incoming ) ) {
        return 0;
    }

    $hidden = 0;
    foreach ( $product->get_children() as $child_id ) {
        $v = wc_get_product( $child_id );
        if ( ! $v || ! $v->is_type( 'variation' ) ) continue;

        $sku = trim( (string) $v->get_sku() );
        if ( $sku === '' ) continue;              // Senza SKU non matchabile: la lasciamo stare.
        if ( isset( $incoming[ $sku ] ) ) continue; // Presente nel JSON: gestita dall'upsert.

        // Gia nascosta in un giro precedente: idempotente, salta.
        if ( $v->get_status() === 'private' && ! $v->is_in_stock() ) continue;

        $v->set_manage_stock( true );
        $v->set_stock_quantity( 0 );
        $v->set_stock_status( 'outofstock' );
        $v->set_status( 'private' ); // "Disabilitata" nel senso WC → esclusa da get_available_variations().
        $v->save();
        $hidden++;
    }
    return $hidden;
}

/**
 * Costruisce un set (mappa sku => true) delle SKU non vuote in arrivo dal JSON.
 *
 * @param array $incoming_variations
 * @return array<string,true>
 */
function gh_cm_incoming_sku_set( array $incoming_variations ): array {
    $set = [];
    foreach ( $incoming_variations as $var_data ) {
        $sku = isset( $var_data['sku'] ) ? trim( (string) $var_data['sku'] ) : '';
        if ( $sku !== '' ) {
            $set[ $sku ] = true;
        }
    }
    return $set;
}

/**
 * Dispatches a bulk import as a background job (kind bulk_import).
 *
 * Writes the products to a token-named file under uploads/gh-jobs/imports/ and
 * fires a one-shot job that walks it in WP-Cron ticks. The dispatch returns in
 * milliseconds, so the upload request never holds long enough to hit
 * Cloudflare's ~100s cap; the actual import runs server-side and survives the
 * user closing the tab.
 *
 * @param array  $data { products: [...] } (or a bare array).
 * @param string $mode 'create' | 'create_or_update'
 * @return array{job_id:string,total:int}|WP_Error
 */
function gh_cm_dispatch_bulk_import( array $data, string $mode = 'create' ): array|WP_Error {

    if ( ! in_array( $mode, [ 'create', 'create_or_update', 'sync' ], true ) ) {
        $mode = 'create';
    }
    if ( ! function_exists( 'gh_jobs_save' ) || ! function_exists( 'gh_jobs_get_kind' ) || ! gh_jobs_get_kind( 'bulk_import' ) ) {
        return new WP_Error( 'jobs_unavailable', 'Job runner non disponibile.' );
    }

    $valid = rp_cm_validate_bulk_json( $data );
    if ( is_wp_error( $valid ) ) {
        return $valid;
    }
    $products = $valid['products'];
    $total    = count( $products );

    // Persist the payload to disk (job params can't carry MBs of JSON).
    $uploads = wp_get_upload_dir();
    if ( ! empty( $uploads['error'] ) ) {
        return new WP_Error( 'upload_dir', 'Upload dir non accessibile: ' . $uploads['error'] );
    }
    $dir = trailingslashit( $uploads['basedir'] ) . 'gh-jobs/imports';
    if ( ! wp_mkdir_p( $dir ) ) {
        return new WP_Error( 'mkdir', "Impossibile creare {$dir}" );
    }
    // Best-effort directory hardening (Apache; nginx ignores .htaccess, but the
    // random token filename keeps the path unguessable).
    if ( ! file_exists( $dir . '/.htaccess' ) ) {
        @file_put_contents( $dir . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n" );
    }
    if ( ! file_exists( $dir . '/index.php' ) ) {
        @file_put_contents( $dir . '/index.php', "<?php // Silence is golden.\n" );
    }

    $token = function_exists( 'wp_generate_password' ) ? wp_generate_password( 16, false ) : bin2hex( random_bytes( 8 ) );
    $path  = trailingslashit( $dir ) . 'import-' . wp_date( 'Ymd-His' ) . '-' . $token . '.json';
    $json  = wp_json_encode( [ 'products' => $products ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
    if ( false === file_put_contents( $path, $json ) ) {
        return new WP_Error( 'write', "Scrittura fallita: {$path}" );
    }

    $saved = gh_jobs_save( [
        'kind'        => 'bulk_import',
        'label'       => sprintf( 'Bulk Import · %d prodotti', $total ),
        // Expression valida ma enabled:false → il cron non la schedula mai;
        // facciamo un fire singolo qui sotto.
        'cron'        => '0 0 1 1 *',
        'enabled'     => false,
        'max_runtime' => 3600,
        'tick_budget' => 25,
        'params'      => [ 'file' => $path, 'mode' => $mode, 'weight_budget' => '80' ],
    ] );

    if ( is_wp_error( $saved ) ) {
        @unlink( $path );
        return $saved;
    }

    // Seed progress so the first status poll has something to show.
    gh_jobs_update_fields( $saved['id'], [
        'last_status'  => 'continue',
        'last_summary' => [ 'processed' => 0, 'total' => $total, 'created' => 0, 'updated' => 0, 'errors' => 0 ],
    ] );

    wp_schedule_single_event( time(), GH_JOBS_TICK_HOOK, [ $saved['id'] ] );
    if ( function_exists( 'spawn_cron' ) ) {
        spawn_cron( time() );
    }

    return [ 'job_id' => (string) $saved['id'], 'total' => $total ];
}
