# Observability assets

Add screenshots here to showcase Grafana dashboards and Jaeger traces.

Suggested files:
- grafana-overview.png (Uber Video Overview)
- grafana-service-metrics.png (Service Latency & Errors & Redis)

How to capture
1) Start the stack as per README/RUNBOOK
2) Generate demo traffic:

```
for i in $(seq 1 50); do curl -fsS http://localhost:8080/health >/dev/null || true; sleep 0.2; done
node ./test-e2e-microservices.js || true
```

3) Open Grafana at http://localhost:3000 and pick the dashboards.
4) Take screenshots and save them with the names above in this folder.
