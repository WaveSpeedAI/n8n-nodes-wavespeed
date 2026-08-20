// Copy node/credential SVG icons into dist so the published package is complete.
import { cpSync, mkdirSync } from 'node:fs';

const icons = ['wavespeed.svg', 'wavespeed.dark.svg'];
mkdirSync('dist/nodes/WaveSpeed', { recursive: true });
mkdirSync('dist/credentials', { recursive: true });
for (const icon of icons) {
	cpSync(`nodes/WaveSpeed/${icon}`, `dist/nodes/WaveSpeed/${icon}`);
	cpSync(`credentials/${icon}`, `dist/credentials/${icon}`);
}
