<?php
/**
 * Plugin Name:  Hive Sync
 * Plugin URI:   https://github.com/FrancescoCorbosiero/golden-hive-plugin
 * Description:  Stock sync — Woo product import/export with reusable mappings, rules, and scheduled jobs. Standalone; integrates with Hive Commerce when present.
 * Version:      1.2.0
 * Author:       Hive Commerce
 * License:      Private
 * Requires PHP: 8.1
 * Requires at least: 6.0
 * Requires Plugins: woocommerce
 */

defined( 'ABSPATH' ) || exit;

define( 'HSYNC_VERSION', '1.2.0' );
define( 'HSYNC_DIR',     plugin_dir_path( __FILE__ ) );
define( 'HSYNC_URL',     plugin_dir_url( __FILE__ ) );
define( 'HSYNC_FILE',    __FILE__ );

$hsync_autoload = HSYNC_DIR . 'vendor/autoload.php';
if ( file_exists( $hsync_autoload ) ) {
    require_once $hsync_autoload;
} elseif ( is_admin() ) {
    add_action( 'admin_notices', function () {
        echo '<div class="notice notice-warning"><p><strong>Hive Sync:</strong> '
            . '<code>vendor/autoload.php</code> mancante. Esegui <code>composer install</code> '
            . 'nella directory del plugin.'
            . '</p></div>';
    } );
}
unset( $hsync_autoload );

require_once HSYNC_DIR . 'includes/migrate.php';
require_once HSYNC_DIR . 'includes/host-adapter.php';
require_once HSYNC_DIR . 'includes/admin-page.php';
require_once HSYNC_DIR . 'includes/assets.php';
require_once HSYNC_DIR . 'includes/ajax.php';
require_once HSYNC_DIR . 'includes/ajax-simple.php';
require_once HSYNC_DIR . 'includes/cron.php';
require_once HSYNC_DIR . 'includes/cron-fallback.php';

// Concrete sources / operations / checks self-register on the
// 'hive_sync/core_booted' action. Required BEFORE Bootstrap::boot()
// so the listener is in place when boot() fires the hook.
require_once HSYNC_DIR . 'includes/registrations.php';

register_activation_hook( __FILE__, 'hsync_activate' );

function hsync_activate(): void {
    hsync_migrate_schema();
    update_option( 'hsync_db_version', HSYNC_VERSION, false );
    hsync_install_defaults();
}

function hsync_install_defaults( bool $force = false ): array {
    if ( ! class_exists( '\\HiveSync\\Workflow\\Seed\\Defaults' ) ) return [ 'mappings' => 0, 'pipelines' => 0, 'jobs' => 0 ];
    $seeder = new \HiveSync\Workflow\Seed\Defaults(
        new \HiveSync\Core\Repo\MappingRepository(),
        new \HiveSync\Core\Pipeline\PipelineRepository(),
        new \HiveSync\Core\Repo\JobRepository(),
        new \HiveSync\Core\Repo\RuleRepository(),
    );
    return $seeder->install( $force );
}

add_action( 'plugins_loaded', function () {
    $installed = get_option( 'hsync_db_version' );
    if ( $installed !== HSYNC_VERSION ) {
        hsync_migrate_schema();
        update_option( 'hsync_db_version', HSYNC_VERSION, false );
    }
    // One-shot data migration: rename source_kind 'goldensneakers'
    // → 'json' (with config.flavor flag) for the GoldenSneakersSource
    // → JsonSource refactor. No-op once it's run.
    if ( function_exists( 'hsync_migrate_gs_to_json' ) ) {
        hsync_migrate_gs_to_json();
    }
    // One-shot move onto the 1.2 scheduler (in-flight cursors → run_state,
    // cadence-free labels, slots re-planned in the site timezone).
    if ( function_exists( 'hsync_migrate_scheduler_v2' ) ) {
        hsync_migrate_scheduler_v2();
    }

    if ( class_exists( '\\HiveSync\\Core\\Bootstrap' ) ) {
        \HiveSync\Core\Bootstrap::boot();
    }
}, 20 );
