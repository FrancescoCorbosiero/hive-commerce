<?php
declare(strict_types=1);

namespace HiveSync\Tests\Unit\Workflow\Simple;

use HiveSync\Workflow\Simple\FeedCategorySnapshot;
use PHPUnit\Framework\TestCase;

final class FeedCategorySnapshotTest extends TestCase
{
    public function testRoundTripKeepsEveryProductAndItsPath(): void
    {
        $items = [
            [ 'SH-1', 'Calzature', 'Sneakers' ],
            [ 'SH-2', 'Calzature', 'Sneakers' ],
            [ 'BG-1', 'Borse', '' ],
            [ 'NC-1', '', '' ],
        ];
        $snap = FeedCategorySnapshot::encode( $items );

        $this->assertSame( 4, $snap['count'] );
        $this->assertSame( [ 'Calzature', 'Sneakers', 'Borse' ], $snap['names'], 'names are stored once' );
        $back = array_map(
            static fn( array $r ): array => [ $r['sku'], $r['cat'], $r['sub'] ],
            iterator_to_array( FeedCategorySnapshot::decode( $snap ), false )
        );
        $this->assertSame( $items, $back );
        $this->assertSame( [ 'SH-1', 'SH-2', 'BG-1', 'NC-1' ], FeedCategorySnapshot::skus( $snap ) );
    }

    public function testSeparatorsInsideFieldsCannotBreakTheFormat(): void
    {
        $snap = FeedCategorySnapshot::encode( [ [ "A\t1", "Cat\nX", "Sub\r\nY" ] ] );
        $row  = iterator_to_array( FeedCategorySnapshot::decode( $snap ), false )[0];

        $this->assertSame( 'A 1', $row['sku'] );
        $this->assertSame( 'Cat X', $row['cat'] );
        $this->assertSame( 'Sub  Y', $row['sub'] );
    }

    public function testItemsWithoutSkuAreDropped(): void
    {
        $this->assertSame( 0, FeedCategorySnapshot::encode( [ [ '', 'Borse', '' ] ] )['count'] );
        $this->assertSame( [], FeedCategorySnapshot::skus( [] ) );
    }

    public function testInShopIsCountedAgainstTheCatalogGivenNow(): void
    {
        // The reason the snapshot keeps SKUs: the same feed snapshot must
        // read differently before and after an import.
        $snap = FeedCategorySnapshot::encode( [ [ 'SH-1', 'Calzature', 'Sneakers' ], [ 'SH-2', 'Calzature', 'Sneakers' ] ] );

        $this->assertSame( 0, FeedCategorySnapshot::tree( $snap, [] )['in_shop'] );

        $after = FeedCategorySnapshot::tree( $snap, [ 'SH-1' => 10, 'SH-2' => 11 ] );
        $this->assertSame( 2, $after['in_shop'] );
        $this->assertSame( 2, $after['categories'][0]['subs'][0]['in_shop'] );
    }
}
