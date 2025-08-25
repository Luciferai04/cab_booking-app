// Minimal OpenTelemetry initialization for Node services
// Uses OTEL_* env vars if provided; otherwise runs with no-op exporters.

try {
  const {
    NodeSDK
  } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const process = require('process');

  const exporter = new OTLPTraceExporter({
    // Respect OTEL_EXPORTER_OTLP_ENDPOINT if set; defaults to http://localhost:4318
  });

  const sdk = new NodeSDK({
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  sdk.start().then(() => {
    process.on('beforeExit', async () => {
      try { await sdk.shutdown(); } catch (_) {}
    });
  }).catch((err) => {
    console.warn('OTel init failed:', err.message);
  });
} catch (e) {
  // OpenTelemetry not installed; run without tracing
}

