import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		name: 'action',
		environment: 'node',
		include: ['tests/**/*.spec.ts']
	}
});
