import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { metrics, type Meter } from '@opentelemetry/api';

let meterProvider: MeterProvider | null = null;

export interface MetricsConfig {
  serviceName: string;
  serviceVersion?: string;
  prometheusPort?: number;
}

/**
 * Initialize OpenTelemetry metrics with a Prometheus exporter.
 * Call this once at service startup before any meter is used.
 */
export function initMetrics(config: MetricsConfig): void {
  const { serviceName, serviceVersion = '0.1.0', prometheusPort = 9464 } = config;

  const exporter = new PrometheusExporter({ port: prometheusPort }, () => {
    // Prometheus scrape endpoint ready at :<prometheusPort>/metrics
  });

  meterProvider = new MeterProvider({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
    }),
    readers: [exporter],
  });

  metrics.setGlobalMeterProvider(meterProvider);
}

export function getMeter(name: string): Meter {
  return metrics.getMeterProvider().getMeter(name);
}

/**
 * Pre-built common meters for mail services.
 */
export function createMailMetrics(serviceName: string) {
  const meter = getMeter(serviceName);

  return {
    messagesProcessed: meter.createCounter('coremail_messages_processed_total', {
      description: 'Total number of messages processed',
    }),
    messagesRejected: meter.createCounter('coremail_messages_rejected_total', {
      description: 'Total number of messages rejected (spam/virus/policy)',
    }),
    activeConnections: meter.createUpDownCounter('coremail_active_connections', {
      description: 'Current number of active connections',
    }),
    processingDuration: meter.createHistogram('coremail_processing_duration_ms', {
      description: 'Message processing duration in milliseconds',
      unit: 'ms',
    }),
    queueDepth: meter.createObservableGauge('coremail_queue_depth', {
      description: 'Current depth of the SMTP outbound queue',
    }),
    authAttempts: meter.createCounter('coremail_auth_attempts_total', {
      description: 'Total authentication attempts',
    }),
    authFailures: meter.createCounter('coremail_auth_failures_total', {
      description: 'Total authentication failures',
    }),
    storageUsedBytes: meter.createObservableGauge('coremail_storage_used_bytes', {
      description: 'Total storage used across all mailboxes',
      unit: 'By',
    }),
    httpRequestDuration: meter.createHistogram('coremail_http_request_duration_ms', {
      description: 'HTTP request duration in milliseconds',
      unit: 'ms',
    }),
    httpRequestsTotal: meter.createCounter('coremail_http_requests_total', {
      description: 'Total HTTP requests',
    }),
  };
}

export type MailMetrics = ReturnType<typeof createMailMetrics>;

/**
 * Express middleware that records HTTP metrics for every request.
 */
export function metricsMiddleware(mailMetrics: MailMetrics) {
  return (req: { method: string; path: string }, res: { statusCode: number; on: Function }, next: Function) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const labels = { method: req.method, path: req.path, status: String(res.statusCode) };
      mailMetrics.httpRequestsTotal.add(1, labels);
      mailMetrics.httpRequestDuration.record(duration, labels);
    });
    next();
  };
}
