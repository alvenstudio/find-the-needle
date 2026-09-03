import { build } from 'esbuild';
const b = await build({ entryPoints: [process.argv[2]], bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'warning' });
await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
