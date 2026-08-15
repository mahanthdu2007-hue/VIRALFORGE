import { describe, expect, it, vi } from 'vitest';
import {
  aiError,
  ERROR_KINDS,
  isAppError,
  mediaError,
  notImplementedError,
  processingError,
  renderingError,
  toAppError,
  validationError,
} from '@/lib/errors';
import { createLogger, type LogLevel } from '@/lib/logger';

describe('error taxonomy', () => {
  it('covers every conceptual category', () => {
    expect(ERROR_KINDS).toEqual([
      'validation',
      'media',
      'ai',
      'processing',
      'rendering',
      'not_found',
      'unexpected',
    ]);
  });

  it.each([
    [validationError, 'validation', 400],
    [mediaError, 'media', 422],
    [aiError, 'ai', 502],
    [processingError, 'processing', 500],
    [renderingError, 'rendering', 500],
  ])('maps %# to the right kind and status', (factory, kind, status) => {
    const error = factory('some_code', 'Something went wrong.');
    expect(error.kind).toBe(kind);
    expect(error.httpStatus).toBe(status);
  });

  it('serialises without leaking stack or cause', () => {
    const cause = new Error('inner detail');
    const json = mediaError('probe_failed', 'Probe failed.', { cause, details: { path: 'a.mp4' } }).toJSON();

    expect(json).toEqual({
      kind: 'media',
      code: 'probe_failed',
      message: 'Probe failed.',
      details: { path: 'a.mp4' },
    });
    expect(JSON.stringify(json)).not.toContain('inner detail');
  });

  it('keeps logDetails off the wire', () => {
    const error = mediaError('command_failed', 'ffprobe failed.', {
      details: { bin: 'ffprobe', exitCode: 1 },
      logDetails: { args: ['/absolute/secret/path.mp4'], stderr: 'raw output' },
    });

    expect(error.logDetails).toEqual({ args: ['/absolute/secret/path.mp4'], stderr: 'raw output' });
    expect(JSON.stringify(error.toJSON())).not.toContain('/absolute/secret/path.mp4');
    expect(error.toJSON().details).toEqual({ bin: 'ffprobe', exitCode: 1 });
  });

  it('flags not-implemented features with their planned phase', () => {
    const error = notImplementedError('Analysis pipeline', 'Phase 2');
    expect(error.code).toBe('not_implemented');
    expect(error.details).toEqual({ feature: 'Analysis pipeline', plannedPhase: 'Phase 2' });
  });
});

describe('toAppError', () => {
  it('passes AppErrors through unchanged', () => {
    const original = validationError('bad', 'Bad.');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error as unexpected and keeps the cause', () => {
    const boom = new Error('boom');
    const wrapped = toAppError(boom);

    expect(wrapped.kind).toBe('unexpected');
    expect(wrapped.message).toBe('boom');
    expect(wrapped.cause).toBe(boom);
  });

  it('wraps non-Error throws without losing the value', () => {
    const wrapped = toAppError('just a string');
    expect(wrapped.kind).toBe('unexpected');
    expect(wrapped.details).toEqual({ thrown: 'just a string' });
  });

  it('recognises its own instances', () => {
    expect(isAppError(validationError('a', 'b'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError({ kind: 'media', code: 'faked' })).toBe(false);
  });

  /**
   * Regression: the Next dev server compiles each route into its own module
   * graph, so a service cached on globalThis throws AppErrors built from a
   * different copy of the class. An `instanceof` check silently reclassified
   * those as `unexpected`, turning 404s into 500s.
   */
  it('recognises an AppError from a separate copy of the module', async () => {
    vi.resetModules();
    const other = await import('@/lib/errors');
    const foreign = other.notFoundError('job_not_found', 'No job.');

    // A genuinely distinct class, exactly as webpack would produce.
    expect(foreign.constructor).not.toBe(validationError('a', 'b').constructor);
    expect(isAppError(foreign)).toBe(true);
    expect(toAppError(foreign)).toBe(foreign);
    expect(toAppError(foreign).kind).toBe('not_found');
    expect(toAppError(foreign).httpStatus).toBe(404);
  });
});

describe('logger', () => {
  const capture = () => {
    const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
    return {
      lines,
      sink: (level: LogLevel, line: string) => lines.push({ level, entry: JSON.parse(line) }),
    };
  };

  it('emits one JSON object per line', () => {
    const { lines, sink } = capture();
    createLogger({ level: 'info', name: 'test', sink }).info('hello', { videoId: 'v1' });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.entry).toMatchObject({ level: 'info', logger: 'test', msg: 'hello', videoId: 'v1' });
    expect(typeof lines[0]!.entry.ts).toBe('string');
  });

  it('suppresses lines below the threshold', () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: 'warn', sink });

    log.debug('quiet');
    log.info('also quiet');
    log.warn('loud');

    expect(lines.map((l) => l.level)).toEqual(['warn']);
  });

  it('normalises errors into kind and code fields', () => {
    const { lines, sink } = capture();
    createLogger({ level: 'info', sink }).error('failed', mediaError('bad_codec', 'Unsupported codec.'));

    expect(lines[0]!.entry.err).toMatchObject({ kind: 'media', code: 'bad_codec' });
  });

  it('records the diagnostics that are withheld from API responses', () => {
    const { lines, sink } = capture();
    createLogger({ level: 'info', sink }).error(
      'probe failed',
      mediaError('command_failed', 'ffprobe failed.', { logDetails: { args: ['/tmp/x.mp4'] } }),
    );

    expect(lines[0]!.entry.err).toMatchObject({ logDetails: { args: ['/tmp/x.mp4'] } });
  });

  it('child loggers inherit bindings', () => {
    const { lines, sink } = capture();
    createLogger({ level: 'info', sink }).child({ jobId: 'j1' }).info('tick');

    expect(lines[0]!.entry).toMatchObject({ jobId: 'j1', msg: 'tick' });
  });

  it('does not throw when a context field is not serialisable', () => {
    const { lines, sink } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => createLogger({ level: 'info', sink }).info('cyclic', cyclic)).not.toThrow();
    expect(lines[0]!.entry).toMatchObject({ ctxUnserialisable: true });
  });

  it('writes to stdout by default rather than swallowing output', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    createLogger({ level: 'info' }).info('to stdout');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
