/** Types for `next-version.mjs` (VERSION-1), so its tests are type-checked. */
export type ReleaseStep = 'patch' | 'minor' | 'major';
export declare const FIRST_VERSION: string;
export declare const isVersion: (value: unknown) => value is string;
export declare const compareVersions: (a: string, b: string) => -1 | 0 | 1;
export declare const highestVersion: (values: readonly string[]) => string | null;
export declare const bumpOfCommit: (message: string) => ReleaseStep;
export declare const bumpOfCommits: (messages: readonly string[]) => ReleaseStep;
export declare const withOverride: (step: ReleaseStep, override: string) => ReleaseStep;
export declare const nextVersion: (previous: string | null, step: ReleaseStep) => string;
