import js from '@eslint/js';
import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import tseslint from 'typescript-eslint';

/**
 * Flat config (ESLint 9). Two plugins are layered here:
 *
 * 1. `@n8n/eslint-plugin-community-nodes` — the official gate n8n runs against
 *    community packages. Its `recommended` config encodes the n8n Cloud
 *    sandbox restrictions (no Node builtins, no `process`/timer globals, no raw
 *    re-throws, no runtime dependencies, ...). Running it here is what stops a
 *    violation from reaching npm; `npx @n8n/scan-community-package` used to be
 *    the first thing that noticed, which is far too late.
 * 2. `eslint-plugin-n8n-nodes-base` — the older style/consistency rules. It
 *    still ships eslintrc-style configs, so we spread their `rules` objects
 *    into flat config blocks and register the plugin ourselves.
 *
 * Layout mirrors `@n8n/node-cli`'s exported config so we stay aligned with
 * upstream without taking on that package's dependency tree.
 */
export default tseslint.config(
	{
		ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs', 'scripts/**', '**/*.js'],
	},
	{
		files: ['**/*.ts'],
		extends: [
			js.configs.recommended,
			tseslint.configs.recommended,
			n8nCommunityNodesPlugin.configs.recommended,
		],
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json'],
				sourceType: 'module',
			},
		},
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		rules: {
			'prefer-spread': 'off',
			'no-console': 'error',
		},
	},
	{
		files: ['package.json'],
		extends: [n8nCommunityNodesPlugin.configs.recommended],
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		rules: {
			...n8nNodesBase.configs.community.rules,
			'n8n-nodes-base/community-package-json-name-still-default': 'error',
		},
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		files: ['credentials/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.credentials.rules,
			// Wants a camelCase docs slug, but that only applies to credentials in
			// the main n8n repository; community credentials must use a full URL.
			// The community-nodes plugin's `credential-documentation-url` rule (which
			// accepts either form) is the authority now, so this legacy rule would
			// only contradict it.
			'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
		},
	},
	{
		files: ['nodes/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.nodes.rules,
			// These two want the deprecated string literal 'main'; the community-nodes
			// plugin's `node-connection-type-literal` rule requires
			// NodeConnectionTypes.Main instead, and that is what n8n Cloud enforces.
			// Both suppressions are also off in `@n8n/node-cli`'s official config.
			'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
			'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
		},
	},
);
