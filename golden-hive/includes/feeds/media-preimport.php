<?php
/**
 * Media Pre-Import — scarica le immagini PRIMA dell'import prodotti.
 *
 * Architettura ispirata a woo-importer/MediaUploader:
 * - Sliding window curl_multi (non aspetta che tutti finiscano — appena
 *   un handle completa, ne aggiunge uno nuovo dalla coda)
 * - Thumbnail generation disabilitata durante il batch (aggiunge solo il
 *   file originale, senza generare 5+ sub-sizes per immagine). Questo e
 *   il singolo speed-up piu grande: da ~3s/img a ~0.3s/img.
 * - Mappa persistente source_url → attachment_id per skip/resume
 */

defined( 'ABSPATH' ) || exit;

const GH_MEDIA_PREIMPORT_MAP_KEY = 'gh_media_preimport_map';

function gh_preimport_get_map(): array {
    $map = get_option( GH_MEDIA_PREIMPORT_MAP_KEY, [] );
    return is_array( $map ) ? $map : [];
}

/**
 * Removes every URL→attachment_id entry whose attachment_id is in
 * $ids. Used by the force re-import flow after it has just deleted
 * those attachments, so the next sideload redownloads fresh bytes
 * instead of resolving stale map entries to nonexistent attachments.
 *
 * @param int[] $ids
 * @return int Number of map entries removed.
 */
function gh_preimport_purge_by_attachment_ids( array $ids ): int {

    if ( empty( $ids ) ) return 0;

    $ids = array_flip( array_map( 'intval', $ids ) );
    $map = gh_preimport_get_map();

    $removed = 0;
    foreach ( $map as $url => $att_id ) {
        if ( isset( $ids[ (int) $att_id ] ) ) {
            unset( $map[ $url ] );
            $removed++;
        }
    }

    if ( $removed > 0 ) {
        update_option( GH_MEDIA_PREIMPORT_MAP_KEY, $map, false );
    }

    return $removed;
}

/**
 * Downloads a batch of image URLs using a sliding-window curl_multi and
 * imports each into WP media library with thumbnail generation DISABLED.
 *
 * @param array $urls        Array of { url, sku, filename? } (or bare URL strings).
 *                           `filename` = base name for the stored file (no
 *                           extension); defaults to the SKU, then an URL hash.
 * @param int   $concurrency Max simultaneous connections (default 10).
 * @param array $opts        { thumbnails?: bool } — true keeps WordPress'
 *                           normal sub-size generation (default false = fast
 *                           feed mode, original file only).
 * @return array { downloaded, skipped, errors, error_urls, error_reasons, map_size }
 *               error_reasons = url => human-readable reason.
 */
function gh_preimport_download_batch( array $urls, int $concurrency = 10, array $opts = [] ): array {

    $thumbnails = ! empty( $opts['thumbnails'] );

    if ( ! function_exists( 'media_handle_sideload' ) ) {
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
    }

    $map = gh_preimport_get_map();

    $downloaded = 0;
    $skipped    = 0;
    $errors     = 0;
    $error_urls = [];
    $reasons    = [];

    // 1. Build the download queue — skip already-mapped URLs
    $queue = []; // [ { url, sku, tmp } ]
    foreach ( $urls as $item ) {
        $url = is_array( $item ) ? ( $item['url'] ?? '' ) : (string) $item;
        $sku = is_array( $item ) ? ( $item['sku'] ?? '' ) : '';
        $fn  = is_array( $item ) ? (string) ( $item['filename'] ?? '' ) : '';
        if ( ! $url ) continue;

        if ( isset( $map[ $url ] ) && wp_get_attachment_url( $map[ $url ] ) ) {
            $skipped++;
            continue;
        }
        unset( $map[ $url ] );
        $queue[] = [ 'url' => $url, 'sku' => $sku, 'filename' => $fn ];
    }

    if ( empty( $queue ) ) {
        update_option( GH_MEDIA_PREIMPORT_MAP_KEY, $map, false );
        return compact( 'downloaded', 'skipped', 'errors', 'error_urls' ) + [ 'error_reasons' => [], 'map_size' => count( $map ) ];
    }

    // 2. DISABLE THUMBNAIL GENERATION for speed.
    //    media_handle_sideload → wp_generate_attachment_metadata → creates
    //    5+ sub-sizes per image. This is the #1 bottleneck. Disabling it
    //    means only the original file is stored. Thumbnails can be
    //    regenerated later via "Regenerate Thumbnails" or WP-CLI.
    //    Callers that import images the shop displays right away (Import
    //    JSON) pass thumbnails=true and keep the normal sub-sizes.
    if ( ! $thumbnails ) {
        add_filter( 'intermediate_image_sizes_advanced', '__return_empty_array', 999 );
    }

    // 3. Sliding-window curl_multi: keep $concurrency connections active.
    //    As each handle completes → immediately sideload the file into WP
    //    and start the next download from the queue. This keeps the pipe
    //    full instead of waiting for the slowest download in the batch.
    $mh       = curl_multi_init();
    $active   = []; // key(ch) → { ch, fp, tmp, url, sku }
    $qi       = 0;  // queue index

    // Fill initial window
    while ( count( $active ) < $concurrency && $qi < count( $queue ) ) {
        $active = gh_preimport_add_handle( $mh, $active, $queue[ $qi ] );
        $qi++;
    }

    // Process
    while ( ! empty( $active ) ) {
        $status = curl_multi_exec( $mh, $running );
        if ( $running ) {
            curl_multi_select( $mh, 0.5 );
        }

        // Check completed handles
        while ( $info = curl_multi_info_read( $mh ) ) {
            $ch  = $info['handle'];
            $key = (int) $ch;

            if ( ! isset( $active[ $key ] ) ) continue;

            $h = $active[ $key ];
            fclose( $h['fp'] );

            $http = (int) curl_getinfo( $ch, CURLINFO_HTTP_CODE );
            $cerr = curl_error( $ch );
            curl_multi_remove_handle( $mh, $ch );
            curl_close( $ch );
            unset( $active[ $key ] );

            // Validate download
            if ( $http < 200 || $http >= 400 || $cerr || ! file_exists( $h['tmp'] ) || filesize( $h['tmp'] ) < 100 ) {
                @unlink( $h['tmp'] );
                $errors++;
                $error_urls[] = $h['url'];
                $reasons[ $h['url'] ] = $cerr !== '' ? 'Download fallito: ' . $cerr
                    : ( ( $http < 200 || $http >= 400 ) ? 'HTTP ' . $http : 'File vuoto o troppo piccolo' );
            } else {
                // Import into WP (fast — no thumbnails unless opted in)
                $ext      = pathinfo( (string) parse_url( $h['url'], PHP_URL_PATH ), PATHINFO_EXTENSION ) ?: 'jpg';
                $basename = $h['filename'] !== '' ? sanitize_file_name( $h['filename'] )
                    : ( $h['sku'] ? sanitize_file_name( $h['sku'] ) : md5( $h['url'] ) );
                $filename = $basename . '-' . substr( md5( $h['url'] ), 0, 6 ) . '.' . $ext;

                $att_id = media_handle_sideload( [
                    'name'     => $filename,
                    'tmp_name' => $h['tmp'],
                ], 0 );

                if ( is_wp_error( $att_id ) ) {
                    @unlink( $h['tmp'] );
                    $errors++;
                    $error_urls[] = $h['url'];
                    // Es. "Sorry, you are not allowed to upload this file type."
                    // per un .avif su un WordPress/server senza supporto AVIF.
                    $reasons[ $h['url'] ] = $att_id->get_error_message();
                } else {
                    $map[ $h['url'] ] = (int) $att_id;
                    // Orphan attachment (no product_id): mark as
                    // "preimport pending" so Safe Cleanup knows it's
                    // intentionally floating in the media library
                    // waiting for a later products-pass to claim it
                    // via the URL → attachment map lookup. The
                    // attach path (gh_parallel_sideload_to_product)
                    // clears this meta when the attachment is given
                    // a product role. Also stamp the source URL so
                    // a future maintenance tool can show where the
                    // orphan came from.
                    update_post_meta( (int) $att_id, '_gh_preimport_pending', '1' );
                    update_post_meta( (int) $att_id, '_gh_preimport_source_url', $h['url'] );
                    if ( ! empty( $h['sku'] ) ) {
                        update_post_meta( (int) $att_id, '_gh_preimport_sku', (string) $h['sku'] );
                    }
                    $downloaded++;
                }
            }

            // Refill: add next URL from queue
            if ( $qi < count( $queue ) ) {
                $active = gh_preimport_add_handle( $mh, $active, $queue[ $qi ] );
                $qi++;
            }
        }
    }

    curl_multi_close( $mh );

    // 4. Re-enable thumbnail generation
    if ( ! $thumbnails ) {
        remove_filter( 'intermediate_image_sizes_advanced', '__return_empty_array', 999 );
    }

    // 5. Persist map
    update_option( GH_MEDIA_PREIMPORT_MAP_KEY, $map, false );

    return [
        'downloaded' => $downloaded,
        'skipped'    => $skipped,
        'errors'     => $errors,
        'error_urls'    => $error_urls,
        'error_reasons' => $reasons,
        'map_size'   => count( $map ),
    ];
}

/**
 * Adds a curl handle to the multi pool.
 */
function gh_preimport_add_handle( $mh, array $active, array $item ): array {

    $tmp = wp_tempnam( $item['url'] );
    $ch  = curl_init( $item['url'] );
    $fp  = fopen( $tmp, 'wb' );

    curl_setopt_array( $ch, [
        CURLOPT_FILE           => $fp,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 HiveCommerce/1.0',
    ] );

    curl_multi_add_handle( $mh, $ch );
    $active[ (int) $ch ] = [
        'ch'  => $ch,
        'fp'  => $fp,
        'tmp' => $tmp,
        'url'      => $item['url'],
        'sku'      => $item['sku'],
        'filename' => (string) ( $item['filename'] ?? '' ),
    ];

    return $active;
}

// ── SHARED PARALLEL SIDELOAD ────────────────────────────────────────────────

/**
 * Parallel sideload to a specific product. Checks pre-import map first,
 * then downloads missing images via sliding-window curl_multi with
 * thumbnails disabled.
 *
 * @param int    $product_id
 * @param array  $urls
 * @param string $sku
 * @param array  $cfg  { first_is_featured?, rest_is_gallery? }
 */
function gh_parallel_sideload_to_product( int $product_id, array $urls, string $sku = '', array $cfg = [] ): void {

    $urls = array_values( array_filter( $urls ) );
    if ( empty( $urls ) ) return;

    if ( ! function_exists( 'media_handle_sideload' ) ) {
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
    }

    $first_featured = $cfg['first_is_featured'] ?? true;
    $rest_gallery   = $cfg['rest_is_gallery'] ?? true;

    // 1. Check pre-import map
    $map         = gh_preimport_get_map();
    $to_download = [];
    $resolved    = []; // index => att_id

    foreach ( $urls as $i => $url ) {
        if ( isset( $map[ $url ] ) && wp_get_attachment_url( $map[ $url ] ) ) {
            $resolved[ $i ] = (int) $map[ $url ];
        } else {
            $to_download[ $i ] = $url;
        }
    }

    // 2. Download missing via curl_multi (with thumbnail skip)
    if ( ! empty( $to_download ) ) {
        add_filter( 'intermediate_image_sizes_advanced', '__return_empty_array', 999 );

        $mh      = curl_multi_init();
        $handles = [];

        foreach ( $to_download as $i => $url ) {
            $tmp = wp_tempnam( $url );
            $ch  = curl_init( $url );
            $fp  = fopen( $tmp, 'wb' );
            curl_setopt_array( $ch, [
                CURLOPT_FILE           => $fp,
                CURLOPT_TIMEOUT        => 30,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS      => 5,
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_USERAGENT      => 'Mozilla/5.0 HiveCommerce/1.0',
            ] );
            curl_multi_add_handle( $mh, $ch );
            $handles[ $i ] = [ 'ch' => $ch, 'fp' => $fp, 'tmp' => $tmp, 'url' => $url ];
        }

        do {
            $status = curl_multi_exec( $mh, $active );
            if ( $active ) curl_multi_select( $mh, 0.5 );
        } while ( $active && $status === CURLM_OK );

        foreach ( $handles as $i => $h ) {
            fclose( $h['fp'] );
            $http = (int) curl_getinfo( $h['ch'], CURLINFO_HTTP_CODE );
            curl_multi_remove_handle( $mh, $h['ch'] );
            curl_close( $h['ch'] );

            if ( $http < 200 || $http >= 400 || ! file_exists( $h['tmp'] ) || filesize( $h['tmp'] ) < 100 ) {
                @unlink( $h['tmp'] );
                continue;
            }

            $ext      = pathinfo( parse_url( $h['url'], PHP_URL_PATH ), PATHINFO_EXTENSION ) ?: 'jpg';
            $filename = ( $sku ? sanitize_file_name( $sku ) : md5( $h['url'] ) ) . '-' . ( $i + 1 ) . '.' . $ext;

            $att_id = media_handle_sideload( [ 'name' => $filename, 'tmp_name' => $h['tmp'] ], $product_id );
            if ( is_wp_error( $att_id ) ) { @unlink( $h['tmp'] ); continue; }

            $resolved[ $i ] = (int) $att_id;
            $map[ $h['url'] ] = (int) $att_id;
        }

        curl_multi_close( $mh );
        remove_filter( 'intermediate_image_sizes_advanced', '__return_empty_array', 999 );
        update_option( GH_MEDIA_PREIMPORT_MAP_KEY, $map, false );
    }

    // 3. Assign in original URL order
    ksort( $resolved );
    $gallery        = [];
    $assigned_first = false;

    foreach ( $resolved as $att_id ) {
        if ( ! $assigned_first && $first_featured ) {
            set_post_thumbnail( $product_id, $att_id );
            $assigned_first = true;
        } elseif ( $rest_gallery ) {
            $gallery[] = $att_id;
        }
        // Attachment now has a product role — clear the orphan marker
        // that a previous media-only pass may have set. Idempotent:
        // delete_post_meta is a no-op when the key is absent.
        delete_post_meta( (int) $att_id, '_gh_preimport_pending' );
    }

    if ( $gallery ) {
        $product = wc_get_product( $product_id );
        if ( $product ) {
            $product->set_gallery_image_ids( $gallery );
            $product->save();
        }
    }
}

// ── ORPHAN HELPERS (media-only pre-stage) ────────────────────────────────────

/**
 * Returns ids of attachments that are currently in "preimport pending"
 * state — downloaded by a media-only pre-stage but not yet claimed by a
 * product. Used by the hive-sync UsageIndex to keep Safe Cleanup from
 * deleting them while a later products-pass is pending.
 *
 * @return int[]
 */
function gh_preimport_pending_attachment_ids(): array {
    global $wpdb;
    $rows = $wpdb->get_col( "
        SELECT post_id FROM {$wpdb->postmeta}
        WHERE meta_key = '_gh_preimport_pending' AND meta_value = '1'
    " );
    return array_values( array_unique( array_map( 'intval', $rows ?: [] ) ) );
}

// ── MAP UTILS ────────────────────────────────────────────────────────────────

function gh_preimport_resolve_urls( array $urls ): array {
    $map = gh_preimport_get_map();
    $ids = [];
    foreach ( $urls as $url ) {
        if ( isset( $map[ $url ] ) ) $ids[] = (int) $map[ $url ];
    }
    return $ids;
}

function gh_preimport_assign_images( int $product_id, array $urls, array $cfg = [] ): void {
    $att_ids = gh_preimport_resolve_urls( $urls );
    if ( empty( $att_ids ) ) return;

    $first_featured = $cfg['first_is_featured'] ?? true;
    $rest_gallery   = $cfg['rest_is_gallery'] ?? true;
    $gallery        = [];

    foreach ( $att_ids as $i => $att_id ) {
        if ( $i === 0 && $first_featured ) {
            set_post_thumbnail( $product_id, $att_id );
        } elseif ( $rest_gallery ) {
            $gallery[] = $att_id;
        }
    }

    if ( $gallery ) {
        $product = wc_get_product( $product_id );
        if ( $product ) {
            $product->set_gallery_image_ids( $gallery );
            $product->save();
        }
    }
}

function gh_preimport_clear_map(): void {
    update_option( GH_MEDIA_PREIMPORT_MAP_KEY, [], false );
}

function gh_preimport_map_stats(): array {
    $map   = gh_preimport_get_map();
    $valid = 0;
    foreach ( $map as $att_id ) {
        if ( wp_get_attachment_url( $att_id ) ) $valid++;
    }
    return [ 'total' => count( $map ), 'valid' => $valid ];
}

/**
 * Validates the pre-import map: checks each attachment_id still exists
 * in the media library, removes stale entries.
 *
 * @return array { valid: int, pruned: int, total_before: int, total_after: int }
 */
function gh_preimport_validate_map(): array {
    $map          = gh_preimport_get_map();
    $total_before = count( $map );
    $pruned       = 0;

    foreach ( $map as $url => $att_id ) {
        if ( ! wp_get_attachment_url( $att_id ) ) {
            unset( $map[ $url ] );
            $pruned++;
        }
    }

    if ( $pruned > 0 ) {
        update_option( GH_MEDIA_PREIMPORT_MAP_KEY, $map, false );
    }

    return [
        'valid'        => count( $map ),
        'pruned'       => $pruned,
        'total_before' => $total_before,
        'total_after'  => count( $map ),
    ];
}
