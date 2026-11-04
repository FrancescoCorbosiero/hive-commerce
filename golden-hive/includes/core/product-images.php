<?php
/**
 * Product Images — risolve le immagini dichiarate in un JSON prodotto e le
 * collega al prodotto (featured + gallery) e alle varianti.
 *
 * Per ogni immagine, in quest'ordine:
 *   1. `id` di un attachment esistente           → riuso
 *   2. URL già scaricato in passato (preimport map) → riuso
 *   3. URL della media library di QUESTO sito      → riuso dell'attachment
 *      (anche se l'URL punta a una miniatura "-300x300" o all'originale di
 *      un "-scaled")
 *   4. URL di questo sito, file presente su disco ma non registrato come
 *      attachment (es. caricato via FTP)            → registrazione, niente copia
 *   5. qualunque altro URL http(s)                   → download (sideload)
 *
 * Usato da: Import JSON (catalog/bulk-creator.php). NON è agganciato al
 * product factory: i feed (GS/SF/CSV/KicksDB) hanno già la loro pipeline
 * media e un hook lì causerebbe doppi download.
 *
 * Formati accettati sull'entry prodotto (il primo presente vince):
 *   - `images`: [ { id?, src?, name?, alt?, position? } | "https://…" | 123 ]
 *     (shape WooCommerce REST API)
 *   - `featured_image_url` + `gallery_image_urls` (shape del catalog export)
 *   - `image`: singola immagine (oggetto | URL | ID)
 * Sulle varianti: `image` (oggetto | URL | ID) oppure `images` (si usa la prima).
 *
 * Semantica (array_key_exists, come da CONVENTIONS):
 *   - chiave assente  → immagini del prodotto NON toccate
 *   - lista vuota     → featured + gallery rimosse (gli attachment restano)
 *   - lista non vuota → featured = prima, gallery = le altre, in ordine
 * Se NESSUNA immagine di una lista non vuota si risolve (download falliti,
 * URL non validi) le immagini attuali restano: un errore non svuota mai.
 */

defined( 'ABSPATH' ) || exit;

/** Peso di un'immagine nel batching dell'import (vedi gh_cm_bulk_entry_weight). */
const GH_IMG_IMPORT_WEIGHT = 4;

// ── Normalizzazione (pure PHP, testabile) ───────────────────────────────────

/**
 * Normalizza una singola dichiarazione immagine.
 *
 * Esempio: gh_img_normalize_spec( 'https://x.com/a.jpg' )
 *          → [ 'id' => 0, 'src' => 'https://x.com/a.jpg', 'name' => '', 'alt' => '', 'position' => null ]
 *
 * @param mixed $raw Oggetto { id, src|url, name, alt, position }, URL, o ID numerico.
 * @return array|null Spec normalizzata, null se vuota.
 */
function gh_img_normalize_spec( mixed $raw ): ?array {

    $spec = [ 'id' => 0, 'src' => '', 'name' => '', 'alt' => '', 'position' => null ];

    if ( is_int( $raw ) || ( is_string( $raw ) && ctype_digit( trim( $raw ) ) ) ) {
        $spec['id'] = (int) $raw;
    } elseif ( is_string( $raw ) ) {
        $spec['src'] = trim( $raw );
    } elseif ( is_array( $raw ) ) {
        $spec['id']   = is_numeric( $raw['id'] ?? null ) ? (int) $raw['id'] : 0;
        $spec['src']  = trim( (string) ( $raw['src'] ?? $raw['url'] ?? '' ) );
        $spec['name'] = trim( (string) ( $raw['name'] ?? '' ) );
        $spec['alt']  = trim( (string) ( $raw['alt'] ?? '' ) );
        if ( isset( $raw['position'] ) && is_numeric( $raw['position'] ) ) {
            $spec['position'] = (int) $raw['position'];
        }
    } else {
        return null;
    }

    if ( str_starts_with( $spec['src'], '//' ) ) {
        $spec['src'] = 'https:' . $spec['src'];
    }
    if ( $spec['id'] < 0 ) {
        $spec['id'] = 0;
    }

    return ( $spec['id'] > 0 || $spec['src'] !== '' ) ? $spec : null;
}

/**
 * Estrae la lista immagini da un'entry prodotto o variante.
 *
 * Esempio: gh_img_specs_from_entry( [ 'images' => [ [ 'src' => $u, 'position' => 0 ] ] ] )
 *          → [ [ 'id' => 0, 'src' => $u, … ] ]
 *
 * @param array $entry     Entry del JSON.
 * @param bool  $variation true per una variante (max 1 immagine, `image` prima di `images`).
 * @return array|null null = nessuna chiave immagine (non toccare); [] = rimuovi; altrimenti spec ordinate e deduplicate.
 */
function gh_img_specs_from_entry( array $entry, bool $variation = false ): ?array {

    $raw_list = null;

    if ( $variation ) {
        if ( array_key_exists( 'image', $entry ) ) {
            $raw_list = ( $entry['image'] === null || $entry['image'] === '' || $entry['image'] === [] ) ? [] : [ $entry['image'] ];
        } elseif ( array_key_exists( 'images', $entry ) ) {
            $raw_list = is_array( $entry['images'] ) ? $entry['images'] : [];
        }
    } elseif ( array_key_exists( 'images', $entry ) ) {
        $raw_list = is_array( $entry['images'] ) ? $entry['images'] : [];
    } elseif ( array_key_exists( 'featured_image_url', $entry ) || array_key_exists( 'gallery_image_urls', $entry ) ) {
        $raw_list = [];
        if ( ! empty( $entry['featured_image_url'] ) ) {
            $raw_list[] = $entry['featured_image_url'];
        }
        foreach ( (array) ( $entry['gallery_image_urls'] ?? [] ) as $u ) {
            $raw_list[] = $u;
        }
    } elseif ( array_key_exists( 'image', $entry ) ) {
        $raw_list = ( $entry['image'] === null || $entry['image'] === '' || $entry['image'] === [] ) ? [] : [ $entry['image'] ];
    }

    if ( $raw_list === null ) {
        return null;
    }

    // Un oggetto singolo passato al posto della lista ({ "src": … }).
    if ( isset( $raw_list['src'] ) || isset( $raw_list['url'] ) || isset( $raw_list['id'] ) ) {
        $raw_list = [ $raw_list ];
    }

    $specs = [];
    foreach ( array_values( $raw_list ) as $i => $raw ) {
        $spec = gh_img_normalize_spec( $raw );
        if ( $spec === null ) continue;
        $spec['_i'] = $i;
        $specs[]    = $spec;
    }

    // Ordine per `position` quando presente (stabile sull'ordine originale).
    usort( $specs, static function ( $a, $b ) {
        $pa = $a['position'] ?? PHP_INT_MAX;
        $pb = $b['position'] ?? PHP_INT_MAX;
        return $pa <=> $pb ?: $a['_i'] <=> $b['_i'];
    } );

    // Dedup: la stessa immagine due volte finirebbe due volte in gallery.
    $seen = [];
    $out  = [];
    foreach ( $specs as $spec ) {
        unset( $spec['_i'] );
        $key = $spec['id'] > 0 ? 'id:' . $spec['id'] : 'src:' . $spec['src'];
        if ( isset( $seen[ $key ] ) ) continue;
        $seen[ $key ] = true;
        $out[]        = $spec;
    }

    if ( $variation ) {
        $out = array_slice( $out, 0, 1 );
    }

    return $out;
}

/**
 * Numero di immagini dichiarate da un'entry (prodotto + varianti). Usato per
 * il peso dei batch d'import.
 *
 * @param array $entry
 * @return int
 */
function gh_img_count_in_entry( array $entry ): int {
    $n = count( gh_img_specs_from_entry( $entry ) ?? [] );
    foreach ( (array) ( $entry['variations'] ?? [] ) as $v ) {
        if ( is_array( $v ) ) {
            $n += count( gh_img_specs_from_entry( $v, true ) ?? [] );
        }
    }
    return $n;
}

/**
 * Se l'URL appartiene alla media library di questo sito, ritorna il path
 * relativo alla cartella uploads (formato di `_wp_attached_file`).
 *
 * Host confrontati senza schema né "www.". Path con segmenti ".." rifiutati.
 *
 * Esempio: gh_img_local_upload_path( 'https://www.shop.it/wp-content/uploads/2026/09/a.jpg', '/wp-content/uploads', [ 'shop.it' ] )
 *          → '2026/09/a.jpg'
 *
 * @param string   $url       URL immagine.
 * @param string   $base_path Path dell'URL base uploads (es. '/wp-content/uploads').
 * @param string[] $hosts     Host considerati "questo sito".
 * @return string|null
 */
function gh_img_local_upload_path( string $url, string $base_path, array $hosts ): ?string {

    $parts = parse_url( $url );
    if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['path'] ) ) {
        return null;
    }
    $scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
    if ( ! in_array( $scheme, [ 'http', 'https' ], true ) ) {
        return null;
    }

    $norm  = static fn( string $h ): string => preg_replace( '/^www\./', '', strtolower( trim( $h ) ) );
    $hosts = array_filter( array_map( $norm, $hosts ) );
    if ( ! in_array( $norm( $parts['host'] ), $hosts, true ) ) {
        return null;
    }

    $prefix = rtrim( $base_path, '/' ) . '/';
    $path   = rawurldecode( $parts['path'] );
    if ( ! str_starts_with( $path, $prefix ) ) {
        return null;
    }

    $rel = substr( $path, strlen( $prefix ) );
    if ( $rel === '' || str_ends_with( $rel, '/' ) ) {
        return null;
    }
    foreach ( explode( '/', $rel ) as $seg ) {
        if ( $seg === '..' || $seg === '.' || $seg === '' ) {
            return null;
        }
    }

    return $rel;
}

/**
 * Candidati `_wp_attached_file` per un path relativo: l'URL può puntare a
 * una miniatura ("-300x300") o all'originale di un'immagine che WordPress
 * ha salvato come "-scaled" / "-rotated".
 *
 * Esempio: gh_img_attached_file_candidates( '2026/09/a-300x300.jpg' )
 *          → [ '2026/09/a-300x300.jpg', '2026/09/a.jpg', '2026/09/a-scaled.jpg', '2026/09/a-rotated.jpg' ]
 *
 * @param string $rel
 * @return string[] In ordine di preferenza, senza duplicati.
 */
function gh_img_attached_file_candidates( string $rel ): array {

    $dot = strrpos( $rel, '.' );
    if ( $dot === false ) {
        return [ $rel ];
    }
    $stem = substr( $rel, 0, $dot );
    $ext  = substr( $rel, $dot );

    $orig = preg_replace( '/-\d+x\d+$/', '', $stem );
    $orig = preg_replace( '/-(scaled|rotated)$/', '', $orig );

    return array_values( array_unique( [
        $rel,
        $orig . $ext,
        $orig . '-scaled' . $ext,
        $orig . '-rotated' . $ext,
    ] ) );
}

// ── Risoluzione (WordPress) ─────────────────────────────────────────────────

/**
 * Host che identificano "questo sito" per gli URL immagine.
 * Filtrabile (`gh_img_local_hosts`) per aggiungere un CDN che serve gli uploads.
 *
 * @return string[]
 */
function gh_img_local_hosts(): array {
    $hosts = [];
    $up    = wp_get_upload_dir();
    foreach ( [ $up['baseurl'] ?? '', home_url(), site_url() ] as $u ) {
        $h = parse_url( (string) $u, PHP_URL_HOST );
        if ( $h ) $hosts[] = $h;
    }
    return array_values( array_unique( (array) apply_filters( 'gh_img_local_hosts', $hosts ) ) );
}

/**
 * Path relativo uploads per un URL di questo sito, o null.
 *
 * @param string $url
 * @return string|null
 */
function gh_img_local_rel_path( string $url ): ?string {
    static $base_path = null, $hosts = null;
    if ( $base_path === null ) {
        $up        = wp_get_upload_dir();
        $base_path = (string) parse_url( (string) ( $up['baseurl'] ?? '' ), PHP_URL_PATH );
        $hosts     = gh_img_local_hosts();
    }
    return $base_path === '' ? null : gh_img_local_upload_path( $url, $base_path, $hosts );
}

/**
 * Cerca nella media library l'attachment il cui file corrisponde a un path
 * relativo (o a una sua variante miniatura/scaled).
 *
 * @param string $rel
 * @return int Attachment ID, 0 se non trovato.
 */
function gh_img_find_attachment_by_rel_path( string $rel ): int {
    global $wpdb;

    $cands = gh_img_attached_file_candidates( $rel );
    $ph    = implode( ',', array_fill( 0, count( $cands ), '%s' ) );
    $rows  = $wpdb->get_results( $wpdb->prepare(
        "SELECT pm.post_id, pm.meta_value FROM {$wpdb->postmeta} pm
         INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id AND p.post_type = 'attachment'
         WHERE pm.meta_key = '_wp_attached_file' AND pm.meta_value IN ($ph)",
        ...$cands
    ) );

    $by_file = [];
    foreach ( (array) $rows as $r ) {
        $by_file[ (string) $r->meta_value ] ??= (int) $r->post_id;
    }
    foreach ( $cands as $c ) {
        if ( isset( $by_file[ $c ] ) ) return $by_file[ $c ];
    }

    // Ultima spiaggia: core (copre plugin che filtrano gli URL degli uploads).
    $id = (int) attachment_url_to_postid( trailingslashit( wp_get_upload_dir()['baseurl'] ) . $rel );
    return $id > 0 ? $id : 0;
}

/**
 * Decide, SENZA effetti collaterali, come verrà risolta ogni immagine.
 * Usato dal preview e come primo passo dell'apply.
 *
 * Ogni spec riceve:
 *   status        existing | local_file | download | invalid
 *   attachment_id (existing)
 *   rel           (local_file)
 *   reason        (invalid)
 *
 * @param array $specs Output di gh_img_specs_from_entry().
 * @return array
 */
function gh_img_plan( array $specs ): array {

    $map = function_exists( 'gh_preimport_get_map' ) ? gh_preimport_get_map() : [];
    $out = [];

    foreach ( $specs as $spec ) {

        if ( $spec['id'] > 0 ) {
            if ( get_post_type( $spec['id'] ) === 'attachment' ) {
                $out[] = $spec + [ 'status' => 'existing', 'attachment_id' => $spec['id'] ];
                continue;
            }
            if ( $spec['src'] === '' ) {
                $out[] = $spec + [ 'status' => 'invalid', 'reason' => "Attachment #{$spec['id']} non trovato" ];
                continue;
            }
            // ID inesistente ma c'è un URL: si prosegue con l'URL.
        }

        $src    = $spec['src'];
        $scheme = strtolower( (string) parse_url( $src, PHP_URL_SCHEME ) );
        if ( ! in_array( $scheme, [ 'http', 'https' ], true ) ) {
            $out[] = $spec + [ 'status' => 'invalid', 'reason' => 'URL non valido (serve http/https)' ];
            continue;
        }

        if ( isset( $map[ $src ] ) && get_post_type( (int) $map[ $src ] ) === 'attachment' ) {
            $out[] = $spec + [ 'status' => 'existing', 'attachment_id' => (int) $map[ $src ] ];
            continue;
        }

        $rel = gh_img_local_rel_path( $src );
        if ( $rel !== null ) {
            $att = gh_img_find_attachment_by_rel_path( $rel );
            if ( $att > 0 ) {
                $out[] = $spec + [ 'status' => 'existing', 'attachment_id' => $att ];
                continue;
            }
            $abs = trailingslashit( wp_get_upload_dir()['basedir'] ) . $rel;
            if ( is_file( $abs ) ) {
                $out[] = $spec + [ 'status' => 'local_file', 'rel' => $rel ];
                continue;
            }
            // URL di questo sito senza attachment né file su disco (es. uploads
            // offloadati su un CDN): si tenta il download; un 404 finisce nel report.
        }

        if ( function_exists( 'wp_http_validate_url' ) && ! wp_http_validate_url( $src ) ) {
            $out[] = $spec + [ 'status' => 'invalid', 'reason' => 'URL rifiutato (host locale/privato o non raggiungibile)' ];
            continue;
        }

        $out[] = $spec + [ 'status' => 'download' ];
    }

    return $out;
}

/**
 * Conteggi del piano per il preview.
 *
 * @param array $entry Entry prodotto (con eventuali varianti).
 * @return array { declared, existing, local_file, download, invalid, clear, untouched, invalid_details[] }
 */
function gh_img_plan_summary( array $entry ): array {

    $sum = [ 'declared' => 0, 'existing' => 0, 'local_file' => 0, 'download' => 0, 'invalid' => 0, 'clear' => false, 'untouched' => true, 'invalid_details' => [] ];

    $lists = [];
    $parent = gh_img_specs_from_entry( $entry );
    if ( $parent !== null ) {
        $sum['untouched'] = false;
        $sum['clear']     = $parent === [];
        $lists[]          = $parent;
    }
    foreach ( (array) ( $entry['variations'] ?? [] ) as $v ) {
        $vs = is_array( $v ) ? gh_img_specs_from_entry( $v, true ) : null;
        if ( $vs !== null ) {
            $sum['untouched'] = false;
            $lists[]          = $vs;
        }
    }

    foreach ( $lists as $specs ) {
        foreach ( gh_img_plan( $specs ) as $p ) {
            $sum['declared']++;
            $sum[ $p['status'] ]++;
            if ( $p['status'] === 'invalid' ) {
                $sum['invalid_details'][] = [ 'src' => $p['src'] !== '' ? $p['src'] : '#' . $p['id'], 'reason' => $p['reason'] ];
            }
        }
    }

    return $sum;
}

/**
 * Registra come attachment un file già presente negli uploads (senza copiarlo).
 *
 * @param string $rel    Path relativo agli uploads.
 * @param int    $parent Post parent.
 * @param string $title
 * @return int|WP_Error
 */
function gh_img_register_local_file( string $rel, int $parent, string $title = '' ): int|WP_Error {

    $up   = wp_get_upload_dir();
    $base = realpath( (string) $up['basedir'] );
    $abs  = realpath( trailingslashit( (string) $up['basedir'] ) . $rel );

    if ( ! $base || ! $abs || ! str_starts_with( $abs, trailingslashit( $base ) ) || ! is_file( $abs ) ) {
        return new WP_Error( 'not_found', 'File non trovato negli uploads' );
    }

    $ft = wp_check_filetype( basename( $abs ) );
    if ( empty( $ft['type'] ) || ! str_starts_with( (string) $ft['type'], 'image/' ) ) {
        return new WP_Error( 'not_image', 'Il file non è un\'immagine consentita' );
    }

    if ( ! function_exists( 'wp_generate_attachment_metadata' ) ) {
        require_once ABSPATH . 'wp-admin/includes/image.php';
    }

    $id = wp_insert_attachment( [
        'post_mime_type' => $ft['type'],
        'post_title'     => $title !== '' ? $title : preg_replace( '/\.[^.]+$/', '', basename( $abs ) ),
        'post_status'    => 'inherit',
        'guid'           => trailingslashit( (string) $up['baseurl'] ) . $rel,
    ], $abs, $parent, true );

    if ( is_wp_error( $id ) ) {
        return $id;
    }
    wp_update_attachment_metadata( (int) $id, wp_generate_attachment_metadata( (int) $id, $abs ) );

    return (int) $id;
}

/**
 * Risolve e collega le immagini di un'entry al prodotto e alle sue varianti.
 *
 * Tutti i download del prodotto (parent + varianti) partono in un unico
 * batch parallelo, con generazione miniature attiva: sono immagini che il
 * negozio mostra. Gli URL scaricati finiscono nella preimport map, quindi un
 * re-import dello stesso JSON riusa gli attachment invece di duplicarli.
 *
 * @param int   $product_id    Prodotto padre.
 * @param array $entry         Entry del JSON.
 * @param array $variation_ids Mappa indice-variante-nel-JSON → variation ID.
 * @return array Report: { touched, featured, gallery, variations, reused, downloaded, registered, cleared, failed[] }
 */
function gh_img_apply_to_product( int $product_id, array $entry, array $variation_ids = [] ): array {

    $report = [ 'touched' => false, 'featured' => 0, 'gallery' => 0, 'variations' => 0, 'reused' => 0, 'downloaded' => 0, 'registered' => 0, 'cleared' => false, 'failed' => [] ];

    $parent_specs = gh_img_specs_from_entry( $entry );
    $var_specs    = [];
    foreach ( array_values( (array) ( $entry['variations'] ?? [] ) ) as $i => $v ) {
        if ( ! is_array( $v ) || empty( $variation_ids[ $i ] ) ) continue;
        $vs = gh_img_specs_from_entry( $v, true );
        if ( $vs !== null ) {
            $var_specs[ (int) $variation_ids[ $i ] ] = $vs;
        }
    }

    if ( $parent_specs === null && ! $var_specs ) {
        return $report;
    }
    $report['touched'] = true;

    $product_name = (string) ( $entry['name'] ?? '' );
    $sku          = (string) ( $entry['sku'] ?? '' );

    // 1. Piano per tutte le liste.
    $plans = [ 'parent' => $parent_specs !== null ? gh_img_plan( $parent_specs ) : null ];
    foreach ( $var_specs as $vid => $vs ) {
        $plans[ 'v' . $vid ] = gh_img_plan( $vs );
    }

    // 2. Download in un unico batch parallelo (URL unici).
    $downloads = [];
    foreach ( $plans as $plan ) {
        foreach ( (array) $plan as $p ) {
            if ( $p['status'] !== 'download' || isset( $downloads[ $p['src'] ] ) ) continue;
            $label = $p['name'] !== '' ? $p['name'] : ( $p['alt'] !== '' ? $p['alt'] : $product_name );
            $downloads[ $p['src'] ] = [
                'url'      => $p['src'],
                'sku'      => $sku,
                'filename' => substr( sanitize_title( $label ), 0, 80 ),
            ];
        }
    }

    $dl_reasons = [];
    $new_ids    = [];
    if ( $downloads ) {
        if ( ! function_exists( 'gh_preimport_download_batch' ) ) {
            foreach ( $downloads as $u => $_ ) $dl_reasons[ $u ] = 'Downloader non disponibile';
        } else {
            $res        = gh_preimport_download_batch( array_values( $downloads ), 6, [ 'thumbnails' => true ] );
            $dl_reasons = (array) ( $res['error_reasons'] ?? [] );
            foreach ( (array) ( $res['error_urls'] ?? [] ) as $u ) {
                $dl_reasons[ $u ] ??= 'Download fallito';
            }
        }
    }
    $map = function_exists( 'gh_preimport_get_map' ) ? gh_preimport_get_map() : [];

    // 3. Plan → attachment ID.
    $resolve = function ( array $p ) use ( &$report, &$new_ids, $map, $dl_reasons, $product_id, $product_name ): int {
        switch ( $p['status'] ) {
            case 'existing':
                $report['reused']++;
                return (int) $p['attachment_id'];
            case 'local_file':
                $id = gh_img_register_local_file( $p['rel'], $product_id, $p['name'] !== '' ? $p['name'] : $product_name );
                if ( is_wp_error( $id ) ) {
                    $report['failed'][] = [ 'src' => $p['src'], 'reason' => $id->get_error_message() ];
                    return 0;
                }
                $report['registered']++;
                $new_ids[ $id ] = true;
                return $id;
            case 'download':
                $id = (int) ( $map[ $p['src'] ] ?? 0 );
                if ( $id <= 0 || isset( $dl_reasons[ $p['src'] ] ) ) {
                    $report['failed'][] = [ 'src' => $p['src'], 'reason' => $dl_reasons[ $p['src'] ] ?? 'Download fallito' ];
                    return 0;
                }
                if ( ! isset( $new_ids[ $id ] ) ) $report['downloaded']++;
                $new_ids[ $id ] = true;
                return $id;
            default:
                $report['failed'][] = [ 'src' => $p['src'] !== '' ? $p['src'] : '#' . $p['id'], 'reason' => $p['reason'] ?? 'Non valido' ];
                return 0;
        }
    };

    $touched_meta = [];
    $claim = function ( int $att_id, array $p ) use ( &$touched_meta, &$new_ids, $product_id, $product_name ): void {
        if ( isset( $touched_meta[ $att_id ] ) ) return;
        $touched_meta[ $att_id ] = true;

        $post = get_post( $att_id );
        if ( ! $post ) return;

        $upd = [];
        if ( (int) $post->post_parent === 0 ) {
            $upd['post_parent'] = $product_id;
        }
        // Titolo solo sugli attachment nati da questo import: un media già in
        // libreria può essere usato da altri prodotti.
        if ( isset( $new_ids[ $att_id ] ) ) {
            $title = $p['name'] !== '' ? $p['name'] : $product_name;
            if ( $title !== '' ) $upd['post_title'] = $title;
        }
        if ( $upd ) {
            wp_update_post( [ 'ID' => $att_id ] + $upd );
        }

        $alt = $p['alt'] !== '' ? $p['alt'] : ( isset( $new_ids[ $att_id ] ) ? ( $p['name'] !== '' ? $p['name'] : $product_name ) : '' );
        if ( $alt !== '' && ( isset( $new_ids[ $att_id ] ) || (string) get_post_meta( $att_id, '_wp_attachment_image_alt', true ) === '' ) ) {
            update_post_meta( $att_id, '_wp_attachment_image_alt', sanitize_text_field( $alt ) );
        }

        delete_post_meta( $att_id, '_gh_preimport_pending' );
    };

    // 4. Parent: featured + gallery.
    if ( $plans['parent'] !== null ) {
        $product = wc_get_product( $product_id );
        if ( $product ) {
            $ids = [];
            foreach ( $plans['parent'] as $p ) {
                $id = $resolve( $p );
                if ( $id > 0 && ! in_array( $id, $ids, true ) ) {
                    $ids[] = $id;
                    $claim( $id, $p );
                }
            }

            $apply = true;
            if ( $plans['parent'] === [] ) {
                $report['cleared'] = true;
            } elseif ( ! $ids ) {
                $apply = false; // tutte fallite: non svuotare le immagini attuali
            }

            if ( $apply ) {
                $featured = $ids[0] ?? 0;
                $gallery  = array_slice( $ids, 1 );
                if ( (int) $product->get_image_id( 'edit' ) !== $featured || array_map( 'intval', $product->get_gallery_image_ids( 'edit' ) ) !== $gallery ) {
                    $product->set_image_id( $featured ?: '' );
                    $product->set_gallery_image_ids( $gallery );
                    $product->save();
                }
                $report['featured'] = $featured;
                $report['gallery']  = count( $gallery );
            }
        }
    }

    // 5. Varianti.
    foreach ( $var_specs as $vid => $_ ) {
        $v = wc_get_product( $vid );
        if ( ! $v || ! $v->is_type( 'variation' ) ) continue;

        $plan = $plans[ 'v' . $vid ];
        if ( $plan === [] ) {
            $new = 0;
        } else {
            $new = $resolve( $plan[0] );
            if ( $new <= 0 ) continue;
            $claim( $new, $plan[0] );
        }
        // 'edit': in contesto 'view' una variante senza immagine ritorna quella del parent.
        if ( (int) $v->get_image_id( 'edit' ) !== $new ) {
            $v->set_image_id( $new ?: '' );
            $v->save();
        }
        if ( $new > 0 ) $report['variations']++;
    }

    return $report;
}
