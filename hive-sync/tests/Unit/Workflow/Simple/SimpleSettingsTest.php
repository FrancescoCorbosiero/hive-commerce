<?php
declare(strict_types=1);

namespace HiveSync\Tests\Unit\Workflow\Simple;

use HiveSync\Workflow\Simple\SimpleSettings;
use PHPUnit\Framework\TestCase;

/**
 * The simple view may only write shapes it can read back: anything a
 * developer configured by hand must come out as "custom" and survive.
 */
final class SimpleSettingsTest extends TestCase
{
    public function testPresetsRoundTripThroughTheirCron(): void
    {
        foreach ( array_keys( SimpleSettings::SCHEDULES ) as $key ) {
            $this->assertSame( $key, SimpleSettings::presetFor( (string) SimpleSettings::cronFor( $key ) ) );
        }
    }

    public function testTheSeededCronReadsAsAPreset(): void
    {
        // The seeded sync jobs ship '0 */2 * * *': a fresh install must
        // show "Ogni 2 ore", not "personalizzato".
        $this->assertSame( '2h', SimpleSettings::presetFor( '0 */2 * * *' ) );
        $this->assertSame( '2h', SimpleSettings::presetFor( '  0  */2 * *   * ' ) );
    }

    public function testAnyOtherCronIsCustomAndNoCronIsManual(): void
    {
        $this->assertSame( 'custom', SimpleSettings::presetFor( '15 4 * * 1-5' ) );
        $this->assertSame( '', SimpleSettings::presetFor( '' ) );
        $this->assertNull( SimpleSettings::cronFor( 'custom' ) );
        $this->assertNull( SimpleSettings::cronFor( 'nope' ) );
    }

    public function testNoBucketsMeansNewProductsComeIn(): void
    {
        $this->assertTrue( SimpleSettings::addsNew( [] ) );
        $this->assertTrue( SimpleSettings::addsNew( [ 'buckets' => [] ] ) );
        $this->assertTrue( SimpleSettings::addsNew( [ 'buckets' => [ 'updateStock', 'new', 'update' ] ] ) );
    }

    public function testMaintainOnlyReadsAsNoNewProducts(): void
    {
        $this->assertFalse( SimpleSettings::addsNew( [ 'buckets' => [ 'updateStock', 'update' ] ] ) );
    }

    public function testAHandPickedBucketSetIsCustom(): void
    {
        $this->assertNull( SimpleSettings::addsNew( [ 'buckets' => [ 'updateStock' ] ] ) );
        $this->assertNull( SimpleSettings::addsNew( [ 'buckets' => [ 'new' ] ] ) );
        $this->assertNull( SimpleSettings::addsNew( [ 'buckets' => 'new' ] ) );
    }

    public function testSwitchingKeepsEveryOtherOption(): void
    {
        $opts = [ 'mapping_slug' => 'sf-default', 'retire_missing' => true, 'category_filter' => [ 'Borse > *' ] ];

        $off = SimpleSettings::withAddNew( $opts, false );
        $this->assertSame( SimpleSettings::MAINTAIN_ONLY, $off['buckets'] );
        $this->assertFalse( SimpleSettings::addsNew( $off ) );

        $on = SimpleSettings::withAddNew( $off, true );
        $this->assertArrayNotHasKey( 'buckets', $on, 'the default is the absent key, never an empty list' );
        $this->assertSame( $opts, $on );
    }
}
