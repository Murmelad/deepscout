import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	{
		languageOptions: {
			globals: { crypto: 'readonly', fetch: 'readonly', Response: 'readonly', Request: 'readonly' }
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	},
	{ ignores: ['node_modules', '.wrangler', 'worker-configuration.d.ts'] }
);
