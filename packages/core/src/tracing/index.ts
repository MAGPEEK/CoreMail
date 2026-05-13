import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, type Span, type Tracer } from '@opentelemetry/api';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

let sdk: NodeSDK | null = null;

export interface TracingConfig {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
}

/**
 * Initialize OpenTelemetry distributed tracing.
 * Exports spans to an OTLP collector (Jaeger / Tempo / etc).
 */
export function initTracing(config: TracingConfig): void {
  const {
    serviceName,
    serviceVersion = '0.1.0',
    otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://otel-collector:4318',
  } = config;

  const exporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });

  sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spanProcessors: [new SimpleSpanProcessor(exporter) as any],
  });

  sdk.start();

  process.on('SIGTERM', () => sdk?.shutdown().catch(() => undefined));
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/**
 * Wraps an async function in a named span.
 */
export async function withSpan<T>(
  tracer: Tracer,
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {}
): Promise<T> {
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      span.setAttributes(attributes);
      const result = await fn(span);
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) }); // ERROR
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}
