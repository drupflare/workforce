import { defineConfig } from 'vitest/config';

const integration = process.env.WORKFORCE_E2E_INTEGRATION === '1';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['tests/unit/**/*.spec.ts']
				}
			},
			{
				test: {
					name: 'e2e',
					environment: 'node',
					include: ['tests/e2e/**/*.spec.ts'],
					globalSetup: ['tests/e2e/global-setup.ts'],
					// one wrangler dev per worker under test; parallel files fight for ports
					fileParallelism: false,
					testTimeout: integration ? 120_000 : 60_000,
					hookTimeout: integration ? 180_000 : 90_000
				}
			}
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
