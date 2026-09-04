# node-demo

An intentionally vulnerable Node.js application used as a target for reysys runtime detection. Every route passes request input straight into a sink on purpose: a SQL statement, an outbound HTTP request, and a filesystem read. It exists so that the node agent, injected by the reysys operator, can be exercised end to end on a development cluster without building or publishing an image.

Never expose this application outside a cluster. The manifests create only a `ClusterIP` service; do not add an `Ingress`, a `LoadBalancer`, or a `NodePort`, and do not run it anywhere that is reachable from an untrusted network.

## What is inside

| Path | Purpose |
| --- | --- |
| `app/server.js` | Express server listening on 8080 with the four routes below |
| `app/package.json`, `app/package-lock.json` | Dependencies (`express`, `pg` only), installed in the cluster with `npm ci` |
| `k8s/00-namespace.yaml` | Namespace `node-demo` |
| `k8s/10-postgres-secret.yaml` | Postgres credentials with `PLACEHOLDER` values to replace before applying |
| `k8s/20-postgres.yaml` | Postgres 17 deployment and service, data on an `emptyDir` |
| `k8s/30-app-configmap.yaml` | The three application files as a ConfigMap |
| `k8s/40-app.yaml` | Application deployment and `ClusterIP` service |

| Route | Sink | Behaviour |
| --- | --- | --- |
| `GET /users?name=` | SQL injection | Concatenates `name` into a `SELECT` against the `users` table and runs it through `pg` |
| `GET /fetch?url=` | SSRF | Requests `url` with both `http.request` and the global `fetch`, and reports the outcome of each |
| `GET /file?name=` | Path traversal | Appends `name` to a fixed `documents` directory path with string concatenation and reads the file |
| `GET /healthz` | none | Readiness endpoint |

The application deployment uses the stock `node:22-alpine` image. An init container copies the ConfigMap files into an `emptyDir` and runs `npm ci --omit=dev` there; the application container then runs `node server.js` from the same directory. A `users` table with three rows and two files under `documents/` are created on startup when absent.

## How the agent gets in

The pod template carries the label `reysys.com/inject: "true"` and the annotations `reysys.com/runtime: node` and `reysys.com/service: node-demo`. The reysys operator's mutating webhook adds the agent to the pod at creation time; nothing in these manifests references the agent, `NODE_OPTIONS`, or any `REYSYS_AGENT_*` variable.

Prerequisites on the cluster:

- The reysys operator is installed and an `Instrumentation` resolves for the `node-demo` namespace (either the cluster default or one created in the namespace) with `spec.node` populated.
- The `Instrumentation` has `spec.capture.captureRequestInputs` set to `true`, otherwise the SSRF and path traversal detectors have no request input to compare against.
- The secret the `Instrumentation` references for backend credentials, `reysys-agent-fleet-credentials`, exists in the `node-demo` namespace. Secrets are namespace-local, so the cluster operator copies it in; it is deliberately not part of these manifests.
- Pods in the namespace can reach `registry.npmjs.org` (for `npm ci` in the init container) and the artifact URL configured in the `Instrumentation` (for the agent download).

## Apply

Replace the two `PLACEHOLDER` values in `k8s/10-postgres-secret.yaml` with credentials of your choosing (do not commit the result), then apply the directory. File names are prefixed so that the namespace is created first.

```sh
kubectl apply -f node-demo/k8s/
kubectl -n node-demo rollout status deployment/postgres
kubectl -n node-demo rollout status deployment/node-demo
```

Confirm the operator injected the agent: the application pod shows a `reysys-agent-init` init container next to `install`, and the `node-demo` container has `NODE_OPTIONS` set.

```sh
kubectl -n node-demo get pod -l app.kubernetes.io/name=node-demo -o jsonpath='{.items[0].spec.initContainers[*].name}{"\n"}'
kubectl -n node-demo get pod -l app.kubernetes.io/name=node-demo -o jsonpath='{.items[0].spec.containers[0].env[?(@.name=="NODE_OPTIONS")].value}{"\n"}'
```

If the pod was created before the operator or the credentials secret were in place, delete it so the webhook sees it again:

```sh
kubectl -n node-demo rollout restart deployment/node-demo
```

## Probes

Forward the service to your machine; the application is not reachable any other way.

```sh
kubectl -n node-demo port-forward service/node-demo 8080:8080
```

Each probe below sends one benign request first so the agent sees the route's normal shape, then one malicious request. Findings appear in the console under service `node-demo`.

### SQL injection

```sh
curl "http://localhost:8080/users?name=alice"
curl "http://localhost:8080/users?name=alice'%20OR%201%3D1%20--"
```

The first call returns one row. The second returns every row because the input closes the string literal, appends `OR 1=1`, and comments out the rest of the statement. Expected in the console: a SQL injection finding for the `SELECT id, name, email FROM users WHERE name = ?` statement, with the request input shown crossing the literal boundary (extra tokens and a comment introduced).

### SSRF

```sh
curl "http://localhost:8080/fetch?url=http://example.com/"
curl "http://localhost:8080/fetch?url=http://169.254.169.254/latest/meta-data/"
```

The response reports the status or error of the `http.request` and `fetch` attempts separately; both are made regardless of whether the destination answers, and both time out after five seconds. Expected in the console: an SSRF finding for `node-demo` where the whole outbound URL is request controlled, classified as link-local metadata and therefore urgent, with evidence from both the `http.request` and the `fetch` sinks. Pointing the probe at another service inside the cluster is not a useful test: requests to the application itself and to service hostnames are exempt by design.

### Path traversal

```sh
curl "http://localhost:8080/file?name=welcome.txt"
curl "http://localhost:8080/file?name=../../../../etc/passwd"
```

The first call returns the seeded document. The second returns the container's `/etc/passwd` because the input escapes the `documents` directory. The route concatenates rather than calling `path.join`, which would collapse the `..` segments before the read and hand the agent a path that no longer contains the request input; the agent ships the path exactly as `fs.readFile` received it (`/app/documents/../../../../etc/passwd`) and the backend does the canonicalisation. Expected in the console: a path traversal finding for `node-demo` with the parent directory escape from the fixed documents anchor, tier urgent.

## Regenerating the ConfigMap

`k8s/30-app-configmap.yaml` mirrors the files in `app/`. After changing `server.js` or the dependencies, run `npm install` in `app/` to refresh the lockfile, then regenerate the ConfigMap:

```sh
kubectl create configmap node-demo-app --namespace node-demo \
  --from-file=node-demo/app/server.js \
  --from-file=node-demo/app/package.json \
  --from-file=node-demo/app/package-lock.json \
  --dry-run=client -o yaml > node-demo/k8s/30-app-configmap.yaml
```

## Remove

```sh
kubectl delete -f node-demo/k8s/
```
