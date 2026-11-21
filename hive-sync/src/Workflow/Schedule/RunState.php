<?php
declare(strict_types=1);

namespace HiveSync\Workflow\Schedule;

/**
 * Shape of wp_hsync_jobs.run_state — the runtime state of the run a job
 * has in flight. NULL on the row means idle.
 *
 *   phase          'running'
 *   trigger        'schedule' (started on a cron slot) | 'manual' (Run button)
 *   slot_at        UTC slot the run serves; null for manual runs
 *   started_at     UTC
 *   last_slice_at  UTC of the last slice that ran
 *   slices         slices executed so far
 *   run_id         wp_hsync_runs row of this run
 *   cursor         the runner's resume cursor (opaque to the scheduler)
 *   progress       {done, total} from the last slice
 *   totals         per-type running counters (KicksDB: processed)
 *   snapshot       {runnable_type, runnable_ref, config} frozen at start
 *
 * Owned by the lease holder only — nothing else writes this column. It
 * used to live in config._resume_cursor, where the job editor's save
 * (which posts the whole config back) could overwrite a fresher cursor
 * with the one the browser loaded minutes earlier.
 *
 * The snapshot is why editing a job never reshapes the run in flight:
 * every slice dispatches what the run STARTED with, so a mapping or
 * config swap mid-run can't produce a run that is half one thing and
 * half another. Edits apply from the next run ("Interrompi" applies
 * them now).
 */
final class RunState
{
    public const PHASE_RUNNING    = 'running';
    public const TRIGGER_SCHEDULE = 'schedule';
    public const TRIGGER_MANUAL   = 'manual';

    /** Config keys that are runtime state, never part of a snapshot. */
    public const RUNTIME_CONFIG_KEYS = [ '_resume_cursor' ];

    public static function isRunning( mixed $state ): bool
    {
        return is_array( $state ) && ( $state['phase'] ?? '' ) === self::PHASE_RUNNING;
    }

    public static function isManual( mixed $state ): bool
    {
        return is_array( $state ) && ( $state['trigger'] ?? '' ) === self::TRIGGER_MANUAL;
    }

    /**
     * @param array<string, mixed> $job hydrated job row
     * @return array{runnable_type: string, runnable_ref: string, config: array<string, mixed>}
     */
    public static function snapshotOf( array $job ): array
    {
        $config = is_array( $job['config'] ?? null ) ? $job['config'] : [];
        foreach ( self::RUNTIME_CONFIG_KEYS as $k ) unset( $config[ $k ] );
        return [
            'runnable_type' => (string) ( $job['runnable_type'] ?? '' ),
            'runnable_ref'  => (string) ( $job['runnable_ref'] ?? '' ),
            'config'        => $config,
        ];
    }

    /**
     * @param array<string, mixed> $snapshot
     * @return array<string, mixed>
     */
    public static function begin( string $trigger, ?int $slotTs, int $now, array $snapshot ): array
    {
        return [
            'phase'         => self::PHASE_RUNNING,
            'trigger'       => $trigger === self::TRIGGER_MANUAL ? self::TRIGGER_MANUAL : self::TRIGGER_SCHEDULE,
            'slot_at'       => JobSchedule::formatUtc( $slotTs ),
            'started_at'    => gmdate( 'Y-m-d H:i:s', $now ),
            'last_slice_at' => null,
            'slices'        => 0,
            'run_id'        => null,
            'cursor'        => null,
            'progress'      => null,
            'totals'        => [],
            'snapshot'      => $snapshot,
        ];
    }

    /**
     * Fold one slice's envelope into the state.
     *
     * @param array<string, mixed> $state
     * @param array<string, mixed> $envelope
     * @return array<string, mixed>
     */
    public static function advance( array $state, array $envelope, int $now ): array
    {
        $state['slices']        = (int) ( $state['slices'] ?? 0 ) + 1;
        $state['last_slice_at'] = gmdate( 'Y-m-d H:i:s', $now );

        $runId = (int) ( $envelope['run_id'] ?? 0 );
        if ( $runId > 0 ) $state['run_id'] = $runId;

        $state['cursor'] = isset( $envelope['cursor'] ) && is_array( $envelope['cursor'] )
            ? $envelope['cursor']
            : null;

        if ( isset( $envelope['progress'] ) && is_array( $envelope['progress'] ) ) {
            $state['progress'] = [
                'done'  => (int) ( $envelope['progress']['done'] ?? 0 ),
                'total' => (int) ( $envelope['progress']['total'] ?? 0 ),
            ];
        }
        return $state;
    }

    /**
     * The run row this state is advancing, from wherever it is known.
     *
     * @param array<string, mixed>|null $state
     */
    public static function runId( ?array $state ): int
    {
        if ( ! is_array( $state ) ) return 0;
        $id = (int) ( $state['run_id'] ?? 0 );
        if ( $id <= 0 && is_array( $state['cursor'] ?? null ) ) {
            $id = (int) ( $state['cursor']['run_id'] ?? 0 );
        }
        return max( 0, $id );
    }

    /**
     * What a browser may see of a run in flight — never the snapshot (it
     * carries the job config, inline credentials included) nor the raw
     * cursor. null when the job is idle.
     *
     * @param array<string, mixed>|null $state
     * @return array{trigger: string, slot_at: mixed, started_at: mixed, last_slice_at: mixed, slices: int, run_id: int, progress: ?array}|null
     */
    public static function publicView( ?array $state ): ?array
    {
        if ( ! self::isRunning( $state ) ) return null;
        return [
            'trigger'       => (string) ( $state['trigger'] ?? '' ),
            'slot_at'       => $state['slot_at'] ?? null,
            'started_at'    => $state['started_at'] ?? null,
            'last_slice_at' => $state['last_slice_at'] ?? null,
            'slices'        => (int) ( $state['slices'] ?? 0 ),
            'run_id'        => self::runId( $state ),
            'progress'      => is_array( $state['progress'] ?? null ) ? $state['progress'] : null,
        ];
    }
}
