/**
 * Who may sign a label: a handle, never a civil name, because the repository
 * is public. Declared once and read by two consumers — the disk test that
 * guards the repository's own tree, and the harness that scores hand-written
 * labels kept outside the repository. The owner adds handles here; nothing
 * else in the code knows one.
 *
 * The license allowlist stays in the disk test: the harness never validates a
 * manifest, so the test is that list's only reader.
 */

export const ALLOWED_LABELERS = ['MPT0M'] as const;
