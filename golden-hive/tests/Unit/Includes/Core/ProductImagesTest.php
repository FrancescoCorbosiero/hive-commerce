<?php
declare(strict_types=1);

namespace GH\Tests\Unit\Includes\Core;

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../../../../includes/core/product-images.php';

/**
 * Pure part of the Import JSON image pipeline: what the JSON declares, and
 * whether a URL belongs to this site's media library. The WordPress half
 * (lookup, sideload, attach) is exercised against a real install.
 */
final class ProductImagesTest extends TestCase
{
    private const U1 = 'https://shop.example/wp-content/uploads/2026/09/a.avif';
    private const U2 = 'https://cdn.other.example/b.jpg';

    // ── Absent / empty / list semantics ──────────────────────────────

    public function testNoImageKeyMeansUntouched(): void
    {
        $this->assertNull( gh_img_specs_from_entry( [ 'name' => 'X' ] ) );
        $this->assertNull( gh_img_specs_from_entry( [ 'sku' => 'V1' ], true ) );
    }

    public function testEmptyImagesMeansClear(): void
    {
        $this->assertSame( [], gh_img_specs_from_entry( [ 'images' => [] ] ) );
        $this->assertSame( [], gh_img_specs_from_entry( [ 'image' => null ], true ) );
    }

    public function testWooRestShapeKeepsMetadataAndSortsByPosition(): void
    {
        $specs = gh_img_specs_from_entry( [ 'images' => [
            [ 'src' => self::U2, 'position' => 1 ],
            [ 'src' => self::U1, 'name' => 'N', 'alt' => 'A', 'position' => 0 ],
        ] ] );

        $this->assertSame( [ self::U1, self::U2 ], array_column( $specs, 'src' ) );
        $this->assertSame( 'N', $specs[0]['name'] );
        $this->assertSame( 'A', $specs[0]['alt'] );
    }

    public function testBareUrlsIdsAndNumericStrings(): void
    {
        $specs = gh_img_specs_from_entry( [ 'images' => [ self::U1, 42, '43', [ 'id' => 44 ] ] ] );

        $this->assertSame( [ 0, 42, 43, 44 ], array_column( $specs, 'id' ) );
        $this->assertSame( self::U1, $specs[0]['src'] );
    }

    public function testDuplicatesAndEmptyEntriesAreDropped(): void
    {
        $specs = gh_img_specs_from_entry( [ 'images' => [ self::U1, self::U1, '', [ 'id' => 0, 'src' => '' ], [ 'id' => 7 ], 7 ] ] );

        $this->assertCount( 2, $specs );
    }

    public function testProtocolRelativeUrlBecomesHttps(): void
    {
        $specs = gh_img_specs_from_entry( [ 'images' => [ '//cdn.other.example/b.jpg' ] ] );
        $this->assertSame( self::U2, $specs[0]['src'] );
    }

    public function testSingleObjectInsteadOfList(): void
    {
        $specs = gh_img_specs_from_entry( [ 'images' => [ 'src' => self::U1 ] ] );
        $this->assertSame( [ self::U1 ], array_column( $specs, 'src' ) );
    }

    public function testCatalogExportShape(): void
    {
        $specs = gh_img_specs_from_entry( [
            'featured_image_url' => self::U1,
            'gallery_image_urls' => [ self::U2 ],
        ] );
        $this->assertSame( [ self::U1, self::U2 ], array_column( $specs, 'src' ) );
    }

    public function testImagesWinsOverOtherShapes(): void
    {
        $specs = gh_img_specs_from_entry( [ 'images' => [ self::U2 ], 'featured_image_url' => self::U1 ] );
        $this->assertSame( [ self::U2 ], array_column( $specs, 'src' ) );
    }

    public function testVariationTakesOneImageFromImageOrImages(): void
    {
        $this->assertSame( [ self::U1 ], array_column( gh_img_specs_from_entry( [ 'image' => [ 'src' => self::U1 ] ], true ), 'src' ) );
        $this->assertSame( [ self::U1 ], array_column( gh_img_specs_from_entry( [ 'images' => [ self::U1, self::U2 ] ], true ), 'src' ) );
    }

    public function testCountCoversParentAndVariations(): void
    {
        $this->assertSame( 3, gh_img_count_in_entry( [
            'images'     => [ self::U1, self::U2 ],
            'variations' => [ [ 'image' => self::U1 ], [ 'sku' => 'no-image' ] ],
        ] ) );
        $this->assertSame( 0, gh_img_count_in_entry( [ 'name' => 'X', 'variations' => [ [ 'sku' => 'a' ] ] ] ) );
    }

    // ── Local media library detection ────────────────────────────────

    public function testLocalUploadPathIgnoresSchemeAndWww(): void
    {
        $base  = '/wp-content/uploads';
        $hosts = [ 'shop.example' ];

        $this->assertSame( '2026/09/a.avif', gh_img_local_upload_path( self::U1, $base, $hosts ) );
        $this->assertSame( '2026/09/a.avif', gh_img_local_upload_path( 'http://www.shop.example/wp-content/uploads/2026/09/a.avif', $base, $hosts ) );
        $this->assertSame( '2026/09/a b.jpg', gh_img_local_upload_path( 'https://shop.example/wp-content/uploads/2026/09/a%20b.jpg?ver=2', $base, $hosts ) );
    }

    public function testForeignHostOrPathIsNotLocal(): void
    {
        $base  = '/wp-content/uploads';
        $hosts = [ 'shop.example' ];

        $this->assertNull( gh_img_local_upload_path( self::U2, $base, $hosts ) );
        $this->assertNull( gh_img_local_upload_path( 'https://shop.example.evil.test/wp-content/uploads/a.jpg', $base, $hosts ) );
        $this->assertNull( gh_img_local_upload_path( 'https://shop.example/wp-content/themes/x/a.jpg', $base, $hosts ) );
        $this->assertNull( gh_img_local_upload_path( 'https://shop.example/wp-content/uploads-old/a.jpg', $base, $hosts ) );
        $this->assertNull( gh_img_local_upload_path( 'ftp://shop.example/wp-content/uploads/a.jpg', $base, $hosts ) );
    }

    public function testTraversalIsRejected(): void
    {
        $this->assertNull( gh_img_local_upload_path(
            'https://shop.example/wp-content/uploads/../../wp-config.php',
            '/wp-content/uploads',
            [ 'shop.example' ]
        ) );
        $this->assertNull( gh_img_local_upload_path(
            'https://shop.example/wp-content/uploads/2026/%2e%2e/x.jpg',
            '/wp-content/uploads',
            [ 'shop.example' ]
        ) );
    }

    public function testCandidatesCoverThumbnailsAndScaledOriginals(): void
    {
        $this->assertSame(
            [ '2026/09/a-300x300.jpg', '2026/09/a.jpg', '2026/09/a-scaled.jpg', '2026/09/a-rotated.jpg' ],
            gh_img_attached_file_candidates( '2026/09/a-300x300.jpg' )
        );
        $this->assertSame(
            [ '2026/09/a-scaled.jpg', '2026/09/a.jpg', '2026/09/a-rotated.jpg' ],
            gh_img_attached_file_candidates( '2026/09/a-scaled.jpg' )
        );
        $this->assertSame( [ 'noext' ], gh_img_attached_file_candidates( 'noext' ) );
    }
}
