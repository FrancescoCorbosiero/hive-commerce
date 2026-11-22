<?php
declare(strict_types=1);

namespace HiveSync\Tests\Unit\Workflow\Simple;

use HiveSync\Workflow\Simple\FeedOverview;
use PHPUnit\Framework\TestCase;

final class FeedOverviewTest extends TestCase
{
    private static function job( int $id, string $type, string $ref, array $config = [], bool $enabled = false, array $extra = [] ): array
    {
        return $extra + [
            'id' => $id, 'runnable_type' => $type, 'runnable_ref' => $ref,
            'cron_expr' => '0 */2 * * *', 'enabled' => $enabled, 'next_run_at' => null,
            'config' => $config, 'run_state' => null, 'run_control' => null,
        ];
    }

    private static function configs(): array
    {
        return [
            'sf-prod' => [ 'slug' => 'sf-prod', 'name' => 'StockFirmati', 'source_kind' => 'csv', 'config' => [ 'flavor' => 'stockfirmati' ] ],
        ];
    }

    private static function build( array $jobs, array $latest = [], ?array $configs = null ): array
    {
        return FeedOverview::build(
            $jobs,
            $configs ?? self::configs(),
            $latest,
            static fn( string $src, array $cfg ): bool => ( $cfg['flavor'] ?? '' ) === 'stockfirmati',
        );
    }

    public function testAnUnconfiguredJobThatIsOffIsHidden(): void
    {
        // The seeder ships GS + SF on every install: the SF-only shop
        // must not get a dead GS card.
        $o = self::build( [
            self::job( 1, 'source.import', 'json/gs-prod', [ '_seed_label' => 'GS — Sync catalogo' ] ),
            self::job( 2, 'source.import', 'csv/sf-prod',  [ '_seed_label' => 'SF — Sync catalogo' ] ),
        ] );

        $this->assertSame( 1, $o['hidden'] );
        $this->assertSame( [ 'SF — Sync catalogo' ], array_column( $o['cards'], 'label' ) );
    }

    public function testAnUnconfiguredJobThatIsOnStaysVisibleAsAProblem(): void
    {
        $o = self::build( [ self::job( 1, 'source.import', 'json/gs-prod', [], true ) ] );

        $this->assertSame( 0, $o['hidden'] );
        $this->assertFalse( $o['cards'][0]['configured'] );
        $this->assertSame( 'config_missing', $o['cards'][0]['problem'] );
        $this->assertFalse( $o['cards'][0]['importable'] );
    }

    public function testImportCardCarriesTheSimpleKnobs(): void
    {
        $o = self::build( [ self::job( 2, 'source.import', 'csv/sf-prod', [
            'options' => [ 'buckets' => [ 'update', 'updateStock' ], 'category_filter' => [ 'Borse > *', 'Calzature > Sneakers' ] ],
        ], true ) ] );
        $c = $o['cards'][0];

        $this->assertSame( 'import', $c['kind'] );
        $this->assertSame( 'csv', $c['source_id'] );
        $this->assertSame( 'sf-prod', $c['config_slug'] );
        $this->assertSame( 'StockFirmati', $c['label'], 'no label → the feed\'s own name, not "source.import · csv/sf-prod"' );
        $this->assertTrue( $c['importable'] );
        $this->assertTrue( $c['has_categories'] );
        $this->assertSame( '2h', $c['schedule'] );
        $this->assertFalse( $c['add_new'] );
        $this->assertFalse( $c['hides_missing'] );
        $this->assertSame( 'Borse, Calzature › Sneakers', $c['categories_label'] );
        $this->assertSame( '×3,5', $c['margins_label'], 'the seeded SF default (no sf_markup_value → legacy 35/10)' );
    }

    public function testEditorBuiltJobsKeepTheirSlugInConfig(): void
    {
        // Mirrors JobRunner: ref = bare source, slug in config.config_slug.
        $o = self::build( [ self::job( 3, 'source.import', 'csv', [ 'config_slug' => 'sf-prod' ] ) ] );

        $this->assertSame( 'sf-prod', $o['cards'][0]['config_slug'] );
        $this->assertTrue( $o['cards'][0]['importable'] );
    }

    public function testInlineConfigJobsRunButCannotBeImportedFromTheBrowser(): void
    {
        $o = self::build( [ self::job( 4, 'source.import', 'csv', [ 'inline_config' => [ 'url' => 'https://x', 'token' => 'secret' ] ] ) ] );
        $c = $o['cards'][0];

        $this->assertTrue( $c['configured'] );
        $this->assertFalse( $c['importable'] );
        $this->assertStringNotContainsString( 'secret', json_encode( $c ), 'credentials never reach the card' );
    }

    public function testKicksDbJobNeedsAnyKicksDbConfig(): void
    {
        $prices = self::job( 5, 'kicksdb.refresh_prices', '', [], false );

        $this->assertSame( 1, self::build( [ $prices ] )['hidden'] );

        $withKdb = self::configs() + [ 'kdb' => [ 'slug' => 'kdb', 'name' => 'KicksDB', 'source_kind' => 'kicksdb', 'config' => [] ] ];
        $o = self::build( [ $prices ], [], $withKdb );
        $this->assertSame( 'prices', $o['cards'][0]['kind'] );
        $this->assertTrue( $o['cards'][0]['configured'] );
        $this->assertNull( $o['cards'][0]['add_new'] );
    }

    public function testLastRunIsTrimmedToCounters(): void
    {
        $o = self::build( [ self::job( 2, 'source.import', 'csv/sf-prod' ) ], [
            2 => [
                'id' => 9, 'status' => 'done', 'started_at' => '2026-11-20 10:00:00', 'finished_at' => '2026-11-20 10:03:00',
                'items_done' => 12, 'items_failed' => 1,
                'report' => [
                    'summary'  => [ 'created' => 4, 'updated' => 8, 'failed' => 1, 'retire_sample' => [ 'A', 'B' ], 'categories' => 'Borse' ],
                    'warnings' => [ 'w1', 'w2' ],
                    'schedule' => [ 'skipped_slots' => 2 ],
                ],
            ],
        ] );
        $last = $o['cards'][0]['last'];

        $this->assertSame( [ 'created' => 4, 'updated' => 8, 'failed' => 1 ], $last['summary'] );
        $this->assertSame( 'Borse', $last['categories'] );
        $this->assertSame( 2, $last['warnings'] );
        $this->assertSame( 2, $last['skipped_slots'] );
    }

    public function testARunInFlightIsExposedWithoutItsSnapshot(): void
    {
        $o = self::build( [ self::job( 2, 'source.import', 'csv/sf-prod', [], true, [
            'run_state' => [
                'phase' => 'running', 'trigger' => 'manual', 'run_id' => 7, 'slices' => 3,
                'progress' => [ 'done' => 10, 'total' => 40 ],
                'snapshot' => [ 'config' => [ 'inline_config' => [ 'token' => 'secret' ] ] ],
                'cursor'   => [ 'index' => 10 ],
            ],
        ] ) ] );
        $run = $o['cards'][0]['run'];

        $this->assertSame( 7, $run['run_id'] );
        $this->assertSame( [ 'done' => 10, 'total' => 40 ], $run['progress'] );
        $this->assertArrayNotHasKey( 'snapshot', $run );
        $this->assertArrayNotHasKey( 'cursor', $run );
    }
}
