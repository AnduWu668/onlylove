const workerUrl = new URL("../../server/dist/worker.js", import.meta.url).href;
await import(workerUrl);
