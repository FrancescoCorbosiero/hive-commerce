<?php
declare(strict_types=1);

namespace HiveSync\Tests\Unit\Workflow\Simple;

use HiveSync\Core\Source\Context;
use HiveSync\Core\Source\FetchRequest;
use HiveSync\Sources\CsvSource;
use HiveSync\Workflow\Simple\MarginSettings;
use PHPUnit\Framework\TestCase;

/**
 * The owner edits "price = cost × N" per category; the fetch applies
 * markup_rules. These tests pin that the two agree, and that hand-made
 * rules survive the simple editor.
 */
final class MarginSettingsTest extends TestCase
{
    private const SF = [ 'flavor' => 'stockfirmati', 'sf_markup_mode' => 'multiplier', 'sf_markup_value' => '3.5' ];

    public function testReadsTheSeededSfDefault(): void
    {
        $m = MarginSettings::read( 'csv', self::SF );

        $this->assertTrue( $m['by_category'] );
        $this->assertSame( 3.5, $m['default'] );
        $this->assertSame( [], $m['categories'] );
    }

    public function testPercentModeReadsAsTheSameMultiplier(): void
    {
        $m = MarginSettings::read( 'csv', [ 'flavor' => 'stockfirmati', 'sf_markup_mode' => 'percent', 'sf_markup_value' => '250' ] );

        $this->assertSame( 3.5, $m['default'] );
    }

    public function testWriteThenReadRoundTrips(): void
    {
        $cfg = MarginSettings::write( 'csv', self::SF + [ 'token' => 'secret' ], 3.0, [
            'Calzature > *'        => 2.5,
            'Calzature > Sneakers' => '4',
            'Borse > *'            => '',      // empty = inherit
        ] );

        $this->assertSame( 'secret', $cfg['token'], 'everything else passes through' );
        $this->assertSame( 'multiplier', $cfg['sf_markup_mode'] );
        $this->assertSame( '3', $cfg['sf_markup_value'] );
        $m = MarginSettings::read( 'csv', $cfg );
        $this->assertSame( 3.0, $m['default'] );
        $this->assertSame( [ 'Calzature > Sneakers' => 4.0, 'Calzature > *' => 2.5 ], $m['categories'] );
        $this->assertSame( 0, $m['custom_rules'] );
    }

    public function testSubcategoryRulesComeBeforeTheirCategory(): void
    {
        $cfg = MarginSettings::write( 'csv', self::SF, 3.0, [ 'Calzature > *' => 2.0, 'Calzature > Sneakers' => 4.0 ] );

        $this->assertSame( [ '_sf_taxonomy', '_sf_category' ], array_column( $cfg['markup_rules'], 'field' ) );
    }

    public function testHandWrittenRulesAreKeptFirstAndCounted(): void
    {
        $brand = [ 'field' => '_sf_brand', 'operator' => 'equals', 'value' => 'Nike', 'percent' => 300.0 ];
        $leaf  = [ 'field' => '_sf_taxonomy', 'operator' => 'equals', 'value' => 'Borse', 'percent' => 100.0 ];
        $cfg   = MarginSettings::write( 'csv', self::SF + [ 'markup_rules' => [ $brand, $leaf ] ], 3.0, [ 'Borse > *' => 2.0 ] );

        $this->assertSame( $brand, $cfg['markup_rules'][0] );
        $this->assertSame( $leaf, $cfg['markup_rules'][1], '_sf_taxonomy without ">" is not a whole-category margin' );
        $this->assertSame( 2, MarginSettings::read( 'csv', $cfg )['custom_rules'] );
    }

    public function testOutOfRangeMarginsAreRefused(): void
    {
        $this->expectException( \InvalidArgumentException::class );
        MarginSettings::write( 'csv', self::SF, 0.8 );
    }

    public function testGenericFeedsHaveOnlyADefault(): void
    {
        $m = MarginSettings::read( 'json', [ 'flavor' => 'goldensneakers', 'markup_percent' => 25 ] );
        $this->assertFalse( $m['by_category'] );
        $this->assertSame( 1.25, $m['default'] );

        $this->assertSame( 40, MarginSettings::write( 'json', [], 1.4 )['markup_percent'] );
        $this->assertFalse( MarginSettings::read( 'kicksdb', [] )['supported'] );
    }

    public function testDescribe(): void
    {
        $cfg = MarginSettings::write( 'csv', self::SF, 3.5, [ 'Calzature > Sneakers' => 4.0 ] );
        $this->assertSame( '×3,5 · Calzature › Sneakers ×4', MarginSettings::describe( MarginSettings::read( 'csv', $cfg ) ) );
    }

    public function testTheFetchAppliesWhatTheEditorWrote(): void
    {
        // End to end through the real SF transform: sale = cost × N.
        $file = (string) tempnam( sys_get_temp_dir(), 'hsync-m-' );
        file_put_contents( $file, implode( "\n", [
            'RECORD_TYPE;SKU;Titel_ITA;STREET_PRICE;PRICE;QUANTITY;CAT;SUBCAT',
            'PRODUCT;A;Sneaker;500;100;1;Calzature;Sneakers',
            'PRODUCT;B;Stivale;500;100;1;Calzature;Stivali',
            'PRODUCT;C;Zaino;500;100;1;Borse;Zaini',
        ] ) . "\n" );
        try {
            $cfg = MarginSettings::write( 'csv', self::SF + [
                'source_type' => 'file', 'file_path' => $file, 'delimiter' => ';', 'enclosure' => '"', 'has_header' => true,
            ], 3.0, [ 'Calzature > *' => 2.0, 'Calzature > Sneakers' => 4.0 ] );
            $items = ( new CsvSource() )->fetch( new FetchRequest( $cfg, [] ), new Context( runId: 't' ) )->items;
            $sale  = [];
            foreach ( $items as $i ) $sale[ $i->sku ] = $i->data['sale_price'];
        } finally {
            unlink( $file );
        }

        $this->assertSame( [ 'A' => '400', 'B' => '200', 'C' => '300' ], $sale );
    }
}
