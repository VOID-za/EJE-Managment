import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Flat ESLint configuration.
 *
 * Extends the Next.js recommended sets and tightens the rules that matter for
 * this codebase: no implicit `any`, explicit type-only imports, and unused
 * variables treated as errors.
 */
const config = [
  // public/vendor holds third-party code vendored unchanged (pdf.js, PDF-VIEW-1): not ours to lint.
  { ignores: ['.next/**', '.next-update/**', 'node_modules/**', 'out/**', 'next-env.d.ts', 'public/vendor/**'] },
  ...coreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];

export default config;
