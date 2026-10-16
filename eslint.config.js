import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'public/**'],
  },
];
