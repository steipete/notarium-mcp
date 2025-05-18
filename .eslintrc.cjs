module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
    // 'prettier' // The plugin:prettier/recommended preset includes the plugin
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended', // Enables ESLint plugin for Prettier and displays prettier errors as ESLint errors.
  ],
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.json', // Point to your tsconfig.json
  },
  rules: {
    // Basic ESLint rules
    indent: ['error', 2, { SwitchCase: 1 }],
    quotes: ['error', 'single', { avoidEscape: true }],
    semi: ['error', 'always'],
    'comma-dangle': ['error', 'always-multiline'],
    'no-unused-vars': 'off', // Use @typescript-eslint/no-unused-vars instead
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }], // Allow specific console methods
    'eol-last': ['error', 'always'],
    'no-trailing-spaces': 'error',
    'object-curly-spacing': ['error', 'always'],
    'arrow-spacing': ['error', { before: true, after: true }],

    // TypeScript specific rules
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-function-return-type': 'off', // Prefer explicit types but allow inference for brevity
    '@typescript-eslint/explicit-module-boundary-types': 'off', // Same as above for module boundaries
    '@typescript-eslint/no-explicit-any': 'off', // Temporarily off for initial scaffolding, should be reviewed
    '@typescript-eslint/no-inferrable-types': 'warn',
    '@typescript-eslint/interface-name-prefix': 'off', // No I- prefix for interfaces
    '@typescript-eslint/no-empty-interface': 'warn',
    '@typescript-eslint/no-namespace': 'warn', // Allow namespaces if truly needed but prefer modules
    '@typescript-eslint/no-non-null-assertion': 'off', // Temporarily off for id! usage, review later

    // Rules to align with Prettier (optional, if you use Prettier)
    // 'prettier/prettier': 'warn', // This is often configured by plugin:prettier/recommended itself
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '.eslintrc.cjs',
    'vitest.config.ts',
    '.prettierrc.json',
  ],
};
