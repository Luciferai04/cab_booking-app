// Minimal OpenTelemetry initialization for Node services
try {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const process = require('process');
  const exporter = new OTLPTraceExporter({});
  const sdk = new NodeSDK({ traceExporter: exporter, instrumentations: [getNodeAutoInstrumentations()] });
  sdk.start().then(() => { process.on('beforeExit', async () => { try { await sdk.shutdown(); } catch(_) {} }); });
} catch (_) {}

